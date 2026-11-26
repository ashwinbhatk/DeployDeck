import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import Docker from "dockerode";
import { db, encryptValue } from "@deploydeck/db";
import { startWebServer } from "./helpers/web-server";
import { CaddyClient } from "../apps/worker/src/caddy";
import { processClaimedJob } from "../apps/worker/src/pipeline";
import { claimNextJob, finishJob } from "../apps/worker/src/queue";
import { runDeployment } from "../apps/worker/src/runtime";
import { RuntimeLogs } from "../apps/worker/src/runtime-logs";

import { POST as rollback } from "../apps/web/app/api/deployments/[id]/rollback/route";
import { POST as stop } from "../apps/web/app/api/deployments/[id]/stop/route";
import { signSession } from "../apps/web/lib/security";
import { processStops } from "../apps/worker/src/stop";
import { recoverStaleJobs, reconcileDrift } from "../apps/worker/src/reconcile";
import { setTimeout as delay } from "node:timers/promises";

process.env.SESSION_SECRET = randomBytes(32).toString("hex");
const exec = promisify(execFile);
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
const logs = new RuntimeLogs(docker);
const userId = randomUUID();
const acceptanceEmail = randomUUID() + "@test.dev";
let root: string;
let caddy: CaddyClient;
let projectId: string;
let caddyStarted = false;
const tags = new Set<string>();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.STARTUP_TIMEOUT = "7000";
process.env.CONTAINER_HOST = "127.0.0.1";
process.env.BASE_DOMAIN = "localhost";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dd-lifecycle-"));
  const { stdout } = await exec("docker", ["create", "caddy:2.10-alpine"]);
  try {
    await exec("docker", ["cp", stdout.trim() + ":/usr/bin/caddy", join(root, "caddy")]);
  } finally {
    await exec("docker", ["rm", "-v", stdout.trim()]);
  }
  const config = JSON.parse(await readFile("infra/caddy/caddy.json", "utf8"));
  config.admin.listen = "unix/" + join(root, "admin.sock");
  config.apps.http.servers.deploydeck.listen = ["unix/" + join(root, "ingress.sock")];
  caddy = new CaddyClient("", join(root, "admin.sock"));
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  await new Promise<void>((accept, reject) => {
    const launcher = spawn(join(root, "caddy"), ["start", "--config", join(root, "config.json")], {
      stdio: "ignore", env: { ...process.env, HOME: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root },
    });
    launcher.on("error", reject).on("exit", code => {
      if (code === 0) accept(); else reject(new Error("Caddy startup failed: " + code));
    });
  });
  caddyStarted = true;
  await db.user.create({ data: { id: userId, email: userId + "@test.dev", passwordHash: "fixture" } });
});

beforeEach(async () => {
  projectId = randomUUID();
  await db.project.create({ data: {
    id: projectId, userId, name: "Lifecycle", repoUrl: "https://github.com/example/fixture",
    port: 3000, healthCheckPath: "/health",
  } });
});

async function ignoreMissing(action: Promise<unknown>) {
  await action.catch(error => { if (error.statusCode !== 404) throw error; });
}

afterEach(async () => {
  await logs.stopAll();
  const containers = await docker.listContainers({ all: true, filters: { label: ["deploydeck.project=" + projectId] } });
  for (const item of containers) await docker.getContainer(item.Id).remove({ force: true, v: true });
  await ignoreMissing(docker.getNetwork("dd-net-" + projectId).remove());
  for (const tag of tags) await ignoreMissing(docker.getImage(tag).remove({ force: true }));
  tags.clear();
  const route = await caddy.projectRoute(projectId);
  if (route) await caddy.replace(projectId, null, route);
  await db.deployment.deleteMany({ where: { projectId } });
  await db.project.deleteMany({ where: { id: projectId } });
});

