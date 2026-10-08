import * as build_id from "./build_id";
import { accessSync, constants, realpathSync, statSync, readdirSync } from "node:fs";
import { resolve as absolute, join, isAbsolute } from "node:path";
import { Provider } from "./providers";
import { PathSearch } from "./os";
import { testBuild } from "./build_assets";
import * as subprocess from "./subprocess";
function executable(path:string):boolean {
  const self=build_id.executablePath(import.meta.filename,process.execPath,absolute(import.meta.dir,"../corgi"),process.env.CORGI_APP_EXE);
  try {const real=realpathSync(path);if(real===realpathSync(self))return false;accessSync(real,constants.X_OK);return statSync(real).isFile();}catch{return false;}
}
export function isVersion(output:string,prefix:string):boolean {const line=output.trim();return line.startsWith(prefix)&&/^\d/.test(line.slice(prefix.length));}
function candidates(provider:Provider,cwd=process.cwd()):string[] {
  const info=Provider.info(provider),command=info.executables[0],paths=(process.env.PATH??"").split(":").map(dir=>absolute(cwd,dir,command));
  const home=process.env.HOME;
  if(home)for(const p of info.home_paths)paths.push(join(home,p));
  const root=testBuild?(process.env.CORGI_TEST_SYSTEM_ROOT??""):"";
  for(const p of info.system_paths)paths.push(root+p);
  if(process.platform==="darwin")for(const apps of [home?join(home,"Applications"):null,root+"/Applications"]){
    if(!apps)continue;let names:string[]=[];try{names=readdirSync(apps).filter(x=>x.endsWith(".app")).sort();}catch{}
    for(const name of [...info.app_bundles,...names])paths.push(join(apps,name,"Contents/Resources",command));
  }
  return [...new Set(paths)];
}
export async function resolve(provider:Provider,cwd:string|null=null):Promise<string> {
  const info=Provider.info(provider),override=process.env[info.binary_env];
  if(override!==undefined&&(override.length||info.version_prefix===null))return override;
  if(!info.version_prefix)return info.executables[0];
  const deadline=performance.now()+2000;
  for(const path of candidates(provider,absolute(cwd??process.cwd()))) {
    if(!executable(path))continue;const timeout=Math.min(750,deadline-performance.now());if(timeout<=0)break;
    try {const output=await subprocess.run([path,"--version"],{timeout_ms:timeout,max_output:4096});
      if(output.ok()&&isVersion(output.stdout.toString(),info.version_prefix))return path;
    }catch{}
  }
  throw Error("ProviderNotFound");
}
/** The first executable `name` on PATH that isn't Corgi itself: a pane-local
 * alias would otherwise exec Corgi again. */
export function onPath(name:string,path_list=process.env.PATH??""):string|null {
  const search=PathSearch.init(path_list,name);
  for(let path=search.next();path!==null;path=search.next())if(executable(path))return path;
  return null;
}
export function installed(provider:Provider):boolean {
  const info=Provider.info(provider),override=process.env[info.binary_env];
  if(override)return override.includes("/")?executable(override):onPath(override)!==null;
  if(onPath(info.executables[0])!==null)return true;
  const home=process.env.HOME,root=testBuild?(process.env.CORGI_TEST_SYSTEM_ROOT??""):"",paths:string[]=[];
  if(home){for(const p of info.home_paths)paths.push(join(home,p));for(const name of info.app_bundles)paths.push(join(home,"Applications",name,"Contents/Resources",info.executables[0]));}
  for(const p of info.system_paths)paths.push(root+p);
  for(const name of info.app_bundles)paths.push(join(root,"/Applications",name,"Contents/Resources",info.executables[0]));
  return paths.some(executable);
}
