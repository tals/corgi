import * as updateProgress from "./machine_progress";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "./os";
import { flock } from "./native_bridge";
import * as errors from "./errors";
import type { Profile } from "./machines";
import * as builds from "./machine_build";

function checkout(): { root: string; bun: string } {
  const root = process.env.CORGI_DEV_ROOT ?? "",
    bun = process.env.CORGI_DEV_BUN ?? "";
  if (!path.isAbsolute(root) || !path.isAbsolute(bun) || !fs.existsSync(path.join(root, "build.ts")))
    throw Error("Start Corgi with ./go.ts from the development checkout.");
  return { root, bun };
}
export function enabled(): boolean {
  return !!process.env.CORGI_DEV_ROOT && !!process.env.CORGI_DEV_BUN && !builds.released(builds.viewer.version);
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
    if (!flock(fd)) {
      progress("Build queued…", { detail: `Waiting for the checkout build lock · ${target}` });
      do {
        signal?.throwIfAborted();
        await Bun.sleep(50);
      } while (!flock(fd));
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
    flock(fd, false);
    fs.closeSync(fd);
  }
}
export function allowed(previous: string | null, installed: string, replace: boolean): void {
  if (previous !== null && previous !== installed && !replace)
    throw Error("Remote changed since the last dev deployment; inspect it, then use --replace to deploy over it.");
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
export function recorded(profile: Profile, hash: string): boolean {
  try {
    return /^[a-f0-9]{64}$/.test(hash) && fs.readFileSync(receiptFile(profile), "utf8").trim() === hash;
  } catch {
    return false;
  }
}
/** Per-checkout receipts prevent a routine dev cycle from overwriting someone else's deployment. */
export function open(profile: Profile, replace: boolean) {
  const file = receiptFile(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file + ".lock", "a", 0o600);
  if (!flock(fd)) {
    fs.closeSync(fd);
    throw Error("DevelopmentDeployInProgress");
  }
  try {
    const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
    if (previous !== null && !/^[a-f0-9]{64}$/.test(previous)) throw Error("InvalidDevelopmentReceipt");
    return {
      accept: (installed: string) => allowed(previous, installed, replace),
      record: (hash: string) => {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("InvalidDevelopmentReceipt");
        os.atomicWrite(file, hash + "\n", 0o600);
      },
      close: () => {
        flock(fd, false);
        fs.closeSync(fd);
      },
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export type Deployment = ReturnType<typeof open>;

/** Adding a new dev machine chooses this checkout; attachment records its installed hash. */
export function initial(): Deployment {
  return { accept() {}, record() {}, close() {} };
}

export async function acquire(profile: Profile, signal?: AbortSignal): Promise<Deployment> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      return open(profile, false);
    } catch (error) {
      if (!errors.is(error, "DevelopmentDeployInProgress")) throw error;
      await Bun.sleep(50);
    }
  }
}
