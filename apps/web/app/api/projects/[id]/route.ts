import { getProject, patchProject } from "../../../../lib/projects";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return getProject(request, (await context.params).id); }
export async function PATCH(request: Request, context: Context) { return patchProject(request, (await context.params).id); }
