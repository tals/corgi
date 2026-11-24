//! `corgi __view PATH [--line N] [--column N]`: a file in a pane of its own,
//! which clicking a file's name in a pane opens. It reads as the peek does,
//! at full height: code with its folds, or a log from its end, following as
//! it grows. `e` hands the file to $VISUAL or $EDITOR at the line shown and
//! comes back after; `q` closes the pane.
//!
//! In a Corgi pane the process also names the file to the daemon
//! (`pane.view`), and each viewer reads the file itself (`Panes`) and draws
//! it where the pane is, so scrolling another computer's file waits on no
//! round trip. Such a viewer tells the process to stop drawing; the process
//! stays for what belongs where the file is: it runs the editor, and ends
//! when a viewer asks. A viewer too old to draw the file sees the process's
//! own drawing, and its keys work as they did.
import { basename, dirname, resolve } from "node:path";
import { Canvas, type Cell } from "./canvas";
import * as errors from "./errors";
import * as fileAccess from "./file_access";
import { progressLabel, size } from "./file_peek";
import { Source } from "./file_source";
import { Reader } from "./file_view";
import * as i18n from "./i18n";
import type { FileView } from "./mirror";
import * as os from "./os";
import * as palette from "./palette";
import * as rpc from "./rpc";
import * as terminalInput from "./terminal_input";
import { directoryLabel, displayWidth, shortPath, Writer } from "./text";

export interface Args {
  path: string;
  line: number | null;
  column: number | null;
}
export function parseArgs(argv: string[]): Args | null {
  let path: string | null = null,
    line: number | null = null,
    column: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--line" || arg === "--column") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return null;
      if (arg === "--line") line = n;
      else column = n;
    } else if (path === null && !arg.startsWith("--")) path = arg;
    else return null;
  }
  return path === null ? null : { path: resolve(path), line, column };
}
/** How an editor opens `path` at `line`. The shell runs the setting, as git
 * runs $EDITOR, so its quotes mean what they do there. Most editors take
 * `+line`; these take `path:line`. */
export function editorCommand(editor: string, path: string, line: number | null): string[] {
  const command = editor.trim() || "vi",
    first = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command),
    name = basename(first?.[1] ?? first?.[2] ?? first?.[3] ?? "");
  const args =
    line === null
      ? [path]
      : /^(?:code|code-insiders|codium|cursor|windsurf)$/.test(name)
        ? ["-g", `${path}:${line}`]
        : /^(?:zed|subl|hx|helix)$/.test(name)
          ? [`${path}:${line}`]
          : [`+${line}`, path];
  return ["/bin/sh", "-c", `${command} "$@"`, command, ...args];
}

export type Key =
  | "quit"
  | "down"
  | "up"
  | "page_down"
  | "page_up"
  | "half_down"
  | "half_up"
  | "top"
  | "end"
  | "left"
  | "right"
  | "follow"
  | "fold"
  | "fold_all"
  | "edit";
