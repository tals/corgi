import { Writer, displayWidth, writeEllipsis, sat } from "./text";
import { Fetch } from "./corgi_animation";
import { milliTimestamp } from "./clock";
import { Rect } from "./layout";
import { Action } from "./action";
import * as keys from "./keys";
import * as km from "./keymap";
import * as bindings from "./bindings";
import { Style as PaletteStyle, keycap } from "./palette";

type Style = "text" | "bright" | "dim" | "rule" | "direct" | "keycap" | "attention";
export interface Part {
  x: number;
  text: string;
  style: Style;
  action: Action | null;
}
export class Column {
  rows: Part[][] = [];
  constructor(
    public width: number,
    public preset: km.Preset,
  ) {}
  line(x: number, text: string, style: Style, action: Action | null = null) {
    this.rows.push([{ x, text, style, action }]);
  }
  space() {
    this.rows.push([]);
  }
  heading(label: string) {
    this.rows.push([
      { x: 0, text: label, style: "bright", action: null },
      {
        x: label.length + 2,
        text: "─".repeat(Math.max(0, this.width - label.length - 2)),
        style: "rule",
        action: null,
      },
    ]);
  }
  group(label: string) {
    this.line(2, label, "bright");
  }
  wrapped(text: string, indent: number, style: Style, right = false, action: Action | null = null) {
    const room = Math.max(1, this.width - indent);
    while (text) {
      let end = 0,
        gap = 0;
      for (const ch of text) {
        if (displayWidth(text.slice(0, end) + ch) > room) break;
        end += ch.length;
        if (ch === " ") gap = end - 1;
      }
      if (end < text.length && gap > 0) end = gap;
      if (!end) end = [...text][0].length;
      const slice = text.slice(0, end).trim();
      this.line(right ? this.width - displayWidth(slice) : indent, slice, style, action);
      text = text.slice(end).trimStart();
    }
  }
  binding(label: string, key: string, indent: number, direct = false, action: Action | null = null) {
    if (indent + displayWidth(label) + 3 + displayWidth(key) <= this.width)
      this.rows.push([
        { x: indent, text: label, style: "text", action },
        {
          x: this.width - displayWidth(key),
          text: key,
          style: direct ? "direct" : "bright",
          action,
        },
      ]);
    else {
      this.wrapped(label, indent, "text", false, action);
      this.wrapped(key, indent, direct ? "direct" : "bright", true, action);
    }
  }
  action(label: string, action: Action, indent: number) {
    const key = spelling(this.preset, action);
    if (key !== null) this.binding(label, key, indent, false, action);
  }
  featured(label: string, action: Action, indent: number) {
    const key = spelling(this.preset, action);
    if (key === null) return;
    const cap = `[ ${key} ]`,
      start = this.rows.length;
    this.wrapped(label, indent + 2, "bright", false, action);
    this.rows[start].push({ x: indent, text: "●", style: "attention", action });
    const last = this.rows.at(-1)![0];
    if (last.x + displayWidth(last.text) + 3 + displayWidth(cap) > this.width) this.space();
    this.rows.at(-1)!.push({
      x: Math.max(0, this.width - displayWidth(cap)),
      text: cap,
      style: "keycap",
      action,
    });
  }
  alsoHeld(label: string, action: Action, indent: number) {
    const shown = bindings.find(this.preset, action),
      held = bindings.first(this.preset, action, false);
    if (shown?.prefixed && held) this.binding(label, bindings.format(held), indent, true, action);
  }
  pair(label: string, a: Action, b: Action, indent: number) {
    const one = spelling(this.preset, a),
      two = spelling(this.preset, b);
    if (one === null || two === null) return;
    const width = displayWidth(one) + 3 + displayWidth(two);
    if (indent + displayWidth(label) + 3 + width > this.width) this.wrapped(label, indent, "text");
    const row: Part[] = [];
    if (indent + displayWidth(label) + 3 + width <= this.width)
      row.push({ x: indent, text: label, style: "text", action: null });
    if (indent + width <= this.width) {
      const x = this.width - width;
      row.push(
        { x, text: one, style: "bright", action: a },
        {
          x: x + displayWidth(one),
          text: " / ",
          style: "bright",
          action: null,
        },
        { x: x + displayWidth(one) + 3, text: two, style: "bright", action: b },
      );
      this.rows.push(row);
    } else {
      this.wrapped(one, indent, "bright", true, a);
      this.wrapped(two, indent, "bright", true, b);
    }
  }
}
export function spelling(preset: km.Preset, action: Action) {
  const shown = bindings.find(preset, action);
  if (!shown) return null;
  if (shown.prefixed) return (preset === "cmux" ? "P " : "") + bindings.format(shown);
  const fallback = bindings.first(preset, action, true);
  return bindings.format(shown) + (fallback ? " · P " + bindings.format(fallback) : "");
}
const act = (name: string, value?: any) => (value === undefined ? ({ name } as Action) : ({ name, value } as Action));
export function navigation(c: Column) {
  c.heading("TABS");
  c.action("New tab → agent picker", act("new"), 2);
  c.alsoHeld("Also works directly", act("new"), 4);
  c.pair("Next / previous", act("next"), act("prev"), 2);
  c.binding("Select tab", c.preset === "tmux" ? "0–9" : c.preset === "cmux" ? "Ctrl+1–9 · P 1–9" : "1–9", 2);
  c.action("Rename", act("rename-tab"), 2);
  c.action("Close", act("close-tab"), 2);
  c.space();
  c.heading("WORKSPACES");
  c.action("New", act("new-workspace"), 2);
  c.action("Edit", act("edit-workspace"), 2);
  c.pair("Next / previous", act("workspace-next"), act("workspace-prev"), 2);
  c.action("Choose workspace", act("choose-workspace"), 2);
  if (c.preset === "herdr") c.binding("Also choose workspace", "g", 4);
  if (c.preset === "cmux") c.binding("Select workspace", "Cmd+1–9", 2);
  c.action("Close workspace", act("close-workspace"), 2);
  c.space();
  c.heading("AGENTS");
  c.featured("Jump to who needs you", act("attention"), 2);
  c.alsoHeld("Also works directly", act("attention"), 4);
  c.group("Navigate");
  c.action("Find", act("find-agent"), 4);
  c.action("Choose", act("choose-agent"), 4);
  c.pair("Next / previous", act("next-agent"), act("prev-agent"), 4);
  c.action("Last visited", act("last-agent"), 4);
  c.group("Manage");
  c.action("New agent", act("new-agent"), 4);
  c.pair("Close / reopen", act("close"), act("undo-close"), 4);
  c.alsoHeld("Reopen directly", act("undo-close"), 4);
  c.action("Mute / unmute", act("mute"), 4);
}
function direction(c: Column, x: number, title: string, caption: string, tag: string, start: number) {
  while (c.rows.length < start + 4) c.space();
  c.rows[start].push({ x: x + 2, text: title, style: "bright", action: null });
  c.rows[start + 1].push({
    x: x + 2,
    text: caption,
    style: "dim",
    action: null,
  });
  for (const [dir, row, offset] of [
    ["up", 2, 6],
    ["left", 3, 2],
    ["down", 3, 6],
    ["right", 3, 10],
  ] as const) {
    const action = act(tag, dir),
      binding = bindings.find(c.preset, action);
    if (binding)
      c.rows[start + row].push({
        x: x + offset,
        text: "[" + bindings.format({ ...binding, mods: {} }) + "]",
        style: "bright",
        action,
      });
  }
}
export function panes(c: Column) {
  c.heading("PANES");
  const top = c.rows.length;
  direction(c, 0, "Focus", c.preset === "cmux" ? "Cmd+Option" : "Move focus", "focus", top);
  if (bindings.find(c.preset, act("swap", "up")))
    direction(
      c,
      c.width >= 30 ? Math.floor((c.width + 2) / 2) : 0,
      "Swap",
      c.preset === "cmux" ? "P + key" : "Move pane",
      "swap",
      c.width >= 30 ? top : c.rows.length,
    );
  if (c.preset === "cmux") c.binding("Also focus", "P h j k l", 2);
  if (c.preset === "corgi") c.binding("Also focus", "h j k l", 2);
  c.action("Next pane", act("next-pane"), 2);
  c.action("Previous pane", act("prev-pane"), 2);
  c.action("Close", act("close"), 2);
  c.space();
  c.group("Split");
  if (c.width >= 30 && c.preset !== "cmux") {
    const right = Math.floor((c.width + 2) / 2),
      splitRight = act("split", "right"),
      splitDown = act("split", "down");
    for (const [left, down] of [
      ["┌──┬──┐", "┌─────┐"],
      ["│  │  │", "├─────┤"],
      ["└──┴──┘", "└─────┘"],
    ])
      c.rows.push([
        { x: 2, text: left, style: "dim", action: splitRight },
        { x: right + 2, text: down, style: "dim", action: splitDown },
      ]);
    c.rows.push([
      {
        x: 2,
        text: bindings.format(bindings.first(c.preset, splitRight, true)!),
        style: "bright",
        action: splitRight,
      },
      { x: 5, text: "Right", style: "text", action: splitRight },
      {
        x: right + 2,
        text: bindings.format(bindings.first(c.preset, splitDown, true)!),
        style: "bright",
        action: splitDown,
      },
      { x: right + 5, text: "Down", style: "text", action: splitDown },
    ]);
  } else c.pair("Right / down", act("split", "right"), act("split", "down"), 4);
  c.group("Arrange");
  c.action("Resize", act("resize-mode"), 4);
  if (c.preset === "tmux") c.binding("Resize", "Ctrl+arrows", 4);
  if (c.preset === "cmux") c.binding("Resize directly", "Ctrl+Shift+HJKL", 4);
  c.action("Zoom / unzoom", act("zoom"), 4);
  c.action("Move to new tab", act("break"), 4);
  c.space();
  c.heading("TERMINAL");
  c.action("Scroll / copy", act("copy-mode"), 2);
  c.action("Paste copied text", act("paste"), 2);
  if (c.preset === "cmux") c.binding("Paste (host terminal)", "Cmd+V", 2);
  c.action("Detach", act("detach"), 2);
  c.space();
  c.heading("CORGI");
  c.action("Toggle sidebar", act("sidebar"), 2);
  c.action("Setup", act("setup"), 2);
}
const command_footer = "Press a shortcut or click a key";
/** The corgi's patch of the footer, from past the longest footer text to the
 * Esc button. */
