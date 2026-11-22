//! Where a large file's lines start, so a line deep in it is found without
//! reading from its start every time: a sparse map of line number to byte
//! offset, with how far the scan has reached, kept under the user's tmp
//! directory on the computer that has the file. It's keyed by the file's
//! identity, and checked against the file's bytes where the scan stopped, so
//! an appended log keeps its indexed prefix and a rewritten file starts
//! over. A scan for a line resumes from the furthest point before it, and a
//! line already passed is found by reading one stride at most.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { atomicWrite, privateDirectory } from "./os";

/** 1-based line `line` starts at byte `at`. */
export interface Point {
  line: number;
  at: number;
}
/** How far a scan for a line has come. */
export interface Progress {
  scanned: number;
  size: number;
  /** Newlines passed, so the line the scan is on, less one. */
  lines: number;
}
/** Where a line starts, that it isn't there, or that finding it means
 * scanning `bytes` more than the budget allowed. */
export type Found = { kind: "found"; at: number } | { kind: "missing"; size: number } | { kind: "far"; bytes: number };
/** What a scan reads through: an open file's size and bytes. */
export interface Readable {
  info(): Promise<{ id: string; size: number }>;
  read(at: number, length: number): Promise<Uint8Array>;
}
export interface FindOptions {
  /** The most bytes to scan past what the index knows before answering `far`. */
  budget: number;
  signal?: AbortSignal;
  progress?: (p: Progress) => void;
}

/** Points kept at most; past it every other one goes and the stride doubles. */
export const max_points = 4096;
/** Bytes between points to begin with: a line passed costs at most this much reading. */
export const first_stride = 1 << 20;
/** Bytes read at a time. */
export const chunk = 1 << 20;
/** The bytes before the scan's end kept to tell the same file from another at its path. */
const probe_bytes = 256;
/** The scan saves this often, so a scan that stops keeps what it read. */
const save_every = 256 << 20;
/** Indexes kept; the oldest go past it. */
export const max_files = 256;
/** How often progress is reported while scanning. */
const progress_ms = 50;

