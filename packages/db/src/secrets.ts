import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function key(_name: "ENCRYPTION_KEY") {
  const value = process.env.ENCRYPTION_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters");
  return Buffer.from(value, "hex");
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
