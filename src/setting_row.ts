//! A row in Corgi setup's options: › while selected, then a name, and at the
//! right edge "● On" or "○ Off" for an on/off setting, or the choice in use
//! with ▾ for a dropdown. The import picker draws
//! Herdr's handoff switch with it, in setup and onboarding alike.
import * as palette from "./palette";
import { Style, colors, type Rgb } from "./palette";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";

/** A row's styles, on its background. */
export interface Row {
  text: string;
  label: string;
  accent: string;
  muted: string;
  quiet: string;
  warn: string;
  background: Rgb;
}
export let normal: Row, selected: Row;
palette.derived(() => {
  const text = new Style({ fg: "text", bg: "surface" }).sgr();
  normal = {
    text,
    label: text,
    accent: new Style({ fg: "accent", bg: "surface" }).sgr(),
    muted: new Style({ fg: "muted", bg: "surface" }).sgr(),
    quiet: new Style({ fg: "faint", bg: "surface" }).sgr(),
    warn: new Style({ fg: "warm", bg: "surface" }).sgr(),
    background: colors.surface,
  };
  selected = {
    text: new Style({ fg: "text", bg: "selected" }).sgr(),
    label: new Style({ fg: "strong", bg: "selected", bold: true }).sgr(),
    accent: new Style({ fg: "accent", bg: "selected" }).sgr(),
    muted: new Style({ fg: "muted", bg: "selected" }).sgr(),
    // Faint is too dim on a selected row.
    quiet: new Style({ fg: "muted", bg: "selected" }).sgr(),
    warn: new Style({ fg: "warm", bg: "selected" }).sgr(),
    background: colors.selected,
  };
});
const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;

/** Paints the row from `x`, `width` wide, with › while `here`; returns its styles. */
export function fill(w: Writer, x: number, y: number, width: number, here: boolean): Row {
  const p = here ? selected : normal;
  w.write(at(x, y) + p.text);
  w.splat(" ", width);
  if (here) w.write(at(x + 2, y) + p.accent + "›");
  return p;
}
/** An on/off setting: its name, and an icon before it in the column where
 * options keep their ● and ○. */
export interface Toggle {
  label: string;
  on: boolean;
  /** Whether the cursor is on the row. */
  here: boolean;
  /** All dim while it can't change. */
  disabled?: boolean;
  glyph?: string;
}
/** An on/off setting's row: its name, and On or Off at the right edge. */
export function drawToggle(w: Writer, x: number, y: number, width: number, t: Toggle): void {
  const p = fill(w, x, y, width, t.here),
    disabled = t.disabled ?? false;
  if (t.glyph) w.write(at(x + 4, y) + (disabled ? p.quiet : p.label) + t.glyph);
  drawValue(w, p, x, y, width, t.label, t.on ? "● On" : "○ Off", t.on && !disabled ? p.accent : p.quiet, disabled);
}
/** A dropdown setting's row: its name, and the choice in use with ▾ at the
 * right edge, marked and green like On while `on`. */
export function drawChoice(
  w: Writer,
  x: number,
  y: number,
  width: number,
  label: string,
  choice: string,
  on: boolean,
  here: boolean,
): void {
  const p = fill(w, x, y, width, here);
  drawValue(w, p, x, y, width, label, `${on ? "●" : "○"} ${choice} ▾`, on ? p.accent : p.quiet);
}
function drawValue(
  w: Writer,
  p: Row,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  style: string,
  disabled = false,
) {
  const value_x = x + width - 2 - displayWidth(value);
  w.write(at(x + 6, y) + (disabled ? p.quiet : p.label));
  writeEllipsis(w, label, sat(value_x - 1, x + 6));
  w.write(at(value_x, y) + style + value);
}
