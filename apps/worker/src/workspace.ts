import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BuildLogWriter } from "./logs";
export const CLONE_TIMEOUT = 120000;
export async function withWorkspace<T>(id: string, work: (path: string) => Promise<T>) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid deployment workspace id");
  const root = "/tmp/deploydeck";
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root,id);
  await mkdir(path, { mode: 0o700 });
  try { return await work(path); }
  finally { await rm(path, { recursive: true, force: true }); }
}
async function git(args: string[], cwd: string, timeout: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (timeout <= 0) throw new Error("Git clone/checkout timed out after 2 minutes");
  return new Promise<{ stdout: string; stderr: string }>((resolve,reject) => {
    let timedOut = false;
    const child = execFile("setsid", ["git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    }, (error,stdout,stderr) => {
      clearTimeout(timer); signal.removeEventListener("abort",kill);
      if (timedOut) reject(new Error("Git clone/checkout timed out after 2 minutes"));
      else if (signal.aborted) reject(new Error("Deployment interrupted during Git checkout"));
      else if (error) reject(new Error(`Git checkout failed: ${stderr || error.message}`));
      else resolve({ stdout, stderr });
    });
    function kill() { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process already exited. */ } } }
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    signal.addEventListener("abort",kill,{once:true});
    if (signal.aborted) kill();
  });
}
export async function clonePinnedRepository(repoUrl: string, sha: string, workspace: string, log: BuildLogWriter, signal: AbortSignal) {
  if (!/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoUrl) || repoUrl.split("/").slice(-2).some(p => p === "." || p === "..")) throw new Error("Repository must be a public HTTPS GitHub URL");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Deployment requires a full pinned commit SHA");
  const deadline = Date.now() + CLONE_TIMEOUT;
  await log.write(`Cloning pinned commit ${sha}\n`);
  const clone = await git(["clone", "--no-checkout", "--no-recurse-submodules", "--", repoUrl, workspace], workspace, deadline-Date.now(), signal);
  await log.write(clone.stdout + clone.stderr);
  const checkout = await git(["checkout", "--detach", sha, "--"], workspace, deadline-Date.now(), signal);
  await log.write(checkout.stdout + checkout.stderr);
  const head = await git(["rev-parse", "HEAD"], workspace, deadline-Date.now(), signal);
  if (head.stdout.trim() !== sha) throw new Error("Checked-out commit does not match pinned commit");
}
