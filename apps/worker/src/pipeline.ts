import { db } from "@deploydeck/db";
import Docker from "dockerode";
import { BuildLogWriter, deploymentSecrets } from "./logs";
import { clonePinnedRepository, withWorkspace } from "./workspace";
import { buildImage, ensureDockerfile } from "./build";
import { StaleDeploymentError, transitionDeploymentStatus } from "./state";
import type { ClaimedJob } from "./queue";
export async function processClaimedJob(job: ClaimedJob, docker: Docker, signal: AbortSignal) {
  const state: { phase: "cloning" | "building" } = { phase: "cloning" };
  let log: BuildLogWriter | undefined;
  try {
    const d = await db.deployment.findUniqueOrThrow({ where: { id: job.deploymentId }, include: { project: true } });
    if (d.status !== "cloning") throw new StaleDeploymentError("Deployment is no longer cloning");
    let values: string[];
    try { values = await deploymentSecrets(d.projectId); }
    catch { throw new Error("Unable to decrypt deployment environment"); }
    log = new BuildLogWriter(d.id,values);
    const writer = log;
    const imageTag = await withWorkspace(d.id,async workspace => {
      await clonePinnedRepository(d.project.repoUrl,d.commitSha,workspace,writer,signal);
      await ensureDockerfile(workspace);
      await transitionDeploymentStatus(d.id,"cloning","building",{ buildStartedAt: new Date() });
      state.phase = "building";
      const image = await buildImage(docker,workspace,d.projectId,d.commitSha,writer,signal);
      await writer.write("Build complete. Container startup awaits Phase 4.\n");
      await writer.flush();
      return image;
    });
    await transitionDeploymentStatus(d.id,"building","starting",{ imageTag, buildFinishedAt: new Date() });
  } catch (error) {
    if (error instanceof StaleDeploymentError) return;
    const raw = error instanceof Error ? error.message : "Deployment build failed";
    const reason = (log ? log.redact(raw) : "Unable to initialize deployment build").slice(0,4096);
    if (log) await log.write(`${reason}\n`).catch(() => {});
    try {
      await transitionDeploymentStatus(job.deploymentId,state.phase,"failed",{ failureReason: reason, ...(state.phase === "building" ? { buildFinishedAt: new Date() } : {}) });
    } catch (stateError) { if (!(stateError instanceof StaleDeploymentError)) throw stateError; }
  } finally { await log?.flush(); }
}
