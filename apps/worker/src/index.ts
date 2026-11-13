import { db } from "@deploydeck/db";
import Docker from "dockerode";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { runWorkerLoop } from "./queue";
import { processClaimedJob } from "./pipeline";
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abort.abort());
}
async function checkCaddy(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: process.env.CADDY_ADMIN_SOCKET ?? "/run/caddy-admin/admin.sock", path: "/config/", timeout: 5000 }, res => {
      res.resume();
      res.on("end", () => res.statusCode === 200 ? resolve() : reject(new Error("Caddy admin unavailable")));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Caddy admin timeout")));
    req.on("error", reject);
    req.end();
  });
}
async function main() {
  const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock", timeout: 5000 });
  await db.$queryRaw`SELECT 1`;
  await docker.ping();
  await checkCaddy();
  if (process.argv.includes("--check")) return;
  console.info("Worker ready to process deployment builds.");
  const buildDocker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
  await runWorkerLoop(randomUUID(),abort.signal,job => processClaimedJob(job,buildDocker,abort.signal));
}
main().catch(() => { console.error("Worker startup failed: verify database, Docker socket, and Caddy admin socket."); process.exitCode = 1; }).finally(() => db.$disconnect());
