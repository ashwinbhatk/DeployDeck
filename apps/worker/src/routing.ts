import { db } from "@deploydeck/db";
import type Docker from "dockerode";
import { CaddyClient, routeFor, type Route } from "./caddy";
import { transitionDeploymentStatus } from "./state";
import { checkHttp } from "./health";
import { containerHost, isDockerError } from "./containers";
import { completeStop } from "./stop";
import type { RuntimeLogs } from "./runtime-logs";
import type { BuildLogWriter } from "./logs";
export class RoutingUncertainError extends Error {}
export async function promoteDeployment(id:string,docker:Docker,caddy:CaddyClient,signal:AbortSignal) {
  let previous:Route|null=null,next:Route|null=null,projectId="",attempted=false;
  let priorIds:string[]=[];
  try {
    return await db.$transaction(async tx=>{
      const d=await tx.deployment.findUniqueOrThrow({where:{id},include:{project:true}});projectId=d.projectId;
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
      if(d.status!=="starting"||!d.containerId||!d.hostPort)throw new Error("Deployment is not ready for promotion");
      const info=await docker.getContainer(d.containerId).inspect();
      if(!info.State.Running)throw new Error(`container exited with code ${info.State.ExitCode}`);
      const reason=await checkHttp(`http://${containerHost()}:${d.hostPort}${d.project.healthCheckPath}`,signal,5000);if(reason)throw new Error(reason);
      previous=await caddy.projectRoute(projectId);next=routeFor(projectId,d.hostPort);
      priorIds=(await tx.deployment.findMany({where:{projectId,status:"healthy",id:{not:id}},select:{id:true}})).map(r=>r.id);
      await transitionDeploymentStatus(id,"starting","healthy",{healthyAt:new Date()},tx);
      attempted=true;
      await caddy.replace(projectId,next,previous);
      await tx.project.update({where:{id:projectId},data:{activeDeploymentId:id}});
      return priorIds;
    },{timeout:90000,maxWait:90000});
  }catch(error){
    if(!attempted)throw error;
    // A commit response can be lost after PostgreSQL committed. Check before compensating.
    try {const d=await db.deployment.findUnique({where:{id},include:{project:true}});if(d?.status==="healthy"&&d.project.activeDeploymentId===id)return priorIds;}
    catch{throw new RoutingUncertainError("Routing outcome uncertain; database confirmation unavailable");}
    try {await caddy.replace(projectId,previous,next);}
    catch{throw new RoutingUncertainError("Routing outcome uncertain; candidate kept running for recovery");}
    throw error;
  }
}
export async function cleanupSuperseded(projectId:string,priorIds:string[],docker:Docker,caddy:CaddyClient,logs:RuntimeLogs,log:BuildLogWriter) {
  for(const id of priorIds){
    try {
      const d=await db.$transaction(async tx=>{
        await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
        const p=await tx.project.findUniqueOrThrow({where:{id:projectId}});
        if(p.activeDeploymentId===id)return null;
        const old=await tx.deployment.findFirst({where:{id,projectId,status:{in:["healthy","stopping"]}}});if(!old)return null;
        if(old.status==="healthy")await transitionDeploymentStatus(id,"healthy","stopping",{},tx);
        return old;
      });
      if(!d)continue;
      await completeStop(id,projectId,docker,caddy,logs);
    }catch{await log.write(`Superseded container cleanup pending for ${id}\n`);}
  }
}
export async function retainRecentImages(projectId:string,docker:Docker) {
  await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
    if(await tx.deployment.count({where:{projectId,status:{in:["queued","cloning","building","starting"]}}}))return;
    const rows=await tx.deployment.findMany({where:{projectId,healthyAt:{not:null},imageTag:{not:null}},orderBy:{healthyAt:"desc"},select:{imageTag:true,containerId:true}});
    const tags=[...new Set(rows.map(r=>r.imageTag!))],keep=new Set(tags.slice(0,5));
    const live=await tx.deployment.findMany({where:{projectId,containerId:{not:null}},select:{imageTag:true}});for(const row of live)if(row.imageTag)keep.add(row.imageTag);
    for(const tag of tags.filter(t=>!keep.has(t)).slice(0,20)) {
      try{await docker.getImage(tag).remove({force:false});}catch(error){if(!isDockerError(error,404)&&!isDockerError(error,409))throw error;}
    }
  },{timeout:90000,maxWait:90000});
}
