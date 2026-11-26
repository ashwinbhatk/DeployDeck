"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge } from "../../../ui/badge";
import { send, useResource } from "../../../ui/client";
import { ProjectForm } from "../../../ui/project-form";
import { DeploymentActions, type Deployment } from "../../../ui/deployment-actions";
import { date, type Project } from "../../../ui/project-types";

type HistoryRow = Deployment & { last_log_at: string | null };
type Detail = Project & { environment_variables: string[]; deployments: HistoryRow[] };
function duration(d: HistoryRow) {
  const end = d.healthy_at ?? (d.status === "failed" ? d.last_log_at ?? d.build_finished_at : d.stopped_at);
  if (!end && ["failed", "stopped"].includes(d.status)) return "-";
  const seconds = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(d.queued_at)) / 1000));
  return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + seconds % 60 + "s";
}
export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, error, refresh } = useResource<{ project: Detail }>("/api/projects/" + id);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function deploy(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMessage("");
    const commit = String(new FormData(e.currentTarget).get("commit") ?? "").trim();
    try {
      const result = await send<{ deployment_id: string }>("/api/projects/" + id + "/deployments", commit ? { commit_sha: commit } : {});
      router.push("/deployments/" + result.deployment_id);
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  if (error) return <><Link href="/">Projects</Link><h1>{error}</h1></>;
  if (!data) return <p>Loading project...</p>;
  const p = data.project;
  return <><div><Link href="/">Projects</Link></div><header className="heading"><h1>{p.name}</h1>
    <button onClick={() => setSettings(!settings)} aria-expanded={settings}>{settings ? "Close settings" : "Project settings"}</button></header>
    <section className="panel stack"><div className="grid"><div><small>Repository</small><div><a href={p.repo_url}>{p.repo_url.slice(19)}</a></div></div>
      <div><small>Branch</small><div><code>{p.branch}</code></div></div><div><small>Container port</small><div>{p.port}</div></div>
      <div><small>Health check</small><div><code>{p.health_check_path}</code></div></div></div>
      <div><a href={p.project_url}>{p.project_url} ↗</a></div>
      <form onSubmit={deploy}><div className="row"><label>Commit SHA (optional)<input name="commit" placeholder="Latest branch commit" /></label>
        <button className="primary" disabled={busy}>{busy ? "Queuing..." : "Deploy now"}</button></div>
        {message && <p role="alert">{message}</p>}</form></section>
    {settings && <section className="panel stack"><h2>Project settings</h2><ProjectForm project={p} onSaved={() => { setSettings(false); refresh(); }} /></section>}
    <section className="panel stack"><div className="heading"><h2>Deployment history</h2><button onClick={refresh}>Refresh</button></div>
    {!p.deployments.length ? <p className="muted">No deployments yet.</p> : <div className="tablewrap"><table><thead><tr>
      {["Commit", "Status", "Duration", "Created", "Actions"].map(title => <th key={title}>{title}</th>)}</tr></thead>
      <tbody>{p.deployments.map(d => <tr key={d.id}><td><a className="mono" href={p.repo_url + "/commit/" + d.commit_sha}>{d.commit_sha.slice(0, 8)}</a>
        {d.image_tag && !d.build_started_at && <small> · Rollback</small>}</td><td><Badge status={d.status}/></td>
        <td>{duration(d)}</td><td>{date(d.created_at)}</td><td><div className="row"><Link href={"/deployments/" + d.id}>View logs</Link>
        <DeploymentActions deployment={d} active={p.active_deployment_id === d.id} onStop={refresh}/></div></td></tr>)}</tbody></table></div>}</section></>;
}
