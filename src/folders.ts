//! What the folder browser reads of a computer's folders. A viewer asks
//! these of its own computer, and a remote machine's daemon answers its
//! viewers with them. Each read is async, so a slow disk holds up only the
//! read that waits on it.
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type * as protocol from "./protocol";

/** What a path holds, a link counting as what it leads to; a link to nothing is a link. */
export type Kind = "folder" | "file" | "link" | "socket" | "pipe" | "device";
export const kinds: readonly Kind[] = ["folder", "file", "link", "socket", "pipe", "device"];
export interface Found {
  kind: Kind;
  size: number;
  /** When it was last modified, in milliseconds since the epoch. */
  modified: number;
}
/** The deepest part of a path that is there, and what stands there. */
export interface Deepest {
  path: string;
  found: Found;
}
/** Why a folder couldn't be used: a file has its name, or making it failed. */
export type Problem = "not_folder" | "not_created";
export const problems: readonly Problem[] = ["not_folder", "not_created"];
/** A folder's real path, or why there is none. */
export type Opened = { path: string } | { problem: Problem };

export type Op = "folder.list" | "folder.find" | "folder.open";
/** A folder request answered from this computer's folders:
 * - `folder.list`, the folders in a folder, null when it can't be read, and the home folder;
 * - `folder.find`, the deepest part of a path that is there;
 * - `folder.open`, a folder's real path, made with the folders above it when it isn't there yet. */
export async function answer(request: Extract<protocol.DecodedRequest, { op: Op }>): Promise<object> {
  const path = named(request.payload.path);
  switch (request.op) {
    case "folder.list":
      return { folders: await subfolders(path), home: homedir() };
    case "folder.find":
      return { deepest: await deepest(path) };
    case "folder.open":
      return { opened: await open(path) };
  }
}
/** A path a viewer named: absolute, or under this computer's home folder as
 * `~`, for a viewer that doesn't know it yet. */
export function named(path: string, home = homedir()): string {
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  if (!isAbsolute(expanded) || Buffer.byteLength(expanded) > 4096) throw Error("InvalidDirectory");
  return expanded;
}

/** Names in a folder that are folders themselves, links to them included,
 * sorted; null when it can't be read. */
async function subfolders(folder: string): Promise<string[] | null> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  const shown = await Promise.all(
    entries.map(e =>
      e.isSymbolicLink()
        ? stat(join(folder, e.name)).then(
            s => s.isDirectory(),
            () => false,
          )
        : e.isDirectory(),
    ),
  );
  return entries
    .filter((_, i) => shown[i])
    .map(e => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
/** What is at a path, or null when nothing is. */
async function found(path: string): Promise<Found | null> {
  const s = await stat(path)
    .catch(() => lstat(path))
    .catch(() => null);
  return s && { kind: kind(s), size: s.size, modified: s.mtimeMs };
}
function kind(s: Stats): Kind {
  if (s.isDirectory()) return "folder";
  if (s.isFile()) return "file";
  if (s.isSymbolicLink()) return "link";
  if (s.isSocket()) return "socket";
  if (s.isFIFO()) return "pipe";
  return "device";
}
/** `path`, or the nearest folder above it that is there, and what stands
 * there; null when nothing is. */
async function deepest(path: string): Promise<Deepest | null> {
  let there = await found(path);
  while (there === null && path !== dirname(path)) there = await found((path = dirname(path)));
  return there === null ? null : { path, found: there };
}
async function open(path: string): Promise<Opened> {
  const s = await stat(path).catch(() => null);
  if (s && !s.isDirectory()) return { problem: "not_folder" };
  try {
    if (!s) await mkdir(path, { recursive: true });
    return { path: await realpath(path) };
  } catch {
    return { problem: "not_created" };
  }
}