function corgiZone(b: Rect): { x: number; w: number } | null {
  const x = 5 + command_footer.length;
  if (b.w < 32 || b.h < 12 || b.w < x + 17 + 6) return null;
  return { x, w: b.w - 17 - x };
}
export function bounds(cols: number, rows: number) {
  const w = Math.min(cols, 112),
    h = Math.min(rows, 36);
  return new Rect(Math.floor((cols - w) / 2), Math.floor((rows - h) / 2), w, h);
}
function color(style: Style): string {
  switch (style) {
    case "text":
      return new PaletteStyle({ fg: "text", bg: "surface" }).sgr();
    case "bright":
      return new PaletteStyle({ fg: "strong", bg: "surface", bold: true }).sgr();
    case "dim":
      return new PaletteStyle({ fg: "faint", bg: "surface" }).sgr();
    case "rule":
      return new PaletteStyle({ fg: "line", bg: "surface" }).sgr();
    case "direct":
      return new PaletteStyle({ fg: "muted", bg: "surface" }).sgr();
    case "keycap":
      return keycap;
    // The sidebar's needs-input dot.
    case "attention":
      return new PaletteStyle({ fg: "warm", bg: "surface", bold: true }).sgr();
  }
}
function clippedAt(w: Writer, b: Rect, x: number, y: number, room: number, value: string, style: Style) {
  if (x >= b.w || y >= b.h) return;
  w.write(`\x1b[${b.y + y + 1};${b.x + x + 1}H${color(style)}`);
  writeEllipsis(w, value, Math.min(room, b.w - x));
}
function at(w: Writer, b: Rect, x: number, y: number, value: string, style: Style) {
  clippedAt(w, b, x, y, sat(b.w, x + 1), value, style);
}
function box(w: Writer, b: Rect) {
  for (let y = 0; y < b.h; y++) {
    w.write(`\x1b[${b.y + y + 1};${b.x + 1}H${color("rule")}${y === 0 ? "╭" : y + 1 === b.h ? "╰" : "│"}`);
    if (y === 0 || y + 1 === b.h) w.write("─".repeat(b.w - 2));
    else w.splat(" ", b.w - 2);
    w.write(y === 0 ? "╮" : y + 1 === b.h ? "╯" : "│");
  }
}
function columnsFor(b: Rect, preset: km.Preset) {
  const dual = b.w >= 60,
    width = dual ? Math.floor((b.w - 9) / 2) - 4 : b.w - 8,
    columns = [new Column(width, preset), new Column(width, preset)];
  navigation(columns[0]);
  panes(columns[1]);
  const total = dual
    ? Math.max(columns[0].rows.length, columns[1].rows.length)
    : columns[0].rows.length + 1 + columns[1].rows.length;
  return { dual, columns, total };
}
export type Hit = { name: "none" | "close" | "play" } | { name: "action"; action: Action };
export class State {
  command_mode = false;
  scroll = 0;
  page_rows = 1;
  max_scroll = 0;
  /** The corgi in the footer, and its cells in the last frame. */
  corgi = new Fetch();
  corgi_room = 0;
  move(down: boolean, rows: number) {
    this.scroll = down ? Math.min(this.max_scroll, this.scroll + rows) : sat(this.scroll, rows);
  }
  /** Throws the footer corgi a ball. Its key, `t`, is a secret: help
   * doesn't list it. */
  play(now: number) {
    this.corgi.throwBall(this.corgi_room, now);
  }
  key(byte: number): boolean {
    switch (byte) {
      case 27:
      case 13:
      case 0x71: // q
      case 0x3f: // ?
        return true;
      case 0x6a: // j
      case 14:
        this.move(true, 1);
        break;
      case 0x6b: // k
      case 16:
        this.move(false, 1);
        break;
      case 0x67: // g
        this.scroll = 0;
        break;
      case 0x47: // G
        this.scroll = this.max_scroll;
        break;
      case 0x74: // t
        this.play(milliTimestamp());
        break;
    }
    return false;
  }
  sequence(seq: string) {
    switch (keys.parse(seq)) {
      case "up":
        this.move(false, 1);
        break;
      case "down":
        this.move(true, 1);
        break;
      case "page_up":
        this.move(false, this.page_rows);
        break;
      case "page_down":
        this.move(true, this.page_rows);
        break;
      case "home":
        this.scroll = 0;
        break;
      case "end":
        this.scroll = this.max_scroll;
        break;
    }
  }
  static closeAt(cols: number, rows: number, x: number, y: number) {
    const b = bounds(cols, rows);
    return !b.contains(x, y) || (y === b.y + sat(b.h, 2) && x >= b.x + sat(b.w, 16));
  }
  static corgiAt(cols: number, rows: number, x: number, y: number) {
    const b = bounds(cols, rows);
    const zone = corgiZone(b);
    if (!zone) return false;
    return y === b.y + b.h - 2 && x >= b.x + zone.x && x < b.x + zone.x + zone.w;
  }
  /** Whether a click at `x`, `y` does something there: a key, the corgi or
   * Esc. Outside the box a click closes help, but nothing is pointed at. */
  pointsAt(cols: number, rows: number, x: number, y: number, preset: km.Preset): boolean {
    const hit = this.hit(cols, rows, x, y, preset);
    switch (hit.name) {
      case "none":
        return false;
      case "close":
        return bounds(cols, rows).contains(x, y);
      default:
        return true;
    }
  }
  hit(cols: number, rows: number, x: number, y: number, preset: km.Preset): Hit {
    if (State.closeAt(cols, rows, x, y)) return { name: "close" };
    if (State.corgiAt(cols, rows, x, y)) return { name: "play" };
    const b = bounds(cols, rows);
    if (b.w < 32 || b.h < 12 || y < b.y + 5 || y >= b.y + b.h - 3) return { name: "none" };
    const { dual, columns, total } = columnsFor(b, preset);
    const scroll = Math.min(this.scroll, sat(total, b.h - 8));
    const offset = y - b.y - 5 + scroll;
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      const base = dual || i === 0 ? 0 : columns[0].rows.length + 1;
      if (offset < base || offset - base >= column.rows.length) continue;
      const start = b.x + (!dual || i === 0 ? 4 : 7 + Math.floor((b.w - 9) / 2));
      for (const part of column.rows[offset - base])
        if (part.action && x >= start + part.x && x < start + part.x + displayWidth(part.text))
          return { name: "action", action: part.action };
    }
    return { name: "none" };
  }
  /** The screen, with the host pointer set to `pointer_shape`. */
  frame(
    cols: number,
    rows: number,
    preset: km.Preset,
    prefix: km.Prefix,
    now: number,
    pointer_shape = "default",
  ): string {
    const w = new Writer();
    // Synchronized, so the corgi's frames redraw the screen without tearing.
    w.write("\x1b[?2026h" + new PaletteStyle({ bg: "bg" }).sgr() + "\x1b[2J\x1b[?25l");
    const b = bounds(cols, rows);
    if (b.w < 32 || b.h < 12) {
      this.page_rows = 1;
      this.max_scroll = 0;
      this.scroll = 0;
      at(w, b, 0, 0, "Help needs 32 × 12", "text");
      if (b.h > 1) at(w, b, 0, 1, "Esc back", "bright");
      this.corgi_room = 0;
      w.write(`\x1b[0m\x1b]22;${pointer_shape}\x1b\\\x1b[?2026l`);
      return w.buffered();
    }
    box(w, b);
    at(w, b, 2, 0, " Corgi ", "bright");
    at(w, b, 3, 1, "Keyboard shortcuts", "bright");
    if (b.w >= 60) at(w, b, b.w - 17, 1, km.name(preset), "dim");
    at(w, b, 3, 3, "PREFIX", "dim");
    at(w, b, 11, 3, `[ ${km.prefixName(prefix)} ]`, "keycap");
    at(
      w,
      b,
      23,
      3,
      preset === "cmux" ? "P = prefix · Cmd = hold" : b.w < 76 ? "then key" : "Release, then press the key.",
      "dim",
    );

    const { dual, columns, total } = columnsFor(b, preset);
    const capacity = b.h - 8;
    this.page_rows = capacity;
    this.max_scroll = sat(total, capacity);
    this.scroll = Math.min(this.scroll, this.max_scroll);
    const right = 3 + Math.floor((b.w - 9) / 2) + 3;
    if (dual) for (let y = 4; y < b.h - 2; y++) at(w, b, right - 2, y, "│", "rule");
    columns.forEach((column, i) => {
      const base = dual || i === 0 ? 0 : columns[0].rows.length + 1;
      const x = !dual || i === 0 ? 4 : right + 1;
      column.rows.forEach((row, index) => {
        const y = base + index;
        if (y < this.scroll || y - this.scroll >= capacity) return;
        for (const part of row) at(w, b, x + part.x, 5 + y - this.scroll, part.text, part.style);
      });
    });
    const scroll_keys = this.command_mode && preset === "tmux" ? "PgUp/PgDn" : "↑↓ PgUp/PgDn";
    const footer =
      total > capacity
        ? `${scroll_keys}  ${this.scroll + 1}–${Math.min(total, this.scroll + capacity)}/${total}`
        : this.command_mode
          ? command_footer
          : "All shortcuts";
    clippedAt(w, b, 3, b.h - 2, b.w - 21, b.w < 60 && total > capacity ? scroll_keys : footer, "dim");
    at(w, b, b.w - 16, b.h - 2, "[ Esc Back ]", "bright");
    this.corgi_room = 0;
    const zone = corgiZone(b);
    if (zone) {
      this.corgi_room = zone.w;
      w.write(`\x1b[${b.y + b.h - 1};${b.x + zone.x + 1}H${color("text")}`);
      w.write(this.corgi.write(zone.w, now));
    }
    w.write(`\x1b[0m\x1b]22;${pointer_shape}\x1b\\\x1b[?2026l`);
    return w.buffered();
  }
}
