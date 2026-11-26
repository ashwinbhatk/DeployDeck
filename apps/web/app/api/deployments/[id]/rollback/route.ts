import { rollbackDeployment } from "../../../../../lib/deployments";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return rollbackDeployment(request, (await context.params).id);
}
