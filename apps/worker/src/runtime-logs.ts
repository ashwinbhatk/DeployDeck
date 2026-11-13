import Docker from "dockerode";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { BuildLogWriter } from "./logs";
export class RuntimeLogs {
  private streams = new Map<string,{stream:Readable;done:Promise<void>}>();
  constructor(private docker: Docker) {}
  async attach(id: string, containerId: string, secrets: string[]) {
    if(this.streams.has(id))return;
    const stream=await this.docker.getContainer(containerId).logs({follow:true,stdout:true,stderr:true,timestamps:false}) as Readable;
    const writers=[new BuildLogWriter(id,secrets,"runtime"),new BuildLogWriter(id,secrets,"runtime")];
    const decoders=[new StringDecoder("utf8"),new StringDecoder("utf8")];
    let stopping=false;
    const done=(async()=>{
      let pending=Buffer.alloc(0);
      try {
        for await(const chunk of stream) {
          pending=Buffer.concat([pending,Buffer.from(chunk)]);
          while(pending.length>=8) {
            const channel=pending[0],size=pending.readUInt32BE(4);
            if(![1,2].includes(channel)||pending[1]||pending[2]||pending[3]||size>1024*1024)throw new Error("Invalid Docker log frame");
            if(pending.length<8+size)break;
            await writers[channel-1].write(decoders[channel-1].write(pending.subarray(8,8+size)));
            pending=pending.subarray(8+size);
          }
        }
        if(pending.length&&!stopping)throw new Error("Truncated Docker log frame");
      }catch(error){if(!stopping)throw error;}
      finally {
        for(let i=0;i<2;i++){await writers[i].write(decoders[i].end());await writers[i].flush();}
      }
    })();
    const originalDestroy=stream.destroy.bind(stream);
    // Intentional detachment ends only this HTTP stream, never the container.
    const detach=()=>{stopping=true;originalDestroy();};
    this.streams.set(id,{stream,done});
    this.detachers.set(id,detach);
    void done.catch(()=>console.error(`Runtime log persistence stopped for ${id}`)).finally(()=>{this.streams.delete(id);this.detachers.delete(id);stream.destroy();});
  }
  private detachers=new Map<string,()=>void>();
  async stop(id: string) {const current=this.streams.get(id);this.detachers.get(id)?.();await current?.done;}
  async stopAll() {await Promise.allSettled([...this.streams.keys()].map(id=>this.stop(id)));}
}
