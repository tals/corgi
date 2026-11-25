//! Another computer's image, copied here for this computer's desktop viewer
//! to open. Each copy gets a new private folder in the temporary directory
//! and keeps the image's own name, so its type shows; opening it again uses
//! the same copy until the image changes. A viewer's copies stay until it
//! exits, since the desktop's viewer may read them late; one an earlier
//! viewer left, as when it crashed, goes at the next copy once it's a day old.
import { rmSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, posix } from "node:path";
import * as fileAccess from "./file_access";
import * as linkThumbnail from "./link_thumbnail";

const prefix = "corgi-image-copy-";
/** How old an earlier viewer's copy is before the next copy removes it. */
const stale_ms = 24 * 60 * 60 * 1000;

/** The name a copy of `path` takes: its last part, with control characters
 * replaced, and never one that leads out of its folder. */
export function copyName(path: string): string {
  const name = posix.basename(path).replace(/[\x00-\x1f\x7f-\x9f]/g, "_");
  return name === "" || name === "." || name === ".." ? "image" : name;
}

/** A finished copy, and the file it was copied from. */
interface Copy {
  path: string;
  from: fileAccess.Info;
}
export class Copies {
  /** The folders of this viewer's copies. */
  private made = new Set<string>();
  /** Copies under way, by the computer's files and the image's path there. */
  private running = new WeakMap<fileAccess.Files, Map<string, Promise<string>>>();
  /** The last finished copy of each, likewise. */
  private copied = new WeakMap<fileAccess.Files, Map<string, Copy>>();
  private closed = false;
  constructor(
    private root = tmpdir(),
    private limit = fileAccess.image_limit,
  ) {}
  /** Copies the image `files` has at `path` here, and resolves with the
   * copy's path. Asking again while it copies waits for the same copy, and
   * asking after gets it back until the image changes. */
  fetch(files: fileAccess.Files, path: string): Promise<string> {
    const name = copyName(path);
    if (!linkThumbnail.isImage(name)) return Promise.reject(Error("NotAnImage"));
    if (this.closed) return Promise.reject(Error("Closed"));
    const running = mapOf(this.running, files);
    let copy = running.get(path);
    if (!copy) {
      copy = this.copy(files, path, name).finally(() => running.delete(path));
      running.set(path, copy);
    }
    return copy;
  }
  /** Removes this viewer's copies, and any that finish after. */
  close(): void {
    this.closed = true;
    for (const dir of this.made)
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    this.made.clear();
  }
  private async copy(files: fileAccess.Files, path: string, name: string): Promise<string> {
    await this.sweep();
    const from = await files.open(path);
    try {
      const info = await from.info();
      if (info.size > this.limit) throw Error("TooLarge");
      const copied = mapOf(this.copied, files),
        kept = copied.get(path);
      if (kept && same(kept.from, info) && (await stat(kept.path).catch(() => null))?.size === info.size)
        return kept.path;
      const dir = await mkdtemp(join(this.root, prefix));
      this.made.add(dir);
      const copy = join(dir, name);
      try {
        await write(from, info.size, copy, files.limits.whole);
        // A file still being written, or rewritten, while it copied would open cut short or mixed.
        if (!same(await from.info(), info)) throw Error("FileChanged");
        if (this.closed) throw Error("Closed");
      } catch (error) {
        this.made.delete(dir);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      copied.set(path, { path: copy, from: info });
      return copy;
    } finally {
      await from.close().catch(() => {});
    }
  }
  /** Removes the copies earlier viewers left a day or more ago. */
  private async sweep(): Promise<void> {
    const uid = process.getuid?.() ?? userInfo().uid,
      now = Date.now();
    for (const entry of await readdir(this.root).catch(() => [])) {
      const dir = join(this.root, entry);
      if (!entry.startsWith(prefix) || this.made.has(dir)) continue;
      const found = await lstat(dir).catch(() => null);
      if (!found?.isDirectory() || found.uid !== uid || now - found.mtimeMs < stale_ms) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
/** Writes `size` bytes of `from` to a new file at `to`, `step` at a time. */
async function write(from: fileAccess.Handle, size: number, to: string, step: number): Promise<void> {
  const out = await open(to, "wx", 0o600);
  try {
    let got = 0;
    while (got < size) {
      const want = Math.min(step, size - got);
      // A reply carrying more than was asked for doesn't get past the limit.
      const bytes = (await from.read(got, want)).subarray(0, want);
      // The file ended early: it shrank, or was still being written.
      if (bytes.length === 0) throw Error("FileChanged");
      for (let put = 0; put < bytes.length;)
        put += (await out.write(bytes, put, bytes.length - put, got + put)).bytesWritten;
      got += bytes.length;
    }
  } finally {
    await out.close();
  }
}
function same(a: fileAccess.Info, b: fileAccess.Info): boolean {
  return a.id === b.id && a.size === b.size && a.mtime === b.mtime;
}
function mapOf<V>(maps: WeakMap<fileAccess.Files, Map<string, V>>, files: fileAccess.Files): Map<string, V> {
  let map = maps.get(files);
  if (!map) maps.set(files, (map = new Map()));
  return map;
}
