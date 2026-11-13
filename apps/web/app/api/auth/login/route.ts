import { db } from "@deploydeck/db";
import { api, body, json, ApiError } from "../../../../lib/http";
import { credentials, sessionCookie } from "../../../../lib/auth";
import { verifyPassword } from "../../../../lib/security";
const dummyHash = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;
export const runtime = "nodejs";
export async function POST(request: Request) {
  return api(async () => {
    const { email, password } = credentials(await body(request), true);
    const user = await db.user.findUnique({ where: { email } });
    const valid = await verifyPassword(password, user?.passwordHash ?? dummyHash);
    if (!user || !valid) throw new ApiError(401, "Invalid email or password");
    return json({ user: { id: user.id, email: user.email, createdAt: user.createdAt } }, 200, { "Set-Cookie": sessionCookie(user.id) });
  });
}
