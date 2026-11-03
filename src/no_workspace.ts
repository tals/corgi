//! With every workspace closed, the pane area holds one big button to create
//! another, and two sketches of what follows: the New workspace dialog, then
//! the workspace in the sidebar. They're drawn as wireframes, not controls,
//! and pressing them presses the button. The button and the sidebar's `[ + ]`
//! light together, as they do the same thing.
import * as i18n from "./i18n";
import * as palette from "./palette";
import { Style, colors, fgRgb } from "./palette";
import { Rect } from "./layout";
import { Writer, displayWidth, writeEllipsis } from "./text";

/** What the pane area shows: the folder a new workspace starts in, as the
 * dialog will show it, and whether the button has the keyboard. */
export interface State {
  name: string;
  folder: string;
  focused: boolean;
}
const button_width = 36;
/** Half a row of edge, three rows of button, and half a row of edge. */
const button_rows = 5;
/** The sketches, frames included, and the arrow between them. */
const dialog_width = 32;
const sidebar_width = 26;
const picture_rows = 11;
const arrow_width = 11;
const steps_width = dialog_width + arrow_width + sidebar_width;
/** How far the rest of the screen fades toward the background, as `writeExit` progress. */
export const dim = 0.7;
/** Rows between the button and the pictures' captions. */
const steps_gap = 3;

export interface Layout {
  button: Rect;
  /** The sketches under their captions, when the area has room for them,
   * and all of it: captions, sketches and the arrow. */
  steps: { dialog: Rect; sidebar: Rect; all: Rect } | null;
}
export function layout(area: Rect): Layout | null {
  const width = Math.min(button_width, area.w - 2);
  if (width < 8 || area.h < 1) return null;
  const rows = area.h >= button_rows + 2 ? button_rows : 1;
  const steps = area.w >= steps_width + 2 && area.h >= button_rows + steps_gap + 1 + picture_rows + 2;
  const height = steps ? button_rows + steps_gap + 1 + picture_rows : rows;
  const top = area.y + Math.floor((area.h - height) / 2);
  const button = new Rect(area.x + Math.floor((area.w - width) / 2), top, width, rows);
  if (!steps) return { button, steps: null };
  const left = area.x + Math.floor((area.w - steps_width) / 2),
    y = top + button_rows + steps_gap + 1;
  return {
    button,
    steps: {
      dialog: new Rect(left, y, dialog_width, picture_rows),
      sidebar: new Rect(left + dialog_width + arrow_width, y, sidebar_width, picture_rows),
      all: new Rect(left, y - 1, steps_width, picture_rows + 1),
    },
  };
}
/** Whether (`x`, `y`) is on the button or the sketches, which press it too. */
export function hit(area: Rect, x: number, y: number): boolean {
  const at = layout(area);
  return !!at && (at.button.contains(x, y) || (at.steps?.all.contains(x, y) ?? false));
}

/** The button, lit while it has the keyboard or the pointer, and the sketches. */
export function draw(w: Writer, area: Rect, state: State, lit: boolean): void {
  const at = layout(area);
  if (!at) return;
  drawButton(w, at.button, lit);
  if (!at.steps) return;
  const { dialog, sidebar } = at.steps;
  caption(w, dialog, "1", i18n.t`Name it and pick a folder`);
  caption(w, sidebar, "2", i18n.t`Find it in the sidebar`);
  drawDialog(w, frame(w, dialog), state);
  drawSidebar(w, frame(w, sidebar), state);
  // A long arrow between them, a space clear of each.
  w.write(
    cup(dialog.y + Math.floor(dialog.h / 2), dialog.x + dialog.w + 1) + new Style({ fg: "faint", bg: "bg" }).sgr(),
  );
  w.write("━".repeat(arrow_width - 3) + "▶\x1b[0m");
}
function cup(y: number, x: number): string {
  return `\x1b[${y + 1};${x + 1}H`;
}
/** A chunky button: rounded by quadrant blocks, the sidebar's button colors
 * while it rests and its call to action when lit. */
