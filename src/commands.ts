//! The resize menu, and the context menus on tabs, workspaces, panes and
//! agents. Mirrors commands.zig.
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import type { Direction } from "./layout";
import { Writer, sat } from "./text";

/** A resize menu row: the key it shows and the resize a click performs. */
export interface Entry {
  key: string;
  label: string;
  direction: Direction;
  needs_pane: boolean;
}
const resize_entries: Entry[] = [
  { key: "h", label: "Resize left", direction: "left", needs_pane: true },
  { key: "j", label: "Resize down", direction: "down", needs_pane: true },
  { key: "k", label: "Resize up", direction: "up", needs_pane: true },
  { key: "l", label: "Resize right", direction: "right", needs_pane: true },
];
export type Hit =
  { tag: "none" } | { tag: "close" } | { tag: "previous" } | { tag: "next" } | { tag: "command"; command: Entry };

export type Item = "new" | "rename" | "clear-name" | "swap" | "split-right" | "split-down" | "zoom" | "fork" | "close";
/** `icon` sits in a column before the labels. A `rule` sets the row apart
 * below a line, and the highlight never starts on it. */
export interface Row {
  item: Item;
  key: string;
  label: string;
  icon: string;
  rule: boolean;
}
const row = (item: Item, key: string, label: string, extra: Partial<Row> = {}): Row => ({
  item,
  key,
  label,
  icon: "",
  rule: false,
  ...extra,
});
const actions = [row("new", "n", "New tab"), row("rename", "r", "Rename"), row("close", "x", "Close")];
const pane_actions = [
  row("swap", "s", "Swap with focused pane"),
  row("rename", "r", "Rename pane"),
  row("clear-name", "c", "Clear pane name"),
  row("split-right", "v", "Split right"),
  row("split-down", "d", "Split down"),
  row("zoom", "z", "Zoom / unzoom"),
  row("close", "x", "Close pane"),
];
const agent_actions = [
  row("rename", "r", "Rename"),
  row("fork", "f", "Fork", { icon: "⑂" }),
  row("close", "x", "Close", { rule: true }),
];
let border: string;
palette.derived(() => {
  border = new Style({ fg: "line", bg: "surface" }).sgr();
});

