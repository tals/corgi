import {test,expect,spyOn} from "bun:test";
import {Server} from "./server";
function fixture(){
  const server=new Server("","","0".repeat(64));
  return {server,dispose:()=>{server.runtime.deinit();(server as any).loop.close();}};
}
test("a viewer's protocol version is checked before its request is decoded",async()=>{
  const {server,dispose}=fixture(),messages:any[]=[];
  try{const cl={protocol_version:null,queue:(value:any)=>messages.push(value)} as any;
    await server.request(cl,{op:"viewer.sync",protocol:1,viewer_protocol:4,interests:"x"});
    expect(messages).toEqual([{err:"UnsupportedViewerProtocol",viewer_protocol:3}]);
    await expect(server.request(cl,{op:"viewer.sync",protocol:1,viewer_protocol:3,interests:"x"})).rejects.toThrow("UnexpectedToken");
  }finally{dispose();}
});
test("one client's or pane's error must not end the daemon loop",async()=>{
  const {server,dispose}=fixture(),report=spyOn(console,"error").mockImplementation(()=>{}),ran:string[]=[];
  try{(server as any).enqueue(async()=>{ran.push("failed");throw Error("DisconnectedClient");});
    (server as any).enqueue(async()=>{ran.push("next client");});await(server as any).jobs;
    expect(ran).toEqual(["failed","next client"]);expect(report).toHaveBeenCalledTimes(1);
  }finally{report.mockRestore();dispose();}
});
test("attention prioritizes input within a burst and releases the next completion",()=>{
  const {server,dispose}=fixture();try{
    server.attention(true,"blocked");server.attention(true,"idle");(server as any).flushBell(2000);
    expect(server.bell_seq).toBe(1);expect(server.last_bell_kind).toBe("needs_input");expect(server.bell_kind).toBe("none");
    const actor=server.runtime.conversations.get("codex","session");actor.state.observation.completed=1n;
    server.attention(true,"idle");(server as any).flushBell(3000);expect(server.bell_seq).toBe(1);
    (server as any).flushBell(3501);expect(server.bell_seq).toBe(2);expect(server.last_bell_kind).toBe("finished");
    server.attention(true,"idle");actor.state.observation.read=1n;(server as any).flushBell(5500);expect(server.bell_seq).toBe(2);expect(server.bell).toBe(false);
  }finally{dispose();}
});
