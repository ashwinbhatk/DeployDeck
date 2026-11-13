import { randomUUID } from "node:crypto";
import { db, Prisma } from "@deploydeck/db";
import { requireUser } from "./auth";
import { api, ApiError, body, json } from "./http";
import { encryptValue } from "./security";
import { projectInput, verifyPublicRepo } from "./validation";
const projectSelect = {
  id: true, userId: true, name: true, repoUrl: true, branch: true, port: true,
  healthCheckPath: true, activeDeploymentId: true, createdAt: true,
  activeDeployment: { select: { status: true } },
} satisfies Prisma.ProjectSelect;
type Project = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>;
function publicProject(p: Project) {
  return { id: p.id, name: p.name, repo_url: p.repoUrl, branch: p.branch, port: p.port,
    health_check_path: p.healthCheckPath, active_deployment_id: p.activeDeploymentId, created_at: p.createdAt,
    active_url: p.activeDeployment?.status === "healthy" ? `${process.env.PUBLIC_PROTOCOL ?? "http"}://project-${p.id}.${process.env.BASE_DOMAIN ?? "localhost"}:${process.env.PUBLIC_PORT ?? "8080"}` : null };
}
export function validId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(404, "Project not found");
}
export function createProject(request: Request) {
  return api(async () => {
    const user = await requireUser(request);
    const input = projectInput(await body(request));
    await verifyPublicRepo(input.repo_url!);
    const id = randomUUID();
    const variables = Object.entries(input.environment_variables ?? {}).map(([key, value]) => ({ key, valueEncrypted: encryptValue(value!, `${id}:${key}`) }));
    const project = await db.$transaction(tx => tx.project.create({
      data: { id, userId: user.id, name: input.name!, repoUrl: input.repo_url!, branch: input.branch, port: input.port!, healthCheckPath: input.health_check_path,
        environmentVariables: { create: variables } }, select: projectSelect,
    }));
    return json({ project: publicProject(project) }, 201);
  });
}
export function listProjects(request: Request) {
  return api(async () => {
    const user = await requireUser(request);
    const projects = await db.project.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { ...projectSelect, deployments: { take: 1, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true, createdAt: true } } } });
    return json({ projects: projects.map(p => ({ ...publicProject(p), latest_deployment: p.deployments[0] ? { id: p.deployments[0].id, status: p.deployments[0].status, created_at: p.deployments[0].createdAt } : null })) });
  });
}
export function getProject(request: Request, id: string) {
  return api(async () => {
    const user = await requireUser(request); validId(id);
    const p = await db.project.findFirst({ where: { id, userId: user.id }, select: { ...projectSelect,
      environmentVariables: { select: { key: true }, orderBy: { key: "asc" } },
      deployments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, commitSha: true, status: true, createdAt: true, queuedAt: true, healthyAt: true, stoppedAt: true } },
    } });
    if (!p) throw new ApiError(404, "Project not found");
    return json({ project: { ...publicProject(p), environment_variables: p.environmentVariables.map(v => v.key), deployments: p.deployments.map(d => ({ id: d.id, commit_sha: d.commitSha, status: d.status, created_at: d.createdAt, queued_at: d.queuedAt, healthy_at: d.healthyAt, stopped_at: d.stoppedAt })) } });
  });
}
export function patchProject(request: Request, id: string) {
  return api(async () => {
    const user = await requireUser(request); validId(id);
    if (!await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } })) throw new ApiError(404, "Project not found");
    const input = projectInput(await body(request), true);
    const p = await db.$transaction(async tx => {
      const updated = await tx.project.update({ where: { id, userId: user.id }, data: { branch: input.branch, port: input.port, healthCheckPath: input.health_check_path }, select: projectSelect });
      for (const [key, value] of Object.entries(input.environment_variables ?? {})) {
        if (value === null) await tx.environmentVariable.deleteMany({ where: { projectId: id, key } });
        else {
          const valueEncrypted = encryptValue(value, `${id}:${key}`);
          await tx.environmentVariable.upsert({ where: { projectId_key: { projectId: id, key } }, create: { projectId: id, key, valueEncrypted }, update: { valueEncrypted } });
        }
      }
      return updated;
    });
    return json({ project: publicProject(p) });
  });
}

export async function requireProject(id: string, userId: string) {
  validId(id);
  const project = await db.project.findFirst({ where: { id, userId } });
  if (!project) throw new ApiError(404, "Project not found");
  return project;
}
export function projectUrl(id: string) {
  return `${process.env.PUBLIC_PROTOCOL ?? "http"}://project-${id}.${process.env.BASE_DOMAIN ?? "localhost"}:${process.env.PUBLIC_PORT ?? "8080"}`;
}
