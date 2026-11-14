import * as viewerRef from "./viewer_ref";
//! Renaming a sidebar row in place: the double-click that starts it and the
//! field that replaces the row's name while it is edited.
import { Dialog, View as NameView } from "./name_dialog";

/** A pane-backed agent row by pane id, or a workspace row by workspace id. */
export type RenameTarget = viewerRef.Pane | viewerRef.Workspace;

/** How soon a second press on the same row counts as a double-click. */
export const double_click_ms = 500;

/** The last left press on a sidebar row's name line, until the next one
 * tells whether it was the second of a double-click. */
export class ClickHistory {
  target: RenameTarget | null = null;
  at = 0;
  y = 0;
  /** The pointer left the pressed line, a drag started, or another press
   * came, since the press. Another press shows in `unclaimed` first and
   * becomes `moved` when the next one comes. */
  moved = false;
  /** A left press came that `press` hasn't taken. */
  unclaimed = false;

  /** Every left press, before it is routed: one the last didn't hand to
   * `press` ends the double-click, so only two presses in a row on the
   * name line make one. */
  pressed(): void {
    if (this.unclaimed) this.moved = true;
    this.unclaimed = true;
  }
  /** Records a press on `target`'s name line; true when it completes a
   * double-click on the first press's line, after which the next press
   * starts over. The presses can land anywhere along the line, so only
   * its row tells them apart. */
  press(target: RenameTarget, now: number, y: number): boolean {
    this.unclaimed = false;
    if (
      this.target !== null &&
      this.target === target &&
      now - this.at < double_click_ms &&
      !this.moved &&
      y === this.y
    ) {
      this.reset();
      return true;
    }
    this.target = target;
    this.at = now;
    this.y = y;
    this.moved = false;
    return false;
  }
  /** The press a second one could still complete at `now`, so motion
   * off its name line has something to end. */
  pending(now: number): RenameTarget | null {
    return this.target !== null && !this.moved && !this.unclaimed && now - this.at < double_click_ms
      ? this.target
      : null;
  }
  /** The pointer left the pressed name line, or a drag started. */
  move(): void {
    this.moved = true;
  }
  reset(): void {
    this.target = null;
    this.at = 0;
    this.y = 0;
    this.moved = false;
    this.unclaimed = false;
  }
}

/** The field open on a row, in place of its name. */
export class InlineRename {
  target: RenameTarget;
  /** The text, caret and overflow, with the centered dialog's limits and
   * character rules for the same kind of name. */
  field: Dialog;
  /** The last failure or overflow notice, until the next edit. */
  message: string | null = null;
  /** Shown muted while the text is empty. */
  fallback: string;
  /** A save is in flight; Return waits for it. */
  saving = false;
  /** The field opened the workspaces drawer, which closes with it. */
  drawer = false;
  /** When the last press in the field came, for a double-click; null after
   * an edit. */
  pressed_at: number | null = null;

  constructor(target: RenameTarget, field: Dialog, fallback: string) {
    this.target = target;
    this.field = field;
    this.fallback = fallback;
  }
  /** A field on `target` holding `text`, wholly selected as a Finder
   * rename is: typing replaces the name, and Right keeps it with the caret
   * at its end. */
  static open(target: RenameTarget, text: string, fallback: string): InlineRename {
    const id = viewerRef.parts(target).id;
    const field = Dialog.init(viewerRef.isPane(target) ? { agent: id } : { workspace_name: id }, text);
    return new InlineRename(target, field, fallback);
  }
  /** A primary press at `column` of the field at `now`: a double-click
   * selects the whole name again, as it was when the field opened, and so do
   * further presses in quick succession; a single press places the caret. */
  press(column: number, width: number, now: number): void {
    const again = this.pressed_at !== null && now - this.pressed_at < double_click_ms;
    this.pressed_at = now;
    if (again) this.field.selected = true;
    else this.place(column, width);
  }
  /** A press at `column` of the field, drawn `width` columns wide: the
   * selection goes and the caret takes the character there, or the end
   * past the text. */
  place(column: number, width: number): void {
    const field = this.field;
    field.position(field.byteAtColumn(NameView.scroll(field, width), Math.max(0, column)));
  }
  /** The text changed: a notice about the last try no longer applies. */
  edited(): void {
    this.message = null;
    this.pressed_at = null;
    this.field.overflow = false;
  }
}
