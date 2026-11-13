import { api, json } from "../../../../lib/http";
import { requireUser } from "../../../../lib/auth";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return api(async () => json({ user: await requireUser(request) }));
}
