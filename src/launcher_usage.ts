//! Compact, single-line usage and reset groups for the agent picker.
//! Mirrors launcher_usage.zig.
import * as i18n from "./i18n";
import { fg } from "./palette";
import { Writer, displayWidth, writeEllipsis, truncatedText, sat } from "./text";
import * as spend from "./usage/spend";
import { expired } from "./usage/account";

const text_capacity = 160;
/** "  6%" through "100%". */
const percent_width = 4;
const separator = " │ ";
/** Between a figure and its reset. */
const gap = "   ";
/** A bar's most cells. */
const full_bar = 6;
/** The widest countdown: "23h 59m". */
const countdown_width = 7;

export interface LimitWindow {
  minutes: number | null;
  used: number;
  reset_at: number | null;
}
export function windowLabel(w: LimitWindow): string {
  const n = w.minutes;
  if (n === null || n === undefined || n <= 0) return i18n.t`Window`;
  if (n % 1440 === 0) return `${n / 1440}d`;
  if (n % 60 === 0) return `${n / 60}h`;
  return `${n}m`;
}
export function countdown(w: LimitWindow, now: number): string | null {
  if (w.reset_at === null || w.reset_at === undefined) return null;
  return resetCountdown(w.reset_at, now);
}
function resetCountdown(at: number, now: number): string {
  const seconds = at - now;
  if (seconds <= 0) return i18n.t`now`;
  const minutes = Math.trunc(seconds / 60) + (seconds % 60 > 0 ? 1 : 0);
  const days = Math.trunc(minutes / 1440);
  const hours = Math.trunc(minutes / 60) % 24;
  const mins = minutes % 60;
  if (days > 0) {
    if (hours > 0) return `${days}d ${hours}h`;
    if (mins > 0) return `${days}d ${mins}m`;
    return `${days}d`;
  }
  if (hours > 0) {
    if (mins > 0) return `${hours}h ${mins}m`;
    return `${hours}h`;
  }
  return `${minutes}m`;
}
export { expired };

interface CellWindow {
  label: string;
  used: number | null;
  figure: string;
  reset: string;
}
/** Whether a window resets within a day, like the 5h one. */
function short(w: LimitWindow): boolean {
  return w.minutes !== null && w.minutes !== undefined && w.minutes > 0 && w.minutes < 1440;
}
/** The longer limit first; a lone short one keeps the second slot. */
function byLength([a, b]: [LimitWindow | null, LimitWindow | null]): [LimitWindow | null, LimitWindow | null] {
  if (a && b) return short(a) && !short(b) ? [b, a] : [a, b];
  const only = a ?? b;
  if (!only) return [null, null];
  return short(only) ? [null, only] : [only, null];
}
/** "<1%" once a month has begun, so it never reads as untouched. */
export function percentFigure(used: number): string {
  return used > 0 && used < 1 ? "<1%" : `${Math.floor(used)}%`;
}
export class Cell {
  /** The weekly limit first, so every account's lines up; 5h follows. */
  windows: [CellWindow | null, CellWindow | null] = [null, null];
  /** Monthly spend, in the second slot after its month's bar. */
  amount = "";
  fallback = "";

