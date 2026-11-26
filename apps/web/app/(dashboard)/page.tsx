"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "../ui/badge";
import { useResource } from "../ui/client";
import { ProjectForm } from "../ui/project-form";
import { date, type Project } from "../ui/project-types";

export default function Home() {
  const { data, error } = useResource<{ projects: Project[] }>("/api/projects");
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  return <><div className="heading"><h1>Projects</h1><button className="primary" aria-expanded={creating}
    onClick={() => setCreating(!creating)}>{creating ? "Close form" : "New project"}</button></div>
    {creating && <section className="panel stack"><h2>New project</h2><ProjectForm onSaved={id => router.push("/projects/" + id)} /></section>}
    {error ? <p role="alert">{error}</p> : !data ? <p>Loading projects...</p> : !data.projects.length ?
      <section className="panel"><h2>No projects yet</h2><p className="muted">Create a project to deploy your first repository.</p></section> :
      <div className="grid">{data.projects.map(p => <article key={p.id} className="panel stack"><div><Badge status={p.latest_deployment?.status} /></div>
        <h2><Link href={"/projects/" + p.id}>{p.name}</Link></h2><div><a href={p.repo_url}>{p.repo_url.replace("https://github.com/", "")}</a>
        <div className="mono muted">{p.branch}</div></div>
        <div><a href={p.project_url}>Project URL ↗</a><br/><small>Created {date(p.created_at)}</small></div></article>)}</div>}</>;
}
