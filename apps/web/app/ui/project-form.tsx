"use client";
import { useState, type FormEvent } from "react";
import { send } from "./client";
import type { Project } from "./project-types";

type Variable = { id: number; key: string; value: string; mode: "keep" | "set" | "remove"; existing: boolean };
type Props = { project?: Project & { environment_variables: string[] }; onSaved: (id: string) => void };
export function ProjectForm({ project, onSaved }: Props) {
  const [rows, setRows] = useState<Variable[]>(() => (project?.environment_variables ?? []).map((key, id) =>
    ({ id, key, value: "", mode: "keep", existing: true })));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function edit(id: number, patch: Partial<Variable>) {
    setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row));
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const values = Object.fromEntries(new FormData(e.currentTarget));
      if (new Set(rows.map(row => row.key)).size !== rows.length) throw new Error("Each environment key must be unique.");
      const environment_variables = Object.fromEntries(rows.filter(row => row.mode !== "keep").map(row =>
        [row.key, row.mode === "remove" ? null : row.value]));
      const result = await send<{ project: Project }>(project ? "/api/projects/" + project.id : "/api/projects",
        { ...values, port: Number(values.port), environment_variables }, project ? "PATCH" : "POST");
      onSaved(result.project.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <form onSubmit={submit}>
    {!project && <><label>Project name<input name="name" required maxLength={100} /></label>
      <label>Public GitHub repository<input name="repo_url" type="url" placeholder="https://github.com/owner/repository" required /></label></>}
    <div className="grid"><label>Branch<input name="branch" defaultValue={project?.branch ?? "main"} required /></label>
      <label>Container port<input name="port" type="number" min="1" max="65535" defaultValue={project?.port ?? 3000} required /></label>
      <label>Health check path<input name="health_check_path" defaultValue={project?.health_check_path ?? "/"} required /></label></div>
    <h3>Environment variables</h3>
    {rows.map(row => <div key={row.id} className="grid">
      <label>Key<input value={row.key} readOnly={row.existing} onChange={e => edit(row.id, { key: e.target.value })} required /></label>
      {row.existing && <label>Action<select value={row.mode} onChange={e => edit(row.id, { mode: e.target.value as Variable["mode"], value: "" })}>
        <option value="keep">Keep masked value</option><option value="set">Replace value</option><option value="remove">Remove key</option></select></label>}
      {row.mode !== "remove" && <label>Value<input type="password" autoComplete="new-password" disabled={row.mode === "keep"}
        placeholder={row.mode === "keep" ? "••••••••" : ""} value={row.value} onChange={e => edit(row.id, { value: e.target.value })} /></label>}
      {!row.existing && <button type="button" onClick={() => setRows(items => items.filter(item => item.id !== row.id))}>Remove key</button>}
    </div>)}
    <div><button type="button" onClick={() => setRows(items => [...items, { id: Math.max(-1, ...items.map(v => v.id)) + 1,
      key: "", value: "", mode: "set", existing: false }])}>Add variable</button></div>
    {error && <p role="alert">{error}</p>}<div><button className="primary" disabled={busy}>{busy ? "Saving..." : project ? "Save settings" : "Create project"}</button></div>
  </form>;
}
