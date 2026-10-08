import { lstatSync, readFileSync, writeFileSync } from "node:fs";
export function titleItems(tui:any):string[]|null {
  if(tui!==null&&tui!==undefined&&(typeof tui!=="object"||Array.isArray(tui)))throw Error("InvalidTitleConfig");
  const title=tui?.terminal_title;
  if(title===null||title===undefined)return ["app-name","thread-id","activity","project"];
  if(!Array.isArray(title)||title.some(item=>typeof item!=="string"))throw Error("InvalidTitleConfig");
  return title.includes("thread-id")?null:[...title,"thread-id"];
}
export function edit(result:any,path:string):any {
  if(!Array.isArray(result?.layers))throw Error("MissingConfigLayers");
  for(const layer of result.layers){const source=layer.name;
    if(source?.type!=="user"||source.file!==path||source.profile!=null)continue;
    if(layer.disabledReason!=null)throw Error("DisabledConfigLayer");
    if(typeof layer.version!=="string"||!layer.version)throw Error("MissingConfigVersion");
    const value=titleItems(layer.config?.tui);return value?{keyPath:"tui.terminal_title",value,mergeStrategy:"replace",filePath:path,expectedVersion:layer.version}:null;
  }
  throw Error("MissingUserConfig");
}
export function backup(path:string):void {
  let stat;try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  if(!stat.isFile())throw Error("ConfigNotRegular");
  if(stat.size>1024*1024)throw Error("FileTooBig");
  try{writeFileSync(path+".corgi-backup",readFileSync(path),{flag:"wx",mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
}
