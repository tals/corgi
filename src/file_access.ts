//! The files the file peek and a link's picture read, and names in panes
//! resolve to: this computer's through node:fs, or another computer's
//! through its daemon, which reads its own the same way. Scans, such as for
//! a deep line, and an image's thumbnail are made where the file is, and
//! another computer's files are read in smaller amounts, since they share
//! its link with the panes' screens. A scan for a line keeps a line index
//! where the file is (see `line_index.ts`), and on another computer runs as
//! a job (see `jobs.ts`), so its progress shows and leaving it stops it.
import { constants, fstatSync, readSync, watch, type BigIntStats } from "node:fs";
import { open, stat, statfs, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import * as errors from "./errors";
import * as fileRef from "./file_ref";
import * as jobs from "./jobs";
import * as lineIndex from "./line_index";
import * as picture from "./picture";
import type * as protocol from "./protocol";

/** A file as a read checks it. */
export interface Info {
  path: string;
  size: number;
  mtime: number;
  /** The same while the path names the same file: its device and inode. */
  id: string;
}
/** An open file. A scan calls `stop` as it goes, which throws to end it. */
export interface Handle {
  info(): Promise<Info>;
  /** Up to `length` bytes at `at`, fewer past the end. */
  read(at: number, length: number): Promise<Uint8Array>;
  /** Where 1-based line `n` starts, found from the file's line index and
   * scanning at most `budget` bytes past it: further than that is `far`,
   * for a reader to ask before scanning on. */
  find(n: number, opts: lineIndex.FindOptions): Promise<lineIndex.Found>;
  /** The newlines from `from` to `to`. */
  newlines(from: number, to: number, stop: () => void): Promise<number>;
  close(): Promise<void>;
  /** On a local disk, its size and reads without async round trips. */
  now: { size(): number; read(at: number, length: number): Uint8Array } | null;
}
/** How much of a file a reader takes at once. */
export interface Limits {
  /** The largest file read whole, as code. */
  whole: number;
  /** The most a followed file grows between reads before reading starts again at its end. */
  growth: number;
  /** The most pixels an animated thumbnail's frames hold together. */
  frames: number;
}
export const local_limits: Limits = { whole: 8 << 20, growth: 16 << 20, frames: 24_000_000 };
export const remote_limits: Limits = { whole: 1 << 20, growth: 256 << 10, frames: 4_000_000 };
export interface Files {
  limits: Limits;
  /** The file `path` names from `cwd`, as a pane's text names it; throws when it names none. */
  find(path: string, cwd?: string): Promise<Info>;
  open(path: string): Promise<Handle>;
  /** Change notices for `path` where the file system sends them, else null.
   * `lost` says a watch that worked has stopped. */
  watch(path: string, notice: (renamed: boolean) => void, lost: () => void): { close(): void } | null;
  /** The image at `path` shrunk to fit `box`, made where it is; throws when it isn't one. */
  thumbnail(path: string, box: picture.Box, wanted?: () => boolean): Promise<picture.Picture>;
}

/** The most a reader scans for a line on its own before asking first: a
 * moment from a disk, warm or cold (about 30 ms from the page cache, under
 * half a second from a laptop's SSD), well inside the second the peek waits
 * to open. A whole file under it, a line near the start of one over it, and
 * a line the index already passed are found without asking; the scan keeps
 * what it read, so asking resumes where it left off. */
export const ask_after = 32 << 20;
/** The most bytes one count of newlines reads for another computer. */
const count_limit = 64 << 20;
/** The most bytes one reply from a daemon carries; a longer read asks for several at once. */
export const read_limit = 64 << 10;
/** The largest image file shrunk for a thumbnail, or copied here to open. */
export const image_limit = 128 << 20;
/** The most a daemon's thumbnail reply carries, as base64. It shares the
 * data connection with pane screens, which a reply past 4 MiB would close. */
export const thumbnail_limit = 512 << 10;
const chunk_size = 1 << 20;
/** Linux's local file systems, by `statfs` magic: ext2-4, xfs, btrfs,
 * tmpfs, f2fs, zfs, bcachefs and overlayfs. They answer reads of a log's
 * growth at once, so it reads without async calls' round trips; a network
 * or FUSE mount could stall the viewer that way and keeps them. */
const local_fs = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0xf2f52010, 0x2fc12fc1, 0xca451a4e, 0x794c7630]);

