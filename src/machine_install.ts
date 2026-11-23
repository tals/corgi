import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  chmodSync,
  readFileSync,
  rmdirSync,
  mkdtempSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import * as updates from "./updates";
import * as build from "./machine_build";
import * as rpc_http from "./rpc_http";
import * as os from "./os";
import * as transfer from "./persist/transfer";

async function hello(daemon: rpc_http.Client) {
  try {
    return await daemon.call("hello");
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
async function check(daemon: rpc_http.Client, target: string, live: Awaited<ReturnType<typeof hello>>): Promise<void> {
  if (live && !transfer.compatible(live) && live.update_abi !== updates.abi)
    throw Error("UpdateRequiresSessionRestart");
  if (await updates.check(daemon, target, live)) throw Error("UpdateCheckFailed");
}
async function reload(daemon: rpc_http.Client, target: string, expected: string): Promise<void> {
  try {
    await daemon.reload(target);
  } catch (error) {
    if ((await hello(daemon))?.build_id !== expected) throw error;
  }
  if ((await hello(daemon))?.build_id !== expected) throw Error("UpdateRuntimeChanged");
}
/** The installed file can match while another checkout serves this socket. */
export async function activate(daemon: rpc_http.Client, executable: string, expected: string): Promise<void> {
  const target = realpathSync(executable);
  const parent = dirname(dirname(target));
  const managed = basename(parent) === "releases";
  // In an installation, the daemon runs the current release's own file.
  const runs = (live: Awaited<ReturnType<typeof hello>>) =>
    live?.build_id === expected && (!managed || live.executable === target);
  if (runs(await hello(daemon))) return;
  const unlock = await updates.setupLock(managed ? dirname(parent) : dirname(target));
  try {
    if (managed && readFileSync(join(dirname(parent), "current"), "utf8").trim() !== basename(dirname(target)))
      throw Error("InstallationChanged");
    const incoming = build.describe(target);
    if (incoming.build_id !== expected) throw Error("InstallationChanged");
    const live = await hello(daemon);
    if (!live) throw Error("UpdateRuntimeChanged");
    if (runs(live)) return;
    await check(daemon, target, live);
    await reload(daemon, target, expected);
  } finally {
    unlock();
  }
}
/** Runs from the transferred candidate. The selected command remains the same. */
export async function install(
  candidate: string,
  destination: string,
  expected: string,
  manifest: string,
): Promise<string> {
  if (!destination.startsWith("/") || /[\x00-\x1f\x7f]/.test(destination)) throw Error("InvalidInstallPath");
  const incoming = build.describe(candidate);
  const present = existsSync(destination);
  const canonical = present ? realpathSync(destination) : destination;
  if (basename(dirname(dirname(canonical))) === "releases") {
    const root = dirname(dirname(dirname(canonical)));
    const unlock = await updates.setupLock(root);
    try {
      const current = readFileSync(join(root, "current"), "utf8").trim();
      if (join(root, "releases", current, "corgi") !== canonical || build.describe(canonical).build_id !== expected)
        throw Error("InstallationChanged");
      if (manifest) updates.verifyArtifact(candidate, manifest);
      const version = build.slot(incoming);
      const directory = join(root, "releases", version);
      const target = join(directory, "corgi");
      if (existsSync(target) && build.describe(target).build_id !== incoming.build_id)
        throw Error("ConflictingInstalledBuild");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!existsSync(target)) {
        copyFileSync(candidate, target);
        chmodSync(target, 0o700);
      }
      if (manifest) copyFileSync(manifest, join(directory, "manifest.json"));
      const daemon = new rpc_http.Client(os.socketPath());
      const live = await hello(daemon);
      await check(daemon, target, live);
      if (live) await reload(daemon, target, incoming.build_id);
      os.atomicWrite(join(root, "previous"), current, 0o600);
      os.atomicWrite(join(root, "current"), version, 0o600);
      return target;
    } finally {
      unlock();
    }
  }
  if (present) {
    const magic = new Uint8Array(await Bun.file(canonical).slice(0, 2).arrayBuffer());
    if (magic[0] === 35 && magic[1] === 33) throw Error("CannotReplaceCorgiWrapper");
  }
  if (manifest) updates.verifyArtifact(candidate, manifest);
  mkdirSync(dirname(canonical), { recursive: true, mode: 0o700 });
  const unlock = await updates.setupLock(dirname(canonical));
  const lock = mkdtempSync(canonical + ".upgrade-");
  const stage = join(lock, "corgi");
  const backup = join(lock, "previous");
  let replaced = false;
  let preserve = false;
  try {
    if (!present && expected) throw Error("InstallationChanged");
    if (present !== existsSync(canonical)) throw Error("InstallationChanged");
    if (present && build.describe(canonical).build_id !== expected) throw Error("InstallationChanged");
    const daemon = new rpc_http.Client(os.socketPath());
    const live = await hello(daemon);
    await check(daemon, candidate, live);
    copyFileSync(candidate, stage);
    chmodSync(stage, 0o700);
    if (present) copyFileSync(canonical, backup);
    renameSync(stage, canonical);
    replaced = true;
    if (live) await reload(daemon, canonical, incoming.build_id);
    return canonical;
  } catch (error) {
    if (replaced && existsSync(backup)) {
      try {
        const live = await hello(new rpc_http.Client(os.socketPath()));
        if (live?.build_id === incoming.build_id) return canonical;
        renameSync(backup, canonical);
      } catch {
        preserve = true;
        process.stderr.write(`Upgrade status is uncertain; previous binary retained at ${backup}.\n`);
      }
    }
    throw error;
  } finally {
    unlock();
    for (const path of preserve ? [stage] : [stage, backup]) {
      try {
        unlinkSync(path);
      } catch {}
    }
    if (!preserve) rmdirSync(lock);
  }
}
