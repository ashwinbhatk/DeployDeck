import { db } from "@deploydeck/db";
import { ApiError } from "./http";
import { COOKIE_NAME, SESSION_SECONDS, signSession, verifySession } from "./security";
export const userSelect = { id: true, email: true, createdAt: true } as const;
export async function requireUser(request: Request) {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(`${COOKIE_NAME}=`));
  if (cookies.length !== 1) throw new ApiError(401, "Unauthorized");
  const id = verifySession(cookies[0].slice(COOKIE_NAME.length + 1));
  if (!id) throw new ApiError(401, "Unauthorized");
  const user = await db.user.findUnique({ where: { id }, select: userSelect });
  if (!user) throw new ApiError(401, "Unauthorized");
  return user;
}
export function sessionCookie(userId?: string) {
  const secure = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).protocol === "https:" : process.env.NODE_ENV === "production";
  return `${COOKIE_NAME}=${userId ? signSession(userId) : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${userId ? SESSION_SECONDS : 0}${secure ? "; Secure" : ""}`;
}
export function credentials(input: Record<string, unknown>) {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const fields: Record<string, string> = {};
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = "Enter a valid email address";
  if (password.length < 12 || Buffer.byteLength(password) > 1024) fields.password = "Use at least 12 characters and at most 1024 bytes";
  if (Object.keys(fields).length) throw new ApiError(422, "Invalid credentials", fields);
  return { email, password };
}