// Herdr's tab context menu: these actions apply to the clicked tab, not the
// currently focused tab. Keep its identity even while tabs move or disappear.
export class TabMenu {
  tab = 0;
  anchor_x = 0;
  anchor_y = 0;
  workspace = false;
  pane = false;
  /** An agent row's menu; `tab` is the agent's pane. */
  agent = false;
  source: number | null = null;
  highlighted = 0;
  /** Rows shown crossed out, which neither keys nor clicks run. */
  off = new Set<Item>();
  constructor(fields: Partial<TabMenu> & { tab: number; anchor_x: number }) {
    Object.assign(this, fields);
  }
  entries(): Row[] {
    if (this.agent) return agent_actions;
    if (this.pane) return this.source !== null ? pane_actions : pane_actions.slice(1);
    return this.workspace ? actions.slice(1) : actions;
  }
  /** The row a key picks. Keys are the menu's own, lowercase, and Shift picks the same row. */
  itemFor(key: number): Item | null {
    const lower = String.fromCharCode(key >= 65 && key <= 90 ? key + 32 : key);
    for (const entry of this.entries()) if (entry.key === lower) return this.off.has(entry.item) ? null : entry.item;
    return null;
  }
  /** The highlighted row's item, unless it is crossed out. */
  highlightedItem(): Item | null {
    const item = this.entries()[this.highlighted].item;
    return this.off.has(item) ? null : item;
  }
  /** Highlights the first row that runs above any rule, so Enter right
   * after opening never closes anything. With none, nothing is highlighted. */
  highlightFirst(): void {
    this.highlighted = 0;
    this.entries().some((entry, index) => {
      if (!entry.rule && !this.off.has(entry.item)) {
        this.highlighted = index;
        return true;
      }
      return false;
    });
  }
  /** Screen lines the rows take: one each, and one per rule. */
  lines(): number {
    return this.entries().length + this.entries().filter(entry => entry.rule).length;
  }
  hasIcons(): boolean {
    return this.entries().some(entry => entry.icon.length > 0);
  }
  /** The widest label, with the icon column when there is one. */
  labelWidth(): number {
    let widest = 0;
    for (const entry of this.entries()) widest = Math.max(widest, Buffer.byteLength(entry.label));
    return widest + (this.hasIcons() ? 2 : 0);
  }
  bounds(width: number, height: number): { x: number; y: number; width: number; padding: number } {
    // Borders, a gutter each side, and a keycap with its space.
    const w = Math.min(width, Math.max(20, this.labelWidth() + 10));
    return {
      x: Math.min(this.anchor_x, width - w),
      y: Math.min(this.anchor_y, sat(height, this.lines() + 2)),
      width: w,
      padding: height >= this.lines() + 2 ? 1 : 0,
    };
  }
  /** The row under `x`, `y`; null on a rule or outside the rows. */
  hit(width: number, height: number, x: number, y: number): number | null {
    const b = this.bounds(width, height);
    if (x < b.x + 1 || x >= b.x + b.width - 1) return null;
    let line = b.y + b.padding;
    const entries = this.entries();
    for (let index = 0; index < entries.length; index++) {
      if (entries[index].rule) line += 1;
      if (y === line) return index;
      line += 1;
    }
    return null;
  }
  /** Moves the highlight to the next row that runs, past crossed-out ones. */
  move(next: boolean): void {
    const len = this.entries().length;
    for (let i = 0; i < len; i++) {
      this.highlighted = next ? (this.highlighted + 1) % len : (this.highlighted + len - 1) % len;
      if (!this.off.has(this.entries()[this.highlighted].item)) return;
    }
  }
  /** Drawn like the launcher: a rounded box on `surface`, `›` on the
   * highlighted row, and each row's key as a cap before its label. */
  draw(w: Writer, width: number, height: number): void {
    const b = this.bounds(width, height);
    if (b.width < 4) return;
    const inner = b.width - 2;
    if (b.padding > 0) {
      for (const r of [0, this.lines() + 1]) {
        w.write(`\x1b[${b.y + r + 1};${b.x + 1}H${border}${r === 0 ? "╭" : "╰"}`);
        w.write("─".repeat(inner));
        w.write(r === 0 ? "╮" : "╯");
      }
    }
    // A narrow menu gives up its keycaps, then its icons, before labels.
    const keys = b.width >= 16;
    const icons = this.hasIcons() && b.width >= 18;
    const gutter = keys ? 2 : 1;
    let line = b.y + b.padding + 1;
    this.entries().forEach((entry, index) => {
      if (entry.rule) {
        w.write(`\x1b[${line};${b.x + 1}H${border}│`);
        w.splat(" ", gutter);
        w.write("─".repeat(sat(inner, 2 * gutter)));
        w.splat(" ", gutter);
        w.write("│");
        line += 1;
      }
      const off = this.off.has(entry.item);
      const highlighted = !off && index === this.highlighted;
      const row_style = highlighted
        ? new Style({ fg: "strong", bg: "selected" }).sgr()
        : new Style({ fg: "text", bg: "surface" }).sgr();
      const dim = new Style({ fg: "faint", bg: "surface" }).sgr();
      w.write(`\x1b[${line};${b.x + 1}H${border}│${row_style}`);
      w.splat(" ", inner);
      w.write(`\x1b[${line};${b.x + b.width}H${border}│\x1b[${line};${b.x + 2}H${row_style}`);
      line += 1;
      let used = gutter;
      w.write(!keys ? " " : highlighted ? "› " : "  ");
      if (keys) {
        // A row that cannot run shows its key flat, like its label.
        w.write(`${off ? dim : keycap} ${entry.key} ${row_style} `);
        used += 4;
      }
      if (icons) {
        const icon_style = off
          ? dim
          : highlighted
            ? new Style({ fg: "muted", bg: "selected" }).sgr()
            : new Style({ fg: "muted", bg: "surface" }).sgr();
        w.write(`${icon_style}${entry.icon.length > 0 ? entry.icon : " "}${row_style} `);
        used += 2;
      }
      const len = Math.min(entry.label.length, sat(inner, used));
      if (off) w.write(new Style({ fg: "faint", bg: "surface", strike: true }).sgr());
      w.write(entry.label.slice(0, len));
    });
    w.write("\x1b[0m\x1b[?25l");
  }
}
/** Key and label styles for a resize-menu row: a keycap when the row can run,
 * and the label on the row's background. */
