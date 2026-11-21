//! The file peek: a card under a file's name in a pane, once the pointer has
//! rested on the name for `link_tooltip.file_delay`. It shows the line the text named in the
//! middle of what's around it, or a log's newest lines as they come. The
//! wheel scrolls it, and a click opens the file in a pane of its own. The
//! file is read while the pointer waits, so the card opens filled.
import { basename, dirname } from "node:path";
import { Canvas } from "./canvas";
import * as errors from "./errors";
import type * as fileRef from "./file_ref";
import { Source } from "./file_source";
import { Reader } from "./file_view";
import * as i18n from "./i18n";
import { Rect } from "./layout";
import * as palette from "./palette";
import { directoryLabel, displayWidth, shortPath, type Writer } from "./text";

/** The lines a peek shows. */
export const rows = 11;
const max_width = 88;
/** Lines one wheel step moves. */
export const wheel_lines = 3;

export function size(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export class Peek {
  reader: Reader | null = null;
  error: string | null = null;
  readonly key: string;
  /** The read that fills it, for tests to wait on. */
  readonly opened: Promise<void>;
  private closed = false;
  constructor(
    readonly path: string,
    readonly ref: fileRef.Ref,
    wake: () => void,
  ) {
    this.key = `${path}:${ref.line ?? ""}:${ref.column ?? ""}`;
    this.opened = Source.open(path, { line: ref.line, changed: wake }).then(
      source => {
        if (this.closed) return void source.close();
        this.reader = new Reader(source, ref.line, ref.column);
        wake();
      },
      error => {
        this.error = errors.name(error) ?? "ReadFailed";
        wake();
      },
    );
  }
  close(): void {
    this.closed = true;
    void this.reader?.source.close();
  }
  /** The file's line at row `r` of the card's body. */
  lineAt(r: number): number | null {
    const reader = this.reader;
    if (!reader) return null;
    const shown = reader.shownRows()[reader.top + r];
    return shown ? reader.source.number(shown.row) : null;
  }
}
/** The one peek a viewer prepares or shows. */
export class Peeks {
  current: Peek | null = null;
  constructor(private wake: () => void) {}
  /** The peek at `path` and `ref`'s line, read now when it's new. */
  get(path: string, ref: fileRef.Ref): Peek {
    const key = `${path}:${ref.line ?? ""}:${ref.column ?? ""}`;
    if (this.current?.key === key) return this.current;
    this.current?.close();
    return (this.current = new Peek(path, ref, this.wake));
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
  peek.reader?.scroll(up ? -wheel_lines : wheel_lines, rows);
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
  reader?.sync(rows);
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
    const hover = pointer ? bodyRow(rect, pointer.x, pointer.y) : null;
    reader.draw(c, 1, 2, rect.w - 2, rows, {
      bg,
      hover: hover === null ? null : reader.top + hover,
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
function metadata(reader: Reader): [string, palette.Rgb, boolean][] {
  const colors = palette.colors,
    s = reader.source,
    bytes = size(s.size);
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
