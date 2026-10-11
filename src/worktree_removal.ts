//! Removing a worktree from the overview by holding ⌫: the hold, read from
//! key repeat, and the row coming apart while it lasts.
import * as palette from "./palette";
import * as corgiAnimation from "./corgi_animation";
import * as worktrees from "./worktrees";
import type { Grid } from "./cell_grid";

export type Effect = "dust" | "burn" | "bury";
export const effects: readonly Effect[] = ["dust", "burn", "bury"];
/** A random effect other than `last`, so one never plays twice running. */
export function pick(last: Effect | null, random = Math.random): Effect {
  const choices = effects.filter(e => e !== last);
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}

/** How long the key is held to remove; letting go undoes it faster. */
export const hold_ms = 1500;
export const heal_ms = 400;
/** Terminals report no key release, only repeats: the first comes after the
 * host's repeat delay, then one at its repeat rate. A longer silence is a release. */
export const first_repeat_ms = 1000;
export const repeat_gap_ms = 250;
/** The host's repeat delay until a hold has shown it. */
export const assumed_delay_ms = 400;
export const message_ms = 4000;
export const finale_ms: Record<Effect, number> = { dust: 600, burn: 500, bury: 1800 };

/** The worktree being removed, and what the footer says about it. */
export interface Target {
  path: string;
  name: string;
  branch: boolean;
  locked: string | null;
  /** Files with uncommitted changes, when known. */
  changes: number | null;
  /** Commits a detached HEAD holds that nothing else does. */
  detached: number;
  agents: number;
  /** Its row and place in the list, kept for the ending once Git has removed it. */
  checkout: worktrees.Checkout;
  index: number;
}
export function target(checkout: worktrees.Checkout, index: number, agents: number): Target {
  return {
    path: checkout.path,
    name: worktrees.label(checkout),
    branch: checkout.branch !== null,
    locked: checkout.locked,
    changes: checkout.changes?.total ?? null,
    detached: checkout.detached ? Number(checkout.comparison?.ahead ?? 0n) : 0,
    agents,
    checkout,
    index,
  };
}

export type Phase = "idle" | "held" | "removing" | "removed" | "failed" | "locked";
export class Hold {
  phase: Phase = "idle";
  target: Target | null = null;
  effect: Effect = "dust";
  progress = 0;
  committed_at = 0;
  settled_at = 0;
  reason = "";
  private repeating = false;
  /** When the hold was last moved on, when it started, and when the key last arrived. */
  private at = 0;
  private started = 0;
  private last = 0;
  /** The host's repeat delay and rate, as measured. */
  private delay = assumed_delay_ms;
  private interval = repeat_gap_ms / 2;
  /** Held until then, unless the key arrives again. */
  private until = 0;
  /** Presses before this are the tail of a hold that already ended. */
  private quiet_until = 0;
  /** When the removed worktree left the list. */
  private gone_at: number | null = null;

