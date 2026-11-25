//! The file peek: a card under a file's name in a pane, once the pointer has
//! rested on the name as long as a link's card waits. It shows the line the text named in the
//! middle of what's around it, or a log's newest lines as they come. The
//! wheel scrolls it, and a click opens the file in a pane of its own. The
//! file is read while the pointer waits, so the card opens filled. A line
//! deep in a large file isn't scanned for until asked: the card says how
//! large the file is, a row starts the scan, and its progress shows.
import { basename, dirname } from "node:path";
import { Canvas } from "./canvas";
import * as errors from "./errors";
import * as fileAccess from "./file_access";
import type * as fileRef from "./file_ref";
import { Source } from "./file_source";
import { Reader } from "./file_view";
import * as i18n from "./i18n";
import { Rect } from "./layout";
import type * as lineIndex from "./line_index";
import * as palette from "./palette";
import { directoryLabel, displayWidth, shortPath, type Writer } from "./text";

/** The lines a peek shows. */
export const rows = 11;
const max_width = 88;
/** Lines one wheel step moves. */
export const wheel_lines = 3;
/** Rows the ask about a far line, or the scan's progress, take from the body. */
export const banner_rows = 3;

export function size(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
/** A count with its thousands apart, as a line number deep in a file reads. */
export const thousands = (n: number) => n.toLocaleString("en-US");
/** How a scan for line `n` is going, for a header. */
export function progressLabel(n: number, p: lineIndex.Progress): string {
  const line = thousands(n),
    done = size(p.scanned),
    total = size(p.size),
    lines = thousands(p.lines);
  return i18n.t`Finding line ${line}… ${done} of ${total} · ${lines} lines`;
}
/** What a click on the peek's body row means. */
export type Hit = { kind: "find" } | { kind: "line"; line: number | null };

export class Peek {
  reader: Reader | null = null;
  error: string | null = null;
  readonly key: string;
  /** The read that fills it, for tests to wait on. */
  readonly opened: Promise<void>;
  private closed = false;
  /** Stops a read the pointer left before it was done, such as a scan to a deep line. */
  private abort = new AbortController();
  constructor(
    readonly path: string,
    readonly ref: fileRef.Ref,
    wake: () => void,
    readonly files: fileAccess.Files = fileAccess.here,
    /** The most scanned for the line before the card asks first. */
    budget = fileAccess.ask_after,
  ) {
    this.key = `${path}:${ref.line ?? ""}:${ref.column ?? ""}`;
    const opts = { line: ref.line, budget, changed: wake, signal: this.abort.signal, files };
    this.opened = Source.open(path, opts).then(
      source => {
        if (this.closed) return void source.close();
        this.reader = new Reader(source, ref.line, ref.column);
        wake();
      },
      error => {
        if (this.closed) return;
        this.error = errors.name(error) ?? "ReadFailed";
        wake();
      },
    );
  }
  close(): void {
    this.closed = true;
    this.abort.abort();
    void this.reader?.source.close();
  }
  /** Rows at the top of the body that ask about a far line, or show the scan for it. */
  get banner(): number {
    const s = this.reader?.source;
    return s && (s.far !== null || s.scan !== null) ? banner_rows : 0;
  }
  /** The rows left for the file's lines. */
  get body(): number {
    return rows - this.banner;
  }
  /** What row `r` of the card's body holds: the row that starts the scan, or a line, pinned or not. */
  hit(r: number): Hit | null {
    const reader = this.reader;
    if (!reader) return null;
    const banner = this.banner;
    if (r < banner) return r === 1 && reader.source.far !== null ? { kind: "find" } : null;
    const found = reader.at(r - banner, rows - banner, true);
    return found ? { kind: "line", line: reader.source.number(found.row) } : null;
  }
  /** The file's line at row `r` of the card's body, pinned or not. */
  lineAt(r: number): number | null {
    const hit = this.hit(r);
    return hit?.kind === "line" ? hit.line : null;
  }
  /** Scans on for the far line the card asked about. */
  find(): void {
    void this.reader?.source.find();
  }
}
/** The one peek a viewer prepares or shows. */
export class Peeks {
  current: Peek | null = null;
  constructor(private wake: () => void) {}
  /** The peek at `path` and `ref`'s line among `files`, read now when it's new. */
  get(path: string, ref: fileRef.Ref, files: fileAccess.Files = fileAccess.here): Peek {
    const key = `${path}:${ref.line ?? ""}:${ref.column ?? ""}`;
    if (this.current?.key === key && this.current.files === files) return this.current;
    this.current?.close();
    return (this.current = new Peek(path, ref, this.wake, files));
  }
  clear(): void {
    this.current?.close();
    this.current = null;
  }
}
/** The card under the name at `anchor`, or over it when there's no room below. */
export function geometry(width: number, height: number, anchor: { x: number; y: number }): Rect | null {
  const w = Math.min(max_width, width - 2),
    h = rows + 3;
  if (w < 32 || height < h + 1) return null;
  const below = anchor.y + 1 + h <= height;
  return new Rect(
    Math.max(0, Math.min(anchor.x - 2, width - w)),
    below ? anchor.y + 1 : Math.max(0, anchor.y - h),
    w,
    h,
  );
}
/** The body row under `x`, `y`, or null off the body. */
export function bodyRow(rect: Rect, x: number, y: number): number | null {
  const r = y - rect.y - 2;
  return x > rect.x && x < rect.x + rect.w - 1 && r >= 0 && r < rows ? r : null;
}
export function wheel(peek: Peek, up: boolean): void {
  peek.reader?.scroll(up ? -wheel_lines : wheel_lines, peek.body);
}
export function draw(w: Writer, rect: Rect, peek: Peek, pointer: { x: number; y: number } | null): void {
  const colors = palette.colors,
    c = new Canvas(rect.x, rect.y, rect.w, rect.h),
    bg = colors.surface,
    reader = peek.reader;
  for (let r = 0; r < rect.h; r++) c.fill(r, bg);
  const edge = (r: number, left: string, right: string) => {
    c.put(0, r, left, colors.line, bg);
    for (let x = 1; x < rect.w - 1; x++) c.put(x, r, r === 0 || r === rect.h - 1 ? "─" : " ", colors.line, bg);
    c.put(rect.w - 1, r, right, colors.line, bg);
  };
  edge(0, "╭", "╮");
  for (let r = 1; r < rect.h - 1; r++) edge(r, "│", "│");
  edge(rect.h - 1, "╰", "╯");
  reader?.sync(peek.body);
  // The name and the line, the folder, then what it holds and whether it's live.
  const line = peek.ref.line !== null ? `:${peek.ref.line}` : "";
  const meta = reader ? metadata(reader) : [];
  const meta_w = meta.reduce((n, [text]) => n + displayWidth(text), 0);
  let x = c.text(2, 1, basename(peek.path) + line, colors.strong, bg, true, rect.w - 4);
  const room = rect.w - 5 - meta_w - x;
  x = c.text(x + 2, 1, shortPath(directoryLabel(dirname(peek.path)), room), colors.muted, bg, false, room);
  let mx = rect.w - 2 - meta_w;
  for (const [text, color, bold] of meta) mx = c.text(mx, 1, text, color, bg, bold);
  const failure = peek.error;
  if (failure !== null) c.text(2, 2, i18n.t`Can't read it: ${failure}`, colors.hot, bg, false, rect.w - 4);
  else if (!reader) c.text(2, 2, i18n.t`Reading…`, colors.muted, bg, false, rect.w - 4);
  else {
    const hover = pointer ? bodyRow(rect, pointer.x, pointer.y) : null,
      banner = peek.banner;
    if (banner > 0) drawBanner(c, 2, rect.w, reader.source, hover === 1, bg);
    reader.draw(c, 1, 2 + banner, rect.w - 2, rows - banner, {
      bg,
      hover: hover === null ? null : hover - banner,
      context: true,
      scrollbar: true,
    });
  }
  const hint = !reader
    ? ""
    : reader.source.mode === "tail" && !reader.following
      ? i18n.t` click to open · scroll to the end to follow `
      : reader.source.mode === "tail"
        ? i18n.t` click to open · scroll up to pause `
        : i18n.t` click to open · scroll `;
  if (hint) c.text(2, rect.h - 1, hint, colors.faint, bg, false, rect.w - 4);
  c.flush(w);
}
/** The ask about a far line, with the row that starts its scan, or how the scan is going. */
function drawBanner(c: Canvas, y: number, w: number, s: Source, hovered: boolean, bg: palette.Rgb): void {
  const colors = palette.colors,
    far = s.far,
    scan = s.scan;
  if (far !== null) {
    const total = size(s.size),
      line = thousands(far.line);
    c.text(2, y, i18n.t`This file is ${total}. Finding line ${line} may take a while.`, colors.muted, bg, false, w - 4);
    const row_bg = hovered ? palette.mix(bg, colors.selected, 50) : bg;
    c.fill(y + 1, row_bg, 1, w - 1);
    c.text(2, y + 1, i18n.t`▸ Find line ${line}`, colors.accent, row_bg, true, w - 4);
  } else if (scan !== null && s.seeking !== null) {
    c.text(2, y, progressLabel(s.seeking, scan), colors.text, bg, false, w - 4);
    const width = w - 4,
      done = scan.size > 0 ? Math.min(width, Math.round((width * scan.scanned) / scan.size)) : 0;
    for (let i = 0; i < width; i++)
      c.put(2 + i, y + 1, i < done ? "━" : "─", i < done ? colors.accent : colors.line, bg);
  }
}
function metadata(reader: Reader): [string, palette.Rgb, boolean][] {
  const colors = palette.colors,
    s = reader.source,
    bytes = size(s.size),
    failure = s.error;
  if (failure !== null) return [[i18n.t`Can't read it: ${failure}`, colors.hot, false]];
  if (s.mode === "code") {
    const count = s.lines.length;
    return [[i18n.t`${count} lines · ${bytes}`, colors.faint, false]];
  }
  const fresh = reader.fresh;
  const live: [string, palette.Rgb, boolean][] = reader.following
    ? [[i18n.t`● live`, colors.accent, true]]
    : [[i18n.t`‖ paused`, colors.muted, false]];
  if (!reader.following && fresh > 0) live.push([i18n.t` · ${fresh} new`, colors.accent, false]);
  return [[`${bytes}  `, colors.faint, false], ...live];
}
