import { db } from "@deploydeck/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ready", service: "web", phase: "foundation" });
  } catch {
    return Response.json({ status: "unavailable", service: "web" }, { status: 503 });
  }
}
