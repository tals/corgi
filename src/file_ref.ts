//! A file a pane's text names: a path the native layer found in plain text
//! (`Link.path`), or a file:// link, with the line and column the text gave.
//! The viewer checks that it names a file on the pane's machine before it
//! underlines it, peeks at it or opens it.
import { homedir, hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type * as fileAccess from "./file_access";

export interface Ref {
  path: string;
  /** 1-based, as the text gave them. */
  line: number | null;
  column: number | null;
}
/** A line or column the text gave; null for none, or for 0, which none is. */
const count = (digits: string | undefined) => {
  const n = Number(digits ?? 0);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
};
/** The file `uri` names: a found path's text, which is the path then
 * `:line` or `:line:column`, or a file:// link to `host`, or to any host
 * when `host` is null, as on a computer whose name isn't known. */
export function parse(uri: string, path: boolean, host: string | null = hostname().toLowerCase()): Ref | null {
  if (path) {
    const m = /^([^:]+)(?::(\d+)(?::(\d+))?)?$/.exec(uri);
    return m ? { path: m[1], line: count(m[2]), column: count(m[3]) } : null;
  }
  if (!/^file:\/\//i.test(uri)) return null;
  let url: URL, name: string;
  try {
    url = new URL(uri);
    name = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // URLs lowercase their host; macOS names often aren't.
  const named = url.hostname;
  if (host !== null && named !== "" && named !== "localhost" && named !== host) return null;
  if (!name || /[\x00-\x1f\x7f]/.test(name)) return null;
  // Tools put the line after the path or in the fragment, as `#L12` or `#12`.
  const fragment = /^#L?(\d+)(?::(\d+)|C(\d+))?$/i.exec(url.hash);
  if (fragment) return { path: name, line: count(fragment[1]), column: count(fragment[2] ?? fragment[3]) };
  const m = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(name)!;
  return { path: m[1], line: count(m[2]), column: count(m[3]) };
}
/** Where `path` leads from `cwd`, with `~` as the home folder. */
export function absolute(path: string, cwd: string, home = homedir()): string {
  if (path === "~" || path.startsWith("~/")) return resolve(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd || home, path);
}
/** Where to look for `path`: as written, then without a diff's `a/` or `b/`. */
export function candidates(path: string, cwd: string, home = homedir()): string[] {
  const out = [absolute(path, cwd, home)];
  if (/^[ab]\//.test(path)) out.push(absolute(path.slice(2), cwd, home));
  return out;
}

type Found = { kind: "missing" } | { kind: "file"; path: string; size: number };
export type Status = { kind: "pending"; ready: Promise<Found> } | Found;
interface Entry {
  status: Found | null;
  at: number;
  checking: Promise<Found> | null;
}
/** How long an answer holds before the next ask checks again. */
const fresh_ms = 3000;
const max_entries = 512;
/** Whether the names in a machine's panes are its files, checked in the
 * background and remembered a while; `wake` redraws once an answer changes. */
export class Resolver {
  private entries = new Map<string, Entry>();
  /** The checks in flight, for tests to wait on. */
  checks = new Set<Promise<Found>>();
  constructor(
    private wake: () => void,
    private files: fileAccess.Files,
  ) {}
  get(ref: Ref, cwd: string, { now = Date.now(), fresh = false } = {}): Status {
    const key = `${cwd}\0${ref.path}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= max_entries) this.entries.delete(this.entries.keys().next().value!);
      entry = { status: null, at: now, checking: null };
      this.entries.set(key, entry);
    }
    if (!entry.checking && (entry.status === null || now - entry.at >= fresh_ms)) {
      entry.at = now;
      const check = this.check(entry, ref.path, cwd);
      entry.checking = check;
      this.checks.add(check);
      void check.finally(() => this.checks.delete(check));
    }
    if (entry.status && !(fresh && entry.checking)) return entry.status;
    return { kind: "pending", ready: entry.checking! };
  }
  private async check(entry: Entry, path: string, cwd: string): Promise<Found> {
    const info = await this.files.find(path, cwd).catch(() => null);
    const found: Found = info ? { kind: "file", path: info.path, size: info.size } : { kind: "missing" };
    entry.checking = null;
    const before = entry.status;
    entry.status = found;
    if (before?.kind !== found.kind || (before.kind === "file" && found.kind === "file" && before.path !== found.path))
      this.wake();
    return found;
  }
}
