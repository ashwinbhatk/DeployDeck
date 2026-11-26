export type Project = {
  id: string; name: string; repo_url: string; branch: string; port: number; health_check_path: string;
  active_deployment_id: string | null; created_at: string; active_url: string | null; project_url: string;
  latest_deployment?: { status: string; created_at: string } | null;
};
export function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "-";
}
