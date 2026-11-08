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
import * as rpc from "./rpc";
import * as os from "./os";

async function hello(socket: string) {
  const connection = new rpc.Connection(socket, { transport: "stream", requestIds: false, timeout_ms: 10_000 });
  try {
    return await connection.call("hello");
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  } finally {
    connection.close();
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
      const socket = os.socketPath();
      const live = await hello(socket);
      if (live && live.update_abi !== incoming.update_abi) throw Error("UpdateRequiresSessionRestart");
      if (await updates.check(socket, target, live)) throw Error("UpdateCheckFailed");
      if (live) {
        const connection = new rpc.Connection(socket, { transport: "stream", requestIds: false, timeout_ms: 45_000 });
        try {
          await connection.call("server.reload", { executable: target });
        } catch (error) {
          if ((await hello(socket))?.build_id !== incoming.build_id) throw error;
        } finally {
          connection.close();
        }
        if ((await hello(socket))?.build_id !== incoming.build_id) throw Error("UpdateRuntimeChanged");
      }
      os.atomicWrite(join(root, "previous"), current + "\n", 0o600);
      os.atomicWrite(join(root, "current"), version + "\n", 0o600);
      return target;
    } finally {
      unlock();
    }
  }
  if (present) {
    const magic = readFileSync(canonical).subarray(0, 4);
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
    const socket = os.socketPath();
    const live = await hello(socket);
    if (live && live.update_abi !== incoming.update_abi) throw Error("UpdateRequiresSessionRestart");
    const failure = await updates.check(socket, candidate, live);
    if (failure) throw Error("UpdateCheckFailed");
    copyFileSync(candidate, stage);
    chmodSync(stage, 0o700);
    if (present) copyFileSync(canonical, backup);
    renameSync(stage, canonical);
    replaced = true;
    if (live) {
      const connection = new rpc.Connection(socket, { transport: "stream", requestIds: false, timeout_ms: 45_000 });
      try {
        await connection.call("server.reload", { executable: canonical });
      } catch (error) {
        const current = await hello(socket);
        if (current?.build_id !== incoming.build_id) throw error;
      } finally {
        connection.close();
      }
      if ((await hello(socket))?.build_id !== incoming.build_id) throw Error("UpdateRuntimeChanged");
    }
    return canonical;
  } catch (error) {
    if (replaced && existsSync(backup)) {
      try {
        const live = await hello(os.socketPath());
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
