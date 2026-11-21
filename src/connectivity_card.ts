import * as details from "./connectivity_details";
import * as palette from "./palette";
import * as text from "./text";
import * as menuAim from "./menu_aim";
import type { Forward } from "./port_forwards";
import { Rect } from "./layout";

export interface Header {
  machine: string;
  rect: Rect;
}
/** A forwarded port as the card lists it, with what serves it there. */
export interface Port {
  forward: Forward;
  name: string;
}
/** The machine's forwarded ports, under its measurements. */
export interface Ports {
  list: Port[];
  /** Rows kept for them since the card opened. */
  room: number;
  pinned: boolean;
  selected: Forward | null;
  offset: number;
  notice: string;
}
export interface Card {
  rect: Rect;
  lines: details.Line[];
  /** For a machine whose ports can be forwarded here. */
  ports?: Ports | null;
}
export type Button = "open" | "stop";
/** At most this many port rows; more scroll. */
const port_rows = 6;

let row: string, row_faint: string, bar: string, bar_faint: string, bar_key: string, bar_off: string;
palette.derived(() => {
  row = new palette.Style({ fg: "text", bg: "selected" }).sgr();
  row_faint = new palette.Style({ fg: "muted", bg: "selected" }).sgr();
  // The held card's bar: what its keys act on, and the keys.
  bar = new palette.Style({ fg: "text", bg: "bg" }).sgr();
  bar_faint = new palette.Style({ fg: "muted", bg: "bg" }).sgr();
  bar_key = new palette.Style({ fg: "strong", bg: "bg", bold: true }).sgr();
  bar_off = new palette.Style({ fg: "faint", bg: "bg" }).sgr();
});

/** The ports' rows from the card's foot: with ports, a gap, the heading,
 * their rows, the bar and its keys; without, a gap, the heading and a line
 * saying how one comes. */
function portsHeight(ports: Ports): number {
  return ports.list.length ? ports.room + 4 : 3;
}
function portsTop(rect: Rect, ports: Ports): number {
  return rect.y + rect.h - 1 - portsHeight(ports);
}
const barY = (rect: Rect) => rect.y + rect.h - 3;
/** The forward on a row under a cell. */
export function portAt(card: Card, x: number, y: number): Forward | null {
  const ports = card.ports;
  if (!ports?.list.length || x <= card.rect.x || x >= card.rect.x + card.rect.w - 1) return null;
  const first = barY(card.rect) - ports.room,
    i = y - first;
  return i >= 0 && i < ports.room ? (ports.list[ports.offset + i]?.forward ?? null) : null;
}
function buttonSpans(rect: Rect): { button: Button; key: string; label: string; x: number; width: number }[] {
  let x = rect.x + rect.w - 2;
  return [
    { button: "stop" as const, key: "x", label: "stop" },
    { button: "open" as const, key: "↵", label: "open" },
  ].map(b => {
    const width = text.displayWidth(`${b.key} ${b.label}`);
    x -= width;
    const span = { ...b, x, width };
    x -= 3;
    return span;
  });
}
/** The held card's bar button under a cell. */
export function buttonAt(card: Card, x: number, y: number): Button | null {
  if (!card.ports?.pinned || !card.ports.list.length || y !== barY(card.rect)) return null;
  return buttonSpans(card.rect).find(b => x >= b.x - 1 && x <= b.x + b.width)?.button ?? null;
}

/** The machine card, shown while its sidebar header is hovered and held open
 * for the keyboard as the resource card is: hovering a port selects it, and
 * a click on one or an arrow over the card holds it. */
