import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

function key(name: "SESSION_SECRET" | "ENCRYPTION_KEY"): Buffer {
  const value = process.env[name];
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${name} must be 32 random bytes encoded as 64 hex characters`);
  return Buffer.from(value, "hex");
}
const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result));
});
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt-v1$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  return timingSafeEqual(await derive(password, Buffer.from(match[1], "hex")), Buffer.from(match[2], "hex"));
}
export const SESSION_SECONDS = 60 * 60 * 24 * 7;
export const COOKIE_NAME = "deploydeck_session";
export function signSession(userId: string, now = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({ v: 1, sub: userId, iat: now, exp: now + SESSION_SECONDS })).toString("base64url");
  return `${payload}.${createHmac("sha256", key("SESSION_SECRET")).update(payload).digest("base64url")}`;
}
export function verifySession(token: string, now = Math.floor(Date.now() / 1000)): string | null {
  const secret = key("SESSION_SECRET");
  if (token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    return p.v === 1 && typeof p.sub === "string" && /^[a-f0-9-]{36}$/i.test(p.sub) && Number.isInteger(p.iat) && Number.isInteger(p.exp) && p.iat <= now && p.exp > now && p.exp - p.iat === SESSION_SECONDS ? p.sub : null;
  } catch { return null; }
}
export function encryptValue(value: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("ENCRYPTION_KEY"), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}
export function decryptValue(value: string, context: string): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^[a-f0-9]{24}$/.test(parts[1]) || !/^[a-f0-9]{32}$/.test(parts[2]) || !/^(?:[a-f0-9]{2})*$/.test(parts[3])) throw new Error("Invalid encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key("ENCRYPTION_KEY"), Buffer.from(parts[1], "hex"), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(parts[2], "hex"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "hex")), decipher.final()]).toString("utf8");
}