const keys: Record<string, Key> = {
  q: "quit",
  "\x1b": "quit",
  "\x03": "quit",
  j: "down",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\r": "down",
  k: "up",
  "\x1b[A": "up",
  "\x1bOA": "up",
  " ": "page_down",
  f: "page_down",
  "\x06": "page_down",
  "\x1b[6~": "page_down",
  b: "page_up",
  "\x02": "page_up",
  "\x1b[5~": "page_up",
  d: "half_down",
  "\x04": "half_down",
  u: "half_up",
  "\x15": "half_up",
  g: "top",
  "<": "top",
  "\x1b[H": "top",
  "\x1bOH": "top",
  "\x1b[1~": "top",
  G: "end",
  ">": "end",
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[4~": "end",
  h: "left",
  "\x1b[D": "left",
  "\x1bOD": "left",
  l: "right",
  "\x1b[C": "right",
  "\x1bOC": "right",
  F: "follow",
  z: "fold",
  Z: "fold_all",
  e: "edit",
  v: "edit",
};
export type Input = { key: Key } | { mouse: terminalInput.Mouse };
/** The keys and mouse reports in what `terminal_input` framed: typed text
 * comes as one run, a key or a sequence whole. */
export function input(events: terminalInput.Input[]): Input[] {
  const out: Input[] = [];
  for (const event of events) {
    if (event.kind === "mouse") {
      out.push({ mouse: event.mouse });
      continue;
    }
    const text = Buffer.from(event.bytes).toString("latin1");
    for (const part of event.kind === "text" ? text : [text]) {
      const key = keys[part];
      if (key) out.push({ key });
    }
  }
  return out;
}

const shift_step = 8;
export class View {
  /** The body row under the pointer, from 0. */
  hover: number | null = null;
  shift = 0;
  constructor(
    readonly reader: Reader,
    readonly line: number | null,
  ) {}
  /** The rows the file shows in: all but the header and the keys. */
  static body(rows: number): number {
    return Math.max(1, rows - 2);
  }
  /** Applies `key` in a `rows` tall pane; "quit" and "edit" are the caller's. */
  key(key: Key, rows: number): void {
    const r = this.reader,
      h = View.body(rows);
    switch (key) {
      case "down":
        return r.scroll(1, h);
      case "up":
        return r.scroll(-1, h);
      case "page_down":
        return r.scroll(h - 1, h);
      case "page_up":
        return r.scroll(-(h - 1), h);
      case "half_down":
        return r.scroll(h >> 1, h);
      case "half_up":
        return r.scroll(-(h >> 1), h);
      case "top":
        return r.home();
      case "end":
        if (r.source.mode === "tail") return r.follow(true);
        r.top = r.shownRows().length;
        return r.scroll(0, h);
      case "left":
        this.shift = Math.max(0, this.shift - shift_step);
        return;
      case "right":
        this.shift += shift_step;
        return;
      case "follow":
        return r.follow(!r.following);
      case "fold": {
        const hit = this.hover === null ? null : r.at(this.hover, h, this.code),
          row = hit?.row ?? r.target ?? r.shownRows()[r.top]?.row;
        if (row !== undefined) r.toggleFold(row);
        return;
      }
      case "fold_all":
        return r.toggleAll();
      case "quit":
      case "edit":
        return;
    }
  }
  /** A mouse report at `x`, `y`: the wheel scrolls, the fold marker folds. */
  mouse(button: number, x: number, y: number, release: boolean, rows: number): void {
    const h = View.body(rows),
      r = this.reader;
    this.hover = y >= 1 && y <= h ? y - 1 : null;
    if (release) return;
    if (button === 64 || button === 65) return r.scroll(button === 64 ? -3 : 3, h);
    // Pinned lines have no fold marker.
    const hit = button === 0 && x <= 1 && this.hover !== null ? r.at(this.hover, h, this.code) : null;
    if (hit && hit.index !== null && r.foldEnds().has(hit.row)) r.toggleFold(hit.row);
  }
  /** The line the editor opens at: the one the text named while it shows,
   * else the first under the pinned lines. */
  lineShown(rows: number): number | null {
    const r = this.reader,
      h = View.body(rows),
      pins = r.pinned(h, this.code).length;
    if (r.target !== null) {
      const at = r.shownIndex(r.target);
      if (at >= r.top + pins && at < r.top + h) return r.source.number(r.target);
    }
    const first = r.at(pins, h, this.code);
    return first ? r.source.number(first.row) : this.line;
  }
  /** The pane column the file's text starts at, past its fold marks and line numbers. */
  get textColumn(): number {
    return this.reader.textColumn(this.code);
  }
  /** Code pins the lines that open its blocks and folds. */
  private get code(): boolean {
    return this.reader.source.mode === "code";
  }
  draw(cols: number, rows: number): string {
    const c = new Canvas(0, 0, cols, rows),
      w = new Writer();
    this.paint(c, cols, rows);
    w.write("\x1b[?2026h");
    c.flush(w);
    w.write("\x1b[?2026l");
    return w.s;
  }
  /** Fills `c`, `cols` by `rows`, with the header, the file and the keys. */
  paint(c: Canvas, cols: number, rows: number): void {
    const colors = palette.colors,
      r = this.reader,
      s = r.source,
      h = View.body(rows);
    r.sync(h);
    c.fill(0, colors.surface);
    const meta = this.meta(),
      meta_w = displayWidth(meta.map(m => m[0]).join(""));
    let x = c.text(1, 0, basename(s.path), colors.strong, colors.surface, true, cols - 2);
    const room = cols - 4 - meta_w - x;
    x = c.text(x + 2, 0, shortPath(directoryLabel(dirname(s.path)), room), colors.muted, colors.surface, false, room);
    let mx = cols - 1 - meta_w;
    for (const [text, color, bold] of meta) mx = c.text(mx, 0, text, color, colors.surface, bold);
    r.draw(c, 0, 1, cols, h, {
      bg: null,
      hover: this.hover,
      context: this.code,
      folds: this.code,
      scrollbar: true,
      shift: this.shift,
    });
    const help =
      s.mode === "code"
        ? i18n.t`q close  e edit  z fold  Z fold all  space page  g/G top/end`
        : i18n.t`q close  e edit  F follow  space page  g/G top/end`;
    c.fill(rows - 1, null);
    c.text(1, rows - 1, help, colors.faint, null, false, cols - 2);
  }
  private meta(): [string, palette.Rgb, boolean][] {
    const colors = palette.colors,
      r = this.reader,
      s = r.source,
      bytes = size(s.size),
      failure = s.error;
    if (failure !== null) return [[i18n.t`Can't read it: ${failure}`, colors.hot, false]];
    if (s.mode === "code") {
      const count = s.lines.length;
      return [[i18n.t`${count} lines · ${bytes}`, colors.faint, false]];
    }
    if (s.scan !== null && s.seeking !== null) return [[progressLabel(s.seeking, s.scan), colors.accent, false]];
    const fresh = r.fresh;
    const out: [string, palette.Rgb, boolean][] = [[`${bytes}  `, colors.faint, false]];
    if (r.following) out.push([i18n.t`● following`, colors.accent, true]);
    else {
      out.push([i18n.t`‖ paused`, colors.muted, false]);
      if (fresh > 0) out.push([i18n.t` · ${fresh} new`, colors.accent, false]);
    }
    return out;
  }
}

const enter = "\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h",
  leave = "\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l";
/** Draws at most this often while a log streams. */
const frame_ms = 33;

/** What a viewer that draws the file sends the pane's process: stop
 * drawing, open the editor at `line`, or end. */
export const quiet_request = "\x1b_corgi-view;quiet;\x1b\\";
export const editRequest = (line: number | null) => `\x1b_corgi-view;edit;${line ?? ""}\x1b\\`;
export const quit_request = "\x1b_corgi-view;quit;\x1b\\";
const lead = "\x1b_corgi-view;";
const request = /\x1b_corgi-view;(quiet|edit|quit);(\d*)\x1b\\/;
export type Request = "quiet" | "quit" | { edit: number | null };
/** The requests in what the pane's process read, the keys around them, and
 * what's left of a request still arriving. */
export function requests(text: string): { found: Request[]; other: string; rest: string } {
  const found: Request[] = [];
  let other = "";
  for (let m = request.exec(text); m; m = request.exec(text)) {
    found.push(m[1] === "edit" ? { edit: m[2] ? Number(m[2]) : null } : (m[1] as "quiet" | "quit"));
    other += text.slice(0, m.index);
    text = text.slice(m.index + m[0].length);
  }
  // A read can end anywhere in one, after its first byte too.
  let at = text.lastIndexOf(lead);
  const escape = text.lastIndexOf("\x1b");
  if (at < 0 && escape >= 0 && lead.startsWith(text.slice(escape))) at = escape;
  if (at < 0 || text.length - at > 64) return { found, other: other + text, rest: "" };
  return { found, other: other + text.slice(0, at), rest: text.slice(at) };
}

/** A pane's file as this viewer reads and shows it. */
export class Hosted {
  view: View | null = null;
  error: string | null = null;
  private closed = false;
  /** A drag over the file's text, in the pane's cells, at the scroll it began at. */
  private drag: { x: number; y: number; to: { x: number; y: number } | null; top: number } | null = null;
  private painted: Canvas | null = null;
  constructor(
    readonly file: FileView,
    readonly files: fileAccess.Files,
    wake: () => void,
  ) {
    Source.open(file.path, { line: file.line, changed: wake, files }).then(
      source => {
        if (this.closed) return void source.close();
        // The pane was asked for a line deep in a large file, so it scans on without asking.
        if (source.far) void source.find();
        this.view = new View(new Reader(source, file.line, file.column), file.line);
        wake();
      },
      error => {
        this.error = errors.name(error) ?? "ReadFailed";
        wake();
      },
    );
  }
  shows(file: FileView, files: fileAccess.Files): boolean {
    const mine = this.file;
    return files === this.files && file.path === mine.path && file.line === mine.line && file.column === mine.column;
  }
  /** Applies the key a viewer encoded for the pane; a paste is no key.
   * Returns what to send the pane's process, if anything. */
  key(bytes: string | Uint8Array | number[], rows: number): string {
    const view = this.view,
      key = keys[typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("latin1")];
    if (key === "quit") return quit_request;
    if (key === "edit") return editRequest(view ? view.lineShown(rows) : this.file.line);
    if (key && view) {
      this.drag = null;
      view.key(key, rows);
    }
    return "";
  }
  /** A mouse report in the pane's cells, with or without Shift. A drag
   * selects the text it crosses; returns that text when it ends, to copy. */
  mouse(button: number, x: number, y: number, release: boolean, rows: number): string | null {
    const view = this.view,
      plain = button & ~28;
    if (!view) return null;
    const cell = { x: Math.max(view.textColumn, x), y: Math.min(Math.max(1, y), View.body(rows)) };
    if (release) return this.drag?.to ? this.selected() : null;
    if (plain === 32) {
      if (this.drag && (this.drag.to || cell.x !== this.drag.x || cell.y !== this.drag.y)) this.drag.to = cell;
      return null;
    }
    if (plain !== 35)
      this.drag = plain === 0 && x >= view.textColumn ? { ...cell, to: null, top: view.reader.top } : null;
    view.mouse(plain, x, y, release, rows);
    return null;
  }
  /** The drag's ends in reading order, while what it began over still shows. */
  private range(): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
    const drag = this.drag;
    if (!drag?.to || !this.view || this.view.reader.top !== drag.top) return null;
    const forward = drag.y < drag.to.y || (drag.y === drag.to.y && drag.x <= drag.to.x);
    return forward ? { from: drag, to: drag.to } : { from: drag.to, to: drag };
  }
  /** The selected cells of each row the drag crosses, as last drawn. */
  private *crossed(): Generator<Cell[]> {
    const range = this.range(),
      c = this.painted;
    if (!range || !c || !this.view) return;
    for (let y = range.from.y; y <= range.to.y && y < c.h; y++) {
      const row = c.cells[y],
        from = y === range.from.y ? range.from.x : this.view.textColumn,
        to = y === range.to.y ? range.to.x : c.w - 1;
      // The scrollbar is no text.
      yield row.slice(from, to + 1).filter((cell, i) => from + i < c.w - 1 || cell.ch !== "┃");
    }
  }
  private selected(): string {
    const lines = [...this.crossed()].map(cells =>
      cells
        .map(cell => cell.ch)
        .join("")
        .trimEnd(),
    );
    return lines.join("\n");
  }
  /** Draws the pane at `x`, `y`, dimmed behind a dialog; `hover` is the pane row under the pointer. */
  draw(w: Writer, x: number, y: number, cols: number, rows: number, hover: number | null, dim = false): void {
    const c = new Canvas(x, y, cols, rows),
      colors = palette.colors,
      view = this.view;
    if (view) {
      view.hover = hover !== null && hover >= 1 && hover <= View.body(rows) ? hover - 1 : null;
      view.paint(c, cols, rows);
      this.painted = c;
      for (const cells of this.crossed())
        for (const cell of cells) Object.assign(cell, { fg: colors.strong, bg: palette.selection_bg });
    } else {
      const failure = this.error;
      for (let r = 0; r < rows; r++) c.fill(r, r === 0 ? colors.surface : null);
      c.text(1, 0, basename(this.file.path), colors.strong, colors.surface, true, cols - 2);
      if (failure !== null) c.text(1, 1, i18n.t`Can't read it: ${failure}`, colors.hot, null, false, cols - 2);
      else c.text(1, 1, i18n.t`Reading…`, colors.muted, null, false, cols - 2);
    }
    if (dim) c.fade();
    c.flush(w);
  }
  close(): void {
    this.closed = true;
    void this.view?.reader.source.close();
  }
}
/** The files a viewer shows in place of its panes. */
export class Panes {
  private shown = new Map<number, Hosted>();
  constructor(private wake: () => void) {}
  /** Reads the files `panes` name, and lets go of the rest. `opened` hears
   * of each pane this viewer starts to draw. */
  sync(
    panes: { id: number; view: FileView | null }[],
    files: fileAccess.Files,
    opened: (pane: number) => void = () => {},
  ): void {
    const live = new Set<number>();
    for (const pane of panes) {
      if (!pane.view) continue;
      live.add(pane.id);
      const had = this.shown.get(pane.id);
      if (had?.shows(pane.view, files)) continue;
      had?.close();
      this.shown.set(pane.id, new Hosted(pane.view, files, this.wake));
      opened(pane.id);
    }
    for (const [id, hosted] of this.shown) {
      if (live.has(id)) continue;
      hosted.close();
      this.shown.delete(id);
    }
  }
  get(pane: number): Hosted | null {
    return this.shown.get(pane) ?? null;
  }
  clear(): void {
    for (const hosted of this.shown.values()) hosted.close();
    this.shown.clear();
  }
}

