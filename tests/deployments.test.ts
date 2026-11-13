import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { before, after, test, mock } from "node:test";
import { db } from "@deploydeck/db";
import { signSession } from "../apps/web/lib/security";
import { POST, GET } from "../apps/web/app/api/projects/[id]/deployments/route";
import { GET as detail } from "../apps/web/app/api/deployments/[id]/route";
process.env.SESSION_SECRET=randomBytes(32).toString("hex");process.env.APP_ORIGIN="https://deploydeck.test";
const uid=randomUUID(), other=randomUUID(), projectId=randomUUID(), sha="a".repeat(40);
let deploymentId="";
const context=(id:string)=>({params:Promise.resolve({id})});
const request=(method="GET", data?:unknown, user=uid)=>new Request("https://deploydeck.test/api/projects/test/deployments",{method,headers:{cookie:`deploydeck_session=${signSession(user)}`,origin:"https://deploydeck.test","content-type":"application/json"},...(data===undefined?{}:{body:JSON.stringify(data)})});
before(async()=>{
 await db.user.createMany({data:[uid,other].map(id=>({id,email:`${id}@test.dev`,passwordHash:"fixture"}))});
 await db.project.create({data:{id:projectId,userId:uid,name:"Deploy",repoUrl:"https://github.com/example/repo",branch:"feature/auth",port:3000}});
});
after(async()=>{mock.restoreAll();await db.deployment.deleteMany({where:{projectId}});await db.project.delete({where:{id:projectId}});await db.user.deleteMany({where:{id:{in:[uid,other]}}});await db.$disconnect();});
test("trigger checks ownership and input before GitHub calls",async()=>{
 const stub=mock.method(globalThis,"fetch",async()=>{throw new Error("Unexpected call")});
 try {
  assert.equal((await POST(request("POST",{},other),context(projectId))).status,404);
  assert.equal((await POST(request("POST",{commit_sha:"bad-sha"}),context(projectId))).status,422);
  assert.equal((await POST(new Request("https://deploydeck.test/api/projects/x/deployments",{method:"POST"}),context(projectId))).status,401);
  assert.equal(stub.mock.callCount(),0);
 }finally{stub.mock.restore();}
});
test("trigger resolves branch to an immutable SHA and atomically enqueues",async()=>{
 const stub=mock.method(globalThis,"fetch",async(url: string|URL|Request,options?:RequestInit)=>{assert(String(url).endsWith("feature%2Fauth"));assert.equal(options?.redirect,"error");return new Response(sha);});
 try {
  const response=await POST(request("POST",{}),context(projectId));assert.equal(response.status,201);
  const body=await response.json();deploymentId=body.deployment_id;assert.equal(body.status,"queued");
  const row=await db.deployment.findUniqueOrThrow({where:{id:deploymentId},include:{job:true}});assert.equal(row.commitSha,sha);assert.equal(row.job?.status,"pending");
  assert.equal((await POST(request("POST",{}),context(projectId))).status,409);assert.equal(stub.mock.callCount(),1);
 }finally{stub.mock.restore();}
});
test("history and metadata enforce ownership and expose no environment values",async()=>{
 const response=await GET(request(),context(projectId));assert.equal(response.status,200);assert.equal((await response.json()).deployments[0].id,deploymentId);
 const found=await detail(request(),context(deploymentId));assert.equal(found.status,200);const d=(await found.json()).deployment;assert.equal(d.commit_sha,sha);assert.equal(d.project_id,projectId);assert(d.project_url.includes(projectId));assert.equal(d.image_tag,null);
 assert.equal((await detail(request("GET",undefined,other),context(deploymentId))).status,404);
 assert.equal((await GET(request("GET",undefined,other),context(projectId))).status,404);
 assert.equal((await detail(request(),context("invalid"))).status,404);
});
test("concurrent triggers create exactly one deployment and one job",async()=>{
 await db.deployment.update({where:{id:deploymentId},data:{status:"failed"}});
 const stub=mock.method(globalThis,"fetch",async()=>new Response("b".repeat(40)));
 try {
  const responses=await Promise.all([POST(request("POST",{commit_sha:"bbbbbbb"}),context(projectId)),POST(request("POST",{commit_sha:"bbbbbbb"}),context(projectId))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
  const rows=await db.deployment.findMany({where:{projectId,status:"queued"},include:{job:true}});assert.equal(rows.length,1);assert.equal(rows[0].commitSha,"b".repeat(40));assert(rows[0].job);
  await db.deployment.update({where:{id:rows[0].id},data:{status:"failed"}});
 }finally{stub.mock.restore();}
});
test("unresolvable or mismatched commits create no queue rows",async()=>{
 const before=await db.deployment.count({where:{projectId}});
 const stub=mock.method(globalThis,"fetch",async()=>new Response("c".repeat(40)));
 try {assert.equal((await POST(request("POST",{commit_sha:"ddddddd"}),context(projectId))).status,422);}finally{stub.mock.restore();}
 assert.equal(await db.deployment.count({where:{projectId}}),before);
});
