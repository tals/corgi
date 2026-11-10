import { Rect, type View } from "./layout";
import * as palette from "./palette";
import * as text from "./text";

/** A machine that hasn't caught up for a while, said over the focused pane. */
export interface State {
  /** The machine, what it's doing and the typing it holds. */
  status: string;
  /** The keys that act on it meanwhile. */
  keys: string;
}

/** The focused pane's top `rows` rows, or the panes' area's without one. */
export function locate(view: View, area: Rect, rows = 2): Rect | null {
  let rect = area;
  if (view.model.count) {
    const focus = view.selection.tabs[view.selection.active].focus;
    rect = view.placements(area).find(spot => spot.id === focus)?.rect ?? area;
  }
  if (rect.w < 8 || rect.h < 1) return null;
  return new Rect(rect.x, rect.y, rect.w, Math.min(rows, rect.h));
}

export function draw(state: State, at: Rect): string {
  const rows = [new palette.Style({ fg: "warm", bg: "surface", bold: true }).sgr() + fit(` ⟳ ${state.status}`, at.w)];
  // With no keys to offer, it takes one row.
  if (state.keys) rows.push(new palette.Style({ fg: "muted", bg: "surface" }).sgr() + fit(`   ${state.keys}`, at.w));
  return rows
    .slice(0, at.h)
    .map((row, i) => `\x1b[${at.y + i + 1};${at.x + 1}H${row}`)
    .join("")
    .concat("\x1b[0m");
}

function fit(value: string, width: number): string {
  const clipped = text.ellipsis(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " "), width);
  return clipped + " ".repeat(Math.max(0, width - text.displayWidth(clipped)));
}
