import { resolve, basename } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const root=import.meta.dir;
function option(name:string,fallback=""):string {
  const args=process.argv.slice(2),prefix=`--${name}=`,inline=args.find(arg=>arg.startsWith(prefix));
  if(inline)return inline.slice(prefix.length);
  const index=args.indexOf(`--${name}`);if(index<0)return fallback;
  if(!args[index+1]||args[index+1].startsWith("--"))throw Error(`Missing --${name} value`);return args[index+1];
}
const buildTarget=option("target",`${process.platform}-${process.arch}`),[platform,arch]=buildTarget.split("-");
if(!["linux-x64","darwin-arm64","darwin-x64"].includes(buildTarget))throw Error(`Unsupported target: ${buildTarget}`);
const nativeRoot=option("native-root",buildTarget===`${process.platform}-${process.arch}`?`${root}/native/zig-out`:`${root}/dist/native-${buildTarget}`);
if(!existsSync(`${root}/node_modules/@earendil-works/pi-tui`)){
  const install=Bun.spawn([process.execPath,"install","--frozen-lockfile"],{cwd:root,stdout:"inherit",stderr:"inherit"});if(await install.exited)throw Error("TUI dependency install failed");
  // This process can't resolve packages installed after it started: build again in a new one.
  const again=Bun.spawn([process.execPath,...process.argv.slice(1)],{stdout:"inherit",stderr:"inherit",stdin:"inherit"});
  process.exit(await again.exited);
}
const args=[`${root}/scripts/zig`,"build","--build-file",`${root}/native/build.zig`,"-Doptimize=ReleaseFast"];
// An explicit --target builds for the oldest systems a release supports, not this machine.
if(process.argv.slice(2).some(arg=>arg==="--target"||arg.startsWith("--target=")))args.push(`-Dtarget=${arch==="arm64"?"aarch64":"x86_64"}-${platform==="darwin"?"macos.13.0":"linux-gnu.2.28"}`);
args.push("--prefix",nativeRoot);
const sysroot=option("sysroot",process.env.CORGI_PROBE_SYSROOT??"");
if(sysroot)args.push("--sysroot",sysroot);
if(!process.argv.includes("--no-native")){const native=Bun.spawn(args,{stdout:"inherit",stderr:"inherit"});if(await native.exited)throw Error("Native build failed");}
if(process.argv.includes("--native-only"))process.exit(0);
mkdirSync(`${root}/dist`,{recursive:true});
const suffix=platform==="darwin"?"dylib":"so";
const files=[`lib/libcorgi_probe.${suffix}`,`lib/libcorgi_system.${suffix}`,`lib/libcorgi_fd.${suffix}`,"bin/pty-exec","bin/corgi-hook"];
const hash=createHash("sha256");for(const file of files)hash.update(new Uint8Array(await Bun.file(`${nativeRoot}/${file}`).arrayBuffer()));
const imports=files.map((file,i)=>`import asset${i} from ${JSON.stringify(`${nativeRoot}/${file}`)} with {type:"file"};`).join("\n");
const nativeHash=hash.digest("hex");
const assets=`${imports}\nexport const nativeFiles={${files.map((file,i)=>`${JSON.stringify(file)}:asset${i}`).join(",")}};export const nativeHash=${JSON.stringify(nativeHash)};export const testBuild=${process.argv.includes("--test")};`;
const config={releaseVersion:option("release-version","0.1.0-dev"),releaseCommit:option("release-commit","bun-port"),updateURL:option("update-url"),updatePublicKey:option("update-public-key"),sentryDSN:option("sentry-dsn")};
const configSource=Object.entries(config).map(([key,value])=>`export const ${key}=${JSON.stringify(value)};`).join("\n");
const outfile=option("outfile",`${root}/dist/${buildTarget===`${process.platform}-${process.arch}`?"corgi":`corgi-${buildTarget}`}${process.argv.includes("--test")?"-test":""}`);
const result=await Bun.build({entrypoints:[`${root}/src/main.ts`,`${root}/src/codex_files_worker.ts`,`${root}/src/trackers/resources_worker.ts`],target:"bun",compile:{target:`bun-${platform}-${arch}` as any,outfile},plugins:[{name:"native-assets",setup(build){build.onLoad({filter:/\/build_assets\.ts$/},()=>({contents:assets,loader:"ts"}));build.onLoad({filter:/\/build_config\.ts$/},()=>({contents:configSource,loader:"ts"}));}}]});
if(!result.success)throw new AggregateError(result.logs,"Bun compile failed");
const binaryHash=createHash("sha256").update(new Uint8Array(await Bun.file(outfile).arrayBuffer())).digest("hex");
await Bun.write(`${outfile}.sha256`,`${binaryHash}  ${basename(outfile)}\n`);
const sourceHash=createHash("sha256");
for(const path of [...new Bun.Glob("{src,assets}/**/*").scanSync({cwd:root,onlyFiles:true})].sort())
  sourceHash.update(path).update(new Uint8Array(await Bun.file(`${root}/${path}`).arrayBuffer()));
await Bun.write(`${outfile}.build.json`,JSON.stringify({builtAt:new Date().toISOString(),target:buildTarget,
  bunVersion:Bun.version,testBuild:process.argv.includes("--test"),releaseVersion:config.releaseVersion,
  releaseCommit:config.releaseCommit,sha256:binaryHash,sourceSHA256:sourceHash.digest("hex"),
  nativeSHA256:nativeHash},null,2)+"\n");
console.log(`Built ${outfile}`);
