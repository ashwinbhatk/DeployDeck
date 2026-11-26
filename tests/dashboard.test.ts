import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { startWebServer } from "./helpers/web-server";
import { after, before, test } from "node:test";
import { db } from "@deploydeck/db";
import { signSession } from "../apps/web/lib/security";
import { GET as openStream } from "../apps/web/app/api/deployments/[id]/logs/route";

const owner = randomUUID(), other = randomUUID(), project = randomUUID();
const email = owner + "@test.dev";
process.env.SESSION_SECRET = randomBytes(32).toString("hex");
const cookie = (user = owner) => "deploydeck_session=" + signSession(user);
let server: Awaited<ReturnType<typeof startWebServer>>;
let origin = "";

before(async () => {
  await db.user.createMany({ data: [owner, other].map(id => ({ id, email: id + "@test.dev", passwordHash: "fixture" })) });
  await db.project.create({ data: { id: project, userId: owner, name: "Dashboard", repoUrl: "https://github.com/example/repo", port: 3000 } });
  server = await startWebServer();
  origin = server.origin;
});
after(async () => {
  await server?.close();
  await db.deployment.deleteMany({ where: { projectId: project } });
  await db.project.deleteMany({ where: { id: project } });
  await db.user.deleteMany({ where: { id: { in: [owner, other] } } });
  await db.$disconnect();
});
const deployment = (status: string) => db.deployment.create({ data: { projectId: project, commitSha: "a".repeat(40), status } });
const url = (id: string) => origin + "/api/deployments/" + id + "/logs";
function events(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return async () => {
    while (!buffer.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) { assert.equal(buffer, ""); return null; }
      buffer += chunk.value;
    }
    const end = buffer.indexOf("\n\n"), event = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const [kind, payload] = event.split("\n");
    return { type: kind.slice(7), data: JSON.parse(payload.slice(6)) };
  };
}
test("log streams require a session and hide unknown and cross-user deployments", async () => {
  const d = await deployment("failed");
  for (const [id, token, status] of [[d.id, "", 401], [d.id, cookie(other), 404], [randomUUID(), cookie(), 404]] as const) {
    const res = await fetch(url(id), { headers: { cookie: token } });
    assert.equal(res.status, status);
  }
});

for (const terminal of ["stopped", "failed"]) {
  test("log stream replays ordered history, tails healthy runtime and closes on " + terminal, async () => {
    const d = await deployment("queued");
    const ts = new Date(Date.now() - 1000);
    const insert = (phase: string, line: string, time = new Date()) =>
      db.deploymentLog.create({ data: { deploymentId: d.id, phase, line, ts: time } });
    const last = await insert("runtime", "late timestamp");
    const first = await insert("build", "first", ts);
    const second = await insert("runtime", "second", ts);
    const res = await fetch(url(d.id), { headers: { cookie: cookie() }, signal: AbortSignal.timeout(15000) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    const next = events(res);
    for (const row of [first, second, last]) assert.deepEqual(await next(),
      { type: "log", data: { id: String(row.id), phase: row.phase, line: row.line, ts: row.ts.toISOString() } });
    assert.equal((await next())?.data.status, "queued");
    await db.$transaction([
      db.deployment.update({ where: { id: d.id }, data: { status: "healthy" } }),
      db.project.update({ where: { id: project }, data: { activeDeploymentId: d.id } }),
    ]);
    const status = await next();
    assert.equal(status?.type, "status"); assert.equal(status.data.status, "healthy"); assert.match(status.data.active_url, /project-/);
    const line = "runtime with <tag> and\na second line";
    await insert("runtime", line);
    const live = await next();
    assert.equal(live?.type, "log"); assert.equal(live.data.line, line);
    const reason = terminal === "failed" ? "container exited unexpectedly" : null;
    await db.deployment.update({ where: { id: d.id }, data: { status: terminal, failureReason: reason } });
    assert.deepEqual(await next(), { type: "status", data: { status: terminal, failure_reason: reason, active_url: null } });
    assert.equal((await next())?.type, "done"); assert.equal(await next(), null);
  });
}
test("aborting a healthy stream sends done and releases the reader", async () => {
  const d = await deployment("healthy");
  const abort = new AbortController();
  const next = events(await openStream(new Request(url(d.id), { signal: abort.signal, headers: { cookie: cookie() } }),
    { params: Promise.resolve({ id: d.id }) }));
  assert.equal((await next())?.type, "status");
  abort.abort(); assert.equal((await next())?.type, "done"); assert.equal(await next(), null);
});

test("production dashboard routes serve account forms and protect all three workspace views", async () => {
  for (const path of ["/login", "/signup"]) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 200); assert.match(await res.text(), /name="password"/);
  }
  const d = await deployment("stopped");
  for (const path of ["/", "/projects/" + project, "/deployments/" + d.id]) {
    const guest = await fetch(origin + path, { redirect: "manual" });
    assert.equal(guest.status, 307); assert.equal(new URL(guest.headers.get("location")!, origin).pathname, "/login");
    const page = await fetch(origin + path, { headers: { cookie: cookie() } });
    assert.equal(page.status, 200); assert((await page.text()).includes(email));
  }
});

test("every project and deployment resource endpoint conceals cross-user resources", async () => {
  const d = await deployment("stopped");
  const p = "/api/projects/" + project, path = "/api/deployments/" + d.id;
  for (const [method, route] of [
    ["GET", p], ["PATCH", p], ["GET", p + "/deployments"], ["POST", p + "/deployments"],
    ["GET", path], ["GET", path + "/logs"], ["GET", path + "/health"], ["POST", path + "/rollback"], ["POST", path + "/stop"],
  ]) {
    const res = await fetch(origin + route, { method, headers: { cookie: cookie(other) } });
    assert.equal(res.status, 404, method + " " + route);
  }
});
