import { db } from "@deploydeck/db";
import type Docker from "dockerode";
import type { CaddyClient } from "./caddy";
import { removeContainer } from "./containers";
import type { RuntimeLogs } from "./runtime-logs";

export async function completeStop(id: string, projectId: string, docker: Docker, caddy: CaddyClient, logs: RuntimeLogs) {
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
    const row = await tx.deployment.findFirst({ where: { id, projectId, status: "stopping" }, include: { project: true } });
    if (!row) return;
    if (row.project.activeDeploymentId === id) {
      const route = await caddy.projectRoute(projectId);
      if (route) await caddy.replace(projectId, null, route);
      await tx.project.update({ where: { id: projectId }, data: { activeDeploymentId: null } });
    }
    await removeContainer(docker.getContainer(row.containerId ?? "dd-" + id));
    await logs.stop(id);
    await tx.deployment.updateMany({
      where: { id, status: "stopping" },
      data: { status: "stopped", stoppedAt: new Date(), containerId: null, hostPort: null },
    });
  }, { timeout: 90000, maxWait: 90000 });
}

export async function processStops(docker: Docker, caddy: CaddyClient, logs: RuntimeLogs) {
  const rows = await db.deployment.findMany({ where: { status: "stopping" }, select: { id: true, projectId: true } });
  for (const row of rows) {
    try { await completeStop(row.id, row.projectId, docker, caddy, logs); }
    catch { console.warn("Worker will retry stop for deployment " + row.id); }
  }
}
