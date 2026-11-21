import * as updateProgress from "./machine_progress";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "./os";
import * as native_bridge from "./native_bridge";
import * as errors from "./errors";
import type { Profile } from "./machines";
import * as builds from "./machine_build";
import * as buildId from "./build_id";

function checkout(): { root: string; bun: string } {
  const root = process.env.CORGI_DEV_ROOT ?? "",
    bun = process.env.CORGI_DEV_BUN ?? "";
  if (!path.isAbsolute(root) || !path.isAbsolute(bun) || !fs.existsSync(path.join(root, "build.ts")))
    throw Error("Start Corgi with ./go.ts from the development checkout.");
  return { root, bun };
}
export function skipUpdates(): boolean {
  return process.env.CORGI_NO_REMOTE_UPDATE === "1";
}
export function enabled(): boolean {
  return (
    !skipUpdates() &&
    !!process.env.CORGI_DEV_ROOT &&
    !!process.env.CORGI_DEV_BUN &&
    !builds.released(builds.viewer.version)
  );
}
/** The launcher supplies its Bun and checkout; neither is needed on the remote. */
export async function artifact(
  target: builds.Target,
  signal?: AbortSignal,
  progress: updateProgress.Report = updateProgress.print,
): Promise<string> {
  const { root, bun } = checkout();
  const fd = fs.openSync(path.join(root, "dist/dev-build.lock"), "a", 0o600);
  try {
    if (!native_bridge.flock(fd)) {
      progress("Build queued…", { detail: `Waiting for the checkout build lock · ${target}` });
      do {
        signal?.throwIfAborted();
        await Bun.sleep(50);
      } while (!native_bridge.flock(fd));
    }
    signal?.throwIfAborted();
    let started: number | null = null;
    let detail = "";
    progress("Checking…", { detail: `Checking cached build inputs for ${target}` });
    const report = () => {
      if (started === null) return;
      progress(`Building ${target}…`, {
        metrics: updateProgress.elapsed(performance.now() - started),
        compact: "Building…",
        detail,
      });
    };
    const child = Bun.spawn(
      [
        bun,
        path.join(root, "build.ts"),
        "--incremental",
        "--target",
        target,
        "--expected-source",
        builds.viewer.source_hash,
      ],
      {
        cwd: root,
        detached: !!signal,
        ipc(message) {
          if (message === "queued") progress("Build queued…", { detail: `Waiting for another build of ${target}` });
          else if (typeof message === "string") {
            started ??= performance.now();
            detail = message;
            report();
          }
        },
        stdin: "ignore",
        stdout: 2,
        stderr: "inherit",
      },
    );
    // Zig and its compiler workers belong to this build too.
    const abort = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const timer = setInterval(report, 1000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const code = await child.exited;
      signal?.throwIfAborted();
      if (code !== 0) throw Error("DevelopmentBuildFailed");
    } finally {
      clearInterval(timer);
      signal?.removeEventListener("abort", abort);
    }
    return path.join(root, "dist", `corgi-${target}`);
  } finally {
    native_bridge.flock(fd, false);
    fs.closeSync(fd);
  }
}
function receiptFile(profile: Profile): string {
  const { root } = checkout();
  const key = crypto
    .createHash("sha256")
    .update(JSON.stringify([profile.name, profile.target, profile.socket]))
    .digest("hex");
  const directory = path.join(root, "dist/dev-deploy");
  return path.join(directory, key);
}
type VerifiedBuild = { hash: string; target: builds.Target; stamp: string };
/** A renamed or rewritten artifact needs a fresh byte comparison. */
export function fileStamp(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs].join(":");
}
export function recorded(profile: Profile, hash: string): boolean {
  try {
    if (!/^[a-f0-9]{64}$/.test(hash)) return false;
    const record = JSON.parse(fs.readFileSync(receiptFile(profile) + ".json", "utf8"));
    if (record.hash !== hash) return false;
    const target = builds.target(record.target);
    const file =
      target === `${process.platform}-${process.arch}`
        ? buildId.self()
        : path.join(checkout().root, "dist", `corgi-${target}`);
    return fileStamp(file) === record.stamp;
  } catch {
    return false;
  }
}
/** Serialize updates from this checkout and remember the verified target for reattach. */
export function open(profile: Profile) {
  const file = receiptFile(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file + ".lock", "a", 0o600);
  if (!native_bridge.flock(fd)) {
    fs.closeSync(fd);
    throw Error("DevelopmentDeployInProgress");
  }
  return {
    record(verified: VerifiedBuild) {
      os.atomicWrite(file + ".json", JSON.stringify(verified) + "\n", 0o600);
    },
    close() {
      native_bridge.flock(fd, false);
      fs.closeSync(fd);
    },
  };
}
export type Deployment = Pick<ReturnType<typeof open>, "record">;

/** Setup learns the socket that identifies the receipt after installing the executable. */
export function initial() {
  let installed: VerifiedBuild;
  return {
    record(verified: VerifiedBuild) {
      installed = verified;
    },
    save(profile: Profile) {
      const receipt = open(profile);
      try {
        receipt.record(installed);
      } finally {
        receipt.close();
      }
    },
  };
}

export async function acquire(profile: Profile, signal?: AbortSignal): Promise<ReturnType<typeof open>> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      return open(profile);
    } catch (error) {
      if (!errors.is(error, "DevelopmentDeployInProgress")) throw error;
      await Bun.sleep(50);
    }
  }
}
