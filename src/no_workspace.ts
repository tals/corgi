//! With every workspace closed, the pane area holds one big button to create
//! another, and two sketches of what follows for an example project: the New
//! workspace dialog, then the workspace in the sidebar. They're drawn as gray
//! wireframes, not controls, and pressing them presses the button. The button
//! and the sidebar's `[ + ]` light together, as they do the same thing.
import * as i18n from "./i18n";
import * as palette from "./palette";
import { Style, colors, fgRgb } from "./palette";
import { Rect } from "./layout";
import { Writer, displayWidth, writeEllipsis } from "./text";

/** Whether the button has the keyboard. */
export interface State {
  focused: boolean;
}
/** The example the sketches name: the site's demo project. Its name is a
 * way into the game. */
const example = { name: "moonlander", folder: "~/moonlander/" };
/** Where the name is written inside each sketch's frame, from its left edge. */
const name_at = { dialog: 3, sidebar: 1, x: 1 };
/** What a press lands on: the button or a sketch, which press it too, or the
 * example's name. */
export type Hit = "create" | "moonlander";
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
  /** The sketches under their captions, when the area has room for them;
   * all of it, captions and the arrow included; and the names in them. */
  steps: { dialog: Rect; sidebar: Rect; all: Rect; names: Rect[] } | null;
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
    y = top + button_rows + steps_gap + 1,
    dialog = new Rect(left, y, dialog_width, picture_rows),
    sidebar = new Rect(left + dialog_width + arrow_width, y, sidebar_width, picture_rows),
    name = (r: Rect, row: number) => new Rect(r.x + 1 + name_at.x, r.y + 1 + row, displayWidth(example.name), 1);
  return {
    button,
    steps: {
      dialog,
      sidebar,
      all: new Rect(left, y - 1, steps_width, picture_rows + 1),
      names: [name(dialog, name_at.dialog), name(sidebar, name_at.sidebar)],
    },
  };
}
export function hit(area: Rect, x: number, y: number): Hit | null {
  const at = layout(area);
  if (!at) return null;
  if (at.steps?.names.some(r => r.contains(x, y))) return "moonlander";
  return at.button.contains(x, y) || at.steps?.all.contains(x, y) ? "create" : null;
}

/** The button, lit while it has the keyboard or the pointer, and the sketches. */
export function draw(w: Writer, area: Rect, lit: boolean): void {
  const at = layout(area);
  if (!at) return;
  drawButton(w, at.button, lit);
  if (!at.steps) return;
  const { dialog, sidebar } = at.steps;
  caption(w, dialog, "1", i18n.t`Name it and pick a folder`);
  caption(w, sidebar, "2", i18n.t`Find it in the sidebar`);
  drawDialog(w, frame(w, dialog));
  drawSidebar(w, frame(w, sidebar));
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
/** Gray writing inside a sketch's frame. */
class Sketch {
  constructor(
    readonly w: Writer,
    readonly r: Rect,
  ) {}
  text(row: number, x: number, token: palette.Token, text: string): void {
    this.w.write(cup(this.r.y + row, this.r.x + x) + new Style({ fg: token, bg: "bg" }).sgr());
    writeEllipsis(this.w, text, this.r.w - x - 1);
  }
  /** `text` on a dotted line across the frame, as a field is sketched. */
  field(row: number, text: string): void {
    const width = this.r.w - 2;
    this.w.write(cup(this.r.y + row, this.r.x + 1) + new Style({ fg: "muted", bg: "bg" }).sgr());
    this.w.write("\x1b[4:4m" + palette.underline("line"));
    writeEllipsis(this.w, text, width);
    this.w.splat(" ", width - Math.min(displayWidth(text), width));
    this.w.write("\x1b[24m");
  }
}
/** The New workspace dialog: its title, the name and folder, and its create button. */
function drawDialog(w: Writer, r: Rect): void {
  const s = new Sketch(w, r),
    create = `↵ ${i18n.t`create`}`;
  s.text(0, 1, "muted", i18n.t`New workspace`);
  s.text(2, 1, "faint", i18n.t`Name`);
  s.field(name_at.dialog, example.name);
  s.text(5, 1, "faint", i18n.t`Folder`);
  s.field(6, example.folder);
  s.text(r.h - 1, Math.max(1, Math.floor((r.w - displayWidth(create)) / 2)), "faint", create);
  w.write("\x1b[0m");
}
/** The sidebar's top with the new workspace selected in it, over the agents. */
function drawSidebar(w: Writer, r: Rect): void {
  const s = new Sketch(w, r);
  s.text(0, 1, "faint", i18n.t`workspaces`);
  s.text(0, r.w - 6, "faint", "[ + ]");
  s.text(name_at.sidebar, 0, "muted", "▌");
  s.text(name_at.sidebar, name_at.x, "text", example.name);
  w.write(cup(r.y + 5, r.x) + new Style({ fg: "line", bg: "bg" }).sgr() + "╌".repeat(r.w));
  s.text(6, 1, "faint", i18n.t`agents`);
  w.write("\x1b[0m");
}