  /** One press of the key, or one repeat. True when it completes the hold:
   * the key is still down once the row is gone. A new hold plays `effect`. */
  press(now: number, target: Target, effect: Effect): boolean {
    this.advance(now);
    if (now < this.quiet_until || this.phase === "removing") {
      this.quiet_until = now + repeat_gap_ms;
      if (this.phase === "locked") this.settled_at = now;
      return false;
    }
    if (target.locked !== null) {
      this.reset();
      this.phase = "locked";
      this.target = target;
      this.settled_at = now;
      this.quiet_until = now + repeat_gap_ms;
      return false;
    }
    const same = this.phase === "held" && this.target?.path === target.path,
      // The first repeat, even one later than the delay expected it.
      first = same && !this.repeating && now - this.started <= first_repeat_ms;
    if (same && (now < this.until || first)) {
      if (this.progress >= 1) {
        this.phase = "removing";
        this.committed_at = now;
        this.gone_at = null;
        this.quiet_until = now + repeat_gap_ms;
        return true;
      }
      if (this.repeating) this.interval = Math.min(repeat_gap_ms, now - this.last);
      else this.delay = Math.max(100, Math.min(first_repeat_ms, now - this.started));
      this.repeating = true;
      this.last = now;
      this.until = now + repeat_gap_ms;
      return false;
    }
    if (!same) {
      this.progress = 0;
      this.effect = effect;
    }
    this.phase = "held";
    this.target = target;
    this.repeating = false;
    this.at = this.started = this.last = now;
    this.until = now + this.delay + repeat_gap_ms;
    return false;
  }
  /** Moves the hold on to `now`: forward while the key is down, back once
   * it's up. It goes forward only to when the next key is due, the first
   * repeat after the host's repeat delay, so a hold doesn't stop to wait for
   * it, and a key let go just before the end, noticed a gap later, never removes. */
  advance(now: number): void {
    if (this.phase === "held") {
      const grown = Math.min(now, this.last + (this.repeating ? this.interval : this.delay));
      if (grown > this.at) {
        this.progress = Math.min(1, this.progress + (grown - this.at) / hold_ms);
        this.at = grown;
      }
      if (now > this.until) {
        this.progress = Math.max(0, this.progress - (now - Math.max(this.at, this.until)) / heal_ms);
        this.at = now;
      }
      if (this.progress === 0 && now >= this.until) this.reset();
    } else if (this.phase !== "idle" && this.phase !== "removing" && now - this.settled_at >= message_ms) this.reset();
  }
  /** The daemon's answer: removed, or why not. */
  settle(now: number, reason: string | null): void {
    this.phase = reason === null ? "removed" : "failed";
    this.reason = reason ?? "";
    this.settled_at = now;
    if (reason !== null) this.progress = 0;
  }
  reset(): void {
    this.phase = "idle";
    this.target = null;
    this.progress = 0;
    this.repeating = false;
  }
  /** Whether the hold is past the point where letting go undoes it. */
  committed(): boolean {
    return this.phase === "removing" || this.phase === "removed";
  }
  /** Whether `path`'s row is drawn coming apart. */
  covers(path: string): boolean {
    return this.target?.path === path && (this.phase === "held" || this.committed());
  }
  /** How far the effect's ending has played, 0 before the hold completes. */
  finale(now: number): number {
    if (!this.committed()) return 0;
    return Math.max(0.0001, Math.min(1, (now - this.committed_at) / finale_ms[this.effect]));
  }
  /** The overview's rows: `entries`, with the removed worktree kept in its
   * place after Git is done with it, until its ending has played and its
   * row has closed, a line at a time. */
  shown(entries: worktrees.Checkout[], now: number): Shown {
    const t = this.target;
    if (!t || !this.committed()) return { entries, removing: null, closed: 0 };
    if (entries.some(e => e.path === t.path)) {
      this.gone_at = null;
      return { entries, removing: t.path, closed: 0 };
    }
    this.gone_at ??= now;
    const from = Math.max(this.committed_at + finale_ms[this.effect], this.gone_at),
      closed = now < from ? 0 : 1 + Math.floor((now - from) / close_step_ms);
    if (closed >= 2) return { entries, removing: null, closed: 0 };
    return { entries: [...entries.slice(0, t.index), t.checkout, ...entries.slice(t.index)], removing: t.path, closed };
  }
}
/** The overview's rows while a removal holds the cursor: the removed row
 * (`removing`) and how many of its two lines have closed. */
export interface Shown {
  entries: worktrees.Checkout[];
  removing: string | null;
  closed: number;
}
/** How long the rows below take to move up each line, once the row is gone. */
export const close_step_ms = 70;

export type Segment = { text: string; color: palette.Token; bold?: boolean };
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** The footer while a hold is on: what goes and what stays. A removal that
 * worked needs no word; one that didn't, or a refusal, says why. */
export function footer(hold: Hold): Segment[] | null {
  const t = hold.target;
  if (!t || hold.phase === "idle" || hold.phase === "removed") return null;
  const dot = { text: " · ", color: "faint" as const };
  switch (hold.phase) {
    case "locked":
      return [
        { text: `${t.name} is locked`, color: "muted" },
        ...(t.locked ? [dot, { text: t.locked, color: "faint" as const }] : []),
      ];
    case "failed":
      return [{ text: `Couldn't remove ${t.name}`, color: "hot" }, dot, { text: hold.reason, color: "muted" }];
    default: {
      const out: Segment[] = [{ text: `Removing ${t.name}`, color: "strong", bold: true }];
      const add = (text: string, color: palette.Token) => out.push(dot, { text, color });
      if (t.changes) add(`${plural(t.changes, "uncommitted file")} lost`, "hot");
      if (t.detached) add(`${plural(t.detached, "detached commit")} lost`, "hot");
      if (t.agents) add(`${plural(t.agents, "agent")} close`, "muted");
      if (t.branch) add("branch kept", "faint");
      return out;
    }
  }
}

