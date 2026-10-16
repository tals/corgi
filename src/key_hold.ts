//! A key held to confirm, read from key repeat, or a mouse button held down.

/** Terminals report no key release, only repeats: the first comes after the
 * host's repeat delay, then one at its repeat rate. A longer silence is a release. */
export const first_repeat_ms = 1000;
export const repeat_gap_ms = 250;
/** The host's repeat delay until a hold has shown it. */
export const assumed_delay_ms = 400;

export class KeyHold {
  /** How far the hold has come, 0 to 1. */
  progress = 0;
  /** Held, or let go and undoing. */
  active = false;
  /** A mouse button holds it until its release. */
  private pressed = false;
  private repeating = false;
  /** When the hold was last moved on, when it started, and when the key last arrived. */
  private at = 0;
  private started = 0;
  private last = 0;
  /** The host's repeat delay and rate, as measured. */
  private delay = assumed_delay_ms;
  private interval: number;
  /** Held until then, unless the key arrives again. */
  private until = 0;
  /** Presses before this are the tail of a hold that already ended. */
  private quiet_until = 0;

  /** Filled in `hold_ms`; let go, emptied in `heal_ms`. A silence of `gap`
   * after a repeat, or of `first_gap` past the host's repeat delay, is a release. */
  constructor(
    readonly hold_ms: number,
    readonly heal_ms: number,
    readonly gap = repeat_gap_ms,
    readonly first_gap = repeat_gap_ms,
  ) {
    this.interval = gap / 2;
  }
  /** One press of the key, or one repeat. True when it completes the hold:
   * the key is still down once the hold is full. The key is ignored then
   * until it is let go. */
  press(now: number): boolean {
    this.advance(now);
    if (this.quieted(now)) {
      this.quiet(now);
      return false;
    }
    // The first repeat, even one later than the delay expected it.
    const first = this.active && !this.repeating && now - this.started <= first_repeat_ms;
    if (this.active && (now < this.until || first)) {
      if (this.progress >= 1) {
        this.quiet(now);
        return true;
      }
      if (this.repeating) this.interval = Math.min(this.gap, now - this.last);
      else this.delay = Math.max(100, Math.min(first_repeat_ms, now - this.started));
      this.repeating = true;
      this.last = now;
      this.until = now + this.gap;
      return false;
    }
    this.start(now);
    this.until = now + this.delay + this.first_gap;
    return false;
  }
  /** A mouse button went down on it; it fills until `release`. */
  down(now: number): void {
    this.advance(now);
    this.start(now);
    this.pressed = true;
    this.until = Infinity;
  }
  release(now: number): void {
    if (!this.pressed) return;
    this.advance(now);
    this.pressed = false;
    this.until = now;
  }
  /** Whether the key or button is still down, as far as can be told. */
  held(now: number): boolean {
    return this.active && (this.pressed || now <= this.until);
  }
  /** Whether a mouse button is holding it full. */
  done(): boolean {
    return this.pressed && this.progress >= 1;
  }
  private start(now: number): void {
    this.active = true;
    this.repeating = false;
    this.at = this.started = this.last = now;
  }
  /** Moves the hold on to `now`: forward while the key is down, back once
   * it's up. It goes forward only to when the next key is due, the first
   * repeat after the host's repeat delay, so a hold doesn't stop to wait for
   * it, and a key let go just before the end, noticed a gap later, never completes. */
  advance(now: number): void {
    if (!this.active) return;
    const grown = this.pressed ? now : Math.min(now, this.last + (this.repeating ? this.interval : this.delay));
    if (grown > this.at) {
      this.progress = Math.min(1, this.progress + (grown - this.at) / this.hold_ms);
      this.at = grown;
    }
    if (now > this.until) {
      this.progress = Math.max(0, this.progress - (now - Math.max(this.at, this.until)) / this.heal_ms);
      this.at = now;
    }
    if (this.progress === 0 && now >= this.until) this.reset();
  }
  /** Whether presses now are the tail of a hold that already ended. */
  quieted(now: number): boolean {
    return now < this.quiet_until;
  }
  /** Ignores the key until it has been let go. */
  quiet(now: number): void {
    this.quiet_until = now + this.gap;
  }
  reset(): void {
    this.active = false;
    this.pressed = false;
    this.repeating = false;
    this.progress = 0;
  }
}

/** Fixed steps keep a spring stable, and the same moments draw the same. */
const spring_step_ms = 2;

/** How stiff a spring is: `omega` in radians a second; `zeta` under 1 overshoots. */
export interface Tune {
  omega: number;
  zeta: number;
}

/** A hold's progress as drawn: a spring chasing it. */
export class Spring {
  /** Below 0 while it swings back past the start. */
  x = 0;
  private v = 0;
  /** Moved on to here, in whole steps; null at rest. */
  private at: number | null = null;

  constructor(readonly tune: Tune) {}
  /** Moves it on to `now`, pulled toward `target`; false once it rests there. */
  step(target: number, now: number, tune = this.tune): boolean {
    const { omega, zeta } = tune;
    // From rest, or after a long stall, it starts from here.
    if (this.at === null || now - this.at > 500) this.at = now;
    for (; this.at + spring_step_ms <= now; this.at += spring_step_ms) {
      const dt = spring_step_ms / 1000;
      this.v += (omega * omega * (target - this.x) - 2 * zeta * omega * this.v) * dt;
      this.x += this.v * dt;
    }
    if (Math.abs(target - this.x) > 0.002 || Math.abs(this.v) > 0.02) return true;
    this.x = target;
    this.v = 0;
    this.at = null;
    return false;
  }
}