const info = (path: string, s: BigIntStats): Info => ({
  path,
  size: Number(s.size),
  mtime: Number(s.mtimeNs) / 1e6,
  id: `${s.dev}:${s.ino}`,
});
function readNow(fd: number, at: number, length: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, length));
  let got = 0;
  while (got < out.length) {
    const n = readSync(fd, out, got, out.length - got, at + got);
    if (n === 0) break;
    got += n;
  }
  return out.subarray(0, got);
}
class LocalHandle implements Handle {
  readonly now: Handle["now"];
  private index: lineIndex.LineIndex | null = null;
  constructor(
    private path: string,
    private fh: FileHandle,
    local: boolean,
  ) {
    this.now = local ? { size: () => fstatSync(fh.fd).size, read: (at, length) => readNow(fh.fd, at, length) } : null;
  }
  async info(): Promise<Info> {
    return info(this.path, await this.fh.stat({ bigint: true }));
  }
  async read(at: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(Math.max(0, length));
    let got = 0;
    while (got < out.length) {
      const { bytesRead } = await this.fh.read(out, got, out.length - got, at + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return out.subarray(0, got);
  }
  async find(n: number, opts: lineIndex.FindOptions): Promise<lineIndex.Found> {
    this.index ??= await lineIndex.LineIndex.load(this);
    return lineIndex.find(this, this.index, n, opts);
  }
  async newlines(from: number, to: number, stop: () => void): Promise<number> {
    const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(chunk_size, to - from)));
    let count = 0;
    for (let at = from; at < to;) {
      stop();
      const { bytesRead } = await this.fh.read(chunk, 0, Math.min(chunk.length, to - at), at);
      if (bytesRead === 0) break;
      for (let i = chunk.indexOf(10); i >= 0 && i < bytesRead; i = chunk.indexOf(10, i + 1)) count++;
      at += bytesRead;
    }
    return count;
  }
  close(): Promise<void> {
    return this.fh.close();
  }
}
/** This computer's files, with `~` as `home`. */
export function local(home = homedir()): Files {
  return {
    limits: local_limits,
    async find(path, cwd = "") {
      let failure: unknown = null;
      for (const candidate of fileRef.candidates(path, cwd, home)) {
        try {
          const found = await stat(candidate, { bigint: true });
          if (found.isFile()) return info(candidate, found);
          failure ??= Error("NotAFile");
        } catch (error) {
          failure ??= error;
        }
      }
      throw failure ?? Error("NotAFile");
    },
    async open(path) {
      // A FIFO's open would wait for a writer, and only files are read.
      const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!(await fh.stat().catch(() => null))?.isFile()) {
        await fh.close().catch(() => {});
        throw Error("NotAFile");
      }
      const fs = process.platform === "linux" ? await statfs(path).catch(() => null) : null;
      return new LocalHandle(path, fh, fs !== null && local_fs.has(fs.type));
    },
    watch(path, notice, lost) {
      try {
        const watcher = watch(path, { persistent: false }, event => notice(event === "rename"));
        watcher.on("error", () => {
          watcher.close();
          lost();
        });
        return watcher;
      } catch {
        return null;
      }
    },
    async thumbnail(path, box, wanted) {
      return picture.shrink(await readAll(this, path, image_limit, wanted), box, local_limits.frames, wanted);
    },
  };
}
export const here = local();

/** The file at `path` whole, read a megabyte at a time while `wanted`;
 * throws `TooLarge` when it's over `limit`. */
