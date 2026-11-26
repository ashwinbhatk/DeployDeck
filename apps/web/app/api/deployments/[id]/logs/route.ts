import { db } from "@deploydeck/db";
import { requireUser } from "../../../../../lib/auth";
import { api, ApiError } from "../../../../../lib/http";
import { projectUrl, validId } from "../../../../../lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await requireUser(request);
    const { id } = await context.params;
    validId(id);
    const readStatus = () => db.deployment.findFirst({
      where: { id, project: { userId: user.id } },
      select: { status: true, failureReason: true, projectId: true, project: { select: { activeDeploymentId: true } } },
    });
    const initial = await readStatus();
    if (!initial) throw new ApiError(404, "Deployment not found");

    const encoder = new TextEncoder();
    let cursor = BigInt(0);
    let previous = "";
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const cleanup = () => {
      closed = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (name: string, data: unknown) => {
          controller.enqueue(encoder.encode("event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n"));
        };
        abort = () => {
          if (closed) return;
          emit("done", {});
          cleanup();
          controller.close();
        };
        async function poll(replay: boolean) {
          try {
            const state = replay ? initial : await readStatus();
            if (closed) return;
            if (!state) { abort(); return; }
            const rows = await db.deploymentLog.findMany({
              where: { deploymentId: id, ...(replay ? {} : { id: { gt: cursor } }) },
              orderBy: replay ? [{ ts: "asc" }, { id: "asc" }] : { id: "asc" },
              select: { id: true, phase: true, line: true, ts: true },
            });
            if (closed) return;
            for (const row of rows) {
              emit("log", { ...row, id: String(row.id) });
              if (row.id > cursor) cursor = row.id;
            }
            const status = { status: state.status, failure_reason: state.failureReason,
              active_url: state.status === "healthy" && state.project.activeDeploymentId === id ? projectUrl(state.projectId) : null };
            const serialized = JSON.stringify(status);
            if (serialized !== previous) { emit("status", status); previous = serialized; }
            if (["failed", "stopped"].includes(state.status)) abort();
            else timer = setTimeout(() => void poll(false), 400);
          } catch (error) {
            if (!closed) { cleanup(); controller.error(error); }
          }
        }
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
        else void poll(true);
      },
      cancel: cleanup,
    });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no",
    } });
  });
}
