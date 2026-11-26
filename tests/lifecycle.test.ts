import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import Docker from "dockerode";
import { db, encryptValue } from "@deploydeck/db";
import { CaddyClient } from "../apps/worker/src/caddy";
import { processClaimedJob } from "../apps/worker/src/pipeline";
import { claimNextJob, finishJob } from "../apps/worker/src/queue";
import { runDeployment } from "../apps/worker/src/runtime";
import { RuntimeLogs } from "../apps/worker/src/runtime-logs";

const exec = promisify(execFile);
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
const logs = new RuntimeLogs(docker);
const userId = randomUUID();
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
  caddy = new CaddyClient(undefined, join(root, "admin.sock"));
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
    await db.user.deleteMany({ where: { id: userId } });
  } finally {
    await db.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function deploy(fixture = "lifecycle-http") {
  const repo = await mkdtemp(join(root, "repo-"));
  await cp(resolve("tests/fixtures", fixture), repo, { recursive: true });
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