export async function readAll(
  files: Files,
  path: string,
  limit: number,
  wanted: () => boolean = () => true,
): Promise<Uint8Array> {
  const fh = await files.open(path);
  try {
    const { size } = await fh.info();
    if (size > limit) throw Error("TooLarge");
    const parts: Uint8Array[] = [];
    for (let got = 0; got < size;) {
      if (!wanted()) throw Error("Aborted");
      const bytes = await fh.read(got, Math.min(chunk_size, size - got));
      if (bytes.length === 0) break;
      parts.push(bytes);
      got += bytes.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** What another computer's daemon is asked: reads, and the scan for a line as a job. */
export type RemoteOp = Op | "file.scan" | "job.poll" | "job.cancel";
/** Sends `op` to a daemon and resolves with its reply, throwing its error. */
export type Call = (op: RemoteOp, payload: object) => Promise<unknown>;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const toBase64 = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.length).toString("base64");
const fromBase64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : "", "base64");
/** Another computer's files, read through its daemon. They send no change
 * notices: a reader polls. An open one is read by its path, so each request
 * names the file it opened, and once the path names another, as after a
 * log's rotation, they throw `FileChanged` rather than mix the two. */
export function remote(call: Call): Files {
  const find = async (path: string, cwd = ""): Promise<Info> => {
    const reply = (await call("file.stat", { path, cwd })) as Record<string, unknown>;
    if (typeof reply.path !== "string" || typeof reply.id !== "string") throw Error("UnexpectedReply");
    return { path: reply.path, size: num(reply.size), mtime: num(reply.mtime), id: reply.id };
  };
  return {
    limits: remote_limits,
    find,
    async open(path) {
      // Fails as opening a file that isn't there would; its answer is the first `info`.
      let first: Info | null = await find(path);
      const id = first.id;
      return {
        now: null,
        async info() {
          const found = first ?? (await find(path));
          first = null;
          if (found.id !== id) throw Error("FileChanged");
          return found;
        },
        async read(at, length) {
          // The parts are asked for together, so a block takes one round trip.
          const parts = await Promise.all(
            Array.from({ length: Math.ceil(Math.max(0, length) / read_limit) }, async (_, i) => {
              const want = Math.min(read_limit, length - i * read_limit);
              const reply = (await call("file.read", { path, id, at: at + i * read_limit, length: want })) as {
                data?: unknown;
              };
              return { want, bytes: fromBase64(reply.data) };
            }),
          );
          // The file ends at the first part short of what it asked for.
          const short = parts.findIndex(part => part.bytes.length < part.want);
          const kept = (short < 0 ? parts : parts.slice(0, short + 1)).map(part => part.bytes);
          return kept.length === 1 ? kept[0] : Buffer.concat(kept);
        },
        async find(n, opts) {
          // The daemon scans as a job, with its index: polls bring the scan's progress.
          let found: lineIndex.Found = { kind: "missing", size: 0 };
          const start = () =>
            call("file.scan", {
              path,
              id,
              line: n,
              budget: Math.min(opts.budget, Number.MAX_SAFE_INTEGER),
              wait: jobs.poll_wait,
            });
          await jobs.follow(call, start, {
            signal: opts.signal,
            progress: p => opts.progress?.(progress(p)),
            result: r => (found = foundOn(r)),
          });
          return found;
        },
        async newlines(from, to, stop) {
          stop();
          return num(((await call("file.count", { path, id, from, to })) as { lines?: unknown }).lines);
        },
        close: async () => {},
      };
    },
    watch: () => null,
    async thumbnail(path, box) {
      const { width, height } = box,
        pixels = remote_limits.frames;
      return received((await call("file.thumbnail", { path, width, height, pixels })) as Record<string, unknown>);
    },
  };
}
/** A thumbnail as a daemon sent it. */
function received(reply: Record<string, unknown>): picture.Picture {
  const frames: unknown[] = Array.isArray(reply.frames) ? reply.frames : [];
  const shrunk: picture.Picture = {
    width: num(reply.width),
    height: num(reply.height),
    png: fromBase64(reply.png),
    delay: num(reply.delay),
    frames: frames.map(frame => {
      const f = (frame ?? {}) as Record<string, unknown>;
      return { png: fromBase64(f.png), x: num(f.x), y: num(f.y), base: num(f.base), delay: num(f.delay) };
    }),
  };
  if (shrunk.width <= 0 || shrunk.height <= 0 || shrunk.png.length === 0) throw Error("UnexpectedReply");
  return shrunk;
}
/** The sizes a picture too big to send is made again at, all at once, as
 * parts of the size its area says fits: smaller ones hold more detail a pixel. */
const retries = [1, 0.9, 0.8, 0.65];
/** The image `bytes` hold shrunk to fit `box` and a reply of `limit` bytes.
 * One too big is made again at a few sizes about the one its area says
 * fits, and the largest that fits is sent. An animation that would shrink
 * past half its size shows still instead. */
export async function sendable(
  bytes: Uint8Array,
  box: picture.Box,
  pixels: number,
  limit: number,
): Promise<picture.Picture> {
  const base64 = (p: picture.Picture) =>
    [p.png, ...p.frames.map(f => f.png)].reduce((sum, png) => sum + 4 * Math.ceil(png.length / 3), 0);
  let shrunk = await picture.shrink(bytes, box, pixels);
  for (let round = 0; base64(shrunk) > limit; round++) {
    if (round === 3) throw Error("TooLarge");
    const animated = shrunk.frames.length > 0,
      scale = Math.sqrt(limit / base64(shrunk));
    if (animated && scale < 0.5) {
      shrunk = await picture.shrink(bytes, box, 0);
      continue;
    }
    const from = shrunk;
    // Bun.Image works off the main thread, so they're made together.
    const made = await Promise.all(
      retries.map(part => {
        const width = Math.max(1, Math.floor(from.width * scale * part)),
          height = Math.max(1, Math.floor(from.height * scale * part));
        return picture.shrink(bytes, { width, height }, animated ? pixels : 0);
      }),
    );
    const fit = made.find(p => base64(p) <= limit);
    if (fit) return fit;
    // None fit: an animation shows still, and a still starts again from the smallest.
    shrunk = animated ? await picture.shrink(bytes, box, 0) : made[made.length - 1];
  }
  return shrunk;
}

/** A scan's progress and answer as a daemon sent them. */
const progress = (value: unknown): lineIndex.Progress => {
  const p = (value ?? {}) as Record<string, unknown>;
  return { scanned: num(p.scanned), size: num(p.size), lines: num(p.lines) };
};
function foundOn(value: unknown): lineIndex.Found {
  const f = (value ?? {}) as Record<string, unknown>;
  switch (f.kind) {
    case "found":
      return { kind: "found", at: num(f.at) };
    case "far":
      return { kind: "far", bytes: num(f.bytes) };
    default:
      return { kind: "missing", size: num(f.size) };
  }
}
/** Finds a line for another computer, as a job it polls: the index stays
 * here, with the file, and `job.signal` stops a scan it lost interest in. */
export async function scan(payload: protocol.Request<"file.scan">, job: jobs.Job): Promise<lineIndex.Found> {
  const h = await here.open(payload.path);
  try {
    if ((await h.info()).id !== payload.id) throw Error("FileChanged");
    return await h.find(Number(payload.line), {
      budget: Number(payload.budget),
      signal: job.signal,
      progress: p => job.progress(p),
    });
  } finally {
    await h.close().catch(() => {});
  }
}

export type Op = "file.stat" | "file.read" | "file.count" | "file.thumbnail";
/** Answers another computer's read of a file here, as its daemon decoded it. */
export async function answer(request: Extract<protocol.DecodedRequest, { op: Op }>): Promise<object> {
  if (request.op === "file.stat") return await here.find(request.payload.path, request.payload.cwd);
  if (request.op === "file.thumbnail") {
    const { path, width, height, pixels } = request.payload;
    const shrunk = await sendable(await readAll(here, path, image_limit), { width, height }, pixels, thumbnail_limit);
    return { ...shrunk, png: toBase64(shrunk.png), frames: shrunk.frames.map(f => ({ ...f, png: toBase64(f.png) })) };
  }
  const h = await here.open(request.payload.path);
  try {
    if ((await h.info()).id !== request.payload.id) throw Error("FileChanged");
    switch (request.op) {
      case "file.read": {
        return {
          data: toBase64(await h.read(Number(request.payload.at), Math.min(request.payload.length, read_limit))),
        };
      }
      case "file.count": {
        // A count fits one reply: it's bounded, as a request on a shared connection must be.
        const from = Number(request.payload.from),
          to = Math.min(Number(request.payload.to), from + count_limit);
        return { lines: await h.newlines(from, to, () => {}) };
      }
    }
  } finally {
    await h.close().catch(() => {});
  }
}
