import Docker from "dockerode";
import { db, decryptValue } from "@deploydeck/db";
export const PORT_MIN = 20000, PORT_MAX = 29999;
export const containerHost = () => process.env.CONTAINER_HOST ?? "host.docker.internal";
export function isDockerError(error: unknown, code: number) { return (error as {statusCode?:number})?.statusCode === code; }
export async function removeContainer(container: Docker.Container) {
  try { await container.stop({ t: 5 }); } catch (error) { if (!isDockerError(error,304) && !isDockerError(error,404)) throw error; }
  try { await container.remove({ force: true, v: true }); } catch (error) { if (!isDockerError(error,404)) throw error; }
}
// This trusted utility runs in the Docker host's network namespace, never in an app image.
const probeScript = `const net=require('node:net');const used=new Set(JSON.parse(process.env.USED_PORTS));
(async()=>{for(let p=20000;p<=29999;p++){if(used.has(p))continue;const s=net.createServer();const free=await new Promise(r=>{s.once('error',()=>r(false));s.listen({port:p,host:'0.0.0.0',exclusive:true},()=>r(true));});if(free){await new Promise(r=>s.close(r));console.log(String(p));return;}}process.exit(2);})().catch(()=>process.exit(3));`;
export async function probeHostPort(docker: Docker, excluded: number[]) {
  const probe = await docker.createContainer({ Image: process.env.PORT_PROBE_IMAGE ?? "node:22-bookworm-slim", Cmd: ["node","-e",probeScript],
    Env: [`USED_PORTS=${JSON.stringify(excluded)}`], User: "1000:1000", Tty: true, Labels: { "deploydeck.role": "port-probe" },
    HostConfig: { NetworkMode: "host", Memory: 64*1024*1024, NanoCpus: 100_000_000, PidsLimit:32, Privileged:false, Binds:[], CapDrop:["ALL"], SecurityOpt:["no-new-privileges"], ReadonlyRootfs:true } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await probe.start();
    const result = await Promise.race([probe.wait(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Host port probe timed out")),15000);})]);
    if (result.StatusCode !== 0) throw new Error("No available host port in 20000-29999");
    const output = await probe.logs({ stdout:true, stderr:false, follow:false });
    const port = Number(output.toString().trim());
    if (!Number.isInteger(port) || port<PORT_MIN || port>PORT_MAX || excluded.includes(port)) throw new Error("Invalid host port probe result");
    return port;
  } finally { clearTimeout(timer); await probe.remove({force:true,v:true}).catch(error=>{if(!isDockerError(error,404))throw error;}); }
}
export async function ensureProjectNetwork(docker: Docker, projectId: string) {
  const name=`dd-net-${projectId}`;
  try {
    const found=await docker.getNetwork(name).inspect();
    if(found.Labels?.["deploydeck.project"]!==projectId || found.Driver!=="bridge")throw new Error("Project network ownership mismatch");
  }catch(error){
    if(!isDockerError(error,404))throw error;
    try {await docker.createNetwork({Name:name,Driver:"bridge",CheckDuplicate:true,Labels:{"deploydeck.project":projectId}});}
    catch(createError){if(!isDockerError(createError,409))throw createError;const found=await docker.getNetwork(name).inspect();if(found.Labels?.["deploydeck.project"]!==projectId)throw new Error("Project network ownership mismatch");}
  }
  return name;
}
export async function startContainer(deploymentId: string, docker: Docker, signal: AbortSignal) {
  let candidate: Docker.Container | undefined;
  let reservedPort: number | undefined;
  try {
    return await db.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(143832, 1)`;
      await tx.$queryRaw`SELECT id FROM deployments WHERE id=${deploymentId}::uuid FOR UPDATE`;
      const d=await tx.deployment.findUniqueOrThrow({where:{id:deploymentId},include:{project:{include:{environmentVariables:true}}}});
      if(d.status!=="starting" || !d.imageTag || d.containerId)throw new Error("Deployment is not ready for container creation");
      const env=d.project.environmentVariables.map(v=>`${v.key}=${decryptValue(v.valueEncrypted,`${d.projectId}:${v.key}`)}`);
      const secrets=env.map(v=>v.slice(v.indexOf("=")+1));
      const network=await ensureProjectNetwork(docker,d.projectId);
      const assigned=await tx.deployment.findMany({where:{hostPort:{not:null},OR:[{status:{in:["starting","healthy","stopping"]}},{containerId:{not:null}}]},select:{hostPort:true}});
      const existing=await docker.listContainers({all:true});
      const used=new Set([...assigned.map(r=>r.hostPort!),...existing.flatMap(c=>(c.Ports ?? []).map(p=>p.PublicPort).filter((p):p is number=>!!p))]);
      for(let attempt=0;attempt<5;attempt++) {
        signal.throwIfAborted();
        const port=await probeHostPort(docker,[...used]);used.add(port);reservedPort=port;
        await tx.deployment.updateMany({where:{id:d.id,status:"starting"},data:{hostPort:port}});
        candidate=await docker.createContainer({name:`dd-${d.id}`,Image:d.imageTag,Env:env,Tty:false,ExposedPorts:{[`${d.project.port}/tcp`]:{}},
          Labels:{"deploydeck.project":d.projectId,"deploydeck.deployment":d.id},
          HostConfig:{NetworkMode:network,PortBindings:{[`${d.project.port}/tcp`]:[{HostIp:"0.0.0.0",HostPort:String(port)}]},
            Memory:256*1024*1024,NanoCpus:500_000_000,PidsLimit:128,Privileged:false,Binds:[],CapDrop:["ALL"],SecurityOpt:["no-new-privileges"],RestartPolicy:{Name:"no"},LogConfig:{Type:"json-file",Config:{"max-size":"10m","max-file":"3"}}}});
        await tx.deployment.updateMany({where:{id:d.id,status:"starting"},data:{containerId:candidate.id}});
        try {await candidate.start();signal.throwIfAborted();}
        catch(error){await removeContainer(candidate);candidate=undefined;await tx.deployment.updateMany({where:{id:d.id,status:"starting"},data:{containerId:null,hostPort:null}});
          if(/port is already allocated|address already in use|failed to bind host port/i.test(String((error as Error).message)))continue;
          throw error;
        }
        const info=await candidate.inspect();
        if(!info.State.Running)throw new Error(`container exited with code ${info.State.ExitCode}`);
        if(info.NetworkSettings.Ports[`${d.project.port}/tcp`]?.[0]?.HostPort!==String(port))throw new Error("Docker published an unexpected port");
        await tx.deployment.updateMany({where:{id:d.id,status:"starting"},data:{containerId:candidate.id,hostPort:port,startedAt:new Date(info.State.StartedAt)}});
        return {container:candidate,hostPort:port,secrets,projectId:d.projectId,healthPath:d.project.healthCheckPath};
      }
      throw new Error("Host port allocation conflicted repeatedly");
    },{timeout:120000,maxWait:120000});
  } catch(error) {
    if(candidate) {
      try {await removeContainer(candidate);}
      catch {
        // Retain ownership metadata if Docker cleanup failed after transaction rollback.
        await db.deployment.updateMany({where:{id:deploymentId,status:"starting"},data:{containerId:candidate.id,hostPort:reservedPort}});
      }
    }
    throw error;
  }
}
