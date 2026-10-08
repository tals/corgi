import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { atomicWrite, quote } from "./os";
import { flock } from "./native_bridge";
import * as rpc from "./rpc";
import { path as recoveryPath } from "./persist/recovery";
import { testBuild } from "./build_assets";
import * as config from "./build_config";
import * as json from "./json";
export const abi="1-a826bd22ebcdbe60";
export const platform=process.platform==="darwin"?"macos-aarch64":"linux-x86_64";
export type Release={version:string;commit:string;feed_url:string;public_key:string;test_mode:boolean};
type Target={url:string;sha256:string;size:number};
type Manifest={schema_version:number;version:string;commit:string;update_abi:string;targets:Record<string,Target>};
export function release(exe:string):Release {
  const r={version:config.releaseVersion,commit:config.releaseCommit,feed_url:config.updateURL,public_key:config.updatePublicKey,test_mode:false};
  if(testBuild){if(basename(dirname(dirname(exe)))==="releases")r.version=basename(dirname(exe));
    if(process.env.CORGI_TEST_UPDATE_URL){r.feed_url=process.env.CORGI_TEST_UPDATE_URL;r.test_mode=true;}r.public_key=process.env.CORGI_TEST_UPDATE_KEY??"";}
  return r;
}
export function version(value:string):number[] {
  const stamp=/^(\d{8})T(\d{6})Z-([a-f0-9]{7,40})$/.exec(value);if(stamp)return [Number(stamp[1]),Number(stamp[2]),0];
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw Error("InvalidReleaseVersion");
  const numbers=value.split(".").map(Number);if(numbers.some(n=>!Number.isSafeInteger(n)))throw Error("InvalidReleaseVersion");return numbers;
}
const compare=(a:string,b:string)=>{const x=version(a),y=version(b);return Math.sign(x[0]-y[0]||x[1]-y[1]||x[2]-y[2]);};
const read=(root:string,name:string):string|null=>{try{const bytes=readFileSync(join(root,name));if(bytes.length>1024*1024)throw Error("FileTooBig");return bytes.toString();}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}};
const write=(root:string,name:string,value:string)=>atomicWrite(join(root,name),value);
const remove=(root:string,name:string)=>{try{unlinkSync(join(root,name));}catch{}};
function privateDirectory(path:string){mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);if(!stat.isDirectory()||stat.uid!==(process.getuid?.()??stat.uid))throw Error("UnsafeDirectory");chmodSync(path,0o700);}
function executable(root:string,v:string){version(v);return join(root,"releases",v,"corgi");}
export function managed(rel:Release,exe:string):string|null {
  if(!rel.feed_url||rel.public_key.length!==64||basename(dirname(dirname(exe)))!=="releases"||basename(dirname(exe))!==rel.version)return null;
  const root=dirname(dirname(dirname(exe)));if(read(root,"current")===null)return null;privateDirectory(root);return root;
}
export function stagedVersion(rel:Release,exe:string):string|null {try{const root=managed(rel,exe),v=root&&read(root,"staged");return v&&compare(v,rel.version)>0?v:null;}catch{return null;}}
async function lock(root:string,name:string,wait:boolean):Promise<(()=>void)|null> {
  const fd=openSync(join(root,name),"a",0o600);while(!flock(fd)){if(!wait){closeSync(fd);return null;}await Bun.sleep(20);}return ()=>{flock(fd,false);closeSync(fd);};
}
export function parse(rel:Release,bytes:string):Manifest {
  const envelope=record(json.parse(bytes),["payload","signature"]);
  string(envelope,"payload");string(envelope,"signature");
  if(!/^[a-fA-F0-9]{64}$/.test(rel.public_key)||typeof envelope.signature!=="string"||!/^[a-fA-F0-9]{128}$/.test(envelope.signature))throw Error("BadUpdateSignature");
  const key=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),Buffer.from(rel.public_key,"hex")]),format:"der",type:"spki"});
  if(!verify(null,Buffer.from(envelope.payload),key,Buffer.from(envelope.signature,"hex")))throw Error("SignatureVerificationFailed");
  const m=record(json.parse(envelope.payload),["schema_version","version","commit","update_abi","targets"]);
  integer(m,"schema_version",32);
  for(const field of ["version","commit","update_abi"])string(m,field);
  const targets=record(m.targets,["macos-aarch64","linux-x86_64"]);
  for(const platform of ["macos-aarch64","linux-x86_64"]){
    const target=record(targets[platform],["url","sha256","size"]);
    string(target,"url");string(target,"sha256");integer(target,"size",64);
  }
  if(m.schema_version!==1)throw Error("UnknownUpdateSchema");version(m.version);
  const t=m.targets?.[platform];if(!t||!Number.isSafeInteger(t.size)||t.size<=0||t.size>256*1024*1024||typeof t.sha256!=="string"||t.sha256.length!==64)throw Error("InvalidUpdateTarget");
  secure(rel,t.url);return m as Manifest;
}
function record(value: unknown, fields: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("UnexpectedToken");
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw Error("UnknownField");
  for (const key of fields) if (!Object.hasOwn(value, key)) throw Error("MissingField");
  return value as Record<string, any>;
}
function string(value: Record<string, any>, key: string): void {
  if (typeof value[key] !== "string") throw Error("UnexpectedToken");
}
function integer(value: Record<string, any>, key: string, bits: number): void {
  const item = value[key];
  if (typeof item !== "bigint" && (typeof item !== "number" || !Number.isInteger(item))) throw Error("UnexpectedToken");
  if (item < 0 || BigInt(item) >= (1n << BigInt(bits))) throw Error("Overflow");
}
function secure(rel:Release,url:string){if(!url.startsWith("https://")&&!(rel.test_mode&&url.startsWith("http://127.0.0.1:")))throw Error("InsecureUpdateURL");}
async function fetchBytes(rel:Release,url:string,limit:number):Promise<Buffer> {
  for(let redirect=0;redirect<10;redirect++){
    secure(rel,url);const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(300000)});
    if([301,302,303,307,308].includes(response.status)){const next=response.headers.get("location");if(!next)throw Error("UpdateSubprocessFailed");url=new URL(next,url).href;continue;}
    if(!response.ok||!response.body)throw Error("UpdateSubprocessFailed");
    if(Number(response.headers.get("content-length"))>limit)throw Error("FileTooBig");
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit)throw Error("FileTooBig");chunks.push(chunk.value);}}finally{await reader.cancel();}
    return Buffer.concat(chunks);
  }
  throw Error("UpdateSubprocessFailed");
}
function verifyFile(path:string,t:Target){const bytes=readFileSync(path);if(bytes.length!==t.size||createHash("sha256").update(bytes).digest("hex")!==t.sha256)throw Error("UpdateChecksumMismatch");}
async function feed(rel:Release,root:string,download:boolean,explicit:boolean):Promise<void> {
  const unlock=await lock(root,"download.lock",explicit);if(!unlock)return;
  try {
    const bytes=(await fetchBytes(rel,`${rel.feed_url}/channels/stable.json`,1024*1024)).toString(),m=parse(rel,bytes),current=read(root,"current");
    if(!current)throw Error("MissingInstalledVersion");if(compare(m.version,current)<=0){if(explicit)console.log("Corgi is up to date.");return;}
    const suppressed=read(root,"suppressed");if(!explicit&&suppressed&&compare(m.version,suppressed)<=0)return;
    if(explicit)console.error(`Corgi ${m.version} is available.${download?" Downloading…":""}`);if(!download)return;
    const dest=executable(root,m.version),dir=dirname(dest);privateDirectory(dir);
    try{verifyFile(dest,m.targets[platform]);}catch{
      const partial=join(dir,"download.tmp");try{atomicWrite(partial,await fetchBytes(rel,m.targets[platform].url,m.targets[platform].size),0o700);verifyFile(partial,m.targets[platform]);
        if(existsSync(dest))throw Error("ExistingReleaseDiffers");renameSync(partial,dest);}finally{remove(dir,"download.tmp");}
    }
    write(dir,"manifest.json",bytes);write(root,"staged",m.version);remove(root,"last-error");
  }finally{unlock();}
}
async function hello(socket:string):Promise<any|null>{try{return await rpc.request(socket,"hello");}catch(error){if(["ENOENT","ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code??""))return null;throw error;}}
function switchCurrent(root:string,v:string){const old=read(root,"current");if(old===null)throw Error("MissingInstalledVersion");if(old!==v){write(root,"previous",old);write(root,"current",v);}if(read(root,"staged")===v)remove(root,"staged");}
function recordError(root:string,error:unknown){try{write(root,"last-error",error instanceof Error?error.message:String(error));}catch{}}
async function activate(root:string,socket:string,v:string,target:string,live:boolean){
  if(live)try{await rpc.request(socket,"server.reload",{executable:target});}catch(error){if((await hello(socket))?.executable!==target)throw error;}
  else{const p=Bun.spawn([target,"__update-start"],{env:{...process.env,CORGI_APP_EXE:target},stdin:"ignore",stdout:"ignore",stderr:"inherit"});if(await p.exited)throw Error("UpdateSubprocessFailed");}
  const h=await hello(socket);if(!h)throw Error("UpdateRuntimeNotReady");if(h.executable!==target)throw Error("UpdateRuntimeChanged");switchCurrent(root,v);
}
async function confirmRestart(socket:string):Promise<boolean|null>{
  if(!process.stdin.isTTY||!process.stderr.isTTY||process.env.CORGI_PANE!==undefined)return null;
  await rpc.request(socket,"session.snapshot");
  process.stderr.write("\n /ᐠ•ᴥ•ᐟ\\  An update is ready, but this session could not be moved safely.\n\nRestarting will stop ALL shells and agents in this runtime and disconnect\nits other viewers. Saved layout and output can be restored; running processes\nwill not survive.\n\nEnter / Esc: keep working     r: restart and update… ");
  const raw=process.stdin.isRaw;process.stdin.setRawMode(true);process.stdin.resume();
  const restore=()=>{process.stdin.setRawMode(raw);process.stdin.pause();};
  const cancel=()=>{restore();process.exit(130);};for(const sig of ["SIGINT","SIGTERM","SIGHUP"] as const)process.once(sig,cancel);
  let key:Buffer;try{key=await new Promise(resolve=>process.stdin.once("data",resolve));}finally{restore();for(const sig of ["SIGINT","SIGTERM","SIGHUP"] as const)process.off(sig,cancel);}
  process.stderr.write("\n");if(key.toString()!=="r")return false;
  process.stderr.write("Type restart to stop these processes and update: ");process.stdin.resume();const answer=await new Promise<string>(resolve=>process.stdin.once("data",b=>resolve(b.toString())));process.stdin.pause();return answer.trim()==="restart";
}
async function select(rel:Release,root:string,socket:string,allow:boolean,explicit:boolean,rollback:boolean):Promise<string>{
  const unlock=await lock(root,"activation.lock",explicit);try{
    let h=await hello(socket);const current=read(root,"current");if(current===null)throw Error("MissingInstalledVersion");
    if(h&&!h.executable)throw Error("RuntimeDoesNotSupportUpdates");const old=h?.executable||executable(root,current);if(!allow||!unlock)return old;
    const candidate=read(root,rollback?"previous":"staged")??(rollback?null:current);if(candidate===null)return old;if(!rollback&&compare(candidate,current)<0)return old;
    const target=executable(root,candidate);if(target===old){switchCurrent(root,candidate);return old;}
    const bytes=read(dirname(target),"manifest.json");if(bytes===null)throw Error("MissingReleaseManifest");const m=parse(rel,bytes);if(m.version!==candidate)throw Error("WrongReleaseManifest");verifyFile(target,m.targets[platform]);
    if(h&&!(h.server_pid>0))throw Error("UpdateRuntimeChanged");
    const deferred=h?`deferred-${Bun.hash.wyhash(socket,0n).toString(16)}-${h.server_pid}`:null;
    if(!explicit&&deferred&&read(root,deferred)===candidate)return old;
    let safe=!h||h.update_abi===m.update_abi;
    if(safe){try{await activate(root,socket,candidate,target,!!h);}catch(error){recordError(root,error);safe=false;}
      if(safe){if(rollback)write(root,"suppressed",current);return target;}h=await hello(socket);if(h?.executable===target)return target;}
    const decision=h?await confirmRestart(socket):null;
    if(decision){const fresh=await hello(socket);if(!fresh||fresh.server_pid!==h.server_pid)throw Error("UpdateRuntimeChanged");await rpc.request(socket,"recovery.save");copyFileSync(recoveryPath(socket),recoveryPath(socket)+".before-update");await rpc.request(socket,"shutdown");
      let stopped=false;for(let i=0;i<100;i++){if(!await hello(socket)){stopped=true;break;}await Bun.sleep(50);}if(!stopped)throw Error("RuntimeDidNotStop");await activate(root,socket,candidate,target,false);if(rollback)write(root,"suppressed",current);return target;}
    if(decision!==null&&deferred)write(root,deferred,candidate);if(explicit){console.error("Update remains downloaded. Keep working, or run corgi update from an outside terminal to choose a restart.");throw Error("UpdateDeferred");}return old;
  }finally{unlock?.();}
}
export async function startup(socket:string,exe:string,cmd:string,skip=false){
  const rel=release(exe),root=managed(rel,exe);if(!root)return;
  let target:string;try{target=await select(rel,root,socket,!skip&&!existsSync(join(root,"auto-off")),false,false);}catch(error){recordError(root,error);target=(await hello(socket))?.executable??exe;}
  if(target!==exe)process.execve!(target,[target,cmd,"--update-routed"],{...process.env,CORGI_APP_EXE:target} as Record<string,string>);
}
export async function command(args:string[],socket:string,exe:string){
  const rel=release(exe),root=managed(rel,exe);if(!root){console.error("This is a development or unmanaged build. Install a release to enable updates.");throw Error("UnmanagedInstallation");}
  if(args.length===2&&args[0]==="auto"){if(args[1]==="off")write(root,"auto-off","off");else if(args[1]==="on"){remove(root,"auto-off");background(socket,exe);}else throw Error("Usage");return;}
  if(args.length===1&&args[0]==="status"){console.error(`Automatic updates: ${existsSync(join(root,"auto-off"))?"off":"on"}`);for(const name of ["current","staged","previous","suppressed","last-error"]){const v=read(root,name);if(v!==null)console.error(`${name}: ${v}`);}const h=await hello(socket);if(h)console.error(`running: ${h.release_version}`);return;}
  const rollback=args.length===1&&args[0]==="rollback";if(args.length>1||(args.length===1&&!rollback&&!["--check","--download-only"].includes(args[0])))throw Error("Usage");
  if(!rollback)await feed(rel,root,args.length===0||args[0]==="--download-only",true);if(args.length===1&&!rollback)return;
  if(rollback&&!existsSync(join(root,"previous")))throw Error("NoPreviousRelease");await select(rel,root,socket,true,true,rollback);console.log("Corgi is ready.");
}
export function background(socket:string,exe:string){const root=managed(release(exe),exe);if(!root||existsSync(join(root,"auto-off")))return;spawn(exe,["__update-worker",socket],{env:{...process.env,CORGI_APP_EXE:exe},stdio:"ignore",detached:true}).unref();}
async function worker(exe:string,socket:string){const rel=release(exe),root=managed(rel,exe);if(!root)return;const unlock=await lock(root,`worker-${Bun.hash.wyhash(socket,0n).toString(16)}.lock`,false);if(!unlock)return;
  try{let next=0;while(!existsSync(join(root,"auto-off"))){if(!await hello(socket))return;const now=Date.now();if(now>=next){try{await feed(rel,root,true,false);}catch(error){recordError(root,error);}next=now+3600000+Math.random()*300000;}await Bun.sleep(30000);}}finally{unlock();}}
// The installer's uninstall mode recognizes this launcher by its exec line.
export const launcher=(root:string)=>`#!/bin/sh\nset -eu\nroot=${quote(root)}\nv=$(cat "$root/current")\ncase "$v" in ''|*[!0-9.a-fTZ-]*) echo 'Invalid Corgi version' >&2; exit 1;; esac\nexec "$root/releases/$v/corgi" "$@"\n`;
async function install(rel:Release,exe:string,root:string,bin:string,manifest:string){
  if(!isAbsolute(root)||!isAbsolute(bin))throw Error("AbsoluteInstallPathRequired");privateDirectory(root);const unlock=await lock(root,"activation.lock",true);
  try{if(existsSync(join(root,"current")))throw Error("AlreadyInstalled");const bytes=readFileSync(manifest,"utf8"),m=parse(rel,bytes);if(m.version!==rel.version||m.commit!==rel.commit)throw Error("WrongReleaseManifest");verifyFile(exe,m.targets[platform]);
    const dest=executable(root,rel.version),dir=dirname(dest);privateDirectory(dir);copyFileSync(exe,dest);chmodSync(dest,0o700);write(dir,"manifest.json",bytes);
    mkdirSync(dirname(bin),{recursive:true});writeFileSync(bin,launcher(root),{flag:"wx",mode:0o755});write(root,"current",rel.version);
  }finally{unlock?.();}
}
export async function internal(args:string[],exe:string):Promise<boolean>{
  switch(args[0]){case "__update-info":{const r=release(exe);console.log(JSON.stringify({version:r.version,commit:r.commit,update_abi:abi,platform,test_mode:r.test_mode}));return true;}
    case "__update-worker":if(args.length!==2)return false;await worker(exe,args[1]);return true;
    case "__install":if(args.length!==4)return false;await install(release(exe),exe,args[1],args[2],args[3]);return true;default:return false;}
}
