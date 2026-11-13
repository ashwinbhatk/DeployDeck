import { db, decryptValue } from "@deploydeck/db";
export async function deploymentSecrets(projectId: string) {
  const rows = await db.environmentVariable.findMany({ where: { projectId } });
  return rows.map(row => decryptValue(row.valueEncrypted, `${projectId}:${row.key}`));
}
export function createRedactor(values: string[]) {
  const secrets = [...new Set(values.flatMap(value => [value, ...value.split(/\r?\n/)])).values()].filter(Boolean).sort((a,b) => b.length-a.length);
  if (!secrets.length) return (value: string) => value;
  const pattern = new RegExp(secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (value: string) => value.replace(pattern, "[REDACTED]");
}
export class BuildLogWriter {
  private pending = "";
  readonly redact: (text: string) => string;
  constructor(private deploymentId: string, values: string[]) { this.redact = createRedactor(values); }
  async write(text: string) {
    this.pending += text;
    if (this.pending.length > 1024 * 1024) { this.pending = ""; throw new Error("Build output line exceeded 1 MiB limit"); }
    let index: number;
    while ((index = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0,index).replace(/\r$/, "");
      this.pending = this.pending.slice(index+1);
      await this.persist(line);
    }
  }
  private async persist(line: string) {
    await db.deploymentLog.create({ data: { deploymentId: this.deploymentId, phase: "build", line: this.redact(line) } });
  }
  async flush() { if (this.pending) { const line=this.pending; this.pending=""; await this.persist(line); } }
}
