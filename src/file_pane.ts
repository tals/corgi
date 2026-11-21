//! `corgi __view PATH [--line N] [--column N]`: a file in a pane of its own,
//! which clicking a file's name in a pane opens. It reads as the peek does,
//! at full height: code with its folds, or a log from its end, following as
//! it grows. `e` hands the file to $VISUAL or $EDITOR at the line shown and
//! comes back after; `q` closes the pane.
import { basename, dirname, resolve } from "node:path";
import { Canvas } from "./canvas";
import * as errors from "./errors";
import { size } from "./file_peek";
import { Source } from "./file_source";
import { Reader } from "./file_view";
import * as i18n from "./i18n";
import * as palette from "./palette";
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
/** How an editor opens `path` at `line`: most take `+line`; these take `path:line`. */
export function editorCommand(editor: string, path: string, line: number | null): string[] {
  const words = editor.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) words.push("vi");
  const name = basename(words[0]);
  if (line === null) return [...words, path];
  if (/^(?:code|code-insiders|codium|cursor|windsurf)$/.test(name)) return [...words, "-g", `${path}:${line}`];
  if (/^(?:zed|subl|hx|helix)$/.test(name)) return [...words, `${path}:${line}`];
  return [...words, `+${line}`, path];
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
export type Input = { key: Key } | { mouse: { button: number; x: number; y: number; release: boolean } };
/** Splits terminal input into the keys and mouse reports it holds. */
export function input(data: string): Input[] {
  const out: Input[] = [];
  for (let i = 0; i < data.length;) {
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i));
    if (mouse) {
      out.push({ mouse: { button: +mouse[1], x: +mouse[2] - 1, y: +mouse[3] - 1, release: mouse[4] === "m" } });
      i += mouse[0].length;
      continue;
    }
    const sequence = /^\x1b(?:\[[\d;]*[~A-Za-z]|O[A-Za-z])/.exec(data.slice(i));
    const text = sequence ? sequence[0] : data[i];
    const key = keys[text];
    if (key) out.push({ key });
    i += text.length;
  }
  return out;
}

const shift_step = 8;
export class View {
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
        r.following = false;
        r.top = 0;
        return r.scroll(0, h);
      case "end":
        r.top = r.shownRows().length;
        r.scroll(0, h);
        return r.follow(r.source.mode === "tail");
      case "left":
        this.shift = Math.max(0, this.shift - shift_step);
        return;
      case "right":
        this.shift += shift_step;
        return;
      case "follow":
        return r.follow(!r.following);
      case "fold": {
        const rows_shown = r.shownRows(),
          at = this.hover ?? (r.target !== null ? r.shownIndex(r.target) : r.top);
        const shown = rows_shown[at];
        if (shown) r.toggleFold(shown.row);
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
    this.hover = y >= 1 && y <= h ? r.top + y - 1 : null;
    if (release) return;
    if (button === 64 || button === 65) return r.scroll(button === 64 ? -3 : 3, h);
    if (button === 0 && x <= 1 && this.hover !== null) {
      const shown = r.shownRows()[this.hover];
      if (shown && r.foldEnds().has(shown.row)) r.toggleFold(shown.row);
    }
  }
  /** The file's line at the top of the view, which the editor opens at. */
  lineShown(): number | null {
    const r = this.reader;
    if (r.target !== null) return r.source.number(r.target);
    const shown = r.shownRows()[r.top];
    return shown ? r.source.number(shown.row) : this.line;
  }
  draw(cols: number, rows: number): string {
    const colors = palette.colors,
      r = this.reader,
      s = r.source,
      h = View.body(rows),
      c = new Canvas(0, 0, cols, rows);
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
      context: s.mode === "code",
      folds: s.mode === "code",
      scrollbar: true,
      shift: this.shift,
    });
    const help =
      s.mode === "code"
        ? i18n.t`q close  e edit  z fold  Z fold all  space page  g/G top/end`
        : i18n.t`q close  e edit  F follow  space page  g/G top/end`;
    c.fill(rows - 1, null);
    c.text(1, rows - 1, help, colors.faint, null, false, cols - 2);
    const w = new Writer();
    w.write("\x1b[?2026h");
    c.flush(w);
    w.write("\x1b[?2026l");
    return w.s;
  }
  private meta(): [string, palette.Rgb, boolean][] {
    const colors = palette.colors,
      r = this.reader,
      s = r.source,
      bytes = size(s.size);
    if (s.mode === "code") {
      const count = s.lines.length;
      return [[i18n.t`${count} lines · ${bytes}`, colors.faint, false]];
    }
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
    paused = false;
  const draw = () => {
    timer = null;
    if (!view || paused) return;
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
  view = new View(new Reader(source, args.line, args.column), args.line);
  out.write(enter);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("latin1");
  let finished!: () => void;
  const done = new Promise<void>(resolve => (finished = resolve));
  const edit = async () => {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    paused = true;
    out.write(leave);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    try {
      const child = Bun.spawn(editorCommand(editor, args.path, view!.lineShown()), {
        stdio: ["inherit", "inherit", "inherit"],
      });
      await child.exited;
    } catch {
      // A missing editor leaves the view as it was.
    }
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    out.write(enter);
    paused = false;
    draw();
  };
  process.stdin.on("data", (data: string) => {
    if (paused) return;
    const rows = out.rows || 24;
    for (const event of input(data)) {
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
  });
  out.on("resize", schedule);
  draw();
  await done;
  if (timer) clearTimeout(timer);
  out.write(leave);
  process.stdin.setRawMode?.(false);
  await source.close();
  process.exit(0);
}
