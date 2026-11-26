import { db } from "@deploydeck/db";
import type Docker from "dockerode";
import { startContainer } from "./containers";
import { BuildLogWriter, deploymentSecrets } from "./logs";
import { waitForHealthy, failRuntime } from "./health";
import { CaddyClient } from "./caddy";
import { RuntimeLogs } from "./runtime-logs";
import { promoteDeployment, cleanupSuperseded, retainRecentImages, RoutingUncertainError } from "./routing";
export async function runDeployment(id:string,docker:Docker,caddy:CaddyClient,logs:RuntimeLogs,signal:AbortSignal) {
  const d=await db.deployment.findUniqueOrThrow({where:{id}});
  if(d.status!=="starting")return;
  let log=new BuildLogWriter(id,[],"runtime");
  let promoted=false;
  try {
    let secrets:string[];
    try{secrets=await deploymentSecrets(d.projectId);}catch{throw new Error("Unable to decrypt runtime environment");}
    log=new BuildLogWriter(id,secrets,"runtime");
    const running=await startContainer(id,docker,signal);
    log=new BuildLogWriter(id,running.secrets,"runtime");
    await logs.attach(id,running.container.id,running.secrets);
    await waitForHealthy(running.container,running.hostPort,running.healthPath,signal);
    const previous=await promoteDeployment(id,docker,caddy,signal);
    promoted=true;
    await log.write("Container healthy and route activated\n");
    await cleanupSuperseded(d.projectId,previous,docker,caddy,logs,log);
    await retainRecentImages(d.projectId,docker);
  }catch(error){
    if(promoted){await log.write("Deployment remains active; post-promotion maintenance needs retry\n");}
    else if(error instanceof RoutingUncertainError){
      // Keep both versions alive when the external routing outcome cannot be confirmed.
      await db.deployment.updateMany({where:{id,status:"starting"},data:{failureReason:log.redact(error.message)}});
      await log.write(`${error.message}\n`);
    }else{
      await failRuntime(id,docker,error instanceof Error?error.message:"Container startup failed",log);
      await logs.stop(id).catch(()=>{});
    }
  }finally{await log.flush();}
}