function rowColors(enabled: boolean, selected: boolean): { key: string; label: string } {
  if (!enabled) return { key: palette.fg("faint"), label: palette.fg("faint") };
  return {
    key: keycap,
    label: selected
      ? new Style({ fg: "strong", bg: "selected" }).sgr()
      : new Style({ fg: "strong", bg: "surface" }).sgr(),
  };
}
export class ResizeView {
  x = 0;
  y = 0;
  width = 0;
  rows = 0;
  columns = 1;
  page = 0;
  pages = 1;
  has_pane = false;
  /** A key code, as Zig's `?u8`. */
  highlighted: string | null = null;
  static init(width: number, height: number, page: number, has_pane: boolean): ResizeView {
    const v = new ResizeView();
    const w = Math.min(width, 34);
    const count = resize_entries.length;
    const rows = Math.max(1, Math.min(count, sat(height, 3)));
    const pages = Math.floor((count + rows - 1) / rows);
    v.x = Math.floor((width - w) / 2);
    v.y = Math.floor(sat(height, rows + 3) / 2);
    v.width = w;
    v.rows = rows;
    v.columns = 1;
    v.page = Math.min(page, pages - 1);
    v.pages = pages;
    v.has_pane = has_pane;
    return v;
  }
  items(): Entry[] {
    const size = this.rows * this.columns;
    const start = this.page * size;
    return resize_entries.slice(start, Math.min(resize_entries.length, start + size));
  }
  hit(x: number, y: number): Hit {
    const v = this;
    if (x < v.x || x >= v.x + v.width || y < v.y || y >= v.y + v.rows + 3) return { tag: "close" };
    if (y === v.y) return x >= sat(v.x + v.width, 3) ? { tag: "close" } : { tag: "none" };
    if (y === v.y + v.rows + 2) {
      if (v.pages > 1) return x < v.x + Math.floor(v.width / 2) ? { tag: "previous" } : { tag: "next" };
      return { tag: "close" };
    }
    if (y < v.y + 2) return { tag: "none" };
    const col = Math.min(v.columns - 1, Math.floor((x - v.x) / Math.floor(v.width / v.columns)));
    const index = col * v.rows + y - v.y - 2;
    const list = v.items();
    if (index >= list.length || (list[index].needs_pane && !v.has_pane)) return { tag: "none" };
    return { tag: "command", command: list[index] };
  }
  draw(w: Writer): void {
    const v = this;
    for (let r = 0; r < v.rows + 3; r++) {
      w.write(`\x1b[${v.y + r + 1};${v.x + 1}H` + new Style({ bg: "surface" }).sgr());
      w.splat(" ", v.width);
    }
    v.line(w, 0, " Resize panes", true);
    w.write(`\x1b[${v.y + 1};${v.x + v.width - 1}H` + palette.fg("muted") + " x");
    v.line(w, 1, " Shortcut or click", false);
    const col_width = Math.floor(v.width / v.columns);
    v.items().forEach((entry, index) => {
      const r = index % v.rows;
      const col = Math.floor(index / v.rows);
      const enabled = !entry.needs_pane || v.has_pane;
      const selected = enabled && v.highlighted === entry.key;
      w.write(
        `\x1b[${v.y + r + 3};${v.x + col * col_width + 1}H${selected ? palette.bg("selected") : palette.bg("surface")}`,
      );
      w.splat(" ", col_width);
      const rc = rowColors(enabled, selected);
      w.write(
        `\x1b[${v.y + r + 3};${v.x + col * col_width + 1}H${rc.key} ${entry.key === "\t" ? "⇥" : entry.key} ${rc.label} `,
      );
      w.write(entry.label.slice(0, Math.min(entry.label.length, sat(col_width, 5))));
    });
    w.write(palette.bg("surface"));
    if (v.pages > 1) {
      const previous = ` < ${v.page + 1}/${v.pages}`;
      v.line(w, v.rows + 2, previous.slice(0, Math.min(previous.length, Math.floor(v.width / 2))), false);
      const next = "Next >";
      const next_len = Math.min(next.length, Math.floor(v.width / 2));
      w.write(`\x1b[${v.y + v.rows + 3};${v.x + v.width - next_len + 1}H${next.slice(next.length - next_len)}`);
    } else v.line(w, v.rows + 2, " Esc done", false);
    w.write("\x1b[0m\x1b[?25l");
  }
  private line(w: Writer, r: number, text: string, bold: boolean): void {
    w.write(
      `\x1b[${this.y + r + 1};${this.x + 1}H${bold ? "\x1b[1m" + palette.fg("strong") : "\x1b[22m" + palette.fg("muted")}`,
    );
    w.write(text.slice(0, Math.min(text.length, this.width)));
  }
}
