import { db } from "@deploydeck/db";
import Docker from "dockerode";
import { randomUUID } from "node:crypto";
import { runWorkerLoop } from "./queue";
import { processClaimedJob } from "./pipeline";
import { CaddyClient } from "./caddy";
import { RuntimeLogs } from "./runtime-logs";
import { runDeployment } from "./runtime";
const abort=new AbortController();
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>abort.abort());
async function main() {
  const socketPath=process.env.DOCKER_SOCKET??"/var/run/docker.sock";
  const docker=new Docker({socketPath,timeout:10000});
  const streamingDocker=new Docker({socketPath});
  const caddy=new CaddyClient();
  await db.$queryRaw`SELECT 1`;await docker.ping();await caddy.request("GET","/config/");
  if(process.argv.includes("--check"))return;
  const logs=new RuntimeLogs(streamingDocker);
  try {
    const active=await db.deployment.findMany({where:{status:"healthy",containerId:{not:null}}});
    for(const d of active){
      const info=await docker.getContainer(d.containerId!).inspect();
      if(info.State.Running)await logs.attach(d.id,d.containerId!,info.Config.Env.map(v=>v.slice(v.indexOf("=")+1)));
    }
    console.info("Worker ready to build and start deployments.");
    await runWorkerLoop(randomUUID(),abort.signal,job=>processClaimedJob(job,streamingDocker,abort.signal,id=>runDeployment(id,docker,caddy,logs,abort.signal)));
  }finally{await logs.stopAll();}
}
main().catch(()=>{console.error("Worker failed: verify database, Docker, and Caddy connectivity.");process.exitCode=1;}).finally(()=>db.$disconnect());