export class Hover {
  private target: Header | null = null;
  private since = 0;
  private updated = -Infinity;
  /** Where the pointer left the header on its way to the card, and when it
   * last moved inside the aim triangle. */
  private aim: { x: number; y: number; at: number } | null = null;
  private pointer: { x: number; y: number } | null = null;
  /** Its size since it opened, which holds while it's open. */
  private size: { cols: number; rows: number; h: number; room: number } | null = null;
  card: Card | null = null;
  pinned = false;
  selected: Forward | null = null;
  offset = 0;
  /** What the last key did, until the next one. */
  notice = "";
  get machine(): string | null {
    return this.target?.machine ?? null;
  }
  due(): number {
    if (this.aim && !this.pinned) return this.aim.at + menuAim.aim_ms;
    return this.target && !this.card ? this.since + 1000 : Infinity;
  }
  clear(): void {
    this.target = null;
    this.card = null;
    this.aim = null;
    this.pointer = null;
    this.size = null;
    this.updated = -Infinity;
    this.release();
  }
  release(): void {
    this.pinned = false;
    this.selected = null;
    this.offset = 0;
    this.notice = "";
  }
  /** Holds the card open with `forward` selected, or the one already is, or the first. */
  pin(forward: Forward | null = null): void {
    const list = this.card?.ports?.list ?? [];
    if (!list.length) return;
    this.pinned = true;
    this.selected = forward ?? (list.some(p => p.forward === this.selected) ? this.selected : list[0].forward);
    this.notice = "";
  }
  /** Moves the selection `by` rows. */
  step(by: number): void {
    const list = this.card?.ports?.list ?? [];
    if (!list.length) return;
    const i = Math.max(
      0,
      list.findIndex(p => p.forward === this.selected),
    );
    this.selected = list[Math.max(0, Math.min(list.length - 1, i + by))].forward;
    this.notice = "";
  }
  /** Whether a forward the card lists is selected. */
  chosen(): boolean {
    return !!this.card?.ports?.list.some(p => p.forward === this.selected);
  }
  /** The pointer at `x`, `y`, over `header` if it's over one. */
  move(header: Header | null, x: number, y: number, now: number): void {
    const from = this.pointer,
      moved = !from || from.x !== x || from.y !== y;
    this.pointer = { x, y };
    if (this.pinned) return;
    if (this.card?.rect.contains(x, y)) {
      this.aim = null;
      // Hovering a port selects it.
      const forward = portAt(this.card, x, y);
      if (forward) this.selected = forward;
      return;
    }
    if (!header) {
      // Heading for the card from its header, the card stays a moment.
      const card = this.card;
      if (card && this.target) {
        if (!moved && this.aim) return;
        if (!this.aim && from && this.target.rect.contains(from.x, from.y))
          this.aim = { x: from.x, y: from.y, at: now };
        if (this.aim && menuAim.aimed(card.rect, this.aim, x, y)) {
          this.aim.at = now;
          return;
        }
      }
      return this.clear();
    }
    this.aim = null;
    if (header.machine !== this.target?.machine || header.rect.y !== this.target.rect.y) {
      this.clear();
      this.pointer = { x, y };
      this.since = now;
    }
    this.target = header;
  }
  /** The pointer rested short of the card: the card goes. */
  expire(now: number): boolean {
    if (!this.aim || this.pinned || now - this.aim.at < menuAim.aim_ms) return false;
    this.clear();
    return true;
  }
  update(
    connection: details.Connection | null,
    cols: number,
    rows: number,
    now: number,
    ports: Port[] | null = null,
  ): Card | null {
    if (!this.target || !connection || connection.name !== this.target.machine || cols < 32 || rows < 12) {
      this.clear();
      return null;
    }
    if (now - this.since < 1000) return null;
    const width = Math.min(76, cols - 2);
    const lines =
      this.card && this.card.rect.w === width && now - this.updated < 1000
        ? this.card.lines
        : details.lines(connection, width - 4, now);
    if (lines !== this.card?.lines) this.updated = now;
    // Rows for ports, kept while the card is open; more scroll. A first
    // port, or the last one stopped, changes what the section shows.
    const count = ports?.length ?? 0,
      last = this.size,
      resized = !last || last.cols !== cols || last.rows !== rows;
    let size = last!;
    if (resized || last.room > 0 !== count > 0) {
      const room = Math.min(port_rows, count),
        section = ports ? (room ? room + 4 : 3) : 0,
        h = Math.min(rows - 2, lines.length + 2 + section);
      // Open, it doesn't shrink: the last port stopped leaves its rows empty.
      size = this.size = { cols, rows, room, h: resized ? h : Math.max(last.h, h) };
    }
    // A detail line that comes while it's open, such as an update's, grows it.
    const wanted = Math.min(rows - 2, lines.length + 2 + (ports ? (size.room ? size.room + 4 : 3) : 0));
    if (wanted > size.h) size = this.size = { ...size, h: wanted };
    if (!ports?.some(p => p.forward === this.selected)) {
      if (this.pinned && ports?.length) this.selected = ports[0].forward;
      else if (this.pinned) this.release();
      else this.selected = null;
    }
    const list = ports ?? [];
    const index = list.findIndex(p => p.forward === this.selected);
    if (index >= 0 && index < this.offset) this.offset = index;
    else if (index >= this.offset + size.room) this.offset = index - size.room + 1;
    this.offset = Math.max(0, Math.min(this.offset, list.length - size.room));
    const rect = new Rect(
      Math.max(1, Math.min(this.target.rect.x + this.target.rect.w, cols - width - 1)),
      Math.max(1, Math.min(this.target.rect.y, rows - size.h - 1)),
      width,
      size.h,
    );
    return (this.card = {
      rect,
      lines,
      ports: ports && {
        list,
        room: size.room,
        pinned: this.pinned,
        selected: this.selected,
        offset: this.offset,
        notice: this.notice,
      },
    });
  }
}

