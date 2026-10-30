//! Renaming a sidebar row in place: the double-click that starts it and the
//! field that replaces the row's name while it is edited.
import { Dialog } from "./name_dialog";

/** A pane-backed agent row by pane id, or a workspace row by workspace id. */
export type RenameTarget = { agent: number } | { workspace: number };

export function sameRenameTarget(a: RenameTarget, b: RenameTarget): boolean {
  if ("agent" in a) return "agent" in b && a.agent === b.agent;
  return "workspace" in b && a.workspace === b.workspace;
}

/** How soon a second press on the same row counts as a double-click. */
export const double_click_ms = 500;

/** The last left press on a sidebar row, until the next one tells whether it
 * was the second of a double-click. */
export class ClickHistory {
  target: RenameTarget | null = null;
  at = 0;
  x = 0;
  y = 0;
  /** The pointer left the pressed cell, or a drag started, since the press. */
  moved = false;

  /** Records a press; true when it completes a double-click, after which the
   * next press starts over. */
  press(target: RenameTarget, now: number, x: number, y: number): boolean {
    if (
      this.target !== null &&
      sameRenameTarget(this.target, target) &&
      now - this.at < double_click_ms &&
      !this.moved
    ) {
      this.reset();
      return true;
    }
    this.target = target;
    this.at = now;
    this.x = x;
    this.y = y;
    this.moved = false;
    return false;
  }
  /** The held pointer is at `x`, `y`: another cell than the press ends the double-click. */
  motion(x: number, y: number): void {
    if (this.target === null) return;
    if (x !== this.x || y !== this.y) this.moved = true;
  }
  /** A drag started. */
  move(): void {
    this.moved = true;
  }
  reset(): void {
    this.target = null;
    this.at = 0;
    this.x = 0;
    this.y = 0;
    this.moved = false;
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

  constructor(target: RenameTarget, field: Dialog, fallback: string) {
    this.target = target;
    this.field = field;
    this.fallback = fallback;
  }
  /** A field on `target` holding `text`, with the caret at its end and
   * nothing selected: typing adds to the name rather than replacing it. */
  static open(target: RenameTarget, text: string, fallback: string): InlineRename {
    const field = Dialog.init("agent" in target ? { agent: target.agent } : { workspace_name: target.workspace }, text);
    field.selected = false;
    field.position(field.len);
    return new InlineRename(target, field, fallback);
  }
  /** The text changed: a notice about the last try no longer applies. */
  edited(): void {
    this.message = null;
    this.field.overflow = false;
  }
}
