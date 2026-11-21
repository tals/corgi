import * as updates from "./updates";
import * as config from "./build_config";
import * as buildId from "./build_id";
import * as os from "./os";

export type Target = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
export interface Identity {
  version: string;
  commit: string;
  source_hash: string;
}
export const viewer: Identity = {
  version: config.releaseVersion,
  commit: config.releaseCommit,
  source_hash: config.sourceHash,
};
// Pin automatic work to the running viewer even if dist/corgi is replaced while it is open.
export const revision = JSON.stringify([viewer.version, viewer.commit, viewer.source_hash]);
export function requireRevision(expected: string): void {
  if (expected === revision) return;
  if (viewer.source_hash && !released(viewer.version)) {
    try {
      const fields: unknown = JSON.parse(expected);
      if (
        Array.isArray(fields) &&
        fields.length === 3 &&
        typeof fields[1] === "string" &&
        fields[0] === viewer.version &&
        fields[2] === viewer.source_hash
      )
        return;
    } catch {}
  }
  throw Error("Development build changed. Restart ./go.ts to use the new revision.");
}
/** The source hash is shared by cross-builds. Executable hashes vary by platform. */
export function compare(a: Identity, b: Identity): "match" | "mismatch" | "unknown" {
  if (!a.version || !b.version) return "unknown";
  if (a.version !== b.version) return "mismatch";
  const release = released(a.version);
  if (a.source_hash && b.source_hash) {
    if (a.source_hash !== b.source_hash) return "mismatch";
    if (!release) return "match";
  }
  if (a.commit && b.commit && a.commit !== b.commit) return "mismatch";
  return release ? "match" : "unknown";
}
export function identity(hello: { release_version?: string; release_commit?: string; source_hash?: string }): Identity {
  const field = (v: unknown) => (typeof v === "string" && /^[a-zA-Z0-9._+-]{1,128}$/.test(v) ? v : "");
  return {
    version: field(hello.release_version),
    commit: field(hello.release_commit),
    source_hash:
      typeof hello.source_hash === "string" && /^[a-f0-9]{64}$/.test(hello.source_hash) ? hello.source_hash : "",
  };
}
export function label(build: Identity): string {
  const commit = /^[a-f0-9]{7,40}(-dirty)?$/.test(build.commit)
    ? build.commit.slice(0, 7) + (build.commit.endsWith("-dirty") ? "-dirty" : "")
    : "";
  return [
    build.version || "Unknown",
    commit,
    build.source_hash && !released(build.version) ? "source " + build.source_hash.slice(0, 8) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export interface Build {
  version: string;
  commit: string;
  target: Target;
  executable: string;
  build_id: string;
  source_hash: string;
  socket: string;
  update_abi: string;
  delta_transfer: "rsync-zstd-v1" | "";
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
export function describe(executable: string, { hash = true } = {}): Build {
  const release = updates.release(executable);
  return {
    version: release.version,
    commit: release.commit,
    target: target(`${process.platform}-${process.arch}`),
    executable,
    build_id: hash ? buildId.of(executable) : "",
    source_hash: config.sourceHash,
    socket: os.socketPath(),
    update_abi: updates.abi,
    delta_transfer: "rsync-zstd-v1",
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
  const result: Build = {
    version: v.version as string,
    commit: v.commit as string,
    update_abi: v.update_abi as string,
    target: v.target === undefined ? platform : target(String(v.target)),
    executable: optional("executable") || executable,
    build_id: optional("build_id"),
    source_hash: optional("source_hash"),
    socket: optional("socket"),
    // Absent on older binaries. Only the exact advertised protocol is usable.
    delta_transfer: v.delta_transfer === "rsync-zstd-v1" ? "rsync-zstd-v1" : "",
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
/** Setup selects the invoking build, regardless of branch ancestry or release order. */
export function matches(local: Build, remote: Build): boolean {
  if (released(local.version) || released(remote.version)) {
    if (local.version !== remote.version) return false;
    if (local.commit !== remote.commit) throw Error("ConflictingReleaseBuilds");
    return true;
  }
  if (local.build_id && local.build_id === remote.build_id) return true;
  if (local.source_hash && remote.source_hash) return local.source_hash === remote.source_hash;
  return false;
}

/** Installation slots stay readable by older updater binaries. This is not the build's release version. */
export function slot(value: Build): string {
  return released(value.version) ? value.version : `0.0.${Number.parseInt(value.build_id.slice(0, 12), 16)}`;
}
