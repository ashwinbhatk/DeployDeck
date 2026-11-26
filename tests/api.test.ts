import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import { db } from "@deploydeck/db";
import { POST as signup } from "../apps/web/app/api/auth/signup/route";
import { POST as login } from "../apps/web/app/api/auth/login/route";
import { POST as logout } from "../apps/web/app/api/auth/logout/route";
import { GET as me } from "../apps/web/app/api/auth/me/route";
import { POST as create, GET as list } from "../apps/web/app/api/projects/route";
import { GET as detail, PATCH as patch } from "../apps/web/app/api/projects/[id]/route";
import { decryptValue, signSession } from "../apps/web/lib/security";
if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
process.env.SESSION_SECRET=randomBytes(32).toString("hex");
process.env.ENCRYPTION_KEY=randomBytes(32).toString("hex");
process.env.APP_ORIGIN="https://deploydeck.test";
const email=`${randomUUID()}@example.test`;
const password="a long test password";
const ids:string[]=[];
let cookie="",otherCookie="",projectId="";
function request(path:string, method="GET", data?:unknown, auth=cookie) {
  return new Request(`https://deploydeck.test/api/${path}`,{method,headers:{cookie:auth,"content-type":"application/json",origin:"https://deploydeck.test"},...(data===undefined?{}:{body:JSON.stringify(data)})});
}
const context=(id:string)=>({params:Promise.resolve({id})});
before(async()=>{
  const response=await signup(request("auth/signup","POST",{email,password},""));
  assert.equal(response.status,201); cookie=response.headers.get("set-cookie")!.split(";")[0];
  ids.push((await response.json()).user.id);
  const other=await signup(request("auth/signup","POST",{email:`other-${email}`,password},""));
  assert.equal(other.status,201); otherCookie=other.headers.get("set-cookie")!.split(";")[0];ids.push((await other.json()).user.id);
});
after(async()=>{
  mock.restoreAll();
  await db.project.updateMany({where:{userId:{in:ids}},data:{activeDeploymentId:null}});
  await db.deployment.deleteMany({where:{project:{userId:{in:ids}}}});
  await db.project.deleteMany({where:{userId:{in:ids}}});await db.user.deleteMany({where:{id:{in:ids}}});await db.$disconnect();
});
test("signup validates input, normalizes email, and rejects duplicate emails",async()=>{
  assert.equal((await signup(request("auth/signup","POST",{email:email.toUpperCase(),password}))).status,409);
  const response=await signup(request("auth/signup","POST",{email:"invalid",password:"short"}));assert.equal(response.status,422);assert((await response.json()).fields.email);
  const stored=await db.user.findUniqueOrThrow({where:{email}});assert.notEqual(stored.passwordHash,password);assert(stored.passwordHash.startsWith("scrypt-v1$"));
});
test("login issues a protected cookie and rejects incorrect or missing users",async()=>{
  const response=await login(request("auth/login","POST",{email,password}));assert.equal(response.status,200);
  const set=response.headers.get("set-cookie")!;for(const flag of ["HttpOnly","SameSite=Lax","Secure","Path=/","Max-Age=604800"]) assert(set.includes(flag));
  assert(!JSON.stringify(await response.json()).includes("passwordHash"));
  assert.equal((await login(request("auth/login","POST",{email,password:"wrong"}))).status,401);
  assert.equal((await login(request("auth/login","POST",{email:`missing-${email}`,password}))).status,401);
});
test("me rejects missing, tampered, expired and deleted-user sessions",async()=>{
  assert.equal((await me(request("auth/me"))).status,200);
  for(const token of ["","deploydeck_session=bad",`deploydeck_session=${signSession(ids[0],1)}`,`deploydeck_session=${signSession(randomUUID())}`]) assert.equal((await me(request("auth/me","GET",undefined,token))).status,401);
});
test("logout clears the cookie and subsequent requests without it are unauthorized",async()=>{
  const response=await logout(request("auth/logout","POST"));assert.equal(response.status,200);assert(response.headers.get("set-cookie")!.includes("Max-Age=0"));
  assert.equal((await me(request("auth/me","GET",undefined,""))).status,401);
});
test("all project routes require authentication",async()=>{
  assert.equal((await list(request("projects","GET",undefined,""))).status,401);
  assert.equal((await create(request("projects","POST",{},""))).status,401);
  assert.equal((await detail(request("projects/x","GET",undefined,""),context(randomUUID()))).status,401);
  assert.equal((await patch(request("projects/x","PATCH",{},""),context(randomUUID()))).status,401);
});
test("project input errors block outbound requests",async()=>{
  const fetchSpy=mock.method(globalThis,"fetch",async()=>{throw new Error("Unexpected network request")});
  for(const data of [{repo_url:"http://127.0.0.1/private"},{repo_url:"https://github.com@evil.test/a/b"},{port:0},{port:65536},{port:"3000"},{branch:"../main"}]) {
    const response=await create(request("projects","POST",{name:"Test",repo_url:"https://github.com/example/repo",port:3000,...data}));assert.equal(response.status,422);assert((await response.json()).fields);
  }
  assert.equal(fetchSpy.mock.callCount(),0);fetchSpy.mock.restore();
});
test("project creation encrypts values and detail returns keys only",async()=>{
  const fetchSpy=mock.method(globalThis,"fetch",async()=>new Response(null,{status:200}));
  try {
    const response=await create(request("projects","POST",{name:" Test ",repo_url:"https://github.com/example/repo",port:3000,environment_variables:{TOKEN:"super-secret",EMPTY:""}}));
    assert.equal(response.status,201);const result=await response.json();projectId=result.project.id;assert.equal(result.project.name,"Test");assert.equal(result.project.active_url,null);
    const value=await db.environmentVariable.findUniqueOrThrow({where:{projectId_key:{projectId,key:"TOKEN"}}});assert(!value.valueEncrypted.includes("super-secret"));assert.equal(decryptValue(value.valueEncrypted,`${projectId}:TOKEN`),"super-secret");
    const response2=await detail(request(`projects/${projectId}`),context(projectId));const text=await response2.text();assert(!text.includes("super-secret"));assert(!text.includes(value.valueEncrypted));assert.deepEqual(JSON.parse(text).project.environment_variables,["EMPTY","TOKEN"]);
  } finally {fetchSpy.mock.restore();}
});
test("cross-user and missing project access return the same 404",async()=>{
  for(const id of [projectId,randomUUID(),"bad-id"]){
    const res=await detail(request(`projects/${id}`,"GET",undefined,otherCookie),context(id));assert.equal(res.status,404);assert.deepEqual(await res.json(),{error:"Project not found"});
    assert.equal((await patch(request(`projects/${id}`,"PATCH",{port:4000},otherCookie),context(id))).status,404);
  }
  const response=await list(request("projects","GET",undefined,otherCookie));assert.deepEqual((await response.json()).projects,[]);
});
test("PATCH upserts, deletes and re-encrypts values without exposing them",async()=>{
  const response=await patch(request(`projects/${projectId}`,"PATCH",{branch:"feature/auth",port:4000,health_check_path:"/health",environment_variables:{TOKEN:"new-secret",EMPTY:null,NEW:"value"}}),context(projectId));assert.equal(response.status,200);assert(!(await response.text()).includes("new-secret"));
  const vars=await db.environmentVariable.findMany({where:{projectId}});assert.equal(vars.length,2);const token=vars.find(v=>v.key==="TOKEN")!;assert.equal(decryptValue(token.valueEncrypted,`${projectId}:TOKEN`),"new-secret");
  assert.equal((await patch(request(`projects/${projectId}`,"PATCH",{user_id:ids[1]},cookie),context(projectId))).status,422);
});
test("invalid encryption configuration rolls back the entire PATCH",async()=>{
  const previous=process.env.ENCRYPTION_KEY;process.env.ENCRYPTION_KEY="bad";
  try {assert.equal((await patch(request(`projects/${projectId}`,"PATCH",{port:5000,environment_variables:{TOKEN:"discard"}}),context(projectId))).status,500);}finally{process.env.ENCRYPTION_KEY=previous;}
  assert.equal((await db.project.findUniqueOrThrow({where:{id:projectId}})).port,4000);
});
test("history is newest-first and list reports the latest status and active URL",async()=>{
  const old=await db.deployment.create({data:{projectId,commitSha:"a".repeat(40),status:"healthy",createdAt:new Date("2025-01-01")}});
  const latest=await db.deployment.create({data:{projectId,commitSha:"b".repeat(40),status:"failed",createdAt:new Date("2025-01-02")}});
  await db.project.update({where:{id:projectId},data:{activeDeploymentId:old.id}});
  const projects=(await (await list(request("projects"))).json()).projects;assert.equal(projects[0].latest_deployment.id,latest.id);assert(projects[0].active_url.includes(projectId));
  const d=(await (await detail(request(`projects/${projectId}`),context(projectId))).json()).project.deployments;assert.deepEqual(d.map((v:{id:string})=>v.id),[latest.id,old.id]);
});
test("cross-origin writes and malformed JSON fail without changing data",async()=>{
  const bad=new Request("https://deploydeck.test/api/auth/logout",{method:"POST",headers:{origin:"https://evil.test",cookie}});assert.equal((await logout(bad)).status,422);
  const malformed=new Request("https://deploydeck.test/api/auth/signup",{method:"POST",headers:{"content-type":"application/json"},body:"{"});assert.equal((await signup(malformed)).status,422);
});

