import Docker from "dockerode";
import { lstat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import tar from "tar-fs";
import dockerIgnore from "@balena/dockerignore";
import type { BuildLogWriter } from "./logs";
export const BUILD_TIMEOUT = 10 * 60 * 1000;
export async function ensureDockerfile(workspace: string) {
  try { if ((await lstat(join(workspace,"Dockerfile"))).isFile()) return; } catch { /* Report a stable error without local paths. */ }
  throw new Error("Missing Dockerfile in repository root");
}
export async function buildContext(workspace: string) {
  const ignore = dockerIgnore({ ignorecase: false });
  try {
    const path = join(workspace,".dockerignore");
    const info = await lstat(path);
    if (!info.isFile() || info.size > 65536) throw new Error("Invalid .dockerignore file");
    ignore.add(await readFile(path,"utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return tar.pack(workspace, { dereference: false, ignore: path => {
    const name = relative(workspace,path).split("\\").join("/");
    if (!name || name === "Dockerfile" || name === ".dockerignore") return false;
    if (name === ".git" || name.startsWith(".git/")) return true;
    return ignore.ignores(name);
  } });
}
export async function buildImage(docker: Docker, workspace: string, projectId: string, sha: string, log: BuildLogWriter, signal: AbortSignal, timeout = BUILD_TIMEOUT) {
  await ensureDockerfile(workspace);
  if (!/^[a-f0-9-]{36}$/i.test(projectId) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid image identity");
  const imageTag = `deploydeck/${projectId}:${sha.slice(0,12)}`;
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal,deadline.signal]);
  const timer = setTimeout(() => deadline.abort(),timeout);
  let archive: Awaited<ReturnType<typeof buildContext>> | undefined;
  let response: Readable | undefined;
  const abort = () => { archive?.destroy(); response?.destroy(new Error("Build request cancelled")); };
  combined.addEventListener("abort",abort,{once:true});
  try {
    combined.throwIfAborted();
    archive = await buildContext(workspace);
    archive.on("error", () => deadline.abort());
    combined.throwIfAborted();
    response = await docker.buildImage(archive, { t: imageTag, dockerfile: "Dockerfile", version: "1", rm: true, forcerm: true,
      memory: 256 * 1024 * 1024, cpuperiod: 100000, cpuquota: 50000, abortSignal: combined }) as Readable;
    response.on("error", () => { /* The async iterator handles stream errors. */ });
    const decoder = new StringDecoder("utf8");
    let pending = "", builtId: string | undefined;
    const event = async (line: string) => {
      if (!line.trim()) return;
      let data: { stream?: string; status?: string; progress?: string; error?: string; errorDetail?: { message?: string }; aux?: { ID?: string } };
      try { data = JSON.parse(line); } catch { throw new Error("Invalid Docker build JSON stream"); }
      if (typeof data.stream === "string") {
        await log.write(data.stream);
        const match = /^Successfully built ([a-f0-9]+)\s*$/m.exec(data.stream);
        if (match) builtId = match[1];
      }
      if (typeof data.status === "string") await log.write(`${data.status}${data.progress ? ` ${data.progress}` : ""}\n`);
      if (typeof data.aux?.ID === "string") { builtId = data.aux.ID; await log.write(`Image built: ${builtId}\n`); }
      const error = data.errorDetail?.message ?? data.error;
      if (error) { await log.write(`${error}\n`); throw new Error(error); }
    };
    for await (const chunk of response) {
      combined.throwIfAborted();
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (pending.length > 1024 * 1024) throw new Error("Docker build JSON record exceeded 1 MiB limit");
      let index: number;
      while ((index=pending.indexOf("\n"))>=0) { const line=pending.slice(0,index); pending=pending.slice(index+1); await event(line); }
    }
    pending += decoder.end();
    if (pending.trim()) await event(pending);
    await log.flush();
    combined.throwIfAborted();
    if (!builtId) throw new Error("Docker stream ended without an image success record");
    const [image] = await docker.listImages({ filters: { reference: [imageTag] }, abortSignal: combined });
    if (!image || !image.Id.replace(/^sha256:/, "").startsWith(builtId.replace(/^sha256:/, ""))) throw new Error("Built image identity did not match Docker inspection");
    return imageTag;
  } catch (error) {
    if (signal.aborted) throw new Error("Deployment interrupted during Docker build");
    if (deadline.signal.aborted) throw new Error("Docker build timed out or context upload failed");
    throw error;
  } finally {
    clearTimeout(timer); combined.removeEventListener("abort",abort);
    archive?.destroy(); response?.destroy();
  }
}
