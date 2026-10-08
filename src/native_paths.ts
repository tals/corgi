import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, lstatSync, chmodSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { nativeFiles,nativeHash } from "./build_assets";
function extract():string {
  if(!nativeFiles)return resolve(import.meta.dir,"../native/zig-out");
  // /tmp is shared: libraries another user could have placed there must never load.
  const parent=join(tmpdir(),`corgi-native-${process.getuid?.()??0}`);
  mkdirSync(parent,{recursive:true,mode:0o700});const stat=lstatSync(parent);
  if(!stat.isDirectory()||stat.uid!==(process.getuid?.()??stat.uid))throw Error("UnsafeDirectory");chmodSync(parent,0o700);
  const root=join(parent,nativeHash);
  for(const [name,asset] of Object.entries(nativeFiles)){
    const destination=join(root,name);if(existsSync(destination))continue;
    mkdirSync(dirname(destination),{recursive:true,mode:0o700});
    const temp=destination+`.${process.pid}.tmp`;
    writeFileSync(temp,readFileSync(asset),{mode:0o700});renameSync(temp,destination);
  }
  return root;
}
export const nativeRoot=process.env.CORGI_NATIVE_ROOT??extract();
