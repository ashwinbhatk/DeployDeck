// Provide only GitHub metadata in the acceptance server. Resolve refs from the same Git repository the worker checks out.
const { execFileSync } = require("node:child_process");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.href === "https://github.com/example/acceptance" && init?.method === "HEAD") return new Response(null);
  const prefix = "/repos/example/acceptance/commits/";
  if (url.origin === "https://api.github.com" && url.pathname.startsWith(prefix)) {
    const ref = url.pathname.slice(prefix.length);
    if (!/^[a-f0-9]{40}$/.test(ref)) return new Response(null, { status: 404 });
    const sha = execFileSync("git", ["-C", process.env.ACCEPTANCE_REPO, "rev-parse", "--verify", ref + "^{commit}"], { encoding: "utf8" });
    return new Response(sha.trim());
  }
  return originalFetch(input, init);
};
