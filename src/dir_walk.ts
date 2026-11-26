//! What's under a directory, for the directory browser's search: inside a
//! Git work tree, the files `git ls-files` lists, tracked and untracked but
//! not ignored, with the folders they're in; elsewhere, the file system's
//! entries, breadth first, skipping `.git` and never entering a folder twice,
//! as through a link. Entries arrive in batches as they're read. A walk stops
//! at `Limits.entries` or after `Limits.ms`, saying which.
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import * as errors from "./errors";
import * as subprocess from "./subprocess";

/** A path under the walked directory, without a trailing "/". */
export interface Entry {
  path: string;
  directory: boolean;
}
export type Mode = "git" | "files";
/** Why a walk stopped short. */
export type Cap = "entries" | "time";
export interface Progress {
  /** How it walks, once it knows. */
  mode: Mode | null;
  scanned: number;
  done: boolean;
  capped: Cap | null;
  /** Why it failed, by name. */
  error: string | null;
}
export interface Limits {
  entries: number;
  ms: number;
}
export const limits: Limits = { entries: 100_000, ms: 10_000 };
/** How often a walk passes on what it found. */
const batch_ms = 50;
/** Folders read at once. */
const parallel = 8;

export const started = (): Progress => ({ mode: null, scanned: 0, done: false, capped: null, error: null });

/** Walks `root`, giving `sink` its entries in batches and the progress so
 * far, until it's done, capped or `signal` aborts. Resolves with the end. */
export async function walk(
  root: string,
  sink: (batch: Entry[], progress: Progress) => void,
  signal: AbortSignal,
  limit: Limits = limits,
): Promise<Progress> {
  const progress = started(),
    deadline = Date.now() + limit.ms;
  let pending: Entry[] = [],
    flushed = Date.now();
  const flush = (force = false) => {
    if (signal.aborted || (!force && Date.now() - flushed < batch_ms)) return;
    flushed = Date.now();
    const batch = pending;
    pending = [];
    if (batch.length || force) sink(batch, { ...progress });
  };
  /** Takes `entry`; false once the walk should stop. */
  const add = (entry: Entry): boolean => {
    if (progress.scanned >= limit.entries) {
      progress.capped = "entries";
      return false;
    }
    progress.scanned++;
    pending.push(entry);
    return true;
  };
  const stopped = () => {
    if (signal.aborted) return true;
    if (Date.now() < deadline) return false;
    progress.capped ??= "time";
    return true;
  };
  try {
    const listed = await gitFiles(root, add, stopped, flush, signal, deadline);
    if (listed) progress.mode = "git";
    else {
      progress.mode = "files";
      await walkFiles(root, add, stopped, flush);
    }
  } catch (error) {
    if (!signal.aborted) progress.error = errors.name(error) ?? "WalkFailed";
  }
  progress.done = true;
  flush(true);
  return progress;
}

/** Lists `root`'s files through Git, with the folders they name. False,
 * having listed nothing, when it isn't in a work tree or Git has nothing
 * there, as in an ignored folder, which the file system walks instead. */
async function gitFiles(
  root: string,
  add: (entry: Entry) => boolean,
  stopped: () => boolean,
  flush: () => void,
  signal: AbortSignal,
  deadline: number,
): Promise<boolean> {
  const quit = subprocess.Quit.init(),
    folders = new Set<string>();
  const end = () => quit.signal();
  signal.addEventListener("abort", end, { once: true });
  if (signal.aborted) end();
  const timer = setTimeout(end, Math.max(0, deadline - Date.now()));
  let rest: Buffer = Buffer.alloc(0),
    any = false,
    full = false,
    last = "";
  const take = (path: string) => {
    // A conflicted file is listed once for each side of the merge, one after another.
    if (!path || full || path === last) return;
    last = path;
    any = true;
    // The folders a path is in come before it, once each.
    for (let slash = path.indexOf("/"); slash > 0; slash = path.indexOf("/", slash + 1)) {
      const folder = path.slice(0, slash);
      if (folders.has(folder)) continue;
      folders.add(folder);
      if (!add({ path: folder, directory: true })) return void (full = true);
    }
    if (!add({ path, directory: false })) full = true;
  };
  try {
    const out = await subprocess
      .run(["git", "--no-optional-locks", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        timeout_ms: null,
        capture: false,
        quit,
        on_output(bytes, stream) {
          if (stream !== "stdout" || full) return;
          // Split on the NULs, so a character a chunk cuts stays whole.
          let buffer = rest.length ? Buffer.concat([rest, bytes]) : bytes;
          for (let nul = buffer.indexOf(0); nul >= 0 && !full; nul = buffer.indexOf(0)) {
            take(buffer.toString("utf8", 0, nul));
            buffer = buffer.subarray(nul + 1);
          }
          rest = buffer;
          if (full || stopped()) quit.signal();
          flush();
        },
      })
      .catch(error => {
        // Stopped on purpose: what it listed stands.
        if (errors.is(error, "Cancelled") && (full || any || signal.aborted || Date.now() >= deadline)) return null;
        if (errors.is(error, "FileNotFound")) return null;
        throw error;
      });
    if (out && !out.ok()) return false;
    if (out) take(rest.toString("utf8"));
    stopped();
    return any;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", end);
  }
}

/** Walks `root` on the file system, a level at a time and a few folders at
 * once, reading each only as far as the cap and `stopped` allow. */
async function walkFiles(
  root: string,
  add: (entry: Entry) => boolean,
  stopped: () => boolean,
  flush: () => void,
): Promise<void> {
  // Every folder entered, by device and inode: one reached again, through
  // a link or as a link's target, isn't entered twice.
  const seen = new Set<string>();
  const enter = async (path: string): Promise<boolean> => {
    const s = await stat(path, { bigint: true }).catch(() => null);
    const key = s?.isDirectory() ? `${s.dev}:${s.ino}` : null;
    if (key === null || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  if (!(await enter(root))) throw Error("NotADirectory");
  let full = false;
  /** Takes folder `rel`'s entries as they're read, queuing its folders on `next`. */
  const read = async (rel: string, next: string[]): Promise<void> => {
    try {
      const dir = await opendir(join(root, rel), { bufferSize: 256 });
      // Leaving the loop early closes the folder.
      for await (const entry of dir) {
        if (full || stopped()) break;
        if (entry.name === ".git") continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        const directory = entry.isSymbolicLink()
          ? ((await stat(join(root, path)).catch(() => null))?.isDirectory() ?? false)
          : entry.isDirectory();
        if (!add({ path, directory })) {
          full = true;
          break;
        }
        if (directory && (await enter(join(root, path)))) next.push(path);
        flush();
      }
    } catch {
      // Unreadable: nothing more from it.
    }
  };
  let level = [""];
  while (level.length && !full && !stopped()) {
    const next: string[] = [],
      folders = level;
    let at = 0;
    const worker = async () => {
      while (at < folders.length && !full && !stopped()) await read(folders[at++], next);
    };
    await Promise.all(Array.from({ length: Math.min(parallel, folders.length) }, worker));
    level = next;
  }
}
