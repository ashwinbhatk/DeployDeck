export class ApiError extends Error {
  constructor(public status: number, message: string, public fields?: Record<string, string>) { super(message); }
}
export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
export async function api(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, ...(error.fields ? { fields: error.fields } : {}) }, error.status);
    return json({ error: "Internal server error" }, 500);
  }
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const trusted = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  if (origin !== null && origin !== trusted) throw new ApiError(422, "Invalid request origin");
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  checkOrigin(request);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ApiError(422, "Expected application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(422, "Expected a JSON object");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 128 * 1024) { await reader.cancel(); throw new ApiError(422, "Request body is too large"); }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "Expected a valid JSON object");
  } finally { reader.releaseLock(); }
}
