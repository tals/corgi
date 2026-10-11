import { Text } from "../providers/common";
import { View, Tokens } from "../usage/live";
import { sub } from "../usage/tokens";
export type Point = { at: number; label: Text; usage: View };
export class Timeline {
  points: Point[] = [];
  get len() {
    return this.points.length;
  }
  baseline = new View({ known: true });
  turn = new Text();
  open = true;
  observedDelta(current: View) {
    const delta = new View({
      known: current.known,
      partial: current.losses !== this.baseline.losses,
      losses: Math.max(0, current.losses - this.baseline.losses),
      since: this.points.at(-1)?.at ?? current.since,
      updated_at: current.updated_at,
    });
    if (!current.known) return delta;
    for (const k of ["input", "cached_input", "output"] as const) {
      delta.tokens[k] = sub(current.tokens[k], this.baseline.tokens[k]);
      if (current.tokens[k] < this.baseline.tokens[k]) delta.partial = true;
    }
    return delta;
  }
  pending(current: View) {
    if (!this.open && this.len) return this.points.at(-1)!.usage;
    const value = this.observedDelta(current),
      last = this.points.at(-1)?.usage;
    if (last) {
      value.tokens.add(last.tokens);
      value.known ||= last.known;
      value.partial ||= last.partial;
      value.losses = Math.min(0xffffffff, value.losses + last.losses);
    }
    return value;
  }
  checkpoint(turn: string, label: Text, current: View, now: number) {
    const interval = this.pending(current),
      last = this.points.at(-1),
      at = last ? Math.max(now, last.at) : now;
    if (last) last.usage = interval;
    if (!(this.open && last && turn === this.turn.text() && label.text() === last.label.text())) {
      if (this.len === 16) this.points.shift();
      this.points.push({
        at,
        label,
        usage: !this.len ? interval : !this.open ? this.observedDelta(current) : new View({ known: current.known }),
      });
    }
    this.turn = new Text(turn);
    this.open = true;
    this.advanceBaseline(current);
  }
  /** Renames the turn's open phase, or starts one when the turn has none. */
  amend(turn: string, label: Text, current: View, now: number) {
    const last = this.points.at(-1);
    if (this.open && last && turn === this.turn.text()) last.label = label;
    this.checkpoint(turn, label, current, now);
  }
  finish(current: View) {
    if (this.len) this.points.at(-1)!.usage = this.pending(current);
    this.open = false;
    this.advanceBaseline(current);
  }
  advanceBaseline(current: View) {
    for (const k of ["input", "cached_input", "output"] as const)
      this.baseline.tokens[k] =
        this.baseline.tokens[k] > current.tokens[k] ? this.baseline.tokens[k] : current.tokens[k];
    this.baseline.known = current.known;
    this.baseline.losses = current.losses;
  }
}
