import { db, Prisma } from "@deploydeck/db";
import { requireUser } from "./auth";
import { api, ApiError, body, checkOrigin, json } from "./http";
import { requireProject, projectUrl } from "./projects";
import { validRepoUrl } from "./validation";
const inFlight = ["queued", "cloning", "building", "starting"];
export async function resolveCommit(repoUrl: string, ref: string, explicit = false): Promise<string> {
  if (!validRepoUrl(repoUrl)) throw new ApiError(422, "Invalid repository URL");
  const repo = repoUrl.slice("https://github.com/".length);
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: { Accept: "application/vnd.github.sha", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    const sha = (await response.text()).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha) || (explicit && !sha.startsWith(ref.toLowerCase()))) throw new Error();
    return sha;
  } catch { throw new ApiError(422, "Unable to resolve a public GitHub commit", { commit_sha: "Check the branch or commit and GitHub availability" }); }
}
type Deployment = Prisma.DeploymentGetPayload<object>;
export function deploymentMetadata(d: Deployment) {
  return { id: d.id, project_id: d.projectId, commit_sha: d.commitSha, image_tag: d.imageTag,
    status: d.status, failure_reason: d.failureReason, container_id: d.containerId, host_port: d.hostPort,
    created_at: d.createdAt, queued_at: d.queuedAt, build_started_at: d.buildStartedAt, build_finished_at: d.buildFinishedAt,
    started_at: d.startedAt, healthy_at: d.healthyAt, stopped_at: d.stoppedAt, project_url: projectUrl(d.projectId) };
}
export function triggerDeployment(request: Request, id: string) {
  return api(async () => {
    const user = await requireUser(request);
    const project = await requireProject(id, user.id);
    checkOrigin(request);
    const input = request.body === null ? {} : await body(request);
    if (Object.keys(input).some(k => k !== "commit_sha") || (input.commit_sha !== undefined && (typeof input.commit_sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(input.commit_sha)))) throw new ApiError(422, "Invalid deployment", { commit_sha: "Use a 7-to-40 character hexadecimal SHA" });
    if (await db.deployment.findFirst({ where: { projectId: id, status: { in: inFlight } }, select: { id: true } })) throw new ApiError(409, "A deployment is already in progress");
    const sha = await resolveCommit(project.repoUrl, input.commit_sha as string ?? project.branch, input.commit_sha !== undefined);
    try {
      const deployment = await db.$transaction(async tx => {
        const owned = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM projects WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid FOR UPDATE`;
        if (!owned.length) throw new ApiError(404, "Project not found");
        if (await tx.deployment.findFirst({ where: { projectId: id, status: { in: inFlight } }, select: { id: true } })) throw new ApiError(409, "A deployment is already in progress");
        return tx.deployment.create({ data: { projectId: id, commitSha: sha, status: "queued", job: { create: { status: "pending" } } }, select: { id: true } });
      });
      return json({ deployment_id: deployment.id, status: "queued" }, 201);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ApiError(409, "A deployment is already in progress");
      throw error;
    }
  });
}
export function deploymentHistory(request: Request, id: string) {
  return api(async () => {
    const user = await requireUser(request); await requireProject(id, user.id);
    const rows = await db.deployment.findMany({ where: { projectId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    return json({ deployments: rows.map(deploymentMetadata) });
  });
}
export function deploymentDetail(request: Request, id: string) {
  return api(async () => {
    const user = await requireUser(request);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(404, "Deployment not found");
    const row = await db.deployment.findFirst({ where: { id, project: { userId: user.id } } });
    if (!row) throw new ApiError(404, "Deployment not found");
    return json({ deployment: deploymentMetadata(row) });
  });
}

export function deploymentHealth(request: Request, id: string) {
  return api(async()=>{
    const user=await requireUser(request);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new ApiError(404,"Deployment not found");
    const row=await db.deployment.findFirst({where:{id,project:{userId:user.id}},include:{project:{select:{activeDeploymentId:true}}}});
    if(!row)throw new ApiError(404,"Deployment not found");
    return json({id:row.id,status:row.status,container_id:row.containerId,host_port:row.hostPort,healthy_at:row.healthyAt,failure_reason:row.failureReason,
      active_routing:row.status==="healthy"&&row.project.activeDeploymentId===id,observation_source:"worker_database"});
  });
}

async function lockedDeployment(tx: Prisma.TransactionClient, id: string, userId: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(404, "Deployment not found");
  const owned = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM projects p JOIN deployments d ON d.project_id = p.id
    WHERE d.id = ${id}::uuid AND p.user_id = ${userId}::uuid FOR UPDATE OF p`;
  if (!owned.length) throw new ApiError(404, "Deployment not found");
  return tx.deployment.findUniqueOrThrow({ where: { id } });
}

export function rollbackDeployment(request: Request, id: string) {
  return api(async () => {
    const user = await requireUser(request);
    return db.$transaction(async tx => {
      const target = await lockedDeployment(tx, id, user.id);
      checkOrigin(request);
      if (!["healthy", "stopped"].includes(target.status) || !target.healthyAt || !target.imageTag)
        throw new ApiError(422, "Rollback requires a previously healthy deployment with an image");
      const { projectId, commitSha, imageTag } = target;
      if (await tx.deployment.count({ where: { projectId, status: { in: inFlight } } }))
        throw new ApiError(409, "A deployment is already in progress");
      const row = await tx.deployment.create({ data: { projectId, commitSha, imageTag, job: { create: {} } } });
      return json({ deployment_id: row.id, status: row.status, source: "rollback", from_image: imageTag }, 202);
    });
  });
}
