import * as updates from "./updates";
import * as config from "./build_config";
import * as buildId from "./build_id";
import * as os from "./os";

export type Target = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
export interface Build {
  version: string;
  commit: string;
  target: Target;
  executable: string;
  build_id: string;
  source_hash: string;
  socket: string;
  update_abi: string;
}
export function target(value: string): Target {
  switch (value) {
    case "darwin-arm64":
    case "darwin-x64":
    case "linux-arm64":
    case "linux-x64":
      return value;
    default:
      throw Error("UnsupportedRemotePlatform");
  }
}
export function describe(executable: string): Build {
  const release = updates.release(executable);
  return {
    version: release.version,
    commit: release.commit,
    target: target(`${process.platform}-${process.arch}`),
    executable,
    build_id: buildId.of(executable),
    source_hash: config.sourceHash,
    socket: os.socketPath(),
    update_abi: updates.abi,
  };
}
export function parse(value: unknown, platform: Target, executable: string): Build {
  if (!value || typeof value !== "object") throw Error("InvalidRemoteBuild");
  const v = value as Record<string, unknown>;
  for (const key of ["version", "commit", "update_abi"])
    if (typeof v[key] !== "string") throw Error("InvalidRemoteBuild");
  const optional = (key: string) => {
    if (v[key] === undefined) return "";
    if (typeof v[key] !== "string") throw Error("InvalidRemoteBuild");
    return v[key] as string;
  };
  const result = {
    version: v.version as string,
    commit: v.commit as string,
    update_abi: v.update_abi as string,
    target: v.target === undefined ? platform : target(String(v.target)),
    executable: optional("executable") || executable,
    build_id: optional("build_id"),
    source_hash: optional("source_hash"),
    socket: optional("socket"),
  };
  for (const path of [result.executable, result.socket])
    if (path && (!path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path))) throw Error("InvalidRemotePath");
  for (const hash of [result.build_id, result.source_hash])
    if (hash && !/^[a-f0-9]{64}$/.test(hash)) throw Error("InvalidRemoteBuild");
  return result;
}
export function released(v: string): boolean {
  try {
    updates.version(v);
    return true;
  } catch {
    return false;
  }
}
/** Positive means local is newer. Unordered development builds are never guessed by wall-clock time. */
export async function compare(
  local: Build,
  remote: Build,
  ancestor: (older: string, newer: string) => Promise<boolean>,
): Promise<number> {
  if (released(local.version) && released(remote.version)) {
    const order = updates.compare(local.version, remote.version);
    if (order) return order;
    if (local.commit !== remote.commit) throw Error("ConflictingReleaseBuilds");
    return 0;
  }
  if (local.build_id && local.build_id === remote.build_id) return 0;
  if (local.source_hash && local.source_hash === remote.source_hash && local.commit === remote.commit) return 0;
  const commit = (build: Build) => (/^[a-f0-9]{40}(?:-dirty)?$/.test(build.commit) ? build.commit.slice(0, 40) : "");
  const a = commit(local),
    b = commit(remote);
  if (!a || !b) throw Error("UnorderedDevelopmentBuilds");
  const dirtyA = local.commit.endsWith("-dirty"),
    dirtyB = remote.commit.endsWith("-dirty");
  if (a === b) {
    if (dirtyA !== dirtyB) return dirtyA ? 1 : -1;
    if (!dirtyA && (!local.source_hash || !remote.source_hash)) return 0;
    throw Error("UnorderedDevelopmentBuilds");
  }
  if (!dirtyB && (await ancestor(b, a))) return 1;
  if (!dirtyA && (await ancestor(a, b))) return -1;
  throw Error("UnorderedDevelopmentBuilds");
}

/** Which way setup copies a build, as `compare` says. Forced, this computer's
 * build goes there unless the two already match, even when it's older or
 * neither is newer. */
export async function direction(
  local: Build,
  remote: Build,
  ancestor: (older: string, newer: string) => Promise<boolean>,
  force: boolean,
): Promise<number> {
  if (!force) return compare(local, remote, ancestor);
  try {
    return (await compare(local, remote, ancestor)) ? 1 : 0;
  } catch {
    return 1;
  }
}

/** Installation slots stay readable by older updater binaries. This is not the build's release version. */
export function slot(value: Build): string {
  return released(value.version) ? value.version : `0.0.${Number.parseInt(value.build_id.slice(0, 12), 16)}`;
}
