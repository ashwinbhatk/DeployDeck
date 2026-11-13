import { deploymentDetail } from "../../../../lib/deployments";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return deploymentDetail(request, (await context.params).id); }
