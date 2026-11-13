import type Docker from "dockerode";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "@deploydeck/db";
import { removeContainer, containerHost } from "./containers";
import { BuildLogWriter } from "./logs";
import { transitionDeploymentStatus } from "./state";
export function startupTimeout() {
  const value=Number(process.env.STARTUP_TIMEOUT??60000);
  if(!Number.isInteger(value)||value<1||value>600000)throw new Error("STARTUP_TIMEOUT must be 1-600000 milliseconds");
  return value;
}
export async function checkHttp(url: string, signal: AbortSignal, timeout: number) {
  try {
    const response=await fetch(url,{redirect:"manual",signal:AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,timeout))])});
    await response.body?.cancel();
    return response.status>=200&&response.status<300 ? null : `health check returned HTTP ${response.status}`;
  }catch(error){
    if(signal.aborted)throw new Error("Deployment interrupted during health check");
    const code=(error as {cause?:{code?:string}}).cause?.code;
    return code==="ECONNREFUSED"?"health check connection refused":"health check timeout";
  }
}
export async function waitForHealthy(container: Docker.Container, port: number, path: string, signal: AbortSignal, timeout=startupTimeout()) {
  if(!path.startsWith("/")||path.startsWith("//")||/[\\\r\n]/.test(path))throw new Error("Invalid HTTP health-check path");
  const url=`http://${containerHost()}:${port}${path}`;
  const deadline=Date.now()+timeout;
  let reason="health check timeout";
  while(Date.now()<deadline){
    signal.throwIfAborted();
    const info=await container.inspect();
    if(!info.State.Running)throw new Error(`container exited with code ${info.State.ExitCode}`);
    if(info.State.Restarting||info.RestartCount>0)throw new Error("container is restarting");
    reason=await checkHttp(url,signal,Math.min(5000,Math.max(1,deadline-Date.now())))??"";
    if(!reason){const latest=await container.inspect();if(!latest.State.Running)throw new Error(`container exited with code ${latest.State.ExitCode}`);return;}
    await delay(Math.min(2000,Math.max(0,deadline-Date.now())),undefined,{signal});
  }
  throw new Error(reason||"health check timeout");
}
export async function failRuntime(id: string, docker: Docker, reason: string, log: BuildLogWriter) {
  const d=await db.deployment.findUniqueOrThrow({where:{id}});
  if(d.status!=="starting")return;
  let removed=true;
  if(d.containerId){try{await removeContainer(docker.getContainer(d.containerId));}catch{removed=false;}}
  const safe=log.redact(`${reason}${removed?"":"; container cleanup pending"}`).slice(0,4096);
  await db.$transaction(async tx=>{
    if(removed)await tx.deployment.updateMany({where:{id,status:"starting"},data:{containerId:null,hostPort:null}});
    await transitionDeploymentStatus(id,"starting","failed",{failureReason:safe},tx);
  });
  await log.write(`${safe}\n`);await log.flush();
}
