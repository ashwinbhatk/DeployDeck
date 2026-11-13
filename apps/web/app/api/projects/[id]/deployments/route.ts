import { deploymentHistory, triggerDeployment } from "../../../../../lib/deployments";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) { return triggerDeployment(request, (await context.params).id); }
export async function GET(request: Request, context: Context) { return deploymentHistory(request, (await context.params).id); }