function drawButton(w: Writer, r: Rect, lit: boolean): void {
  const fill = lit ? palette.call_to_action : new Style({ fg: "strong", bg: "surface", bold: true }).sgr(),
    edge = palette.bg("bg") + fgRgb(lit ? palette.call_to_action_bg : colors.surface),
    label = `+  ${i18n.t`Create workspace`}`;
  if (r.h === 1) {
    w.write(cup(r.y, r.x) + edge + "▐" + fill);
    centered(w, label, r.w - 2);
    w.write(edge + "▌\x1b[0m");
    return;
  }
  for (let row = 0; row < r.h; row++) {
    const top = row === 0,
      bottom = row === r.h - 1;
    w.write(cup(r.y + row, r.x) + edge);
    if (top || bottom) {
      w.write((top ? "▗" : "▝") + (top ? "▄" : "▀").repeat(r.w - 2) + (top ? "▖" : "▘"));
      continue;
    }
    w.write("▐" + fill);
    if (row === Math.floor(r.h / 2)) centered(w, label, r.w - 2);
    else w.splat(" ", r.w - 2);
    w.write(edge + "▌");
  }
  w.write("\x1b[0m");
}
/** `text` in the middle of `width` columns, cut when it doesn't fit. */
function centered(w: Writer, text: string, width: number): void {
  const pad = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
  w.splat(" ", pad);
  const used = Math.min(displayWidth(text), width - pad);
  writeEllipsis(w, text, width - pad);
  w.splat(" ", width - pad - used);
}
/** The end of a path, which says the most, in `room` columns. */
function tail(text: string, room: number): string {
  if (displayWidth(text) <= room) return text;
  const chars = Array.from(text);
  let end = "";
  while (chars.length > 0 && displayWidth(chars[chars.length - 1] + end) < room) end = chars.pop()! + end;
  return "…" + end;
}
/** A step's number and what happens, over its sketch. */
function caption(w: Writer, r: Rect, number: string, text: string): void {
  w.write(cup(r.y - 1, r.x + 1) + new Style({ fg: "strong", bg: "bg", bold: true }).sgr() + number);
  w.write(new Style({ fg: "muted", bg: "bg" }).sgr() + "  ");
  writeEllipsis(w, text, r.w - 4);
  w.write("\x1b[0m");
}
/** A sketch's dashed frame, cleared inside; returns the rectangle inside it. */
function frame(w: Writer, r: Rect): Rect {
  const line = new Style({ fg: "line", bg: "bg" }).sgr();
  w.write(cup(r.y, r.x) + line + "╭" + "╌".repeat(r.w - 2) + "╮");
  for (let row = 1; row < r.h - 1; row++) w.write(cup(r.y + row, r.x) + line + "╎" + " ".repeat(r.w - 2) + "╎");
  w.write(cup(r.y + r.h - 1, r.x) + line + "╰" + "╌".repeat(r.w - 2) + "╯");
  return new Rect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
}
/** Pencil strokes: a line standing for text, and what's written by hand. */
class Sketch {
  constructor(
    readonly w: Writer,
    readonly r: Rect,
  ) {}
  stroke(row: number, x: number, length: number): void {
    this.w.write(cup(this.r.y + row, this.r.x + x) + new Style({ fg: "line", bg: "bg" }).sgr() + "━".repeat(length));
  }
  /** `text` on a dotted line `width` long, as a field is sketched. */
  field(row: number, text: string, width: number): void {
    const ink = new Style({ fg: "muted", bg: "bg" }).sgr() + "\x1b[4:4m" + palette.underline("line");
    this.w.write(cup(this.r.y + row, this.r.x + 1) + ink);
    writeEllipsis(this.w, text, width);
    this.w.splat(" ", width - Math.min(displayWidth(text), width));
    this.w.write("\x1b[24m");
  }
  text(row: number, x: number, token: palette.Token, text: string, width: number): void {
    this.w.write(cup(this.r.y + row, this.r.x + x) + new Style({ fg: token, bg: "bg" }).sgr());
    writeEllipsis(this.w, text, width);
  }
}
/** The New workspace dialog: its title, the name and folder it opens with,
 * and its create button. */
function drawDialog(w: Writer, r: Rect, state: State): void {
  const s = new Sketch(w, r),
    width = r.w - 2;
  s.stroke(0, 1, 13);
  s.stroke(2, 1, 4);
  s.field(3, state.name, width);
  s.stroke(5, 1, 6);
  s.field(6, tail(state.folder, width), width);
  const button = Math.floor((r.w - 8) / 2);
  s.text(r.h - 1, button, "faint", "↵", 1);
  s.stroke(r.h - 1, button + 2, 6);
  w.write("\x1b[0m");
}
/** The sidebar's top with the new workspace selected in it. */
function drawSidebar(w: Writer, r: Rect, state: State): void {
  const s = new Sketch(w, r);
  s.stroke(0, 1, 10);
  s.text(0, r.w - 3, "faint", "+", 1);
  s.text(1, 0, "muted", "▌", 1);
  s.text(1, 1, "text", state.name, r.w - 2);
  s.stroke(2, 1, 8);
  w.write(cup(r.y + 5, r.x) + new Style({ fg: "line", bg: "bg" }).sgr() + "╌".repeat(r.w));
  s.stroke(6, 1, 9);
  s.stroke(6, r.w - 6, 5);
  w.write("\x1b[0m");
}
