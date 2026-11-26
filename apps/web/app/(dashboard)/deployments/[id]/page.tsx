"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../../../ui/badge";
import { useResource } from "../../../ui/client";
import { DeploymentActions, type Deployment } from "../../../ui/deployment-actions";
import { date } from "../../../ui/project-types";

type Metadata = Deployment & { project_id: string; failure_reason: string | null; host_port: number | null; project_url: string };
type Status = { status: string; failure_reason: string | null; active_url: string | null };
type Line = { id: string; phase: "build" | "runtime"; ts: string; line: string };
const phases = { all: "All logs", build: "Build logs", runtime: "Runtime logs" } as const;
const steps = { queued_at: "Queued", build_started_at: "Build started", build_finished_at: "Build finished",
  started_at: "Container started", healthy_at: "Healthy", stopped_at: "Stopped" } as const;

function Viewer({ id }: { id: string }) {
  const { data, error, refresh } = useResource<{ deployment: Metadata }>("/api/deployments/" + id);
  const [live, setLive] = useState<Status>();
  const [lines, setLines] = useState<Line[]>([]);
  const [phase, setPhase] = useState<keyof typeof phases>("all");
  const [auto, setAuto] = useState(true);
  const [connection, setConnection] = useState("Connecting");
  const [copyMessage, setCopyMessage] = useState("");
  const pane = useRef<HTMLDivElement>(null);
  const loaded = !!data;
  useEffect(() => {
    if (!loaded) return;
    const source = new EventSource("/api/deployments/" + id + "/logs");
    const seen = new Set<string>();
    const pending: Line[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending.splice(0);
      if (batch.length) setLines(current => current.concat(batch));
    };
    source.onopen = () => setConnection("Connected");
    source.onerror = () => setConnection("Reconnecting");
    source.addEventListener("log", event => {
      const line: Line = JSON.parse(event.data);
      if (seen.has(line.id)) return;
      seen.add(line.id); pending.push(line);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    source.addEventListener("status", event => { setLive(JSON.parse(event.data)); refresh(); });
    source.addEventListener("done", () => { source.close(); setConnection("Complete"); });
    return () => { source.close(); cancelAnimationFrame(frame); };
  }, [id, loaded, refresh]);
  useEffect(() => { if (auto && pane.current) pane.current.scrollTop = pane.current.scrollHeight; }, [lines, phase, auto]);
  if (error) return <><Link href="/">Projects</Link><h1>{error}</h1></>;
  if (!data) return <p>Loading deployment...</p>;
  const d = data.deployment;
  const status = live?.status ?? d.status;
  const visible = phase === "all" ? lines : lines.filter(line => line.phase === phase);
  async function copy() {
    try { await navigator.clipboard.writeText(visible.map(l => l.ts + " [" + l.phase + "] " + l.line).join("\n")); setCopyMessage("Logs copied"); }
    catch { setCopyMessage("Clipboard unavailable. Select and copy the log text."); }
  }
  return <><div><Link href={"/projects/" + d.project_id}>Back to project</Link></div>
    <header className="heading"><h1>Deployment <code>{d.commit_sha.slice(0, 8)}</code></h1><Badge status={status}/></header>
    {status === "failed" && <p role="alert">{live?.failure_reason ?? d.failure_reason ?? "Deployment failed"}</p>}
    <section className="panel stack"><div className="grid"><div><small>Commit</small><div><code>{d.commit_sha}</code></div></div>
      <div><small>Image tag</small><div><code>{d.image_tag ?? "-"}</code></div></div><div><small>Host port</small><div>{d.host_port ?? "-"}</div></div></div>
      <div className="grid">{(Object.keys(steps) as (keyof typeof steps)[]).map(key =>
        <div key={key}><small>{steps[key]}</small><div>{date(d[key])}</div></div>)}</div>
      <div className="row">{live?.active_url && <a href={live.active_url}>Open live project ↗</a>}
      <DeploymentActions deployment={{ ...d, status }} active={!!live?.active_url} onStop={refresh}/></div></section>
    <section className="panel stack"><div className="heading"><h2>Deployment logs</h2><small role="status">{connection}</small></div>
      <div className="heading"><div className="row">{(Object.keys(phases) as (keyof typeof phases)[]).map(key =>
        <button key={key} aria-pressed={phase === key} onClick={() => { setPhase(key); setCopyMessage(""); }}>{phases[key]}</button>)}</div>
        <div className="row"><label className="row"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />Auto-scroll</label>
        <button disabled={!visible.length} onClick={copy}>Copy logs</button></div></div>
      {copyMessage && <small role="status">{copyMessage}</small>}
      <div className="console" ref={pane} tabIndex={0} aria-label="Deployment log output">
        {!visible.length && <p className="muted">No {phase === "all" ? "" : phase + " "}logs yet.</p>}
        {visible.map(line => <div key={line.id} className="logline"><time title={date(line.ts)}>{new Date(line.ts).toLocaleTimeString()}</time>
          <span className="phase">{line.phase}</span><code>{line.line}</code></div>)}</div></section></>;
}
export default function DeploymentDetail() {
  const { id } = useParams<{ id: string }>();
  return <Viewer key={id} id={id} />;
}
