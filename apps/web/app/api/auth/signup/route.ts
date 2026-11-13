import { randomUUID } from "node:crypto";
import { db, Prisma } from "@deploydeck/db";
import { api, body, json, ApiError } from "../../../../lib/http";
import { credentials, sessionCookie, userSelect } from "../../../../lib/auth";
import { hashPassword } from "../../../../lib/security";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return api(async () => {
    const { email, password } = credentials(await body(request));
    const id = randomUUID();
    const cookie = sessionCookie(id);
    const passwordHash = await hashPassword(password);
    try {
      const user = await db.user.create({ data: { id, email, passwordHash }, select: userSelect });
      return json({ user }, 201, { "Set-Cookie": cookie });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ApiError(409, "Email is already registered");
      throw error;
    }
  });
}
