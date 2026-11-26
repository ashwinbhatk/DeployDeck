import { db } from "@deploydeck/db";
import { transitionDeploymentStatus } from "./state";
import { setTimeout as delay } from "node:timers/promises";
export type ClaimedJob = { id: string; deploymentId: string; workerId: string };
export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  return db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; deployment_id: string }[]>`
      SELECT id, deployment_id FROM deployment_jobs WHERE status = 'pending'
      ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return null;
    const job = rows[0];
    await tx.$executeRaw`UPDATE deployment_jobs SET status = 'claimed', claimed_at = now(), claimed_by = ${workerId} WHERE id = ${job.id}::uuid AND status = 'pending'`;
    const deployment = await tx.deployment.findUniqueOrThrow({ where: { id: job.deployment_id }, select: { imageTag: true } });
    await transitionDeploymentStatus(job.deployment_id, "queued", deployment.imageTag ? "starting" : "cloning", {}, tx);
    return { id: job.id, deploymentId: job.deployment_id, workerId };
  });
}
export async function finishJob(job: ClaimedJob) {
  const result = await db.deploymentJob.updateMany({ where: { id: job.id, status: "claimed", claimedBy: job.workerId }, data: { status: "done" } });
  if (result.count !== 1) throw new Error("Job ownership changed before completion");
}
export async function runWorkerLoop(workerId: string, signal: AbortSignal, processJob: (job: ClaimedJob) => Promise<void>) {
  while (!signal.aborted) {
    const job = await claimNextJob(workerId) ?? await claimPreparedJob(workerId);
    if (!job) {
      await delay(1000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      continue;
    }
    try { await processJob(job); }
    finally { await finishJob(job); }
  }
}

// Resume completed Phase 3 build jobs that have not started a container yet.
export async function claimPreparedJob(workerId: string): Promise<ClaimedJob | null> {
  return db.$transaction(async tx=>{
    const rows=await tx.$queryRaw<{id:string;deployment_id:string}[]>`
      SELECT j.id,j.deployment_id FROM deployment_jobs j JOIN deployments d ON d.id=j.deployment_id
      WHERE j.status='done' AND d.status='starting' AND d.image_tag IS NOT NULL
        AND d.container_id IS NULL AND d.failure_reason IS NULL
      ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
    if(!rows.length)return null;
    const row=rows[0];
    await tx.deploymentJob.update({where:{id:row.id},data:{status:"claimed",claimedAt:new Date(),claimedBy:workerId}});
    return {id:row.id,deploymentId:row.deployment_id,workerId};
  });
}
