//! What's under a directory, for the directory browser's search: inside a
//! Git work tree, the files `git ls-files` lists, tracked and untracked but
//! not ignored, with the folders they're in; elsewhere, the file system's
//! entries, breadth first, skipping `.git` and never entering a folder twice
//! through a link. Entries arrive in batches as they're found. A walk stops
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
    full = false;
  const take = (path: string) => {
    if (!path || full) return;
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

/** Walks `root` on the file system, a level at a time. */
async function walkFiles(
  root: string,
  add: (entry: Entry) => boolean,
  stopped: () => boolean,
  flush: () => void,
): Promise<void> {
  const seen = new Set<string>();
  const id = async (path: string) => {
    const s = await stat(path, { bigint: true }).catch(() => null);
    return s?.isDirectory() ? `${s.dev}:${s.ino}` : null;
  };
  const top = await id(root);
  if (top === null) throw Error("NotADirectory");
  seen.add(top);
  let level = [""];
  let full = false;
  while (level.length && !full && !stopped()) {
    const next: string[] = [];
    for (let i = 0; i < level.length && !full && !stopped(); i += parallel) {
      const read = await Promise.all(level.slice(i, i + parallel).map(rel => list(root, rel)));
      for (const entries of read)
        for (const { rel, directory, link } of entries) {
          if (!add({ path: rel, directory })) {
            full = true;
            break;
          }
          if (!directory) continue;
          // A folder reached through a link is entered once, wherever else it's reached from.
          if (link) {
            const key = await id(join(root, rel));
            if (key === null || seen.has(key)) continue;
            seen.add(key);
          }
          next.push(rel);
        }
      flush();
    }
    level = next;
  }
}
/** A folder's entries, as paths from `root`; a folder that can't be read has none. */
async function list(root: string, rel: string): Promise<{ rel: string; directory: boolean; link: boolean }[]> {
  const out: { rel: string; directory: boolean; link: boolean }[] = [];
  try {
    const dir = await opendir(join(root, rel), { bufferSize: 256 });
    for await (const entry of dir) {
      if (entry.name === ".git") continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const target = await stat(join(root, path)).catch(() => null);
        out.push({ rel: path, directory: target?.isDirectory() ?? false, link: true });
      } else out.push({ rel: path, directory: entry.isDirectory(), link: false });
    }
  } catch {
    // Unreadable: nothing to add.
  }
  return out;
}
