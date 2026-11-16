import type { Key } from "./keys";
import type { Terminal } from "./mirror";
import { codepointWidth, displayWidth } from "./text";

type Point = { x: number; y: number };
type Selection = { kind: "characters" | "lines"; anchor: Point };
type Motion =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "top"
  | "bottom"
  | "page_up"
  | "page_down"
  | "half_up"
  | "half_down";
export type Command = Motion | "select" | "lines" | "swap" | "copy" | "cancel";
type Navigation = Exclude<Command, "copy" | "cancel"> | { scroll: number };

export function command(key: number | Key): Command | null {
  switch (key) {
    case 104:
    case "left":
      return "left";
    case 108:
    case "right":
      return "right";
    case 107:
    case "up":
      return "up";
    case 106:
    case "down":
      return "down";
    case 48:
    case "home":
      return "home";
    case 36:
    case "end":
      return "end";
    case 103:
      return "top";
    case 71:
      return "bottom";
    case 2:
    case "page_up":
      return "page_up";
    case 6:
    case "page_down":
      return "page_down";
    case 21:
      return "half_up";
    case 4:
      return "half_down";
    case 32:
    case 118:
      return "select";
    case 86:
      return "lines";
    case 111:
      return "swap";
    case 121:
    case 13:
      return "copy";
    case 113:
    case 27:
    case 3:
      return "cancel";
    default:
      return null;
  }
}

/** Cells use Ghostty's widths, retaining combining marks with their base. */
function cells(line: string): { x: number; width: number; text: string }[] {
  const result: { x: number; width: number; text: string }[] = [];
  let x = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const width = codepointWidth(cp);
    const previous = result.at(-1);
    if (width === 0 && previous) previous.text += ch;
    else if (width > 0) {
      result.push({ x, width, text: ch });
      x += width;
    }
  }
  return result;
}

