//! Compact, single-line usage and reset groups for the agent picker.
//! Mirrors launcher_usage.zig.
import { fg } from "./palette";
import { Writer, displayWidth, writeEllipsis, asciiText, truncatedText, sat } from "./text";

const text_capacity = 160;
/** "  6%" through "100%". */
const percent_width = 4;
const separator = " │ ";

export interface LimitWindow {
  minutes: number | null;
  used: number;
  reset_at: number | null;
}
export function windowLabel(w: LimitWindow): string {
  const n = w.minutes;
  if (n === null || n === undefined || n <= 0) return "Window";
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
  if (seconds <= 0) return "now";
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
export const usage_max_age = 10 * 60;
/** Whether a reading fetched at `fetched_at` is too old to show. */
export function expired(fetched_at: number, now: number): boolean {
  return fetched_at <= 0 || now - fetched_at >= usage_max_age;
}

interface CellWindow {
  label: string;
  used: number;
  reset: string;
}
export class Cell {
  /** By slot, so one provider's weekly limit sits under another's. */
  windows: [CellWindow | null, CellWindow | null] = [null, null];
  fallback = "";

  static init(windows: [LimitWindow | null, LimitWindow | null], now: number): Cell {
    const cell = new Cell();
    windows.forEach((window, i) => {
      if (!window) return;
      cell.windows[i] = {
        label: asciiText(windowLabel(window), text_capacity),
        used: window.used,
        reset: asciiText(countdown(window, now) ?? "unknown", text_capacity),
      };
    });
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
    cell.fallback = truncatedText(`Unavailable · ${reason}`, text_capacity);
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
      let plain = "";
      grid.slots.forEach((slot, i) => {
        if (!slot) return;
        if (i > 0 && grid.slots[0] !== null) plain += separator;
        const window = this.windows[i];
        if (!window) {
          plain += " ".repeat(slotWidth(slot, 0));
          return;
        }
        plain += padded(window.label, slot.label);
        plain += ` ${String(window.used).padStart(3)}% · `;
        plain += padded(window.reset, slot.reset);
      });
      writeEllipsis(w, plain.replace(/ +$/, ""), width);
      return;
    }
    const bar_width = grid.barWidth(width);
    const empty = selected ? fg("line") : fg("selected");
    const quiet = selected ? fg("muted") : fg("faint");
    grid.slots.forEach((slot, i) => {
      if (!slot) return;
      if (i > 0 && grid.slots[0] !== null) w.write(fg("line") + separator + row_style);
      const window = this.windows[i];
      if (!window) {
        w.splat(" ", slotWidth(slot, bar_width));
        return;
      }
      w.write(row_style + fg("muted"));
      w.write(padded(window.label, slot.label));
      w.write(`${row_style} `);
      const color = window.used >= 100 ? fg("hot") : window.used >= 80 ? fg("warm") : fg("accent");
      if (bar_width > 0) {
        const filled = Math.floor((bar_width * window.used + 50) / 100);
        w.write(color);
        for (let j = 0; j < bar_width; j++) {
          if (j === filled) w.write(empty);
          w.write("━");
        }
        w.write(`${row_style} `);
      }
      w.write(
        `\x1b[1m${window.used >= 80 ? color : fg("strong")}${String(window.used).padStart(3)}%${row_style}` +
          fg("line") +
          ` · ${quiet}`,
      );
      w.write(padded(window.reset, slot.reset));
      w.write(row_style);
    });
  }
}
interface Slot {
  label: number;
  reset: number;
}
function slotWidth(slot: Slot, bar: number): number {
  return slot.label + 1 + (bar > 0 ? bar + 1 : 0) + percent_width + 3 + slot.reset;
}
/** Column widths shared by every row's groups, so they line up as a grid. */
export class Grid {
  /** Null where no row has that window. */
  slots: [Slot | null, Slot | null] = [null, null];
  /** The widest status, such as "Track usage", shown instead of groups. */
  status = 0;
  add(cell: Cell): void {
    if (!cell.limited()) this.status = Math.max(this.status, displayWidth(cell.fallback));
    cell.windows.forEach((window, i) => {
      if (!window) return;
      const wider = { ...(this.slots[i] ?? { label: 0, reset: 0 }) };
      wider.label = Math.max(wider.label, displayWidth(window.label));
      wider.reset = Math.max(wider.reset, displayWidth(window.reset));
      this.slots[i] = wider;
    });
  }
  minimumWidth(): number {
    return Math.max(this.status, this.groupsWidth(0));
  }
  preferredWidth(): number {
    return Math.max(this.status, this.groupsWidth(6));
  }
  groupsWidth(bar: number): number {
    let size = 0;
    for (const slot of this.slots) {
      if (!slot) continue;
      if (size > 0) size += displayWidth(separator);
      size += slotWidth(slot, bar);
    }
    return size;
  }
  /** The same in every row: up to six cells, then none once a group would
   * get fewer than two. */
  barWidth(width: number): number {
    const groups = (this.slots[0] !== null ? 1 : 0) + (this.slots[1] !== null ? 1 : 0);
    if (groups === 0) return 0;
    const extra = Math.floor(sat(width, this.groupsWidth(0)) / groups);
    return extra >= 3 ? Math.min(6, extra - 1) : 0;
  }
  /** Whether `cell` was among the rows the grid was sized for. */
  holds(cell: Cell): boolean {
    const wider = new Grid();
    wider.slots = [this.slots[0] && { ...this.slots[0] }, this.slots[1] && { ...this.slots[1] }];
    wider.status = this.status;
    wider.add(cell);
    return JSON.stringify(wider.slots) === JSON.stringify(this.slots);
  }
}
function padded(text: string, width: number): string {
  return text + " ".repeat(sat(width, displayWidth(text)));
}
