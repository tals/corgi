import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function digest(root: string, patterns: string[]): string {
  const files = new Set(
    patterns.flatMap(pattern => [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })]),
  );
  const hash = crypto.createHash("sha256");
  for (const file of [...files].filter(file => !/zig-(cache|out|pkg)/.test(file)).sort()) {
    const bytes = fs.readFileSync(path.join(root, file));
    hash.update(JSON.stringify([file, bytes.length])).update(bytes);
  }
  return hash.digest("hex");
}
export function source(root: string): string {
  return crypto
    .createHash("sha256")
    .update(Bun.version)
    .update(
      digest(root, [
        "{src,assets}/**/*",
        "native/**/*.{c,h,zig,zon}",
        "package.json",
        "bun.lock",
        "build.ts",
        "scripts/{build_inputs.ts,zig,translations.ts}",
      ]),
    )
    .digest("hex");
}
export function native(root: string, target: string, explicit: boolean, sdk: string): string {
  return crypto
    .createHash("sha256")
    .update(
      digest(root, [
        "native/**/*.{c,h,zig,zon}",
        "scripts/zig",
        "scripts/tools.sh",
        "build.ts",
        "scripts/build_inputs.ts",
      ]),
    )
    .update(JSON.stringify([target, explicit, sdk, process.env.ZIG ?? ""]))
    .update(
      sdk && fs.existsSync(path.join(sdk, "SDKSettings.json"))
        ? fs.readFileSync(path.join(sdk, "SDKSettings.json"))
        : "",
    )
    .digest("hex");
}
export function macosSdk(root: string): string {
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(["xcrun", "--sdk", "macosx", "--show-sdk-path"], {
      stdout: "pipe",
      stderr: "inherit",
    });
    if (result.exitCode) throw Error("Install the Xcode command line tools to build for macOS.");
    return result.stdout.toString().trim();
  }
  const local = path.join(root, ".tools/macos-sdk");
  if (fs.existsSync(path.join(local, "SDKSettings.json"))) return local;
  const git = Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
  if (!git.exitCode) {
    const shared = path.join(path.dirname(path.resolve(root, git.stdout.toString().trim())), ".tools/macos-sdk");
    if (fs.existsSync(path.join(shared, "SDKSettings.json"))) return shared;
  }
  throw Error(`Building for macOS requires an SDK: copy it to ${local} or set CORGI_PROBE_SYSROOT.`);
}
export function files(platform: string): string[] {
  const suffix = platform === "darwin" ? "dylib" : "so";
  return [
    `lib/libcorgi_term.${suffix}`,
    `lib/libcorgi_system.${suffix}`,
    "bin/pty-exec",
    "bin/corgi-hook",
    "bin/corgi-remote-bridge",
  ];
}
export function nativeOutput(root: string, platform: string): string {
  const hash = crypto.createHash("sha256");
  for (const file of files(platform)) hash.update(fs.readFileSync(path.join(root, file)));
  return hash.digest("hex");
}