/** Viewer-local cursor and selection over the scrollback rows actually displayed. */
export class State {
  cursor: Point;
  selection: Selection | null = null;
  private lines = new Map<number, string>();
  private cols: number;
  private rows: number;
  private requested: number | null = null;
  private identity: bigint | null = null;
  private queued: Navigation[] = [];
  constructor(readonly terminal: Terminal) {
    this.cols = terminal.inner.cols;
    this.rows = terminal.inner.rows;
    const caret = terminal.caret() ?? { x: 0, y: this.rows - 1 };
    this.cursor = { x: caret.x, y: terminal.displayedOffset + caret.y };
    terminal.offset = terminal.displayedOffset;
    terminal.clearSelection();
    this.sync();
  }
  close(): void {
    this.terminal.clearSelection();
    this.terminal.scrollViewport("bottom");
  }
  found(): void {
    const term = this.terminal,
      match = term.selection;
    if (!match) return;
    const top = term.offset ?? term.bottom;
    this.selection = { kind: "characters", anchor: { x: match.x, y: top + match.y } };
    this.cursor = { x: match.end_x, y: top + match.end_y };
    this.requested = top;
    term.holding_selection = false;
  }
  /** Hold each received viewport until navigation asks for another. */
  sync(): void {
    const term = this.terminal;
    if (term.holding_selection) return;
    if (this.requested !== null) {
      this.requested = Math.min(this.requested, term.bottom);
      if (this.requested !== term.displayedOffset) {
        term.offset = this.requested;
        return;
      }
    } else if ((term.offset ?? term.bottom) !== term.displayedOffset) return;
    const cols = term.inner.cols,
      rows = term.inner.rows;
    const identity = term.known?.identity ?? this.identity;
    if (cols !== this.cols || rows !== this.rows || identity !== this.identity) {
      this.cols = cols;
      this.rows = rows;
      this.lines.clear();
      this.selection = null;
      this.cursor.y = Math.max(term.displayedOffset, Math.min(this.cursor.y, term.displayedOffset + rows - 1));
    }
    if (this.requested === null)
      this.cursor.y = Math.max(term.displayedOffset, Math.min(this.cursor.y, term.displayedOffset + rows - 1));
    this.identity = identity;
    this.requested = null;
    const lines = term.inner.text().split("\n");
    for (let y = 0; y < rows; y++) this.lines.set(term.displayedOffset + y, lines[y] ?? "");
    this.cursor.x = this.column(this.cursor.x);
    this.reveal();
    while (this.requested === null && this.queued.length > 0) {
      const command = this.queued.shift();
      if (command) this.act(command);
    }
  }
  private column(x: number): number {
    x = Math.max(0, Math.min(x, this.cols - 1));
    const cell = cells(this.lines.get(this.cursor.y) ?? "").find(cell => cell.x <= x && x < cell.x + cell.width);
    return cell?.x ?? x;
  }
  mouse(x: number, y: number, anchor: Point | null = null): void {
    this.sync();
    const top = this.terminal.displayedOffset;
    this.requested = null;
    this.queued = [];
    this.terminal.offset = top;
    this.cursor = { x, y: top + y };
    this.selection = anchor ? { kind: "characters", anchor: { x: anchor.x, y: top + anchor.y } } : null;
    this.highlight();
  }
  visibleCursor(): Point | null {
    if (this.requested !== null) return null;
    const y = this.cursor.y - this.terminal.displayedOffset;
    return y >= 0 && y < this.rows ? { x: this.cursor.x, y } : null;
  }
  private range(): { start: Point; end: Point } | null {
    if (!this.selection) return null;
    const anchor = this.selection.anchor,
      cursor = this.cursor;
    const forward = anchor.y < cursor.y || (anchor.y === cursor.y && anchor.x <= cursor.x);
    const start = { ...(forward ? anchor : cursor) },
      end = { ...(forward ? cursor : anchor) };
    if (this.selection.kind === "lines") {
      start.x = 0;
      end.x = this.cols - 1;
    }
    return { start, end };
  }
  private highlight(): void {
    const range = this.range(),
      top = this.terminal.displayedOffset,
      bottom = top + this.rows - 1;
    if (!range || range.end.y < top || range.start.y > bottom) {
      this.terminal.clearSelection();
    } else {
      this.terminal.select(
        range.start.y < top ? 0 : range.start.x,
        Math.max(range.start.y - top, 0),
        range.end.y > bottom ? this.cols - 1 : range.end.x,
        Math.min(range.end.y - top, this.rows - 1),
      );
    }
    this.terminal.holding_selection = true;
  }
  act(command: Navigation): void {
    this.sync();
    const term = this.terminal;
    // Replay navigation once the requested rows arrive, without skipping selected text.
    if (this.requested !== null || (term.offset ?? term.bottom) !== term.displayedOffset) {
      this.queued.push(command);
      return;
    }
    if (typeof command === "object") {
      const top = term.displayedOffset;
      const delta = Math.max(-this.rows, Math.min(command.scroll, this.rows));
      const next = Math.max(0, Math.min(top + delta, term.bottom));
      if (next !== top && delta !== command.scroll) this.queued.unshift({ scroll: command.scroll - delta });
      this.cursor.y = Math.max(next, Math.min(this.cursor.y, next + this.rows - 1));
      this.reveal(next);
      return;
    }
    switch (command) {
      case "select":
      case "lines":
        const kind = command === "lines" ? "lines" : "characters";
        this.selection =
          this.selection?.kind === kind ? null : { kind, anchor: this.selection?.anchor ?? { ...this.cursor } };
        break;
      case "swap":
        if (this.selection) [this.cursor, this.selection.anchor] = [this.selection.anchor, this.cursor];
        break;
      case "left":
        this.cursor.x = this.column(this.cursor.x - 1);
        break;
      case "right": {
        const cell = cells(this.lines.get(this.cursor.y) ?? "").find(cell => cell.x === this.cursor.x);
        this.cursor.x = this.column(this.cursor.x + (cell?.width ?? 1));
        break;
      }
      case "home":
        this.cursor.x = 0;
        break;
      case "end":
        this.cursor.x = this.column(displayWidth((this.lines.get(this.cursor.y) ?? "").trimEnd()) - 1);
        break;
      case "up":
        this.cursor.y--;
        break;
      case "down":
        this.cursor.y++;
        break;
      case "half_up":
        this.cursor.y -= Math.max(1, Math.floor(this.rows / 2));
        break;
      case "half_down":
        this.cursor.y += Math.max(1, Math.floor(this.rows / 2));
        break;
      case "page_up":
        this.cursor.y -= Math.max(1, this.rows - 1);
        break;
      case "page_down":
        this.cursor.y += Math.max(1, this.rows - 1);
        break;
      case "top":
        this.cursor.y = 0;
        break;
      case "bottom":
        this.cursor.y = term.bottom + this.rows - 1;
        break;
    }
    this.reveal();
  }
  private reveal(viewport?: number): void {
    const term = this.terminal;
    this.cursor.y = Math.max(0, Math.min(this.cursor.y, term.bottom + this.rows - 1));
    this.cursor.x = this.column(this.cursor.x);
    const top = term.displayedOffset;
    let next =
      viewport ??
      (this.cursor.y < top ? this.cursor.y : this.cursor.y >= top + this.rows ? this.cursor.y - this.rows + 1 : top);
    // Visit intervening rows so a selection spanning scrollback is complete.
    if (this.selection) next = Math.max(top - this.rows, Math.min(next, top + this.rows));
    if (next !== top) {
      term.scrollViewport({ row: next });
      // A numeric bottom stays still while the program produces output.
      term.offset = next;
      this.requested = next;
    } else this.highlight();
  }
  /** Null means a requested viewport has not arrived yet; never copy a partial range. */
  text(): string | null {
    this.sync();
    if (this.requested !== null) return null;
    const range = this.range();
    if (!range) return this.terminal.selectedText();
    const lines: string[] = [];
    for (let y = range.start.y; y <= range.end.y; y++) {
      const line = this.lines.get(y);
      if (line === undefined) return null;
      const left = y === range.start.y ? range.start.x : 0;
      const right = y === range.end.y ? range.end.x : this.cols - 1;
      const selected = cells(line)
        .filter(cell => cell.x + cell.width > left && cell.x <= right)
        .map(cell => cell.text)
        .join("");
      lines.push(this.selection?.kind === "lines" ? selected.trimEnd() : selected);
    }
    return lines.join("\n") + (this.selection?.kind === "lines" ? "\n" : "");
  }
}
