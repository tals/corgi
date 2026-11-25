//! Another computer's image, copied here for this computer's desktop viewer
//! to open. Each copy gets a new private folder in the temporary directory
//! and keeps the image's own name, so its type shows. A viewer's copies stay
//! until it exits, since the desktop's viewer may read them late; one an
//! earlier viewer left, as when it crashed, goes at the next copy once it's
//! a day old.
import { rmSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
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

export class Copies {
  /** The folders of this viewer's copies. */
  private made = new Set<string>();
  constructor(
    private root = tmpdir(),
    private limit = fileAccess.image_limit,
  ) {}
  /** Copies the image `files` has at `path` here, and resolves with the copy's path. */
  async fetch(files: fileAccess.Files, path: string): Promise<string> {
    const name = copyName(path);
    if (!linkThumbnail.isImage(name)) throw Error("NotAnImage");
    await this.sweep();
    const from = await files.open(path);
    try {
      const { size } = await from.info();
      if (size > this.limit) throw Error("TooLarge");
      const dir = await mkdtemp(join(this.root, prefix));
      this.made.add(dir);
      const copy = join(dir, name);
      try {
        await write(from, size, copy, files.limits.whole);
      } catch (error) {
        this.made.delete(dir);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return copy;
    } finally {
      await from.close().catch(() => {});
    }
  }
  /** Removes this viewer's copies. */
  close(): void {
    for (const dir of this.made)
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    this.made.clear();
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
    for (let got = 0; got < size;) {
      const want = Math.min(step, size - got);
      // A reply carrying more than was asked for doesn't get past the limit.
      const bytes = (await from.read(got, want)).subarray(0, want);
      if (bytes.length === 0) break;
      for (let put = 0; put < bytes.length;)
        put += (await out.write(bytes, put, bytes.length - put, got + put)).bytesWritten;
      got += bytes.length;
    }
  } finally {
    await out.close();
  }
}
