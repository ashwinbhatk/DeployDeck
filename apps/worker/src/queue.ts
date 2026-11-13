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
    await transitionDeploymentStatus(job.deployment_id, "queued", "cloning", {}, tx);
    return { id: job.id, deploymentId: job.deployment_id, workerId };
  });
}
export async function finishJob(job: ClaimedJob) {
  const result = await db.deploymentJob.updateMany({ where: { id: job.id, status: "claimed", claimedBy: job.workerId }, data: { status: "done" } });
  if (result.count !== 1) throw new Error("Job ownership changed before completion");
}
export async function runWorkerLoop(workerId: string, signal: AbortSignal, processJob: (job: ClaimedJob) => Promise<void>) {
  while (!signal.aborted) {
    const job = await claimNextJob(workerId);
    if (!job) {
      await delay(1000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      continue;
    }
    try { await processJob(job); }
    finally { await finishJob(job); }
  }
}
