import { ApiError } from "./http";
export const REPO_PATTERN = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
export function validRepoUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && REPO_PATTERN.test(value) && value.split("/").slice(-2).every(x => x !== "." && x !== "..");
}
export async function verifyPublicRepo(url: string, fetcher: typeof fetch = fetch) {
  if (!validRepoUrl(url)) throw new ApiError(422, "Invalid project", { repo_url: "Use a public HTTPS GitHub repository URL" });
  try {
    const response = await fetcher(url, { method: "HEAD", redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) throw new Error();
  } catch {
    throw new ApiError(422, "Invalid project", { repo_url: "Repository must be publicly reachable without redirects" });
  }
}
export function validBranch(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "@" && !value.startsWith("-") && !value.endsWith(".") && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") && value.split("/").every(p => p.length > 0 && !p.startsWith(".") && !p.endsWith(".lock"));
}
export type ProjectInput = { name?: string; repo_url?: string; branch?: string; port?: number; health_check_path?: string; environment_variables?: Record<string, string | null> };
export function projectInput(input: Record<string, unknown>, patch = false): ProjectInput {
  const fields: Record<string, string> = {};
  const allowed = patch ? ["branch", "port", "health_check_path", "environment_variables"] : ["name", "repo_url", "branch", "port", "health_check_path", "environment_variables"];
  for (const field of Object.keys(input)) if (!allowed.includes(field)) fields[field] = "Unknown or immutable field";
  if (!patch) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100) fields.name = "Use a name between 1 and 100 characters";
    if (!validRepoUrl(input.repo_url)) fields.repo_url = "Use https://github.com/owner/repository";
  }
  if ((!patch || "port" in input) && (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535)) fields.port = "Use an integer from 1 to 65535";
  if ("branch" in input && !validBranch(input.branch)) fields.branch = "Invalid Git branch name";
  if ("health_check_path" in input && (typeof input.health_check_path !== "string" || !input.health_check_path.startsWith("/") || input.health_check_path.startsWith("//") || /[\x00-\x20\x7f\\#]/.test(input.health_check_path) || input.health_check_path.length > 2048)) fields.health_check_path = "Use an absolute HTTP path starting with a single /";
  if ("environment_variables" in input) {
    const env = input.environment_variables;
    if (!env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > 100) fields.environment_variables = "Use an object with at most 100 variables";
    else for (const [name, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) fields[`environment_variables.${name}`] = "Invalid environment variable key";
      else if (!(patch && value === null) && (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 16384)) fields[`environment_variables.${name}`] = "Use a string up to 16384 bytes without null characters";
    }
  }
  if (Object.keys(fields).length) throw new ApiError(422, "Invalid project", fields);
  const result = { ...input } as ProjectInput;
  if (!patch) { result.name = result.name!.trim(); result.branch ??= "main"; result.health_check_path ??= "/"; }
  return result;
}
