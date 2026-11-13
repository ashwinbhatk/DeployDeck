import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@deploydeck/db";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point to a disposable PostgreSQL database");
const userId = randomUUID();
const projects: string[] = [];
before(async () => {
  await db.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "test-only" } });
});
after(async () => {
  await db.deployment.deleteMany({ where: { projectId: { in: projects } } });
  await db.project.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
async function project() {
  const p = await db.project.create({ data: { userId, name: "Fixture", repoUrl: "https://github.com/example/app", port: 3000 } });
  projects.push(p.id);
  return p;
}
function deployment(projectId: string, status = "queued") {
  return db.deployment.create({ data: { projectId, commitSha: "a".repeat(40), status } });
}
test("concurrent deployment inserts allow exactly one in-flight row", async () => {
  const p = await project();
  const results = await Promise.allSettled([deployment(p.id), deployment(p.id)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "P2002");
  assert.equal(await db.deployment.count({ where: { projectId: p.id } }), 1);
});
test("all in-flight states are guarded, while historical rows coexist", async () => {
  for (const status of ["queued", "cloning", "building", "starting"]) {
    const p = await project();
    await deployment(p.id, status);
    await assert.rejects(deployment(p.id), { code: "P2002" });
    await deployment(p.id, "failed");
    await deployment(p.id, "healthy");
    await deployment(p.id, "stopped");
  }
});
test("invalid statuses, phases, and ports are rejected", async () => {
  const p = await project();
  await assert.rejects(deployment(p.id, "invalid"));
  const d = await deployment(p.id);
  await assert.rejects(db.deploymentLog.create({ data: { deploymentId: d.id, phase: "invalid", line: "test" } }));
  await assert.rejects(db.deploymentJob.create({ data: { deploymentId: d.id, status: "invalid" } }));
  await assert.rejects(db.project.update({ where: { id: p.id }, data: { port: 65536 } }));
  await assert.rejects(db.deployment.update({ where: { id: d.id }, data: { hostPort: 0 } }));
});
test("foreign keys reject orphaned deployments and active pointers", async () => {
  await assert.rejects(deployment(randomUUID()), { code: "P2003" });
  const p = await project();
  await assert.rejects(db.project.update({ where: { id: p.id }, data: { activeDeploymentId: randomUUID() } }), { code: "P2003" });
});
test("environment keys and deployment jobs are unique within their scope", async () => {
  const p = await project();
  const data = { projectId: p.id, key: "TOKEN", valueEncrypted: "test-ciphertext" };
  await db.environmentVariable.create({ data });
  await assert.rejects(db.environmentVariable.create({ data }), { code: "P2002" });
  const d = await deployment(p.id);
  await db.deploymentJob.create({ data: { deploymentId: d.id } });
  await assert.rejects(db.deploymentJob.create({ data: { deploymentId: d.id } }), { code: "P2002" });
});
test("transaction rollback leaves neither a deployment nor a job", async () => {
  const p = await project();
  await assert.rejects(db.$transaction(async tx => {
    const d = await tx.deployment.create({ data: { projectId: p.id, commitSha: "b".repeat(40) } });
    await tx.deploymentJob.create({ data: { deploymentId: d.id } });
    throw new Error("deliberate abort");
  }), /deliberate abort/);
  assert.equal(await db.deployment.count({ where: { projectId: p.id } }), 0);
});
