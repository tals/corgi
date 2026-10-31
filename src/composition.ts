import type { Terminal } from "./mirror";
import type { Rect } from "./layout";
import type { Writer } from "./text";

export interface Pane {
  terminal: Terminal;
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  at: number;
  revision: number;
}

export type Cursor = { x: number; y: number } | null;
export function cursorBytes(cursor: Cursor): string {
  return cursor ? `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h` : "\x1b[?25l";
}

/** TypeScript owns the drawing order; pane cells stay in their native surface. */
export class Frame {
  chrome = "";
  panes: Pane[] = [];
  cursor: Cursor = null;
  /** Insertion after pane content, before the final pointer shape and sync close. */
  cursor_at: number | null = null;
  reusable = true;
  pane(w: Writer, terminal: Terminal, id: number, rect: Rect): void {
    this.panes.push({
      terminal,
      id,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      at: w.s.length,
      revision: terminal.render_revision,
    });
  }
  cover(rect: Rect): void {
    if (
      this.panes.some(p => p.x < rect.x + rect.w && rect.x < p.x + p.w && p.y < rect.y + rect.h && rect.y < p.y + p.h)
    )
      this.reusable = false;
  }
  finish(chrome: string, prefix = "", suffix = ""): this {
    this.chrome = prefix + chrome + suffix;
    if (prefix) for (const pane of this.panes) pane.at += prefix.length;
    if (this.cursor_at !== null) this.cursor_at += prefix.length;
    return this;
  }
  /** The complete ANSI frame remains the reference and fallback. */
  text(): string {
    let result = "",
      from = 0;
    for (const p of this.panes) {
      result += this.chrome.slice(from, p.at) + p.terminal.rows(p.id, p.x, p.y, p.w, p.h, false, null);
      from = p.at;
    }
    if (this.cursor_at !== null)
      return (
        result + this.chrome.slice(from, this.cursor_at) + cursorBytes(this.cursor) + this.chrome.slice(this.cursor_at)
      );
    return result + this.chrome.slice(from);
  }
  sharesChrome(previous: Frame): boolean {
    return this.reusable && previous.reusable && this.matches(previous);
  }
  matches(previous: Frame): boolean {
    return this.chrome === previous.chrome && this.cursor_at === previous.cursor_at && this.samePanes(previous);
  }
  private samePanes(previous: Frame): boolean {
    return (
      this.panes.length === previous.panes.length &&
      this.panes.every((p, i) => {
        const q = previous.panes[i];
        return (
          p.terminal === q.terminal &&
          p.id === q.id &&
          p.x === q.x &&
          p.y === q.y &&
          p.w === q.w &&
          p.h === q.h &&
          p.at === q.at
        );
      })
    );
  }
}

export type Output = string | Frame;

export function same(left: Output, right: Output): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return (
    right.matches(left) &&
    right.cursor?.x === left.cursor?.x &&
    right.cursor?.y === left.cursor?.y &&
    right.panes.every((p, i) => p.revision === left.panes[i].revision)
  );
}