/** Where indexes live, as other Corgi tmp state: private to the user. */
export function directory(): string {
  return process.env.CORGI_LINE_INDEX_DIR || `/tmp/corgi-${process.getuid?.() ?? userInfo().uid}/lines`;
}
interface Saved {
  id: string;
  stride: number;
  scanned: number;
  lines: number;
  points: [number, number][];
  probe: string;
}
export class LineIndex {
  /** Line starts past the first, ascending, `stride` or more apart. */
  points: Point[] = [];
  /** Bytes whose newlines are counted, and how many there were. */
  scanned = 0;
  lines = 0;
  stride = first_stride;
  /** Whether anything changed since it was saved. */
  private dirty = false;
  private fresh = true;
  constructor(
    readonly id: string,
    private dir = directory(),
  ) {}
  /** The index for the file `fh` is, from disk when one is there and still
   * speaks for the file: it's no shorter than the scan reached, and the bytes
   * where the scan stopped are as they were. */
  static async load(fh: Readable, dir = directory()): Promise<LineIndex> {
    const { id, size } = await fh.info(),
      index = new LineIndex(id, dir);
    let saved: Saved;
    try {
      // Only the user's own, private directory is read, and pruned below.
      privateDirectory(dir);
      saved = JSON.parse(readFileSync(join(dir, file(id)), "utf8"));
    } catch {
      return index;
    }
    index.fresh = false;
    if (saved.id !== id || !Number.isSafeInteger(saved.scanned) || saved.scanned > size) return index;
    const probe = Buffer.from(saved.probe, "base64");
    if (probe.length > 0) {
      const now = await fh.read(saved.scanned - probe.length, probe.length);
      if (!probe.equals(now)) return index;
    }
    index.scanned = saved.scanned;
    index.lines = Number(saved.lines) || 0;
    index.stride = Number(saved.stride) || first_stride;
    index.points = (Array.isArray(saved.points) ? saved.points : [])
      .filter(
        p => Array.isArray(p) && Number.isSafeInteger(p[0]) && Number.isSafeInteger(p[1]) && p[1] <= saved.scanned,
      )
      .map(([line, at]) => ({ line, at }));
    return index;
  }
  /** Whether line `n`'s start is within the scanned bytes. */
  covers(n: number): boolean {
    return n <= this.lines + 1;
  }
  /** Where to scan for line `n` from: the furthest point at or before it,
   * or the scan's end when it's past the scanned bytes. */
  resume(n: number): Point {
    if (!this.covers(n)) return { line: this.lines + 1, at: this.scanned };
    let lo = 0,
      hi = this.points.length - 1;
    if (hi < 0 || this.points[0].line > n) return { line: 1, at: 0 };
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.points[mid].line <= n) lo = mid;
      else hi = mid - 1;
    }
    return this.points[lo];
  }
  /** The scan passed the start of line `line` at `at`: a point when it's a stride on. */
  add(line: number, at: number): void {
    const last = this.points[this.points.length - 1] ?? { line: 1, at: 0 };
    if (at - last.at < this.stride || at <= last.at) return;
    this.points.push({ line, at });
    this.dirty = true;
    if (this.points.length > max_points) {
      this.points = this.points.filter((_, i) => i % 2 === 1);
      this.stride *= 2;
    }
  }
  /** The scan counted `lines` newlines in the first `scanned` bytes. */
  advance(scanned: number, lines: number): void {
    if (scanned <= this.scanned) return;
    this.scanned = scanned;
    this.lines = lines;
    this.dirty = true;
  }
  /** Writes it, with the bytes before the scan's end, when anything changed. */
  async save(fh: Readable): Promise<void> {
    if (!this.dirty) return;
    const dir = this.dir;
    const length = Math.min(probe_bytes, this.scanned),
      probe = length > 0 ? await fh.read(this.scanned - length, length) : new Uint8Array();
    const saved: Saved = {
      id: this.id,
      stride: this.stride,
      scanned: this.scanned,
      lines: this.lines,
      points: this.points.map(p => [p.line, p.at]),
      probe: Buffer.from(probe.buffer, probe.byteOffset, probe.length).toString("base64"),
    };
    try {
      privateDirectory(dir);
      if (this.fresh) prune(dir);
      atomicWrite(join(dir, file(this.id)), JSON.stringify(saved));
      this.dirty = false;
      this.fresh = false;
    } catch {
      // A tmp dir that can't be written leaves the scan to start over next time.
    }
  }
}
const file = (id: string) => `${id.replace(/[^\w.-]/g, "-")}.json`;
/** Makes room for one more index: the oldest go past `max_files`. */
function prune(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length < max_files) return;
  const aged = names
    .map(name => {
      try {
        return { name, at: statSync(join(dir, name)).mtimeMs };
      } catch {
        return { name, at: 0 };
      }
    })
    .sort((a, b) => a.at - b.at);
  for (const { name } of aged.slice(0, names.length - max_files + 1)) rmSync(join(dir, name), { force: true });
}

/** Where 1-based line `n` starts in `fh`, scanning from what `index` knows
 * and adding to it as it goes. It scans at most `budget` bytes before
 * answering `far`, saving what it read; a scan the signal stops saves too. */
export async function find(fh: Readable, index: LineIndex, n: number, opts: FindOptions): Promise<Found> {
  const { size } = await fh.info();
  if (n <= 1) return { kind: "found", at: 0 };
  const from = index.resume(n),
    // A line the index passed is a stride away at most: never far.
    budget = index.covers(n) ? Math.max(opts.budget, index.stride + chunk) : opts.budget;
  let at = from.at,
    line = from.line,
    spent = 0,
    unsaved = 0,
    reported = 0;
  const report = (now = Date.now()) => {
    reported = now;
    opts.progress?.({ scanned: at, size, lines: line - 1 });
  };
  const stop = (): void => {
    if (opts.signal?.aborted) throw Error("Aborted");
  };
  try {
    while (at < size) {
      stop();
      if (spent >= budget) {
        report();
        return { kind: "far", bytes: size - at };
      }
      const bytes = await fh.read(at, Math.min(chunk, size - at));
      if (bytes.length === 0) break;
      const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
      for (let i = view.indexOf(10); i >= 0; i = view.indexOf(10, i + 1)) {
        const start = at + i + 1;
        line++;
        index.advance(start, line - 1);
        if (line === n) {
          report();
          return { kind: "found", at: start };
        }
        index.add(line, start);
      }
      at += bytes.length;
      spent += bytes.length;
      unsaved += bytes.length;
      index.advance(at, line - 1);
      if (unsaved >= save_every) {
        unsaved = 0;
        await index.save(fh);
      }
      const now = Date.now();
      if (now - reported >= progress_ms) report(now);
    }
    report();
    return { kind: "missing", size };
  } finally {
    await index.save(fh);
  }
}
