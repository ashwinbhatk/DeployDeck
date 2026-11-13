import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";
import Docker from "dockerode";
import { db } from "@deploydeck/db";
import { BuildLogWriter } from "../apps/worker/src/logs";
import { buildContext, buildImage } from "../apps/worker/src/build";
import { buildPreparedDeployment } from "../apps/worker/src/pipeline";

test("build context respects Dockerignore, excludes Git metadata and never dereferences symlinks",async()=>{
 const root=await mkdtemp(join(tmpdir(),"dd-context-"));const context=join(root,"context");await mkdir(context);
 try {
  await mkdir(join(context,".git"));await mkdir(join(context,"nested"));await mkdir(join(context,"excluded"));
  await writeFile(join(context,"Dockerfile"),"FROM scratch\n");await writeFile(join(context,".dockerignore"),"secret.txt\nnested/*.key\nDockerfile\nexcluded\n!excluded/keep.txt\n");
  await writeFile(join(context,"excluded","keep.txt"),"keep");await writeFile(join(context,"excluded","hide.txt"),"exclude");
  await writeFile(join(context,"secret.txt"),"excluded");await writeFile(join(context,"nested","private.key"),"excluded");
  await writeFile(join(context,".git","config"),"excluded");await writeFile(join(root,"outside"),"NEVER_UPLOAD_HOST_CONTENT");await symlink(join(root,"outside"),join(context,"link"));
  const archive=join(root,"context.tar");await pipeline(await buildContext(context),createWriteStream(archive));
  const {stdout}=await promisify(execFile)("tar",["-tf",archive]);assert(stdout.includes("Dockerfile"));assert(!stdout.includes("secret.txt"));assert(!stdout.includes("private.key"));assert(!stdout.includes(".git/config"));assert(stdout.includes("excluded/keep.txt"));assert(!stdout.includes("excluded/hide.txt"));
  assert(!(await readFile(archive)).includes(Buffer.from("NEVER_UPLOAD_HOST_CONTENT")));
 }finally{await rm(root,{recursive:true,force:true});}
});
test("real Docker build, image verification, failure redaction and cancellation",async t=>{
 const socket=process.env.DOCKER_SOCKET??"/var/run/docker.sock";
 try {await access(socket);}catch(error){if(process.env.REQUIRE_DOCKER_TESTS==="1")throw error;t.skip("Docker socket unavailable; real build test requires Docker Engine");return;}
 const docker=new Docker({socketPath:socket,timeout:30000});await docker.ping();
 const uid=randomUUID(),pid=randomUUID();const sha="e".repeat(40),tag=`deploydeck/${pid}:${sha.slice(0,12)}`;
 await db.user.create({data:{id:uid,email:`${uid}@test.dev`,passwordHash:"fixture"}});
 await db.project.create({data:{id:pid,userId:uid,name:"Docker fixture",repoUrl:"https://github.com/example/fixture",port:3000}});
 try {
  const d=await db.deployment.create({data:{projectId:pid,commitSha:sha,status:"cloning"}});const log=new BuildLogWriter(d.id,[]);
  await buildPreparedDeployment(d,resolve("tests/fixtures/build-valid"),docker,log,new AbortController().signal);
  const row=await db.deployment.findUniqueOrThrow({where:{id:d.id}});assert.equal(row.status,"starting");assert.equal(row.imageTag,tag);assert(row.buildStartedAt);assert(row.buildFinishedAt);assert((await docker.getImage(tag).inspect()).Id.startsWith("sha256:"));
  assert(await db.deploymentLog.count({where:{deploymentId:d.id}})>0);
  // Release the Phase 3 in-flight gate only inside this disposable test fixture.
  await db.deployment.update({where:{id:d.id},data:{status:"stopped"}});
  const failed=await db.deployment.create({data:{projectId:pid,commitSha:"f".repeat(40),status:"cloning"}});const badLog=new BuildLogWriter(failed.id,["missing-sensitive-file"]);
  await assert.rejects(buildPreparedDeployment(failed,resolve("tests/fixtures/build-invalid"),docker,badLog,new AbortController().signal));await badLog.flush();
  const bad=await db.deployment.findUniqueOrThrow({where:{id:failed.id}});assert.equal(bad.status,"failed");assert(!bad.failureReason?.includes("missing-sensitive-file"));
  const logs=await db.deploymentLog.findMany({where:{deploymentId:failed.id}});assert(!logs.some(l=>l.line.includes("missing-sensitive-file")));
  await assert.rejects(buildImage(docker,resolve("tests/fixtures/build-valid"),pid,"d".repeat(40),new BuildLogWriter(failed.id,[]),new AbortController().signal,1));
 }finally{
  for(const suffix of ["e","f","d"])await docker.getImage(`deploydeck/${pid}:${suffix.repeat(12)}`).remove({force:true}).catch(()=>{});
  await db.deployment.deleteMany({where:{projectId:pid}});await db.project.delete({where:{id:pid}});await db.user.delete({where:{id:uid}});await db.$disconnect();
 }
});
