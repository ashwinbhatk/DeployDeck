import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const globalDb = globalThis as unknown as { deploydeckDb?: PrismaClient };
export const db = globalDb.deploydeckDb ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 }) });
if (process.env.NODE_ENV !== "production") globalDb.deploydeckDb = db;
export { Prisma, PrismaClient } from "@prisma/client";
export { encryptValue, decryptValue } from "./secrets";
