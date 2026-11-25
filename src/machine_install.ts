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
  rmSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import * as updates from "./updates";
import * as build from "./machine_build";
import * as rpc_http from "./rpc_http";
import * as os from "./os";
import * as transfer from "./persist/transfer";
import * as moved from "./machine_moved";

/** How long an install waits out another's, such as a second viewer's move
 * of the same machine handing off its daemon. */
const lock_ms = 120_000;

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
  const unlock = await updates.setupLock(managed ? dirname(parent) : dirname(target), lock_ms);
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
/** Copies `candidate` to `target` whole or not at all: a full disk or a kill
 * mustn't leave part of a release where the next install would find it. */
function place(candidate: string, target: string): void {
  // The activation lock keeps this to one copy at a time.
  const partial = target + ".partial";
  copyFileSync(candidate, partial);
  chmodSync(partial, 0o700);
  renameSync(partial, target);
}
/** Hands the daemon off to `target`, unless it already runs it. */
async function handoff(target: string, build_id: string, moving: (build_id: string) => void): Promise<void> {
  const daemon = new rpc_http.Client(os.socketPath());
  const live = await hello(daemon);
  if (live?.build_id === build_id && live.executable === target) return;
  await check(daemon, target, live);
  moving(build_id);
  if (live) await reload(daemon, target, build_id);
}
/** Runs from the transferred candidate. The selected command remains the same.
 * `by` names the computer whose viewer moved the machine, for the viewers this
 * move leaves behind; a move that fails leaves the last one's name. */
export async function install(
  candidate: string,
  destination: string,
  expected: string,
  manifest: string,
  by = "",
): Promise<string> {
  let undo = () => {};
  let switching = "";
  const moving = (build_id: string) => {
    switching = build_id;
    if (by) undo = moved.record(os.socketPath(), by, build_id);
  };
  try {
    return await replace(candidate, destination, expected, manifest, moving);
  } catch (error) {
    // A daemon that switched anyway keeps the name of the computer that switched it.
    const live = switching ? await hello(new rpc_http.Client(os.socketPath())).catch(() => null) : null;
    if (live?.build_id !== switching) undo();
    throw error;
  }
}
/** A machine another install already moved to this build counts as moved. */
async function replace(
  candidate: string,
  destination: string,
  expected: string,
  manifest: string,
  moving: (build_id: string) => void,
): Promise<string> {
  if (!destination.startsWith("/") || /[\x00-\x1f\x7f]/.test(destination)) throw Error("InvalidInstallPath");
  const incoming = build.describe(candidate);
  const present = existsSync(destination);
  const canonical = present ? realpathSync(destination) : destination;
  const holds = (file: string) => existsSync(file) && build.describe(file).build_id === incoming.build_id;
  if (basename(dirname(dirname(canonical))) === "releases") {
    const root = dirname(dirname(dirname(canonical)));
    const unlock = await updates.setupLock(root, lock_ms);
    try {
      const current = readFileSync(join(root, "current"), "utf8").trim();
      const version = build.slot(incoming);
      const directory = join(root, "releases", version);
      const target = join(directory, "corgi");
      // A copy a kill cut short.
      rmSync(target + ".partial", { force: true });
      const done = current === version && holds(target);
      if (
        !done &&
        (join(root, "releases", current, "corgi") !== canonical || build.describe(canonical).build_id !== expected)
      )
        throw Error("InstallationChanged");
      if (manifest) updates.verifyArtifact(candidate, manifest);
      if (!done) {
        if (version === current) throw Error("ConflictingInstalledBuild");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        // Another build under this release's name is a copy cut short.
        if (!holds(target)) place(candidate, target);
        if (manifest) copyFileSync(manifest, join(directory, "manifest.json"));
      }
      await handoff(target, incoming.build_id, moving);
      updates.moved(root, version);
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
  const unlock = await updates.setupLock(dirname(canonical), lock_ms);
  const lock = mkdtempSync(canonical + ".upgrade-");
  const stage = join(lock, "corgi");
  const backup = join(lock, "previous");
  let replaced = false;
  let preserve = false;
  try {
    if (!present && expected) throw Error("InstallationChanged");
    if (present !== existsSync(canonical)) throw Error("InstallationChanged");
    if (present && holds(canonical)) {
      await handoff(canonical, incoming.build_id, moving);
      return canonical;
    }
    if (present && build.describe(canonical).build_id !== expected) throw Error("InstallationChanged");
    const daemon = new rpc_http.Client(os.socketPath());
    const live = await hello(daemon);
    await check(daemon, candidate, live);
    copyFileSync(candidate, stage);
    chmodSync(stage, 0o700);
    if (present) copyFileSync(canonical, backup);
    renameSync(stage, canonical);
    replaced = true;
    moving(incoming.build_id);
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
