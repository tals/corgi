//! A file as the file peek and the file pane read it, no more of it than they
//! show. A code file under `code_limit` is read whole and decoded into lines,
//! so its lines have their numbers, until it grows past the limit. A log, or
//! anything larger, is read from its end, one block, and earlier blocks as
//! someone scrolls back, or from its start when they go there. Its bytes
//! stay as they were read, with where each line starts, and a line is
//! decoded only when it is shown: following a busy log finds newlines and
//! keeps the bytes, as `tail -F` copies them, and no more.
//!
//! Like `tail -F`, it follows growth through the file system's change
//! notices with a slow poll behind them, reads only the new bytes, and starts
//! again at the end of a file that was truncated or replaced. While writes
//! keep coming it checks on a short timer instead of taking every notice.
import * as errors from "./errors";
import * as fileAccess from "./file_access";
import type * as lineIndex from "./line_index";

/** Larger files read from their end, as logs do; another computer's past
 * a smaller size (see `fileAccess.Limits`). */
export const code_limit = fileAccess.local_limits.whole;
/** One read: the window a log opens with, and each block before it. */
export const block = 256 << 10;
/** Growth past this between two reads is skipped, as by a reader that fell
 * behind; another computer's past less. */
export const skip_after = fileAccess.local_limits.growth;
/** The most lines following keeps; the oldest drop past it. */
export const max_lines = 50_000;
/** The most bytes following keeps: the oldest lines drop past it, and a
 * line still being written that is longer keeps only its end. */
export const max_bytes = 16 << 20;
/** Lines kept above a place a viewer holds, for it to scroll up into. */
export const hold_margin = 1000;
/** Rows kept from a held place down: more than a screen shows. */
const hold_rows = 256;
const poll_ms = 1000;
/** The most growth one read on a local disk takes at once. */
const sync_limit = 4 << 20;
/** While writes keep coming, how often growth is checked, and how long
 * without any before change notices take over again. */
const burst_ms = 10,
  quiet_ms = 500;
/** Decoded lines kept for drawing again. */
const cache_lines = 4096;

export type Mode = "code" | "tail";
const log_name = /\.(?:log|out|err|jsonl|ndjson)(?:\.\d+)?$|\.log\.[\w-]+$/i;
/** How a file at `path` of `size` bytes is read, when files up to `whole` read whole. */
export function modeFor(path: string, size: number, whole = code_limit): Mode {
  return size > whole || log_name.test(path) ? "tail" : "code";
}
const nul = (bytes: Uint8Array, upto = bytes.length) => bytes.subarray(0, upto).includes(0);
/** Adds where each line after a newline in `bytes`, read at `at`, starts. */
function scan(bytes: Uint8Array, at: number, starts: number[]): void {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let i = view.indexOf(10); i >= 0; i = view.indexOf(10, i + 1)) starts.push(at + i + 1);
}

