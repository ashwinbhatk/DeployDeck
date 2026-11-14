import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isDeepStrictEqual } from "node:util";
import { containerHost } from "./containers";
export type Route = Record<string,unknown>;
const routesPath="/id/project-routes/handle/0/routes";
class CaddyError extends Error {constructor(public status:number){super(`Caddy admin returned HTTP ${status}`);}}
export class CaddyClient {
  constructor(private url=process.env.CADDY_ADMIN_URL,private socket=process.env.CADDY_ADMIN_SOCKET??"/run/caddy-admin/admin.sock") {}
  async request(method:string,path:string,data?:unknown,etag?:string):Promise<{data:unknown;etag?:string}> {
    const target=this.url?new URL(path,this.url):undefined;
    if(target&&!['http:','https:'].includes(target.protocol))throw new Error("Invalid CADDY_ADMIN_URL");
    const body=data===undefined?undefined:JSON.stringify(data);
    return new Promise((resolve,reject)=>{
      const transport=target?.protocol==='https:'?httpsRequest:httpRequest;
      const req=transport({...(target?{hostname:target.hostname,port:target.port,protocol:target.protocol}:{socketPath:this.socket}),path:target?target.pathname:path,method,
        headers:{...(body?{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}:{}),...(etag?{"If-Match":etag}:{})}},res=>{
        let raw="";res.setEncoding("utf8");
        res.on("data",chunk=>{raw+=chunk;if(raw.length>2*1024*1024)req.destroy(new Error("Caddy response too large"));});
        res.on("error",reject);res.on("end",()=>{clearTimeout(timer);if((res.statusCode??500)>=400)return reject(new CaddyError(res.statusCode!));try{resolve({data:raw?JSON.parse(raw):null,etag:res.headers.etag});}catch{reject(new Error("Invalid Caddy JSON response"));}});
      });
      const timer=setTimeout(()=>req.destroy(new Error("Caddy admin request timed out")),5000);
      req.on("error",error=>{clearTimeout(timer);reject(error);});req.end(body);
    });
  }
  async projectRoute(id:string):Promise<Route|null> {
    const result=await this.request("GET",routesPath);
    if(!Array.isArray(result.data))throw new Error("Caddy project routes are not an array");
    return result.data.find((r:Route)=>r['@id']===`dd-project-${id}`)??null;
  }
  async replace(id:string,next:Route|null,expected:Route|null) {
    for(let attempt=0;attempt<6;attempt++){
      const current=await this.request("GET",routesPath);
      if(!Array.isArray(current.data)||!current.etag)throw new Error("Caddy did not return versioned routes");
      const existing=current.data.find((r:Route)=>r['@id']===`dd-project-${id}`)??null;
      if(isDeepStrictEqual(existing,next))return;
      if(!isDeepStrictEqual(existing,expected))throw new Error("Caddy project route changed concurrently");
      const routes=current.data.filter((r:Route)=>r['@id']!==`dd-project-${id}`);if(next)routes.push(next);
      try{await this.request("PATCH",routesPath,routes,current.etag);}catch(error){if(error instanceof CaddyError&&error.status===412)continue;throw error;}
      if(!isDeepStrictEqual(await this.projectRoute(id),next))throw new Error("Caddy route verification failed");
      return;
    }
    throw new Error("Caddy route update conflicted repeatedly");
  }
}
export function routeFor(projectId:string,port:number):Route {
  const domain=process.env.BASE_DOMAIN??"localhost";
  if(!/^[a-z0-9.-]+$/i.test(domain))throw new Error("Invalid BASE_DOMAIN");
  return {'@id':`dd-project-${projectId}`,match:[{host:[`project-${projectId}.${domain}`]}],handle:[{handler:"reverse_proxy",upstreams:[{dial:`${containerHost()}:${port}`}]}],terminal:true};
}
