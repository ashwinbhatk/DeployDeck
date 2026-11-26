import { db } from "@deploydeck/db";
import type Docker from "dockerode";
import { setTimeout as delay } from "node:timers/promises";
import { isDockerError } from "./containers";

export function milliseconds(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new Error("Invalid " + name);
  return value;
}

const unfinished = ["cloning", "building", "starting"];

export async function recoverStaleJobs(docker: Docker, grace = milliseconds("STALE_JOB_GRACE_MS", 60000)) {
  const cutoff = new Date(Date.now() - grace);
  const expired = { status: "claimed", claimedAt: { lt: cutoff } };
  const candidates = await db.deployment.findMany({ where: { status: { in: unfinished }, job: expired } });
  for (const row of candidates) {
    await db.$transaction(async tx => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM deployment_jobs WHERE deployment_id = ${row.id}::uuid
        AND status = 'claimed' AND claimed_at < ${cutoff} FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return;
      const container = docker.getContainer("dd-" + row.id);
      try {
        const info = await container.inspect();
        if (info.State.Running) return;
      } catch (error) { if (!isDockerError(error, 404)) throw error; }
      const changed = await tx.deployment.updateMany({
        where: { id: row.id, status: { in: unfinished } },
        data: { status: "failed", failureReason: "worker restarted mid-deployment" },
      });
      if (changed.count) await tx.deploymentJob.update({ where: { id: locked[0].id }, data: { status: "done" } });
    }, { timeout: 30000 });
  }
}

export async function reconcileDrift(docker: Docker) {
  // Read healthy rows first so a deployment promoted during Docker listing cannot be failed by an older snapshot.
  const healthy = await db.deployment.findMany({ where: { status: "healthy" }, select: { id: true, containerId: true } });
  const containers = await docker.listContainers({ filters: { name: ["^/dd-"] } });
  const running = new Set(containers.flatMap(c => c.Names));
  for (const row of healthy) {
    if (running.has("/dd-" + row.id)) continue;
    const changed = await db.deployment.updateMany({
      where: { id: row.id, status: "healthy", containerId: row.containerId },
      data: { status: "failed", failureReason: "container exited unexpectedly" },
    });
    if (changed.count) console.warn("Deployment drift: container exited unexpectedly for " + row.id);
  }
  const expected = await db.deployment.findMany({ where: { status: { in: ["starting", "healthy"] } }, select: { id: true } });
  const known = new Set(expected.map(d => "/dd-" + d.id));
  for (const name of running) {
    if (name.startsWith("/dd-") && !known.has(name)) console.warn("Deployment drift: orphaned running container " + name.slice(1));
  }
}

export async function monitorDrift(docker: Docker, signal: AbortSignal, interval: number) {
  while (!signal.aborted) {
    try { await delay(interval, undefined, { signal }); }
    catch (error) { if (signal.aborted) return; throw error; }
    try { await reconcileDrift(docker); }
    catch { console.warn("Worker could not reconcile Docker state; retrying next interval"); }
  }
}
