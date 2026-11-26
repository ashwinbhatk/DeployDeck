import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";
import Docker from "dockerode";
import { db, encryptValue } from "@deploydeck/db";
import { claimNextJob, finishJob, runWorkerLoop } from "../apps/worker/src/queue";
import { transitionDeploymentStatus } from "../apps/worker/src/state";
import { BuildLogWriter, deploymentSecrets } from "../apps/worker/src/logs";
import { withWorkspace } from "../apps/worker/src/workspace";
import { buildPreparedDeployment, processClaimedJob } from "../apps/worker/src/pipeline";
process.env.ENCRYPTION_KEY=randomBytes(32).toString("hex");
const uid=randomUUID();const projectIds:string[]=[];
before(()=>db.user.create({data:{id:uid,email:`${uid}@test.dev`,passwordHash:"fixture"}}));
afterEach(async()=>{await db.deployment.deleteMany({where:{projectId:{in:projectIds}}});await db.project.deleteMany({where:{userId:uid}});projectIds.length=0;});
after(async()=>{await db.user.delete({where:{id:uid}});await db.$disconnect();});
async function fixture(repoUrl="https://github.com/example/repo") {
 const project=await db.project.create({data:{userId:uid,name:"Worker",repoUrl,port:3000}});projectIds.push(project.id);
 return db.deployment.create({data:{projectId:project.id,commitSha:"a".repeat(40),job:{create:{status:"pending"}}},include:{job:true}});
}
test("concurrent claimers never claim the same job",async()=>{
 const a=await fixture(),b=await fixture();
 const claimed=(await Promise.all(Array.from({length:8},(_,i)=>claimNextJob(`worker-${i}`)))).filter(x=>x!==null);
 assert.equal(claimed.length,2);assert.deepEqual(new Set(claimed.map(j=>j.deploymentId)),new Set([a.id,b.id]));
 assert.equal(await db.deployment.count({where:{projectId:{in:projectIds},status:"cloning"}}),2);
 for(const job of claimed) {const row=await db.deploymentJob.findUniqueOrThrow({where:{id:job.id}});assert(row.claimedAt);assert.equal(row.claimedBy,job.workerId);}
});
test("SKIP LOCKED skips a row locked by another transaction",async()=>{
 const a=await fixture();const b=await fixture();
 let release!:()=>void, entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve});const ready=new Promise<void>(resolve=>{entered=resolve});
 const lock=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM deployment_jobs WHERE id=${a.job!.id}::uuid FOR UPDATE`;entered();await gate;});
 await ready;
 try {assert.equal((await claimNextJob("second-worker"))?.deploymentId,b.id);}finally{release();await lock;}
});
test("state updates reject invalid and stale transitions",async()=>{
 const d=await fixture();await transitionDeploymentStatus(d.id,"queued","cloning");
 await assert.rejects(transitionDeploymentStatus(d.id,"queued","cloning"),/state changed/);
 await assert.rejects(transitionDeploymentStatus(d.id,"cloning","starting"),/Invalid/);
 await transitionDeploymentStatus(d.id,"cloning","failed",{failureReason:"test failure"});
 await assert.rejects(transitionDeploymentStatus(d.id,"failed","cloning"),/Invalid/);
 assert.equal((await db.deployment.findUniqueOrThrow({where:{id:d.id}})).status,"failed");
});
test("worker decrypts the same format and redacts split chunks before persistence",async()=>{
 const d=await fixture();const value="secret$.*value";
 await db.environmentVariable.create({data:{projectId:d.projectId,key:"TOKEN",valueEncrypted:encryptValue(value,`${d.projectId}:TOKEN`)}});
 const values=await deploymentSecrets(d.projectId);assert.deepEqual(values,[value]);
 const log=new BuildLogWriter(d.id,[...values,"line1\nline2",""]);
 await log.write("prefix secret$.");await log.write("*value suffix\nline1\nline2\n");await log.flush();
 const rows=await db.deploymentLog.findMany({where:{deploymentId:d.id}});const joined=rows.map(r=>r.line).join("\n");
 for(const secret of [value,"line1","line2"])assert(!joined.includes(secret));assert(joined.includes("[REDACTED]"));assert(rows.every(r=>r.phase==="build"));
});
test("missing Dockerfile fails before connecting to Docker and cleans workspace",async()=>{
 const d=await fixture();await claimNextJob("missing-file");const log=new BuildLogWriter(d.id,[]);
 const previous=await db.deployment.create({data:{projectId:d.projectId,commitSha:"b".repeat(40),status:"healthy"}});
 await db.project.update({where:{id:d.projectId},data:{activeDeploymentId:previous.id}});
 await assert.rejects(withWorkspace(d.id,async workspace=>{
  await writeFile(`${workspace}/README.md`,"No Dockerfile");
  await buildPreparedDeployment(d,workspace,new Docker({socketPath:"/nonexistent-docker.sock"}),log,new AbortController().signal);
 }),/Missing Dockerfile in repository root/);await log.flush();
 const row=await db.deployment.findUniqueOrThrow({where:{id:d.id}});assert.equal(row.status,"failed");assert.equal(row.failureReason,"Missing Dockerfile in repository root");assert.equal(row.buildStartedAt,null);
 assert.equal((await db.project.findUniqueOrThrow({where:{id:d.projectId}})).activeDeploymentId,previous.id);
 await assert.rejects(access(`/tmp/deploydeck/${d.id}`));
});
test("failed Git validation records failure, completes the job and removes workspace",async()=>{
 const d=await fixture("http://127.0.0.1/private");const abort=new AbortController();
 await runWorkerLoop("pipeline-worker",abort.signal,async job=>{await processClaimedJob(job,new Docker({socketPath:"/nonexistent-docker.sock"}),abort.signal);abort.abort();});
 const row=await db.deployment.findUniqueOrThrow({where:{id:d.id},include:{job:true}});assert.equal(row.status,"failed");assert.equal(row.job?.status,"done");await assert.rejects(access(`/tmp/deploydeck/${d.id}`));
});
test("finally completes a claimed job even when processing throws",async()=>{
 const d=await fixture();const abort=new AbortController();
 await assert.rejects(runWorkerLoop("throw-worker",abort.signal,async job=>{await transitionDeploymentStatus(job.deploymentId,"cloning","failed");throw new Error("step failed");}),/step failed/);
 assert.equal((await db.deploymentJob.findUniqueOrThrow({where:{deploymentId:d.id}})).status,"done");
 await assert.rejects(finishJob({id:d.job!.id,deploymentId:d.id,workerId:"another-worker"}),/ownership changed/);
});

test("transition guard rejects skipped phases and terminal-state resurrection", async () => {
  const id = randomUUID();
  for (const [from, to] of [["queued", "healthy"], ["failed", "starting"], ["stopped", "healthy"]] as const) {
    await assert.rejects(transitionDeploymentStatus(id, from, to), { message: "Invalid deployment transition: " + from + " -> " + to });
  }
});
