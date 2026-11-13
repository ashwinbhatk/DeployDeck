import { createProject, listProjects } from "../../../lib/projects";
export const runtime = "nodejs";
export const GET = listProjects;
export const POST = createProject;