export interface Options {
  /** The 1-based line to open at: a log's window is read around it. */
  line?: number | null;
  /** The most bytes scanned for that line past what its index knows before
   * the open gives up on it: the window opens at the end with `far` set, and
   * `find` scans on once asked. */
  budget?: number;
  /** Off for one read and no notices. */
  follow?: boolean;
  mode?: Mode;
  /** After each change to what's read. */
  changed?: () => void;
  /** Stops an open still reading, as when the pointer leaves for another name. */
  signal?: AbortSignal;
  /** Where the file is: this computer's disk unless another's daemon reads it. */
  files?: fileAccess.Files;
}
/** A file just opened, and what its handle said of it. */
type Opened = { fh: fileAccess.Handle; info: fileAccess.Info };
export class Source {
  /** A code file that grows past `code_limit` turns into a log. */
  mode: Mode;
  /** A code file's lines, without their newlines. */
  lines: string[] = [];
  /** The file's number for row 0, once the window's start is known. */
  first: number | null = null;
  /** Where row 0 starts; the bytes before it are unread. */
  start = 0;
  /** Where the next read starts. */
  end = 0;
  size = 0;
  binary = false;
  /** Why following last failed, until it works again. */
  error: string | null = null;
  /** The row a viewer holds at its top, or null while it follows the end:
   * growth past the caps then drops lines on the side away from it. */
  hold: number | null = null;
  /** Counts of lines the file grew by, read in at the start and dropped
   * from the start: a viewer keeps its place with them. */
  added = 0;
  prepended = 0;
  dropped = 0;
  /** Times the window started over at the end: the file shrank, was
   * replaced or grew faster than it was read, or a viewer went to its end. */
  restarts = 0;
  /** Times the window moved to the file's start. */
  rewinds = 0;
  /** Times `find` moved the window to the line it was asked for, `sought`. */
  seeks = 0;
  sought: number | null = null;
  /** The line asked for lies past the budget's scan: `find` scans on. */
  far: { line: number; bytes: number } | null = null;
  /** The line being scanned for, and how far the scan has come, while one runs. */
  seeking: number | null = null;
  scan: lineIndex.Progress | null = null;
  /** Bumps with every change. */
  version = 0;
  /** A log's window: the blocks its bytes were read in, and where each of
   * its lines starts; the last starts the line still being written. */
  private blocks: { at: number; bytes: Uint8Array }[] = [];
  private starts: number[] = [];
  private cache = new Map<number, string>();
  private text = new TextDecoder();
  private files: fileAccess.Files;
  private fh: fileAccess.Handle | null = null;
  /** Which file was read, and when it last changed. */
  private id = "";
  private mtime = 0;
  /** A followed file's size and time when its path was last looked up. */
  private looked: { size: number; mtime: number } | null = null;
  private watcher: { close(): void } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private burst: ReturnType<typeof setInterval> | null = null;
  private quiet = 0;
  private busy: Promise<void> | null = null;
  private again = false;
  private named = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** Reads asked for and not done; a second ask while one waits is dropped. */
  private asked = new Set<"earlier" | "later">();
  private closed = false;
  /** Stops a scan for a line: on close, or once the open is called off. */
  private aborter = new AbortController();
  private constructor(
    readonly path: string,
    mode: Mode,
    private opts: Options,
  ) {
    this.mode = mode;
    this.files = opts.files ?? fileAccess.here;
    const abort = () => this.aborter.abort(Error("Aborted"));
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });
  }
  static async open(path: string, opts: Options = {}): Promise<Source> {
    try {
      return await Source.start(path, opts);
    } catch (error) {
      // Another computer's file was replaced as it opened: the new one opens.
      if (!errors.is(error, "FileChanged")) throw error;
      return await Source.start(path, opts);
    }
  }
  private static async start(path: string, opts: Options): Promise<Source> {
    // The first read takes this handle, so another computer's file opens in few round trips.
    const fh = await (opts.files ?? fileAccess.here).open(path);
    let info: fileAccess.Info;
    try {
      info = await fh.info();
    } catch (error) {
      await fh.close().catch(() => {});
      throw error;
    }
    const whole = (opts.files ?? fileAccess.here).limits.whole;
    const source = new Source(path, opts.mode ?? modeFor(path, info.size, whole), opts);
    try {
      await source.load({ fh, info }, opts.line ?? null);
      source.stop();
    } catch (error) {
      await source.close();
      throw error;
    }
    if (opts.follow !== false) source.follow();
    return source;
  }
  /** Throws once the open is called off. */
  private stop(): void {
    if (this.opts.signal?.aborted) throw Error("Aborted");
  }
  /** Rows to show: the whole lines, then one being written. */
  get count(): number {
    if (this.mode === "code") return this.lines.length;
    const whole = this.starts.length - 1;
    return whole + (this.end > this.starts[whole] ? 1 : 0);
  }
  /** Row `row`'s text, or its first `max` bytes' when it's longer. */
  line(row: number, max = Infinity): string {
    if (this.mode === "code") return this.lines[row] ?? "";
    if (row < 0 || row >= this.count) return "";
    const from = this.starts[row],
      to = row + 1 < this.starts.length ? this.starts[row + 1] - 1 : this.end;
    // The line being written changes, and a cut one is only its start: neither is kept.
    if (row + 1 >= this.starts.length || to - from > max) return this.decode(from, Math.min(to, from + max));
    let text = this.cache.get(from);
    if (text === undefined) {
      if (this.cache.size >= cache_lines) this.cache.clear();
      text = this.decode(from, to);
      this.cache.set(from, text);
    }
    return text;
  }
  /** The last line while it is still being written. */
  get partial(): string {
    if (this.mode === "code" || this.starts.length === 0) return "";
    return this.decode(this.starts[this.starts.length - 1], this.end);
  }
  /** The file's line number at `row`, when the window knows it. */
  number(row: number): number | null {
    return this.first === null ? null : this.first + row;
  }
  /** The row showing the file's line `n`, or null when it isn't read. */
  rowOf(n: number): number | null {
    if (this.first === null) return null;
    const row = n - this.first;
    return row >= 0 && row < this.count ? row : null;
  }
  /** Whether growth joins the window: it reaches the file's end. */
  get atEnd(): boolean {
    return this.end >= this.size;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.aborter.abort(Error("Closed"));
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.burst) clearInterval(this.burst);
    this.burst = null;
    const fh = this.fh;
    this.fh = null;
    await fh?.close().catch(() => {});
  }
  /** The bytes from `from` to `to`, decoded. */
  private decode(from: number, to: number): string {
    if (to <= from) return "";
    // The last block holding `from`.
    let lo = 0,
      hi = this.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.blocks[mid].at <= from) lo = mid;
      else hi = mid - 1;
    }
    const first = this.blocks[lo];
    if (!first) return "";
    if (to <= first.at + first.bytes.length)
      return this.text.decode(first.bytes.subarray(from - first.at, to - first.at));
    const parts: Uint8Array[] = [];
    for (let i = lo; i < this.blocks.length && this.blocks[i].at < to; i++) {
      const b = this.blocks[i];
      parts.push(b.bytes.subarray(Math.max(0, from - b.at), Math.min(b.bytes.length, to - b.at)));
    }
    return this.text.decode(Buffer.concat(parts));
  }
  private async load(opened: Opened, line: number | null): Promise<void> {
    if (this.mode === "code") return this.readWhole(opened);
    await this.reopen(opened);
    if (line !== null && (await this.locate(line, this.opts.budget ?? fileAccess.ask_after))) return;
    await this.readTail();
  }
  /** Reads the file whole, through `opened` when it's open already. It reads
   * block by block to the end, which a file in /proc doesn't give as its
   * size, and stops at a binary file's first block, or once its reader is gone. */
  private async readWhole(opened?: Opened): Promise<void> {
    const fh = opened?.fh ?? (await this.files.open(this.path)),
      limit = this.files.limits.whole,
      parts: Uint8Array[] = [];
    let info: fileAccess.Info,
      got = 0,
      binary = false;
    try {
      info = opened?.info ?? (await fh.info());
      for (;;) {
        // As much as its size says, or with no size, until it ends.
        const want = Math.min(block, limit - got, info.size > 0 ? info.size - got : block);
        if (want <= 0) break;
        if (got > 0) {
          if (this.closed) throw Error("Closed");
          this.stop();
        }
        const bytes = await fh.read(got, want);
        binary ||= got === 0 && nul(bytes, 8192);
        parts.push(bytes);
        got += bytes.length;
        if (binary || bytes.length < want) break;
      }
    } finally {
      await fh.close().catch(() => {});
    }
    const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    this.id = info.id;
    this.mtime = info.mtime;
    this.binary = binary;
    const lines = binary ? [] : this.text.decode(bytes).split("\n");
    // A final newline ends the last line rather than starting another.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    this.lines = lines;
    this.first = 1;
    this.start = 0;
    this.end = got;
    this.size = Math.max(info.size, got);
  }
  /** Opens the path again, or takes `opened`; the file read so far stays open until then. */
  private async reopen(opened?: Opened): Promise<void> {
    const fh = opened?.fh ?? (await this.files.open(this.path));
    if (this.closed) {
      await fh.close().catch(() => {});
      throw Error("Closed");
    }
    const old = this.fh;
    this.fh = fh;
    await old?.close().catch(() => {});
    const info = opened?.info ?? (await fh.info());
    this.id = info.id;
    this.size = info.size;
    this.looked = { size: info.size, mtime: info.mtime };
  }
  private read(at: number, length: number): Promise<Uint8Array> {
    return this.fh!.read(at, length);
  }
  /** The window `bytes` read at `at` makes, from its first whole line. */
  private window(at: number, bytes: Uint8Array): void {
    let body = bytes,
      start = at;
    // A block that starts mid-line drops that line's end, unless it is all
    // one line, which shows cut.
    const nl = at > 0 ? bytes.indexOf(10) : -1;
    if (nl >= 0 && nl < bytes.length - 1) {
      body = bytes.subarray(nl + 1);
      start = at + nl + 1;
    }
    this.end = at + bytes.length;
    this.binary = nul(body);
    this.blocks = this.binary ? [] : [{ at: start, bytes: body }];
    this.starts = [this.binary ? this.end : start];
    if (!this.binary) scan(body, start, this.starts);
    this.cache.clear();
    this.start = start;
    this.first = start === 0 ? 1 : null;
  }
  private async readTail(): Promise<void> {
    const at = Math.max(0, this.size - block);
    this.window(at, await this.read(at, this.size - at));
  }
  /** Opens the window a little before line `n`, scanning `budget` bytes at
   * most past what the file's index knows; false when it's past the end, or
   * further than that: then `far` says so, for `find` to scan on. */
  private async locate(n: number, budget: number): Promise<boolean> {
    this.far = null;
    this.seeking = n;
    let found: lineIndex.Found;
    try {
      found = await this.fh!.find(n, {
        budget,
        signal: this.aborter.signal,
        progress: p => {
          this.scan = p;
          this.bump();
        },
      });
    } finally {
      this.seeking = null;
      this.scan = null;
    }
    if (found.kind === "far") this.far = { line: n, bytes: found.bytes };
    if (found.kind !== "found" || found.at >= this.size) return false;
    const from = Math.max(0, found.at - (block >> 3));
    this.window(from, await this.read(from, Math.min(block, this.size - from)));
    // Lines between the window's start and line n.
    let before = 0;
    while (before < this.starts.length && this.starts[before] < found.at) before++;
    this.first = n - before;
    return true;
  }
  /** Scans on for the line `far` names, however far, and moves the window
   * to it; `scan` shows how it's going. False when it isn't there. */
  find(): Promise<boolean> {
    return this.attempt(async () => {
      const far = this.far;
      if (!far || this.mode === "code" || !this.fh) return false;
      this.far = null;
      this.bump();
      try {
        this.size = (await this.fh.info()).size;
        if (!(await this.locate(far.line, Infinity))) return false;
      } catch (error) {
        // A scan that failed, or was stopped, can be asked for again.
        this.far = far;
        throw error;
      }
      this.hold = null;
      this.seeks++;
      this.sought = far.line;
      this.bump();
      return true;
    });
  }
  /** Adds bytes read at the window's end: the file's growth, or the next
   * block of a window that stopped short of it. */
  private append(bytes: Uint8Array, grew: boolean): void {
    if (bytes.length === 0) return;
    const lines = this.starts.length;
    this.blocks.push({ at: this.end, bytes });
    scan(bytes, this.end, this.starts);
    this.end += bytes.length;
    if (grew) this.added += this.starts.length - lines;
    if (!grew || this.hold === null) return this.dropStart();
    // A held place keeps its rows: the start gives way down to a little
    // above it, then the end gives up what's still over.
    this.dropStart(Math.max(0, this.hold - hold_margin));
    this.dropEnd(this.hold + hold_rows);
  }
  private get over(): boolean {
    return this.starts.length - 1 > max_lines || this.end - this.start > max_bytes;
  }
  /** The whole lines keeping to the caps from the start drops: a tenth at a
   * time, so following a busy log doesn't shift every read. */
  private startDrop(): number {
    if (!this.over) return 0;
    const whole = this.starts.length - 1,
      from = this.end - Math.floor(max_bytes * 0.9);
    let drop = whole > max_lines ? whole - Math.floor(max_lines * 0.9) : 0;
    if (this.end - this.start > max_bytes) while (drop < whole && this.starts[drop] < from) drop++;
    return drop;
  }
  /** Keeps to the caps from the window's start, where no one reads,
   * dropping at most `limit` lines. */
  private dropStart(limit = Infinity): void {
    if (!this.over) return;
    const over_bytes = this.end - this.start > max_bytes,
      from = this.end - Math.floor(max_bytes * 0.9),
      wanted = this.startDrop(),
      drop = Math.min(wanted, limit);
    this.starts.splice(0, drop);
    // The line being written is still too long: it shows cut, as `window` does.
    if (over_bytes && drop === wanted && this.starts[0] < from) this.starts[0] = from;
    const start = this.starts[0];
    while (this.blocks.length > 1 && this.blocks[0].at + this.blocks[0].bytes.length <= start) this.blocks.shift();
    const head = this.blocks[0];
    if (head && head.at < start) this.blocks[0] = { at: start, bytes: head.bytes.slice(start - head.at) };
    this.cache.clear();
    this.start = start;
    this.dropped += drop;
    if (this.hold !== null) this.hold = Math.max(0, this.hold - drop);
    if (this.first !== null) this.first += drop;
  }
  /** Keeps to the caps from the window's end, which then stops short of the
   * file's, keeping at least `rows` rows. */
  private dropEnd(rows = 0): void {
    if (!this.over) return;
    const until = this.start + Math.floor(max_bytes * 0.9),
      whole = this.starts.length - 1,
      kept = Math.min(rows, whole);
    let keep = Math.min(whole, Math.max(rows, Math.floor(max_lines * 0.9)));
    // The rows asked for stay too, unless they alone pass the cap.
    while (keep > 0 && this.starts[keep] > (keep > kept ? until : this.start + max_bytes)) keep--;
    // A first line longer than the cap shows cut.
    const end = keep > 0 ? this.starts[keep] : Math.min(this.end, until);
    this.starts.length = keep + 1;
    while (this.blocks.length > 1 && this.blocks[this.blocks.length - 1].at >= end) this.blocks.pop();
    const tail = this.blocks[this.blocks.length - 1];
    if (tail && tail.at + tail.bytes.length > end) tail.bytes = tail.bytes.slice(0, end - tail.at);
    this.cache.clear();
    this.end = end;
  }
  /** Runs reads one at a time, so none sees another's window half changed. */
  private serial<T>(read: () => Promise<T>): Promise<T> {
    const next = this.chain.then(read, read);
    this.chain = next.catch(() => {});
    return next;
  }
  private once(what: "earlier" | "later", read: () => Promise<boolean>): Promise<boolean> {
    if (this.asked.has(what)) return Promise.resolve(false);
    this.asked.add(what);
    return this.attempt(read).finally(() => this.asked.delete(what));
  }
  /** Runs `read` in its turn. It's asked for in passing, as a scroll or a
   * key does, so a failure shows rather than throws. */
  private attempt(read: () => Promise<boolean>): Promise<boolean> {
    return this.serial(async () => {
      try {
        return !this.closed && (await read());
      } catch (error) {
        // Another computer's path names another file now: that one is read.
        if (errors.is(error, "FileChanged")) {
          await this.update(true);
          return true;
        }
        this.fail(error);
        return false;
      }
    });
  }
  /** Reads the block before the window; false at the file's start. */
  earlier(): Promise<boolean> {
    return this.once("earlier", () => this.readEarlier());
  }
  /** Reads the block after a window that doesn't reach the end. */
  later(): Promise<boolean> {
    return this.once("later", () => this.readLater());
  }
  /** Moves a log's window to the file's first block; false when it's there.
   * Each ask takes its turn, so the last of a start and an end asked
   * for in a row is where the window ends up. */
  toStart(): Promise<boolean> {
    return this.attempt(async () => {
      if (this.mode === "code" || this.start === 0 || !this.fh) return false;
      this.window(0, await this.read(0, Math.min(block, this.size)));
      if (this.hold !== null) this.hold = 0;
      this.rewinds++;
      this.bump();
      return true;
    });
  }
  /** Moves a log's window to the file's end, as following reads it; false when it's there. */
  toEnd(): Promise<boolean> {
    return this.attempt(async () => {
      if (this.mode === "code" || this.atEnd || !this.fh) return false;
      this.size = (await this.fh.info()).size;
      await this.readTail();
      // A viewer follows a window that starts over at the end.
      this.hold = null;
      this.restarts++;
      this.bump();
      return true;
    });
  }
  private async readEarlier(): Promise<boolean> {
    if (this.mode === "code" || this.start === 0 || !this.fh || this.binary) return false;
    const at = Math.max(0, this.start - block);
    const bytes = await this.read(at, this.start - at);
    if (bytes.length === 0) return false;
    // The block starts at its first whole line, unless it holds none: then
    // it's all one line too long for it, which shows cut.
    let body = bytes,
      start = at;
    const nl = at > 0 ? bytes.indexOf(10) : -1;
    if (nl >= 0 && nl < bytes.length - 1) {
      body = bytes.subarray(nl + 1);
      start = at + nl + 1;
    }
    const starts = [start];
    scan(body, start, starts);
    // A window that starts on a newline's heels gains whole rows; one that
    // starts partway through a line, cut, has that row reach back instead.
    const joined = bytes[bytes.length - 1] !== 10;
    if (starts[starts.length - 1] === this.start) starts.pop();
    else if (joined) this.starts.shift();
    const rows = joined ? starts.length - 1 : starts.length;
    this.starts = starts.concat(this.starts);
    this.blocks.unshift({ at: start, bytes: body });
    this.cache.clear();
    this.start = start;
    this.prepended += rows;
    if (this.hold !== null) this.hold += rows;
    this.first = this.first !== null ? this.first - rows : start === 0 ? 1 : null;
    // The reader is at the start, so the end gives way.
    this.dropEnd(this.hold === null ? 0 : this.hold + hold_rows);
    this.bump();
    return true;
  }
  private async readLater(): Promise<boolean> {
    if (this.mode === "code" || this.atEnd || !this.fh) return false;
    const bytes = await this.read(this.end, Math.min(block, this.size - this.end));
    this.append(bytes, false);
    this.bump();
    return bytes.length > 0;
  }
  private bump(): void {
    this.version++;
    this.opts.changed?.();
  }
  private follow(): void {
    this.arm();
    this.timer = setInterval(() => {
      // A watch that failed, or found no file, is tried again, as `tail -F` does.
      if (!this.burst) this.arm();
      this.poke(true);
    }, poll_ms);
    this.timer.unref?.();
  }
  /** Waits for the next change notice. */
  private arm(): void {
    if (this.closed || this.watcher) return;
    // Without one, the slow poll alone notices growth.
    const watcher = this.files.watch(
      this.path,
      renamed => this.notice(renamed),
      () => {
        if (this.watcher === watcher) this.watcher = null;
      },
    );
    this.watcher = watcher;
  }
  /** A change notice: reads it now, then checks every `burst_ms` while
   * writes keep coming, and waits for notices again after `quiet_ms`
   * without any. A notice costs more than a check, and a log written a
   * line at a time would send one per line. */
  private notice(named: boolean): void {
    this.watcher?.close();
    this.watcher = null;
    this.poke(named);
    if (this.burst || this.closed) return;
    this.quiet = 0;
    let checking = false;
    this.burst = setInterval(() => {
      // A slow disk's check outlasts the interval; they don't queue up.
      if (checking) return;
      checking = true;
      const seen = this.version;
      void this.refresh(false).then(() => {
        checking = false;
        if (this.version !== seen) this.quiet = 0;
        else if (++this.quiet * burst_ms >= quiet_ms && this.burst) {
          clearInterval(this.burst);
          this.burst = null;
          this.arm();
          // Writes between the last check and the watch.
          this.poke();
        }
      });
    }, burst_ms);
    this.burst.unref?.();
  }
  /** Something may have changed: reads it now, one read at a time. Notices
   * during a read make one more, which takes everything written meanwhile.
   * `named` also checks that the path still names the file read, as after
   * a rename. */
  poke(named = false): void {
    if (this.closed) return;
    this.named ||= named;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = (async () => {
      do {
        this.again = false;
        const check = this.named;
        this.named = false;
        await this.refresh(check);
      } while (this.again && !this.closed);
    })().finally(() => (this.busy = null));
  }
  /** The reads in flight, for tests and benchmarks to wait on. */
  settled(): Promise<void> {
    return this.busy ?? Promise.resolve();
  }
  /** Reads what changed since the last read. A growing log's own descriptor
   * says how far it grew; `named` also looks the path up again, to notice
   * a log replaced under its name. */
  refresh(named = true): Promise<void> {
    return this.serial(() => this.update(named));
  }
  private async update(named: boolean): Promise<void> {
    try {
      await this.check(named).catch(error => {
        // Another computer's path came to name another file partway through
        // the read; looking it up again reads that one instead.
        if (errors.is(error, "FileChanged")) return this.check(true);
        throw error;
      });
      if (this.error !== null) {
        this.error = null;
        this.bump();
      }
    } catch (error) {
      this.fail(error);
    }
  }
  /** Counts the lines a log grew by past a window that stops short of its
   * end, without keeping them; growth too fast to read goes uncounted. */
  private async countGrowth(from: number, to: number): Promise<void> {
    if (to - from > skip_after || !this.fh) return;
    this.added += await this.fh.newlines(from, to, () => {
      if (this.closed) throw Error("Closed");
    });
  }
  /** Shows why a read failed, once until it changes. */
  private fail(error: unknown): void {
    if (this.closed) return;
    const name = errors.name(error) ?? "ReadFailed";
    if (name === this.error) return;
    this.error = name;
    this.bump();
  }
  private async check(named: boolean): Promise<void> {
    // The path's size, when it was just looked up and still names the file read.
    let known: number | null = null;
    if (this.mode === "code" || named || !this.fh) {
      const found = await this.files.find(this.path).catch(() => null);
      // Gone: what was read stays until it comes back.
      if (!found || this.closed) return;
      if (this.mode === "code") {
        if (found.id === this.id && found.size === this.size && found.mtime === this.mtime) return;
        if (found.size <= this.files.limits.whole) {
          await this.readWhole();
          return this.bump();
        }
        // Too large now to read whole each change: it's followed from its end.
        this.mode = "tail";
        this.lines = [];
        return await this.restart();
      }
      if (found.id !== this.id) return await this.restart();
      // An edit in place, as an editor's save over a large file, can keep
      // the size and change only the time: what's shown is read again.
      const edited = this.looked !== null && found.size === this.looked.size && found.mtime !== this.looked.mtime;
      this.looked = { size: found.size, mtime: found.mtime };
      if (edited) return await this.reread();
      known = found.size;
    }
    const now = this.fh!.now;
    const size = known ?? (now ? now.size() : (await this.fh!.info()).size);
    if (this.closed) return;
    if (size < this.end) return await this.restart();
    if (size === this.size) return;
    const joined = this.atEnd,
      before = this.size;
    this.size = size;
    if (!joined) {
      await this.countGrowth(before, size);
      return this.bump();
    }
    const grown = this.size - this.end;
    // A held place stays where it is; the window stops short of the end.
    if (grown > this.files.limits.growth) return this.hold !== null ? this.bump() : await this.restart();
    const bytes = now && grown <= sync_limit ? now.read(this.end, grown) : await this.read(this.end, grown);
    this.append(bytes, true);
    this.bump();
  }
  /** Reads the window again where it is, after an edit in place that kept
   * the file's size: the reader keeps its place, its numbers and whether it
   * follows. */
  private async reread(): Promise<void> {
    const from = this.start,
      first = this.first,
      // The byte before a line's start is its newline, which `window` drops to begin at the line.
      at = Math.max(0, from - 1);
    this.window(at, await this.read(at, this.end - at));
    if (this.start === from) this.first = first;
    this.bump();
  }
  private async restart(): Promise<void> {
    await this.reopen();
    await this.readTail();
    this.hold = null;
    this.restarts++;
    this.bump();
  }
}
