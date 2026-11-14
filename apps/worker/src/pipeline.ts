import { db } from "@deploydeck/db";
import Docker from "dockerode";
import { BuildLogWriter, deploymentSecrets } from "./logs";
import { clonePinnedRepository, withWorkspace } from "./workspace";
import { buildImage, ensureDockerfile } from "./build";
import { StaleDeploymentError, transitionDeploymentStatus } from "./state";
import type { ClaimedJob } from "./queue";
async function fail(id: string, phase: "cloning" | "building", error: unknown, log?: BuildLogWriter) {
  if (error instanceof StaleDeploymentError) return;
  const raw = error instanceof Error ? error.message : "Deployment build failed";
  const reason = (log ? log.redact(raw) : "Unable to initialize deployment build").slice(0,4096);
  if (log) await log.write(`${reason}\n`).catch(() => {});
  try {
    await transitionDeploymentStatus(id,phase,"failed",{ failureReason: reason, ...(phase === "building" ? { buildFinishedAt: new Date() } : {}) });
  } catch (stateError) { if (!(stateError instanceof StaleDeploymentError)) throw stateError; }
}
// Startup only follows a verified real image build.
export async function buildPreparedDeployment(d: { id: string; projectId: string; commitSha: string }, workspace: string, docker: Docker, log: BuildLogWriter, signal: AbortSignal) {
  let phase: "cloning" | "building" = "cloning";
  try {
    await ensureDockerfile(workspace);
    await transitionDeploymentStatus(d.id,"cloning","building",{ buildStartedAt: new Date() });
    phase = "building";
    const imageTag = await buildImage(docker,workspace,d.projectId,d.commitSha,log,signal);
    await log.write("Build complete. Preparing container startup.\n");
    await log.flush();
    signal.throwIfAborted();
    await transitionDeploymentStatus(d.id,"building","starting",{ imageTag, buildFinishedAt: new Date() });
  } catch (error) { await fail(d.id,phase,error,log); throw error; }
}
export async function processClaimedJob(job: ClaimedJob, docker: Docker, signal: AbortSignal, startRuntime?: (id: string) => Promise<void>) {
  let log: BuildLogWriter | undefined;
  try {
    const d = await db.deployment.findUniqueOrThrow({ where: { id: job.deploymentId }, include: { project: true } });
    if (d.status === "starting" && startRuntime) {await startRuntime(d.id);return;}
    if (d.status !== "cloning") throw new StaleDeploymentError("Deployment is no longer cloning");
    let values: string[];
    try { values = await deploymentSecrets(d.projectId); }
    catch { throw new Error("Unable to decrypt deployment environment"); }
    log = new BuildLogWriter(d.id,values);
    const writer = log;
    await withWorkspace(d.id,async workspace => {
      await clonePinnedRepository(d.project.repoUrl,d.commitSha,workspace,writer,signal);
      await buildPreparedDeployment(d,workspace,docker,writer,signal);
    });
    if(startRuntime)await startRuntime(d.id);
  } catch (error) { await fail(job.deploymentId,"cloning",error,log); }
  finally { await log?.flush(); }
}
