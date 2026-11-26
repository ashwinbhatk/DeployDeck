import { db, Prisma } from "@deploydeck/db";
export type BuildStatus = "queued" | "cloning" | "building" | "starting" | "healthy" | "stopping" | "stopped" | "failed";
const allowed: Record<BuildStatus, BuildStatus[]> = {
  queued: ["cloning", "starting"], cloning: ["building", "failed"], building: ["starting", "failed"], starting: ["healthy", "failed"], healthy: ["stopping"], stopping: ["stopped"], stopped: [], failed: [],
};
export class StaleDeploymentError extends Error {}
export type TransitionFields = { imageTag?: string; failureReason?: string; buildStartedAt?: Date; buildFinishedAt?: Date; healthyAt?: Date; stoppedAt?: Date };
export async function transitionDeploymentStatus(id: string, expectedFrom: BuildStatus, nextTo: BuildStatus, extraFields: TransitionFields = {}, tx: Prisma.TransactionClient = db) {
  if (!allowed[expectedFrom]?.includes(nextTo)) throw new Error(`Invalid deployment transition: ${expectedFrom} -> ${nextTo}`);
  const { imageTag, failureReason, buildStartedAt, buildFinishedAt, healthyAt, stoppedAt } = extraFields;
  const result = await tx.deployment.updateMany({ where: { id, status: expectedFrom }, data: { status: nextTo, imageTag, failureReason, buildStartedAt, buildFinishedAt, healthyAt, stoppedAt } });
  if (result.count !== 1) throw new StaleDeploymentError("Deployment state changed before worker update");
}
