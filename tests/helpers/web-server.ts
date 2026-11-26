import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export async function startWebServer(env: NodeJS.ProcessEnv = {}, nodeArgs: string[] = []) {
  const server = spawn(process.execPath, [...nodeArgs, "node_modules/next/dist/bin/next", "start", "apps/web", "-H", "127.0.0.1", "-p", "0"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0", ...env } });
  const exited = once(server, "exit");
  let output = "";
  server.stdout.on("data", chunk => { output += chunk; });
  server.stderr.on("data", chunk => { output += chunk; });
  async function close() {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await exited;
  }
  try {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      assert.equal(server.exitCode, null, "Next startup failed: " + output);
      const origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (origin && output.includes("Ready")) return { origin, close };
      await delay(50);
    }
    throw new Error("Timed out starting Next: " + output);
  } catch (error) { await close(); throw error; }
}