/** Where a row comes apart, in the grid's cells. */
export interface Area {
  /** The row's first line; its second line is just below. */
  y: number;
  /** The card's inside columns, inclusive. */
  left: number;
  right: number;
  /** The rows dust and sparks may drift through, inclusive. */
  top: number;
  bottom: number;
}
type Letter = { x: number; y: number; ch: string; fg: palette.Rgb; bold: boolean };
const tick_ms = 40;
/** A repeatable number in [0, 1) for a cell, so a frame drawn twice matches. */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const braille = (bits: number) => String.fromCharCode(0x2800 + bits);
const isBraille = (ch: string) => ch >= "⠀" && ch <= "⣿";
/** Braille dot bits by [column][row] inside a cell. */
const dots = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

/** Draws the row in `area` coming apart: `progress` while the key is held,
 * then `finale` from 0 to 1 once it's gone. Every effect runs right to left. */
export function paint(grid: Grid, area: Area, effect: Effect, progress: number, finale: number, now: number): void {
  const letters: Letter[] = [];
  for (const y of [area.y, area.y + 1])
    for (let x = area.left; x <= area.right; x++) {
      const c = grid.at(x, y);
      if (c && c.ch !== " " && c.ch !== "") letters.push({ x, y, ...c });
    }
  const along = (x: number) => (area.right - x) / Math.max(1, area.right - area.left),
    tick = Math.floor(now / tick_ms);
  switch (effect) {
    case "dust":
      return dust(grid, area, letters, along, finale > 0 ? 1 + finale * 0.42 : progress);
    case "burn":
      return burn(grid, area, along, finale > 0 ? 1 + finale * 0.3 : progress, tick);
    case "bury":
      return bury(grid, area, progress, finale, tick);
  }
}

/** The row crumbles into braille dots that drift right, into the part already gone. */
function dust(grid: Grid, area: Area, letters: Letter[], along: (x: number) => number, v: number): void {
  if (v <= 0) return;
  const c = palette.colors,
    found = new Map<number, { bits: number; age: number }>();
  for (const l of letters) {
    const start = along(l.x) * 0.86 + hash(l.x, l.y, 1) * 0.05 + (l.y === area.y ? 0.02 : 0),
      age = v - start;
    if (age < -0.035) continue;
    if (age < 0) grid.put(l.x, l.y, l.ch, c.faint, l.bold);
    else if (age < 0.016) grid.put(l.x, l.y, braille(0xff & ~(1 << Math.floor(hash(l.x, l.y, 2) * 8))), c.muted);
    else grid.put(l.x, l.y, " ", c.faint);
    for (let k = 0; k < 5; k++) {
      const r = (n: number) => hash(l.x, l.y, n * 8 + k),
        life = 0.16 + r(6) * 0.22,
        a = v - (start + 0.01 + r(1) * 0.025);
      if (a < 0 || a >= life) continue;
      const sx = Math.round(l.x * 2 + Math.floor(r(2) * 2) + (50 + r(3) * 120) * a),
        sy = Math.round(l.y * 4 + Math.floor(r(4) * 4) + (-36 + r(5) * 46) * a + Math.sin(r(7) * 6.28 + a * 30) * 1.2),
        cx = Math.floor(sx / 2),
        cy = Math.floor(sy / 4);
      if (cx < area.left || cx > area.right || cy < area.top || cy > area.bottom) continue;
      const key = cy * 4096 + cx,
        speck = found.get(key) ?? { bits: 0, age: 1 };
      speck.bits |= dots[sx - cx * 2][sy - cy * 4];
      speck.age = Math.min(speck.age, a / life);
      found.set(key, speck);
    }
  }
  for (const [key, speck] of found) {
    const x = key % 4096,
      y = Math.floor(key / 4096),
      ch = grid.at(x, y)?.ch ?? "";
    if (ch !== " " && !isBraille(ch)) continue;
    const bits = isBraille(ch) ? ch.charCodeAt(0) - 0x2800 : 0;
    grid.put(x, y, braille(bits | speck.bits), speck.age < 0.35 ? c.muted : speck.age < 0.7 ? c.faint : c.line);
  }
}