/** Keeps the file `file` gives named to the daemon at `socket` for `pane`,
 * again whenever a reloaded daemon has forgotten it. */
function naming(pane: number, socket: string, file: () => FileView | null): { tell(): Promise<void>; close(): void } {
  let conn = new rpc.Connection(socket),
    retry: ReturnType<typeof setTimeout> | null = null,
    closed = false;
  const tell = async () => {
    const named = file();
    await conn.call("pane.view", {
      pane,
      path: named?.path ?? null,
      line: named?.line ?? null,
      column: named?.column ?? null,
    });
  };
  const watch = () =>
    conn.onClose(() => {
      const again = async (wait: number) => {
        retry = null;
        if (closed) return;
        conn.close();
        conn = new rpc.Connection(socket);
        try {
          await tell();
          watch();
        } catch {
          retry = setTimeout(() => void again(Math.min(wait * 2, 2000)), wait);
        }
      };
      if (!closed) retry = setTimeout(() => void again(250), 100);
    });
  watch();
  return {
    // A daemon that doesn't take the name leaves the process drawing.
    tell: () => tell().catch(() => {}),
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      conn.close();
    },
  };
}

/** Runs the file view in this pane until `q`. */
export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write("usage: corgi __view PATH [--line N] [--column N]\n");
    process.exitCode = 2;
    return;
  }
  const out = process.stdout;
  let timer: ReturnType<typeof setTimeout> | null = null,
    last = 0,
    view: View | null = null,
    paused = false,
    // A viewer draws the file itself.
    quiet = false,
    line = args.line,
    column = args.column;
  const draw = () => {
    timer = null;
    if (!view || paused || quiet) return;
    last = Date.now();
    out.write(view.draw(out.columns || 80, out.rows || 24));
  };
  const schedule = () => {
    if (timer === null) timer = setTimeout(draw, Math.max(0, last + frame_ms - Date.now()));
  };
  let source: Source;
  try {
    source = await Source.open(args.path, { line: args.line, changed: schedule });
  } catch (error) {
    process.stderr.write(`corgi: can't read ${args.path}: ${errors.name(error) ?? "unknown error"}\n`);
    process.exitCode = 1;
    return;
  }
  // A line deep in a large file: the pane was asked for it, so it scans on without asking.
  if (source.far) void source.find();
  view = new View(new Reader(source, args.line, args.column), args.line);
  out.write(enter);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  // In a Corgi pane, its viewers hear which file this is; the editor has the pane while it runs.
  const pane = Number(process.env.CORGI_PANE) || 0,
    named =
      pane > 0
        ? naming(pane, process.env.CORGI_SOCKET || os.socketPath(), () =>
            paused ? null : { path: args.path, line, column },
          )
        : null;
  void named?.tell();
  const parser = new terminalInput.Parser();
  let escape: ReturnType<typeof setTimeout> | null = null;
  let finished!: () => void;
  const done = new Promise<void>(resolve => (finished = resolve));
  /** Runs the editor at `at`, the line a viewer shows, or at the one drawn here. */
  const edit = async (at: number | null = view!.lineShown(out.rows || 24)) => {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    paused = true;
    await named?.tell();
    out.write(leave);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    try {
      const child = Bun.spawn(editorCommand(editor, args.path, at), { stdio: ["inherit", "inherit", "inherit"] });
      await child.exited;
    } catch {
      // A missing editor leaves the view as it was.
    }
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    out.write(enter);
    paused = false;
    // A viewer comes back where the editor opened.
    if (at !== line) column = null;
    line = at;
    await named?.tell();
    draw();
  };
  const take = (events: terminalInput.Input[]) => {
    if (escape) clearTimeout(escape);
    escape = null;
    if (paused) return;
    const rows = out.rows || 24;
    for (const event of input(events)) {
      if ("mouse" in event) {
        const m = event.mouse;
        view!.mouse(m.button, m.x, m.y, m.release, rows);
        continue;
      }
      if (event.key === "quit") return finished();
      if (event.key === "edit") return void edit();
      view!.key(event.key, rows);
    }
    schedule();
    // A read can end partway through a key; a lone Escape is one once nothing follows it.
    const due = parser.due();
    if (due !== Infinity) escape = setTimeout(() => take(parser.expire()), Math.max(0, due - performance.now()));
  };
  let pending = "",
    held: ReturnType<typeof setTimeout> | null = null;
  process.stdin.on("data", (data: Buffer) => {
    if (held) clearTimeout(held);
    held = null;
    if (paused) return;
    const asked = requests(pending + data.toString("latin1"));
    pending = asked.rest;
    // What began like a request and went no further was keys, such as Escape.
    if (pending)
      held = setTimeout(() => {
        const keys = pending;
        pending = "";
        take(parser.feed(Buffer.from(keys, "latin1")));
      }, 50);
    for (const found of asked.found) {
      if (found === "quit") return finished();
      if (found === "quiet") quiet = true;
      else return void edit(found.edit);
    }
    if (asked.other) take(parser.feed(Buffer.from(asked.other, "latin1")));
  });
  out.on("resize", schedule);
  draw();
  await done;
  if (timer) clearTimeout(timer);
  if (escape) clearTimeout(escape);
  if (held) clearTimeout(held);
  named?.close();
  out.write(leave);
  process.stdin.setRawMode?.(false);
  await source.close();
  process.exit(0);
}
