//! What the folder browser reads of a computer's folders: the viewer's own
//! from its disk, and a remote machine's through its daemon, which answers
//! with these same reads.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

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

/** Names in a folder that are folders themselves, or null when it can't be read. */
export function subfolders(folder: string): string[] | null {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  const names: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) names.push(e.name);
    else if (e.isSymbolicLink())
      try {
        if (statSync(join(folder, e.name)).isDirectory()) names.push(e.name);
      } catch {}
  }
  return names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** What is at a path, or null when nothing is. */
export function stat(path: string): Found | null {
  let s: Stats;
  try {
    s = statSync(path);
  } catch {
    try {
      s = lstatSync(path);
    } catch {
      return null;
    }
  }
  return { kind: kind(s), size: s.size, modified: s.mtimeMs };
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
export function deepest(path: string, at: (path: string) => Found | null = stat): Deepest | null {
  let found = at(path);
  while (found === null && path !== dirname(path)) found = at((path = dirname(path)));
  return found === null ? null : { path, found };
}

export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Makes `path` and the folders above it; false when it can't. */
export function make(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    return isFolder(path);
  } catch {
    return false;
  }
}

/** The real path of folder `path`, made with the folders above it when it
 * isn't there yet. */
export function open(path: string): Opened {
  if (isFolder(path)) return { path: realpathSync(path) };
  if (existsSync(path)) return { problem: "not_folder" };
  if (make(path)) return { path: realpathSync(path) };
  return { problem: "not_created" };
}
