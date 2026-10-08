import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readdirSync} from "node:fs";
import {join} from "node:path";
const root=mkdtempSync("/tmp/corgi-crash-check-"),reports:string[]=[];
const server=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(request){reports.push(await request.text());return new Response("{}");}});
const options={dsn:`http://test@127.0.0.1:${server.port}/1`,database:root,version:"0.1.0-test"};
const init=`import * as crash from ${JSON.stringify(join(import.meta.dir,"src/crash.ts"))};crash.init('daemon',${JSON.stringify(options)});`;
async function child(code:string){
  const proc=Bun.spawn(["/bin/sh","-c",'ulimit -c 0; exec "$@"',"crash-check",process.execPath,"-e",init+code],{cwd:root,stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,status]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  return {status,stdout,stderr};
}
try{
  const js=await child("throw Error('synthetic JavaScript failure');");assert.notEqual(js.status,0);
  assert(readdirSync(join(root,"outbox")).some(name=>name.endsWith(".envelope")),js.stderr);
  await child("await Bun.sleep(100);await crash.uploadPending();crash.deinit();");
  assert(reports.some(report=>report.includes("synthetic JavaScript failure")));
  const before=reports.length;
  const native=await child("import {dlopen} from 'bun:ffi';const lib=dlopen(process.platform==='darwin'?'/usr/lib/libSystem.B.dylib':'libc.so.6',{abort:{args:[],returns:'void'}});lib.symbols.abort();");assert.notEqual(native.status,0);
  await child("await Bun.sleep(100);await crash.uploadPending();crash.deinit();");
  assert(reports.length>before,JSON.stringify({native,files:readdirSync(root,{recursive:true})}));
  console.log(JSON.stringify({passed:true,reports:reports.length,jsExit:js.status,nativeExit:native.status,nativeFatalSaved:true,uploadedToLocalFixture:true},null,2));
}finally{server.stop(true);rmSync(root,{recursive:true,force:true});}