function at(w: text.Writer, x: number, y: number, style: string, value: string, width: number): void {
  if (width <= 0) return;
  w.write(w.cup(y + 1, x + 1) + style);
  text.writeEllipsis(w, value, width);
}
function status(forward: Forward): { label: string; color: palette.Token } {
  switch (forward.failure) {
    case "refused":
      return { label: "nothing listening", color: "warm" };
    case "prohibited":
      return { label: "forwarding refused", color: "hot" };
    case "unreachable":
      return { label: "unreachable", color: "hot" };
    case null:
      return forward.open ? { label: `${forward.open} open`, color: "accent" } : { label: "idle", color: "muted" };
  }
}

export function draw(w: text.Writer, card: Card): void {
  const { rect, lines, ports } = card;
  const style = new palette.Style({ fg: "text", bg: "surface" }).sgr();
  for (let y = 0; y < rect.h; y++) {
    w.write(w.cup(rect.y + y + 1, rect.x + 1) + style);
    w.splat(" ", rect.w);
  }
  // The measurements take what the ports leave.
  const room = (ports ? portsTop(rect, ports) : rect.y + rect.h - 1) - rect.y - 1;
  lines.slice(0, Math.max(0, room)).forEach((line, i) => {
    w.write(w.cup(rect.y + i + 2, rect.x + 3));
    w.write(new palette.Style({ fg: line.color ?? "text", bg: "surface", bold: line.heading ?? false }).sgr());
    text.writeEllipsis(w, line.text, rect.w - 4);
    w.write(details.heat(line, rect.x + 2 + w.column, rect.y + i + 1, rect.w - 4));
  });
  if (ports) drawPorts(w, rect, ports);
  w.write("\x1b[0m\x1b[?25l");
}

function drawPorts(w: text.Writer, rect: Rect, ports: Ports): void {
  const x = rect.x + 2,
    width = rect.w - 4,
    heading = portsTop(rect, ports) + 1,
    plain = new palette.Style({ fg: "text", bg: "surface" }).sgr(),
    faint = new palette.Style({ fg: "faint", bg: "surface" }).sgr();
  at(w, x, heading, new palette.Style({ fg: "strong", bg: "surface", bold: true }).sgr(), "Forwarded ports", width);
  if (!ports.list.length) {
    at(w, x, heading + 1, faint, "Opening a localhost link from this machine forwards its port", width);
    return;
  }
  // Columns: the machine's port, what serves it, where it is here, and how it's doing.
  const here_width = 18,
    state_width = Math.min(17, Math.max(0, width - 7 - here_width - 1)),
    name_width = Math.max(0, width - 7 - here_width - state_width - 2);
  ports.list.slice(ports.offset, ports.offset + ports.room).forEach((port, i) => {
    const y = heading + 1 + i,
      chosen = port.forward === ports.selected,
      { label, color } = status(port.forward),
      text_style = chosen ? row : plain,
      dim = chosen ? row_faint : new palette.Style({ fg: "muted", bg: "surface" }).sgr();
    if (chosen) {
      w.write(w.cup(y + 1, rect.x + 2) + row);
      w.splat(" ", rect.w - 2);
    }
    at(w, x, y, text_style, String(port.forward.port).padStart(5), 5);
    at(w, x + 7, y, dim, port.name, name_width);
    at(w, x + 7 + name_width + 1, y, text_style, `→ localhost:${port.forward.local}`, here_width);
    const state = new palette.Style({ fg: color, bg: chosen ? "selected" : "surface" }).sgr();
    at(w, x + width - Math.min(state_width, text.displayWidth(label)), y, state, label, state_width);
  });
  const y = barY(rect);
  if (!ports.pinned) {
    at(w, x, y + 1, faint, "↑↓ or click to select", width);
    return;
  }
  w.write(w.cup(y + 1, rect.x + 1) + bar);
  w.splat(" ", rect.w);
  const spans = buttonSpans(rect),
    left = spans.at(-1)!.x - 2 - x;
  at(w, x, y, bar, ports.notice || ports.selected?.url || "", left);
  for (const b of spans) {
    const off = ports.selected === null;
    at(w, b.x, y, off ? bar_off : bar_key, b.key, 1);
    at(w, b.x + 2, y, off ? bar_off : bar_faint, b.label, text.displayWidth(b.label));
  }
  at(w, x, y + 1, faint, "↑↓ select  ↵ open  x stop  esc close", width);
}