after(async () => {
  try {
    if (caddyStarted) await exec(join(root, "caddy"), ["stop", "--address", "unix/" + join(root, "admin.sock")]);
    await db.user.deleteMany({ where: { OR: [{ id: userId }, { email: acceptanceEmail }] } });
  } finally {
    await db.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function deploy(fixture = "lifecycle-http", version?: "v1" | "v2") {
  const repo = await mkdtemp(join(root, "repo-"));
  await cp(resolve("tests/fixtures", fixture), repo, { recursive: true });
  if (version) await appendFile(join(repo, "Dockerfile"), "\nENV APP_VERSION=" + version + "\n");
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "--quiet");
  await git("add", ".");
  await git("-c", "user.name=Ashwin Bhat K", "-c", "user.email=ashwinbhatk00@gmail.com",
    "commit", "-qm", "Build lifecycle fixture " + randomUUID());
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  tags.add("deploydeck/" + projectId + ":" + sha.slice(0, 12));
  const row = await db.deployment.create({ data: { projectId, commitSha: sha, job: { create: {} } } });
  assert.equal(row.status, "queued");
  const job = await claimNextJob(userId);
  assert.equal(job?.deploymentId, row.id);
  assert(job);
  const state = () => db.deployment.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal((await state()).status, "cloning");
  const signal = new AbortController().signal;
  await processClaimedJob(job, docker, signal, async id => {
    const built = await state();
    assert.equal(built.status, "starting");
    assert(built.buildStartedAt && built.buildFinishedAt);
    await runDeployment(id, docker, caddy, logs, signal);
  }, async (_url, pinned, workspace) => {
    await exec("git", ["clone", "--no-checkout", "--", repo, workspace]);
    await exec("git", ["-C", workspace, "checkout", "--detach", pinned]);
    assert.equal((await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim(), pinned);
  });
  await finishJob(job);
  return state();
}

async function assertServing(id: string, version: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.activeDeploymentId, id);
  const result = await new Promise<{ status?: number; body: string }>((accept, reject) => {
    get({ socketPath: join(root, "ingress.sock"), path: "/", headers: { Host: "project-" + projectId + ".localhost" } }, res => {
      let body = "";
      res.setEncoding("utf8").on("data", chunk => { body += chunk; });
      res.on("error", reject).on("end", () => accept({ status: res.statusCode, body }));
    }).on("error", reject);
  });
  assert.deepEqual(result, { status: 200, body: version });
}

test("healthy deployment enforces container limits and serves v1 through Caddy", async () => {
  const row = await deploy();
  assert.equal(row.status, "healthy", row.failureReason ?? undefined);
  const info = await docker.getContainer("dd-" + row.id).inspect();
  assert.equal(info.Id, row.containerId);
  assert.equal(info.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(info.HostConfig.NanoCpus, 500_000_000);
  assert.equal(info.HostConfig.PidsLimit, 128);
  assert.equal(info.HostConfig.Privileged, false);
  assert.deepEqual(info.Mounts, []);
  assert(row.hostPort && row.hostPort >= 20000 && row.hostPort <= 29999);
  assert.equal(info.NetworkSettings.Ports["3000/tcp"]?.[0].HostPort, String(row.hostPort));
  await assertServing(row.id, "v1");
});

async function setVariable(key: string, value: string) {
  const valueEncrypted = encryptValue(value, projectId + ":" + key);
  await db.environmentVariable.upsert({
    where: { projectId_key: { projectId, key } },
    create: { projectId, key, valueEncrypted }, update: { valueEncrypted },
  });
}

test("failed build, unhealthy response, timeout and crash preserve the live deployment", async () => {
  const live = await deploy();
  await assertServing(live.id, "v1");
  const broken = await deploy("lifecycle-build-failure");
  assert.equal(broken.status, "failed");
  assert.match(broken.failureReason ?? "", /deliberately-missing-lifecycle-file/);
  assert(broken.buildStartedAt && broken.buildFinishedAt);
  assert.equal(broken.imageTag, null);
  await assertServing(live.id, "v1");

  const failures = [
    ["unhealthy", /health check returned HTTP 503/],
    ["timeout", /^health check \[REDACTED\]$/],
    ["exit", /^container \[REDACTED\]ed with code 42$/],
  ] as const;
  for (const [mode, reason] of failures) {
    await setVariable("FIXTURE_MODE", mode);
    const failed = await deploy();
    assert(failed.imageTag && failed.buildFinishedAt);
    assert.equal(failed.status, "failed");
    assert.match(failed.failureReason ?? "", reason);
    assert.equal(failed.containerId, null);
    assert.equal(failed.hostPort, null);
    await assert.rejects(docker.getContainer("dd-" + failed.id).inspect(), { statusCode: 404 });
    await assertServing(live.id, "v1");
  }
});

test("build and runtime logs redact both encrypted project secrets", async () => {
  const values = { API_SECRET_KEY: "super-secret-value-123", DB_TOKEN: "tok-987654" };
  for (const [key, value] of Object.entries(values)) await setVariable(key, value);
  const live = await deploy();
  await assertServing(live.id, "v1");
  await logs.stop(live.id);
  const rows = await db.deploymentLog.findMany({ where: { deploymentId: live.id } });
  for (const phase of ["build", "runtime"]) {
    const lines = rows.filter(row => row.phase === phase).map(row => row.line).join("\n");
    for (const [key, value] of Object.entries(values)) {
      assert(lines.includes(key + "=[REDACTED]"), phase + " should mask " + key);
      assert(!lines.includes(value), phase + " stored plaintext for " + key);
    }
  }
});

test("replacement stops v1 and keeps only the five newest successful image tags", async t => {
  // Observe committed transitions even when two updates occur between client polls.
  const schema = "trace_" + projectId.replaceAll("-", "");
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("CREATE SCHEMA " + schema);
    await tx.$executeRawUnsafe(`CREATE TABLE ${schema}.states (seq bigserial, id uuid, status text)`);
    await tx.$executeRawUnsafe(`CREATE FUNCTION ${schema}.record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO ${schema}.states (id, status) VALUES (NEW.id, NEW.status); RETURN NEW; END $$`);
    await tx.$executeRawUnsafe(`CREATE TRIGGER ${schema} AFTER INSERT OR UPDATE OF status ON deployments
      FOR EACH ROW WHEN (NEW.project_id = '${projectId}') EXECUTE FUNCTION ${schema}.record()`);
  });
  t.after(async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("DROP TRIGGER " + schema + " ON deployments");
      await tx.$executeRawUnsafe("DROP SCHEMA " + schema + " CASCADE");
    });
  });
  const versions = [];
  for (let version = 1; version <= 6; version++) {
    await setVariable("APP_VERSION", "v" + version);
    const next = await deploy();
    assert.equal(next.status, "healthy", next.failureReason ?? undefined);
    await assertServing(next.id, "v" + version);
    versions.push(next);
    if (version === 2) {
      const first = versions[0];
      const stopped = await db.deployment.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(stopped.status, "stopped");
      assert(stopped.stoppedAt);
      assert.equal(stopped.containerId, null);
      await assert.rejects(docker.getContainer("dd-" + first.id).inspect(), { statusCode: 404 });
      const history = await db.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM ${schema}.states WHERE id = $1::uuid ORDER BY seq`, first.id);
      assert.deepEqual(history.map(row => row.status), ["queued", "cloning", "building", "starting", "healthy", "stopping", "stopped"]);
      await docker.getImage(first.imageTag!).inspect();
    }
  }
  await assert.rejects(docker.getImage(versions[0].imageTag!).inspect(), { statusCode: 404 });
  for (const recent of versions.slice(1)) await docker.getImage(recent.imageTag!).inspect();
});

function post(action: typeof rollback, id: string, user: string | null = userId) {
  const url = "http://localhost/api/deployments/" + id + (action === rollback ? "/rollback" : "/stop");
  return action(new Request(url, { method: "POST", headers: user ? { cookie: "deploydeck_session=" + signSession(user) } : {} }),
    { params: Promise.resolve({ id }) });
}

async function twoVersions() {
  const first = await deploy("lifecycle-http", "v1");
  await assertServing(first.id, "v1");
  const second = await deploy("lifecycle-http", "v2");
  await assertServing(second.id, "v2");
  return { first, second };
}

async function queueRollback(target: { id: string; imageTag: string | null; commitSha: string }) {
  const response = await post(rollback, target.id);
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.deepEqual(body, { deployment_id: body.deployment_id, status: "queued", source: "rollback", from_image: target.imageTag });
  const row = await db.deployment.findUniqueOrThrow({ where: { id: body.deployment_id }, include: { job: true } });
  assert.equal(row.projectId, projectId);
  assert.equal(row.commitSha, target.commitSha);
  assert.equal(row.imageTag, target.imageTag);
  assert.equal(row.job?.status, "pending");
  return row.id;
}

async function runRollback(id: string) {
  const job = await claimNextJob(userId);
  assert(job && job.deploymentId === id);
  const signal = new AbortController().signal;
  await processClaimedJob(job, docker, signal, next => runDeployment(next, docker, caddy, logs, signal));
  await finishJob(job);
  const row = await db.deployment.findUniqueOrThrow({ where: { id } });
  assert.equal(row.buildStartedAt, null);
  assert.equal(row.buildFinishedAt, null);
  return row;
}

test("rollback reuses the retained v1 image and switches traffic back from v2", async () => {
  const { first } = await twoVersions();
  const id = await queueRollback(first);
  assert.equal((await post(rollback, first.id)).status, 409);
  const rolled = await runRollback(id);
  assert.equal(rolled.status, "healthy", rolled.failureReason ?? undefined);
  const info = await docker.getContainer("dd-" + id).inspect();
  assert.equal(info.Image, (await docker.getImage(first.imageTag!).inspect()).Id);
  await assertServing(id, "v1");
});

test("an unhealthy rollback removes its container and keeps v2 serving", async () => {
  const { first, second } = await twoVersions();
  await setVariable("FIXTURE_MODE", "unhealthy");
  const rolled = await runRollback(await queueRollback(first));
  assert.equal(rolled.status, "failed");
  assert.match(rolled.failureReason ?? "", /HTTP 503/);
  await assert.rejects(docker.getContainer("dd-" + rolled.id).inspect(), { statusCode: 404 });
  await assertServing(second.id, "v2");
});

test("a pruned rollback image fails before startup and preserves v2", async () => {
  const { first, second } = await twoVersions();
  await docker.getImage(first.imageTag!).remove();
  const rolled = await runRollback(await queueRollback(first));
  assert.equal(rolled.status, "failed");
  assert.equal(rolled.failureReason, "Rollback image no longer exists locally");
  assert.equal(rolled.startedAt, null);
  await assertServing(second.id, "v2");
});

test("manual stop retires the route and removes the container", async () => {
  const live = await deploy();
  await assertServing(live.id, "v1");
  const response = await post(stop, live.id);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { deployment_id: live.id, status: "stopping" });
  assert.equal((await post(stop, live.id)).status, 409);
  await processStops(docker, caddy, logs);
  const row = await db.deployment.findUniqueOrThrow({ where: { id: live.id }, include: { project: true } });
  assert.equal(row.status, "stopped");
  assert(row.stoppedAt);
  assert.equal(row.project.activeDeploymentId, null);
  assert.equal(await caddy.projectRoute(projectId), null);
  await assert.rejects(docker.getContainer("dd-" + row.id).inspect(), { statusCode: 404 });
});

test("deployment controls enforce session, ownership and rollback eligibility", async () => {
  const other = randomUUID();
  await db.user.create({ data: { id: other, email: other + "@test.dev", passwordHash: "fixture" } });
  try {
    const row = await db.deployment.create({ data: { projectId, status: "failed", commitSha: "a".repeat(40) } });
    for (const action of [rollback, stop]) {
      assert.equal((await post(action, row.id, null)).status, 401);
      assert.equal((await post(action, row.id, other)).status, 404);
      assert.equal((await post(action, randomUUID())).status, 404);
    }
    assert.equal((await post(rollback, row.id)).status, 422);
    assert.equal((await post(stop, row.id)).status, 409);
    await db.deployment.update({ where: { id: row.id }, data: { status: "stopped", healthyAt: new Date() } });
    assert.equal((await post(rollback, row.id)).status, 422);
  } finally { await db.user.delete({ where: { id: other } }); }
});

test("startup recovers expired claims and preserves recent jobs", async () => {
  const row = await db.deployment.create({ data: { projectId, status: "building", commitSha: "a".repeat(40),
    job: { create: { status: "claimed", claimedAt: new Date() } } } });
  await recoverStaleJobs(docker);
  assert.equal((await db.deployment.findUniqueOrThrow({ where: { id: row.id } })).status, "building");
  await db.deploymentJob.update({ where: { deploymentId: row.id }, data: { claimedAt: new Date(Date.now() - 120000) } });
  await recoverStaleJobs(docker);
  const failed = await db.deployment.findUniqueOrThrow({ where: { id: row.id }, include: { job: true } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureReason, "worker restarted mid-deployment");
  assert.equal(failed.job?.status, "done");
});

test("external container death records drift and preserves the existing Caddy route", async () => {
  const live = await deploy();
  await assertServing(live.id, "v1");
  const route = await caddy.projectRoute(projectId);
  assert(route);
  const container = docker.getContainer("dd-" + live.id);
  await container.kill();
  await container.wait();
  await reconcileDrift(docker);
  const row = await db.deployment.findUniqueOrThrow({ where: { id: live.id } });
  assert.equal(row.status, "failed");
  assert.equal(row.failureReason, "container exited unexpectedly");
  assert.deepEqual(await caddy.projectRoute(projectId), route);
});

test("worker signals drain a starting rollback and exit cleanly", async () => {
  const live = await deploy();
  await assertServing(live.id, "v1");
  await setVariable("FIXTURE_MODE", "timeout");
  const candidate = await queueRollback(live);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/index.ts"], {
      env: { ...process.env, CADDY_ADMIN_SOCKET: join(root, "admin.sock"), CADDY_ADMIN_URL: "", STARTUP_TIMEOUT: "60000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const exited = new Promise<number | null>((accept, reject) => {
      child.once("error", reject).once("exit", accept);
    });
    try {
      const deadline = Date.now() + 45000;
      while (true) {
        assert.equal(child.exitCode, null, output);
        const row = await db.deployment.findUniqueOrThrow({ where: { id: candidate } });
        if (output.includes("Worker ready") && (signal === "SIGINT" || row.containerId)) break;
        assert(Date.now() < deadline, "Worker did not reach expected state: " + output);
        await delay(100);
      }
      child.kill(signal);
      const timeout = AbortSignal.timeout(30000);
      const overdue = new Promise<never>((_, reject) => timeout.addEventListener("abort", () => reject(new Error("Worker shutdown timed out")), { once: true }));
      assert.equal(await Promise.race([exited, overdue]), 0, output);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }
  const row = await db.deployment.findUniqueOrThrow({ where: { id: candidate }, include: { job: true } });
  assert.equal(row.status, "failed");
  assert.equal(row.job?.status, "done");
  await assert.rejects(docker.getContainer("dd-" + candidate).inspect(), { statusCode: 404 });
  await assertServing(live.id, "v1");
});

test("recovery preserves a running startup container and drift reports it if orphaned", async t => {
  const row = await db.deployment.create({ data: { projectId, status: "starting", commitSha: "b".repeat(40),
    job: { create: { status: "claimed", claimedAt: new Date(Date.now() - 120000) } } } });
  const name = "dd-" + row.id;
  const container = await docker.createContainer({
    name, Image: "node:22-bookworm-slim", Cmd: ["sleep", "300"], Labels: { "deploydeck.project": projectId },
  });
  await container.start();
  await recoverStaleJobs(docker);
  const current = await db.deployment.findUniqueOrThrow({ where: { id: row.id }, include: { job: true } });
  assert.equal(current.status, "starting");
  assert.equal(current.job?.status, "claimed");
  await db.deployment.delete({ where: { id: row.id } });
  const warnings = t.mock.method(console, "warn");
  await reconcileDrift(docker);
  assert(warnings.mock.calls.some(call => String(call.arguments[0]).includes("orphaned running container " + name)));
  assert((await container.inspect()).State.Running);
});

test("HTTP signup, concurrent deploy, replacement, failed build, rollback and stop", async t => {
  // This journey creates its own project via HTTP instead of the suite's seeded project.
  await db.project.delete({ where: { id: projectId } });
  const repo = await mkdtemp(join(root, "acceptance-"));
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "-q", "-b", "main");
  await cp(resolve("tests/fixtures/lifecycle-http"), repo, { recursive: true });
  async function commit(message: string) {
    await git("add", ".");
    await git("-c", "user.name=Ashwin Bhat K", "-c", "user.email=ashwinbhatk00@gmail.com", "commit", "-qm", message);
    return (await git("rev-parse", "HEAD")).stdout.trim();
  }
  const firstSha = await commit("Serve v1");
  await appendFile(join(repo, "Dockerfile"), "\nENV APP_VERSION=v2\n");
  const nextSha = await commit("Serve v2");
  await cp(resolve("tests/fixtures/lifecycle-build-failure/Dockerfile"), join(repo, "Dockerfile"));
  const brokenSha = await commit("Exercise build failure");

  const web = await startWebServer({ ACCEPTANCE_REPO: repo }, ["--require", resolve("tests/helpers/github-fixture.cjs")]);
  t.after(web.close);
  let cookie = "";
  const post = (path: string, data = {}) => fetch(web.origin + "/api/" + path, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(data),
  });
  const signup = await post("auth/signup", { email: acceptanceEmail, password: randomUUID() });
  assert.equal(signup.status, 201);
  cookie = signup.headers.get("set-cookie")!.split(";")[0];
  const created = await post("projects", { name: "Acceptance", repo_url: "https://github.com/example/acceptance", port: 3000, health_check_path: "/health" });
  assert.equal(created.status, 201);
  projectId = (await created.json()).project.id;
  const trigger = (commit_sha: string) => post("projects/" + projectId + "/deployments", { commit_sha });
  async function processResponse(response: Response, sha: string, status = 201) {
    assert.equal(response.status, status);
    const { deployment_id: id } = await response.json();
    tags.add("deploydeck/" + projectId + ":" + sha.slice(0, 12));
    const job = await claimNextJob(userId);
    assert(job && job.deploymentId === id);
    const signal = new AbortController().signal;
    await processClaimedJob(job, docker, signal, next => runDeployment(next, docker, caddy, logs, signal),
      async (_url, pinned, workspace) => {
        assert.equal(pinned, sha);
        await exec("git", ["clone", "--no-checkout", "--", repo, workspace]);
        await exec("git", ["-C", workspace, "checkout", "--detach", pinned]);
      });
    await finishJob(job);
    return db.deployment.findUniqueOrThrow({ where: { id } });
  }
  const responses = await Promise.all([trigger(firstSha), trigger(firstSha)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(await db.deploymentJob.count({ where: { deployment: { projectId } } }), 1);
  const first = await processResponse(responses.find(r => r.status === 201)!, firstSha);
  assert.equal(first.status, "healthy");
  await assertServing(first.id, "v1");
  const next = await processResponse(await trigger(nextSha), nextSha);
  assert.equal(next.status, "healthy");
  await assertServing(next.id, "v2");
  assert.equal((await db.deployment.findUniqueOrThrow({ where: { id: first.id } })).status, "stopped");
  await assert.rejects(docker.getContainer("dd-" + first.id).inspect(), { statusCode: 404 });
  const failed = await processResponse(await trigger(brokenSha), brokenSha);
  assert.equal(failed.status, "failed");
  assert.match(failed.failureReason ?? "", /deliberately-missing-lifecycle-file/);
  await assertServing(next.id, "v2");
  const restored = await processResponse(await post("deployments/" + first.id + "/rollback"), firstSha, 202);
  assert.equal(restored.status, "healthy");
  assert.equal(restored.imageTag, first.imageTag);
  assert.equal(restored.buildStartedAt, null);
  assert.equal(restored.buildFinishedAt, null);
  await assertServing(restored.id, "v1");
  assert.equal((await post("deployments/" + restored.id + "/stop")).status, 202);
  await processStops(docker, caddy, logs);
  assert.equal((await db.deployment.findUniqueOrThrow({ where: { id: restored.id } })).status, "stopped");
  await assert.rejects(docker.getContainer("dd-" + restored.id).inspect(), { statusCode: 404 });
  assert.equal(await caddy.projectRoute(projectId), null);
});