/** A fire front: letters ahead of it warm up, behind it they glow, then go to ash. */
function burn(grid: Grid, area: Area, along: (x: number) => number, v: number, tick: number): void {
  if (v <= 0) return;
  const c = palette.colors,
    ember = palette.mix(c.hot, c.surface, 45);
  for (const y of [area.y, area.y + 1])
    for (let x = area.left; x <= area.right; x++) {
      const cell = grid.at(x, y);
      if (!cell) continue;
      const a = v - (along(x) * 0.8 + hash(x, y, 0) * 0.04 + (y === area.y ? 0.035 : 0)),
        text = cell.ch !== " ";
      if (a < -0.07) continue;
      if (a < 0) {
        if (text) cell.fg = c.warm;
        continue;
      }
      const h = hash(x, y, tick);
      if (a < 0.045) {
        const flame = y === area.y ? (h < 0.5 ? "▒" : "░") : h < 0.35 ? "█" : h < 0.75 ? "▓" : "▒";
        grid.put(x, y, flame, h < 0.55 ? c.hot : c.warm);
      } else if (a < 0.12) {
        if (text) grid.put(x, y, cell.ch, ember);
        else grid.put(x, y, hash(x, y, 1) < 0.14 ? "˙" : " ", ember);
      } else grid.put(x, y, text && a < 0.22 ? "·" : " ", c.faint);
    }
  if (v >= 1 || area.y - 1 < area.top) return;
  const front = area.right - ((v - 0.055) / 0.8) * (area.right - area.left);
  for (let k = 0; k < 3; k++) {
    if (hash(k, tick, 3) < 0.35) continue;
    const x = Math.round(front + (hash(k, tick, 4) - 0.5) * 5);
    if (x >= area.left && x <= area.right && grid.blank(x, area.y - 1))
      grid.put(x, area.y - 1, hash(k, tick, 5) < 0.5 ? "˙" : "·", c.warm);
  }
}

/** Bury's ending, in shares of its time: the last kicks, the mound sinking,
 * the corgi sitting up, sitting content, then trotting off. */
const ending = { kicked: 0.07, sinks: 0.1, sunk: 0.43, settled: 0.2, content: 0.55, leaves: 0.78 };
/** The corgi walks in from the right and kicks dirt back over the row, with
 * Unearth's dirt. At the end it sits a while as the mound sinks, then trots off. */
function bury(grid: Grid, area: Area, progress: number, finale: number, tick: number): void {
  if (progress <= 0 && finale === 0) return;
  const c = palette.colors,
    a = corgiAnimation,
    { left, right } = area,
    enter = 0.07,
    span = right - 6 - left;
  // The corgi's leftmost cell; it is seven cells wide.
  const at =
    finale > 0
      ? left
      : progress < enter
        ? Math.round(right + 1 - (progress / enter) * 7)
        : Math.round(right - 6 - ((progress - enter) / (1 - enter)) * span);
  const kick = clamp(finale / ending.kicked) * 8,
    sink = clamp((finale - ending.sinks) / (ending.sunk - ending.sinks));
  for (const y of [area.y, area.y + 1])
    for (let x = left; x <= right; x++) {
      const cell = grid.at(x, y);
      if (!cell) continue;
      if (sink > 0) {
        const height = Math.round(4 - (sink * 6 - ((x - left) / Math.max(1, right - left)) * 1.5));
        if (y === area.y && x < left + 7) grid.put(x, y, " ", c.text);
        else grid.put(x, y, height >= 4 ? a.buried[x % 10] : height >= 1 ? a.pile[height] : " ", a.dirt);
        continue;
      }
      const d = x - (y === area.y ? at + 7 : at + 1) + kick;
      if (d < 0) continue;
      const height = Math.min(4, Math.floor(d / 1.2));
      if (height >= 4) grid.put(x, y, a.buried[x % 10], a.dirt);
      else if (height > 0) grid.put(x, y, a.pile[height], a.dirt);
      else if (cell.ch !== " ") cell.fg = c.faint;
    }
  let dog = a.walk_left[Math.floor(tick / 2) % 4],
    x0 = at;
  if (finale === 0 && progress >= enter) {
    const clod = at + 7 + (tick % 3);
    if (clod <= right) grid.put(clod, area.y, a.clods[tick % 3], a.dirt);
  } else if (finale >= ending.leaves) x0 = left - Math.floor(((finale - ending.leaves) / (1 - ending.leaves)) * 9);
  else if (finale >= ending.kicked)
    dog =
      a.wagTail(Math.floor(tick / 3)) +
      (finale < ending.settled ? "ᐱ•ᴥ•ᐱ" : finale >= ending.content ? "ᐯ◡ᴥ◡ᐯ" : "ᐯ•ᴥ•ᐯ");
  [...dog].forEach((ch, i) => {
    if (x0 + i >= left && x0 + i <= right) grid.put(x0 + i, area.y, ch, c.text);
  });
}
