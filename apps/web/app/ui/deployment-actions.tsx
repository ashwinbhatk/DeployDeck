"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { send } from "./client";

export type Deployment = {
  id: string; status: string; image_tag: string | null; commit_sha: string; created_at: string;
  queued_at: string; build_started_at: string | null; build_finished_at: string | null;
  started_at: string | null; healthy_at: string | null; stopped_at: string | null;
};
export function DeploymentActions({ deployment: d, active, onStop }: { deployment: Deployment; active: boolean; onStop: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(action: "rollback" | "stop") {
    setError(""); setBusy(true);
    try {
      const result = await send<{ deployment_id: string }>("/api/deployments/" + d.id + "/" + action);
      if (action === "rollback") router.push("/deployments/" + result.deployment_id);
      else onStop();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>{(d.status === "healthy" || d.status === "stopped") && d.healthy_at && d.image_tag &&
    <button disabled={busy} onClick={() => act("rollback")}>Rollback</button>}
    {active && d.status === "healthy" && <button disabled={busy} onClick={() => act("stop")}>Stop container</button>}
    {error && <span role="alert">{error}</span>}</>;
}
