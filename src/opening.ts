//! A pane an action is opening. It takes the keyboard as the action starts:
//! keys typed before the daemon makes the pane wait here, and reach the pane
//! once it exists. Moving focus elsewhere takes the keyboard back; what was
//! typed for the pane still goes to it. Pastes don't wait: one made while a
//! pane is opening is dropped.
import type { Machine } from "./machine";

/** Keys typed for a pane still opening, at most. */
export const limit = 64 * 1024;

export class Opening {
  private keys: number[] = [];
  /** Asked to close before it opened: it closes as it arrives. */
  closing = false;
  /** `id` stands for the pane until the daemon names it; it's negative, so
   * it never names one of the daemon's. `machine` is the one it opens on. */
  constructor(
    readonly id: number,
    readonly machine: Machine,
  ) {}
  /** Keys typed for it; false when they don't fit, and they're dropped. */
  type(keys: ArrayLike<number>): boolean {
    if (this.keys.length + keys.length > limit) return false;
    for (let i = 0; i < keys.length; i++) this.keys.push(keys[i]);
    return true;
  }
  /** What was typed, in order, leaving nothing. */
  take(): number[] {
    return this.keys.splice(0);
  }
}
