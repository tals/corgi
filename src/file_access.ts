//! The files the file peek reads and names in panes resolve to: this
//! computer's through node:fs, or another computer's through its daemon,
//! which reads its own the same way. Scans, such as for a deep line, run
//! where the file is, and another computer's files are read in smaller
//! amounts, since they share its link with the panes' screens.
import { constants, fstatSync, readSync, watch, type BigIntStats } from "node:fs";
import { open, stat, statfs, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import * as errors from "./errors";
import * as fileRef from "./file_ref";
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
  /** Where 1-based line `n` starts, looked for in the first `limit` bytes; -1 when it isn't there. */
  line(n: number, limit: number, stop: () => void): Promise<number>;
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
}
export const local_limits: Limits = { whole: 8 << 20, growth: 16 << 20 };
export const remote_limits: Limits = { whole: 1 << 20, growth: 256 << 10 };
export interface Files {
  limits: Limits;
  /** The file `path` names from `cwd`, as a pane's text names it; throws when it names none. */
  find(path: string, cwd?: string): Promise<Info>;
  open(path: string): Promise<Handle>;
  /** Change notices for `path` where the file system sends them, else null.
   * `lost` says a watch that worked has stopped. */
  watch(path: string, notice: (renamed: boolean) => void, lost: () => void): { close(): void } | null;
}

/** The most bytes one scan reads. */
export const scan_limit = 4 * 1024 ** 3;
/** How long a daemon scans for a line before answering that it didn't find it. */
export const scan_ms = 10_000;
/** The most bytes one reply from a daemon carries; a longer read asks for several at once. */
export const read_limit = 64 << 10;
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
  async line(n: number, limit: number, stop: () => void): Promise<number> {
    if (n <= 1) return 0;
    const chunk = Buffer.allocUnsafe(chunk_size);
    let at = 0,
      seen = 1;
    while (at < Math.min(limit, scan_limit)) {
      // Scanning gigabytes stops once its reader is gone.
      stop();
      const { bytesRead } = await this.fh.read(chunk, 0, chunk.length, at);
      if (bytesRead === 0) break;
      for (let i = chunk.indexOf(10); i >= 0 && i < bytesRead; i = chunk.indexOf(10, i + 1))
        if (++seen === n) return at + i + 1;
      at += bytesRead;
    }
    return -1;
  }
  async newlines(from: number, to: number, stop: () => void): Promise<number> {
    to = Math.min(to, from + scan_limit);
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
  };
}
export const here = local();

/** Sends `op` to a daemon and resolves with its reply, throwing its error. */
export type Call = (op: Op, payload: object) => Promise<unknown>;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** Another computer's files, read through its daemon. They send no change
 * notices: a reader polls. */
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
      return {
        now: null,
        async info() {
          const found = first ?? (await find(path));
          first = null;
          return found;
        },
        async read(at, length) {
          // The parts are asked for together, so a block takes one round trip.
          const parts = await Promise.all(
            Array.from({ length: Math.ceil(Math.max(0, length) / read_limit) }, async (_, i) => {
              const want = Math.min(read_limit, length - i * read_limit);
              const reply = (await call("file.read", { path, at: at + i * read_limit, length: want })) as {
                data?: unknown;
              };
              return { want, bytes: Buffer.from(typeof reply.data === "string" ? reply.data : "", "base64") };
            }),
          );
          // The file ends at the first part short of what it asked for.
          const short = parts.findIndex(part => part.bytes.length < part.want);
          const kept = (short < 0 ? parts : parts.slice(0, short + 1)).map(part => part.bytes);
          return kept.length === 1 ? kept[0] : Buffer.concat(kept);
        },
        async line(n, limit, stop) {
          stop();
          const at = ((await call("file.line", { path, line: n, limit })) as { at?: unknown }).at;
          return typeof at === "number" && Number.isSafeInteger(at) ? at : -1;
        },
        async newlines(from, to, stop) {
          stop();
          return num(((await call("file.count", { path, from, to })) as { lines?: unknown }).lines);
        },
        close: async () => {},
      };
    },
    watch: () => null,
  };
}

export type Op = "file.stat" | "file.read" | "file.line" | "file.count";
/** Answers another computer's read of a file here, as its daemon decoded it. */
export async function answer(request: Extract<protocol.DecodedRequest, { op: Op }>): Promise<object> {
  if (request.op === "file.stat") return await here.find(request.payload.path, request.payload.cwd);
  const h = await here.open(request.payload.path);
  // A scan stops short of the request's timeout, which would drop the connection it shares.
  const deadline = Date.now() + scan_ms,
    budget = () => {
      if (Date.now() > deadline) throw Error("ScanTooLong");
    };
  try {
    switch (request.op) {
      case "file.read": {
        const bytes = await h.read(Number(request.payload.at), Math.min(request.payload.length, read_limit));
        return { data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("base64") };
      }
      case "file.line":
        try {
          return { at: await h.line(Number(request.payload.line), Number(request.payload.limit), budget) };
        } catch (error) {
          // Not found in time: the reader opens at the end instead.
          if (errors.is(error, "ScanTooLong")) return { at: -1 };
          throw error;
        }
      case "file.count":
        return { lines: await h.newlines(Number(request.payload.from), Number(request.payload.to), budget) };
    }
  } finally {
    await h.close().catch(() => {});
  }
}
