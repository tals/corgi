import {Runtime} from "./tests/runtime";
import {readFileSync} from "node:fs";
const runtime=new Runtime();
try{
  await runtime.setUp();
  const first=(await runtime.session()).workspaces[0].id;
  await runtime.command("pane.create",{workspace:first,cwd:runtime.temp.name,command:"/bin/sleep 300"});
  const second=await runtime.command("workspace.create",{name:"second",cwd:runtime.temp.name});
  console.log(JSON.stringify({first,second}));
  for(let i=0;i<10;i++){
    const {resources,panes}=await runtime.session();console.log(JSON.stringify({at:i,resources,panes:panes.map((p:any)=>({id:p.id,pid:p.pid,exited:p.exited}))}));await Bun.sleep(1000);
  }
  console.log(readFileSync(runtime.temp.name+"/server.log","utf8"));
}finally{await runtime.tearDown();}