  static init(windows: [LimitWindow | null, LimitWindow | null], now: number): Cell {
    const cell = new Cell();
    byLength(windows).forEach((window, i) => {
      if (!window) return;
      cell.windows[i] = {
        label: truncatedText(windowLabel(window), text_capacity),
        used: window.used,
        figure: `${window.used}%`,
        reset: truncatedText(countdown(window, now) ?? i18n.t`unknown`, text_capacity),
      };
    });
    return cell;
  }
  static monthly(reading: spend.Reading, now: number): Cell {
    const cell = new Cell();
    const used = spend.percent(reading);
    cell.windows[0] = {
      label: "mo",
      used,
      figure: used === null ? "" : percentFigure(used),
      reset: resetCountdown(reading.reset_at, now),
    };
    cell.amount = spend.amounts(reading);
    return cell;
  }
  /** Not `ascii`, which would blank the "…" and "—" in statuses. */
  static status(text: string): Cell {
    const cell = new Cell();
    cell.fallback = truncatedText(text, text_capacity);
    return cell;
  }
  static unavailable(reason: string): Cell {
    const cell = new Cell();
    cell.fallback = truncatedText(i18n.t`Unavailable · ${reason}`, text_capacity);
    return cell;
  }
  limited(): boolean {
    return this.windows[0] !== null || this.windows[1] !== null;
  }
  /** `selected` rows need brighter grays: faint text and empty cells vanish on them. */
  write(w: Writer, grid: Grid, width: number, row_style: string, selected: boolean): void {
    if (!this.limited()) return writeEllipsis(w, this.fallback, width);
    if (width < grid.groupsWidth(0) || !grid.holds(this)) {
      // At exceptionally small widths, clip text before adding any SGR.
      const plain = new Writer();
      writeGroups(
        plain,
        grid.widened(this),
        this,
        0,
        separator,
        (window, slot) => {
          plain.write(padded(window.label, slot.label));
          plain.write(` ${window.figure.padStart(slot.figure)}${gap}`);
          plain.write(padded(window.reset, slot.reset));
        },
        text => plain.write(text),
      );
      writeEllipsis(w, plain.s.replace(/ +$/, ""), width);
      return;
    }
    const bar_width = grid.barWidth(width);
    const quiet = selected ? fg("muted") : fg("faint");
    const money = fg(selected ? "text" : "muted");
    writeGroups(
      w,
      grid,
      this,
      bar_width,
      fg("line") + separator + row_style,
      (window, slot) => {
        w.write(row_style + fg("muted"));
        w.write(padded(window.label, slot.label));
        w.write(`${row_style} `);
        const used = window.used ?? 0;
        const near = used >= 80;
        const color = used >= 100 ? fg("hot") : near ? fg("warm") : fg("accent");
        if (bar_width > 0) {
          if (window.used === null) w.splat(" ", bar_width);
          else writeBar(w, used, bar_width, color, fg("line"), "─");
          w.write(`${row_style} `);
        }
        // Figures keep the row's ink until a limit nears.
        w.write(`${near ? `\x1b[1m${color}` : ""}${window.figure.padStart(slot.figure)}${row_style}${gap}${quiet}`);
        w.write(padded(window.reset, slot.reset));
        w.write(row_style);
      },
      text => w.write(money + text + row_style),
    );
  }
}
/** Each slot's group, or blanks where the row lacks that limit, so rows line
 * up; the rule only stands between two groups. A month's amount takes the
 * second slot, which a month leaves empty. */
function writeGroups(
  w: Writer,
  grid: Grid,
  cell: Cell,
  bar: number,
  rule: string,
  group: (window: CellWindow, slot: Slot) => void,
  amount: (text: string) => void,
): void {
  const [first, second] = grid.slots;
  const [lead, follow] = cell.windows;
  if (first) {
    if (lead) group(lead, first);
    else w.splat(" ", slotWidth(first, bar));
  }
  if (!follow && !cell.amount) return;
  if (first) {
    if (lead && follow) w.write(rule);
    else w.splat(" ", displayWidth(separator));
  }
  if (follow) group(follow, second!);
  else amount(cell.amount);
}
export function writeBar(w: Writer, used: number, width: number, filled_ink: string, empty_ink: string, track = "━") {
  const filled = Math.round((width * Math.max(0, Math.min(100, used))) / 100);
  w.write(filled_ink + "━".repeat(filled) + empty_ink + track.repeat(width - filled));
}
interface Slot {
  label: number;
  figure: number;
  reset: number;
}
function slotWidth(slot: Slot, bar: number): number {
  return slot.label + 1 + (bar > 0 ? bar + 1 : 0) + slot.figure + gap.length + slot.reset;
}
/** Column widths shared by every row's groups, so they line up as a grid. */
export class Grid {
  /** Null where no row has that window. */
  slots: [Slot | null, Slot | null] = [null, null];
  /** The widest monthly amount, which shares the second slot. */
  amount = 0;
  /** The widest status, such as "Track usage", shown instead of groups. */
  status = 0;
  add(cell: Cell): void {
    if (!cell.limited()) this.status = Math.max(this.status, displayWidth(cell.fallback));
    this.amount = Math.max(this.amount, displayWidth(cell.amount));
    cell.windows.forEach((window, i) => {
      if (!window) return;
      this.slots[i] = widen(this.slots[i], window);
    });
  }
  minimumWidth(): number {
    return Math.max(this.status, this.groupsWidth(0));
  }
  preferredWidth(): number {
    return Math.max(this.status, this.groupsWidth(full_bar));
  }
  /** Groups with full bars and every reset as wide as a countdown gets, so
   * a column sized by it holds still while they tick. */
  steadyWidth(): number {
    const steady = new Grid(),
      widest = (slot: Slot | null) => slot && { ...slot, reset: Math.max(slot.reset, countdown_width) };
    steady.slots = [widest(this.slots[0]), widest(this.slots[1])];
    steady.amount = this.amount;
    return steady.groupsWidth(full_bar);
  }
  groupsWidth(bar: number): number {
    const [first, second] = this.slots;
    const after = Math.max(second ? slotWidth(second, bar) : 0, this.amount);
    if (!first) return after;
    return slotWidth(first, bar) + (after > 0 ? displayWidth(separator) + after : 0);
  }
  /** The same in every row: up to six cells, then none once a group would
   * get fewer than two. */
  barWidth(width: number): number {
    for (let bar = full_bar; bar >= 2; bar--) if (this.groupsWidth(bar) <= width) return bar;
    return 0;
  }
  /** A copy sized for `cell` as well. */
  widened(cell: Cell): Grid {
    const wider = new Grid();
    wider.slots = [this.slots[0] && { ...this.slots[0] }, this.slots[1] && { ...this.slots[1] }];
    wider.amount = this.amount;
    wider.status = this.status;
    wider.add(cell);
    return wider;
  }
  /** Whether `cell` was among the rows the grid was sized for. */
  holds(cell: Cell): boolean {
    const wider = this.widened(cell);
    return JSON.stringify([wider.slots, wider.amount]) === JSON.stringify([this.slots, this.amount]);
  }
}
function widen(slot: Slot | null, window: CellWindow): Slot {
  return {
    label: Math.max(slot?.label ?? 0, displayWidth(window.label)),
    figure: Math.max(slot?.figure ?? percent_width, displayWidth(window.figure)),
    reset: Math.max(slot?.reset ?? 0, displayWidth(window.reset)),
  };
}
function padded(text: string, width: number): string {
  return text + " ".repeat(sat(width, displayWidth(text)));
}
