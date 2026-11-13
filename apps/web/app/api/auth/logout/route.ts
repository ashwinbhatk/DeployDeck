import { api, checkOrigin, json } from "../../../../lib/http";
import { sessionCookie } from "../../../../lib/auth";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return api(async () => { checkOrigin(request); return json({ ok: true }, 200, { "Set-Cookie": sessionCookie() }); });
}