test("repository failures do not create a project",async()=>{
  const before=await db.project.count({where:{userId:ids[0]}});
  for(const status of [302,404,500]) {
    const stub=mock.method(globalThis,"fetch",async()=>new Response(null,{status}));
    try {const response=await create(request("projects","POST",{name:"Rejected",repo_url:"https://github.com/example/repo",port:3000}));assert.equal(response.status,422);assert((await response.json()).fields.repo_url);}finally{stub.mock.restore();}
  }
  assert.equal(await db.project.count({where:{userId:ids[0]}}),before);
});
test("oversized JSON and duplicate session cookies are rejected",async()=>{
  const response=await signup(request("auth/signup","POST",{email,password:"a".repeat(130*1024)}));assert.equal(response.status,422);
  assert.equal((await me(request("auth/me","GET",undefined,`${cookie}; ${cookie}`))).status,401);
});
test("create encryption failure leaves no project or environment rows",async()=>{
  const before=await db.project.count({where:{userId:ids[0]}});
  const stub=mock.method(globalThis,"fetch",async()=>new Response(null,{status:200}));
  const previous=process.env.ENCRYPTION_KEY;process.env.ENCRYPTION_KEY="bad";
  try {assert.equal((await create(request("projects","POST",{name:"Rejected",repo_url:"https://github.com/example/repo",port:3000,environment_variables:{TOKEN:"secret"}}))).status,500);}finally{process.env.ENCRYPTION_KEY=previous;stub.mock.restore();}
  assert.equal(await db.project.count({where:{userId:ids[0]}}),before);
});

test("project creation returns field-level 422 for disallowed repository schemes, hosts and shell punctuation", async t => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected outbound request"); });
  const valid = { name: "Validation", repo_url: "https://github.com/example/repo", port: 3000 };
  for (const [field, values] of Object.entries({
    repo_url: ["file:///fixture", "http://127.0.0.1/example/repo", "https://example.test/example/repo"],
    branch: ["feature;one", "release|two", "topic&three", "topic$four", "topic(five)"],
  })) {
    for (const value of values) {
      const response = await create(request("projects", "POST", { ...valid, [field]: value }));
      assert.equal(response.status, 422);
      assert((await response.json()).fields[field]);
    }
  }
  assert.equal(network.mock.callCount(), 0);
});
