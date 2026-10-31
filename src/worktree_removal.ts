//! Removing a worktree from the overview by holding ⌫: the hold, read from
//! key repeat, and the row coming apart while it lasts.
import * as palette from "./palette";
import * as corgiAnimation from "./corgi_animation";
import * as worktrees from "./worktrees";
import * as sidebar from "./sidebar";
import { Grid } from "./cell_grid";
import { ellipsis, displayWidth } from "./text";
import { clean } from "./trackers/git_status";
import { KeyHold } from "./key_hold";

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
export const message_ms = 4000;
export const finale_ms: Record<Effect, number> = { dust: 600, burn: 500, bury: 1800 };

/** The worktree being removed, and what the footer says about it. */
export interface Target {
  workspace: number;
  path: string;
  name: string;
  branch: boolean;
  locked: string | null;
  holder: worktrees.Holder | null;
  /** Files with uncommitted changes, when known. */
  changes: number | null;
  /** Commits a detached HEAD holds that nothing else does. */
  detached: number;
  agents: number;
  /** Its row and place in the list, kept for the ending once Git has removed it. */
  checkout: worktrees.Checkout;
  index: number;
}
export function target(workspace: number, checkout: worktrees.Checkout, index: number, agents: number): Target {
  return {
    workspace,
    path: checkout.path,
    name: worktrees.label(checkout),
    branch: checkout.branch !== null,
    locked: checkout.locked,
    holder: checkout.holder,
    changes: checkout.changes?.total ?? null,
    detached: checkout.detached ? Number(checkout.comparison?.ahead ?? 0n) : 0,
    agents,
    checkout,
    index,
  };
}

/** A locked worktree's hold ends in `confirm`, its lock shown, until Enter removes it anyway. */
export type Phase = "idle" | "held" | "confirm" | "removing" | "removed" | "stopped" | "failed";
export class Hold {
  phase: Phase = "idle";
  target: Target | null = null;
  effect: Effect = "dust";
  committed_at = 0;
  settled_at = 0;
  reason = "";
  /** The daemon's removal, and what it last said about deleting the files. */
  job = 0;
  report: worktrees.Removal | null = null;
  private key = new KeyHold(hold_ms, heal_ms);
  /** When the removed worktree left the list. */
  private gone_at: number | null = null;

  get progress(): number {
    return this.key.progress;
  }

  /** One press of the key, or one repeat. True when it completes the hold:
   * the key is still down once the row is gone. A locked worktree's hold
   * completes to `confirm` instead. A new hold plays `effect`, a locked
   * worktree's one that clears the row for its note. */
  press(now: number, target: Target, effect: Effect): boolean {
    this.advance(now);
    if (this.key.quieted(now) || this.phase === "removing" || this.phase === "confirm") {
      this.key.quiet(now);
      return false;
    }
    if (this.phase !== "held" || this.target?.path !== target.path) {
      this.key.reset();
      this.effect = target.locked !== null && effect === "bury" ? "dust" : effect;
      this.report = null;
    }
    this.phase = "held";
    this.target = target;
    if (!this.key.press(now)) return false;
    if (target.locked !== null) {
      this.phase = "confirm";
      this.settled_at = now;
      return false;
    }
    return this.commit(now);
  }
  /** Enter on a locked worktree's note: removes it anyway. */
  confirm(now: number): boolean {
    return this.phase === "confirm" && this.commit(now);
  }
  /** Keeps a locked worktree: its row comes back the way a let-go hold does. */
  cancel(now: number): void {
    if (this.phase !== "confirm") return;
    this.phase = "held";
    this.key.letGo(now);
  }
  private commit(now: number): boolean {
    this.phase = "removing";
    this.job = 0;
    this.committed_at = now;
    this.gone_at = null;
    return true;
  }
  /** Moves the hold on to `now`; see `KeyHold.advance`. */
  advance(now: number): void {
    if (this.phase === "held") {
      this.key.advance(now);
      if (!this.key.active) this.reset();
    } else if (
      this.phase !== "idle" &&
      this.phase !== "removing" &&
      this.phase !== "confirm" &&
      now - this.settled_at >= message_ms
    )
      this.reset();
  }
  /** The daemon's answer: removed, or why not. */
  settle(now: number, reason: string | null): void {
    this.phase = reason === null ? "removed" : "failed";
    this.reason = reason ?? "";
    this.settled_at = now;
    if (reason !== null) this.key.reset();
  }
  /** Esc stopped Git deleting it; the worktree stays, short of what was already gone. */
  stopped(now: number): void {
    this.phase = "stopped";
    this.settled_at = now;
    this.key.reset();
  }
  reset(): void {
    this.phase = "idle";
    this.target = null;
    this.report = null;
    this.key.reset();
  }
  /** Whether the hold is past the point where letting go undoes it. */
  committed(): boolean {
    return this.phase === "removing" || this.phase === "removed";
  }
  /** Whether `path`'s row is drawn coming apart. */
  covers(path: string): boolean {
    return this.target?.path === path && (this.phase === "held" || this.phase === "confirm" || this.committed());
  }
  /** Whether the frame still moves: a note waiting on Enter stops once settled. */
  animating(now: number): boolean {
    return this.phase !== "confirm" || this.settling(now) < 1;
  }
  /** How far the other worktrees fade while a locked one's band is up, 0 to 1:
   * with the hold, all the way while it waits, and back as it comes apart. */
  dimming(now: number): number {
    if (this.target?.locked == null) return 0;
    switch (this.phase) {
      case "held":
        return this.progress;
      case "confirm":
        return 1;
      case "removing":
      case "removed":
        return 1 - this.finale(now);
      default:
        return 0;
    }
  }
  /** How far a completed hold on a locked worktree has settled, 0 to 1. */
  settling(now: number): number {
    if (this.phase !== "confirm") return 0;
    return Math.max(0.0001, Math.min(1, (now - this.settled_at) / finale_ms[this.effect]));
  }
  /** How far the effect's ending has played, 0 before the hold completes. */
  finale(now: number): number {
    if (!this.committed()) return 0;
    return Math.max(0.0001, Math.min(1, (now - this.committed_at) / finale_ms[this.effect]));
  }
  /** The overview's rows: `entries`, with the removed worktree kept in its
   * place after Git is done with it, until its ending has played and its
   * row, `lines` tall, has closed, a line at a time. */
  shown(entries: worktrees.Checkout[], now: number, lines = 2): Shown {
    const t = this.target;
    if (!t || !this.committed()) return { entries, removing: null, closed: 0 };
    if (entries.some(e => e.path === t.path)) {
      this.gone_at = null;
      return { entries, removing: t.path, closed: 0 };
    }
    this.gone_at ??= now;
    const from = Math.max(this.committed_at + finale_ms[this.effect], this.gone_at),
      closed = now < from ? 0 : 1 + Math.floor((now - from) / close_step_ms);
    if (closed >= lines) return { entries, removing: null, closed: 0 };
    return { entries: [...entries.slice(0, t.index), t.checkout, ...entries.slice(t.index)], removing: t.path, closed };
  }
}
/** The overview's rows while a removal holds the cursor: the removed row
 * (`removing`) and how many of its lines have closed. */
export interface Shown {
  entries: worktrees.Checkout[];
  removing: string | null;
  closed: number;
}
/** How long the rows below take to move up each line, once the row is gone. */
export const close_step_ms = 70;

export type Segment = { text: string; color: palette.Token; bold?: boolean };
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** The footer while a hold is on: what goes and what stays, still while a
 * locked worktree's band asks first. A removal that worked needs no word;
 * one that didn't says why. */
export function footer(hold: Hold): Segment[] | null {
  const t = hold.target;
  if (!t || hold.phase === "idle" || hold.phase === "removed") return null;
  const dot = { text: " · ", color: "faint" as const };
  const losses = (out: Segment[]) => {
    const add = (text: string, color: palette.Token) => out.push(dot, { text, color });
    if (t.changes) add(`${plural(t.changes, "uncommitted file")} lost`, "hot");
    if (t.detached) add(`${plural(t.detached, "detached commit")} lost`, "hot");
    if (t.agents) add(`${plural(t.agents, "agent")} close`, "muted");
    if (t.branch) add("branch kept", "faint");
    return out;
  };
  switch (hold.phase) {
    case "failed":
      return [{ text: `Couldn't remove ${t.name}`, color: "hot" }, dot, { text: hold.reason, color: "muted" }];
    case "stopped":
      return [
        { text: `Stopped removing ${t.name}`, color: "warm" },
        dot,
        { text: "some of its files may be gone", color: "muted" },
      ];
    case "removing":
      return [{ text: `Removing ${t.name}`, color: "strong", bold: true }, dot, { text: "Esc stop", color: "faint" }];
    default:
      return losses([
        { text: `Removing ${t.name}`, color: "strong", bold: true },
        ...(t.locked !== null ? [dot, { text: "locked", color: "warm" as const }] : []),
      ]);
  }
}
/** Where a locked worktree's band goes: over its row's columns, `left` to
 * `right` inclusive, from its first line `y` for `lines` lines. */
export interface Band {
  y: number;
  lines: number;
  left: number;
  right: number;
}
/** Who holds a lock, and whether they still run, faded under the pill. */
function holderSegments(t: Target): Segment[] {
  if (!t.locked) return [{ text: "no reason given", color: "faint" }];
  const n = worktrees.lockNote(t.locked),
    dot = { text: " · ", color: "faint" as const };
  if (n.pid === null) return [{ text: t.locked, color: "muted" }];
  return [
    { text: n.by, color: "muted" },
    ...(t.holder === "running" ? [dot, { text: "still running", color: "hot" as const, bold: true }] : []),
    ...(t.holder === "exited" ? [dot, { text: "exited", color: "muted" as const }] : []),
  ];
}
/** The keys, widest first: the first that fits beside the pill is drawn.
 * `gap` sets Esc's pair apart, past a rule. */
const key_sets: { label: string; gap: string | null }[] = [
  { label: " remove anyway", gap: "  " },
  { label: " remove", gap: "  " },
  { label: " remove", gap: " " },
  { label: " remove", gap: null },
];
/** A locked worktree's band, in a grid `w` by `h`, for its row's columns to
 * come apart onto: a warm band with the LOCKED pill and its keys on the
 * first line, who holds the lock under them, or between them on a row of
 * one line. Only the band's cells have a fill. */
export function underlay(w: number, h: number, band: Band, t: Target): Grid {
  const c = palette.colors,
    grid = new Grid(w, h, c.text),
    tint = palette.mix(c.selected, c.warm, 16),
    { y, left, right } = band;
  const write = (x: number, row: number, text: string, fg: palette.Rgb, bold = false, bg = tint) => {
    grid.text(x, row, text, fg, bold);
    grid.fill(x, row, displayWidth(text), bg);
    return x + displayWidth(text);
  };
  /** Segments from `x`, ending before `end`: the first is cut to keep the rest whole. */
  const segments = (x: number, row: number, end: number, list: Segment[]) => {
    const rest = list.slice(1).reduce((n, s) => n + displayWidth(s.text), 0);
    list.forEach((s, i) => {
      const text = ellipsis(clean(s.text), end - x - (i ? 0 : rest));
      if (text) x = write(x, row, text, c[s.color], s.bold ?? false);
    });
  };
  for (let i = 0; i < Math.max(1, band.lines); i++) {
    grid.fill(left, y + i, right - left + 1, tint);
    grid.put(left, y + i, "▎", c.warm);
  }
  const pill = write(left + 2, y, " LOCKED ", c.bg, true, c.warm);
  // The keys end a cell in from the band's edge; Enter's pair is bold, Esc's past a rule.
  let keys = right;
  for (const set of key_sets) {
    const width = 7 + displayWidth(set.label) + (set.gap === null ? 0 : 2 * set.gap.length + 11);
    if (pill + 2 + width > right) continue;
    keys = right - width;
    let x = write(keys, y, " Enter ", c.strong, true, c.line);
    x = write(x, y, set.label, c.strong, true);
    if (set.gap !== null) {
      x = write(x, y, set.gap, c.text);
      x = write(x, y, "│", c.faint);
      x = write(x, y, set.gap, c.text);
      x = write(x, y, " Esc ", c.text, false, c.line);
      write(x, y, " keep", c.text);
    }
    break;
  }
  if (band.lines > 1) segments(left + 3, y + 1, right, holderSegments(t));
  else segments(pill + 2, y, keys - 2, holderSegments(t));
  return grid;
}

/** Where a row comes apart, in the grid's cells. */
export interface Area {
  /** The row's first line, and how many lines it has. */
  y: number;
  lines: number;
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
const lines = (area: Area) => Array.from({ length: Math.max(1, area.lines) }, (_, i) => area.y + i);
/** Braille dot bits by [column][row] inside a cell. */
const dots = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

/** Draws the row in `area` coming apart: `progress` while the key is held,
 * then `finale` from 0 to 1 once it's gone. Every effect runs right to left.
 * A locked worktree's columns come apart onto `under`, its band (the cells
 * it fills), which waits there, `settle` from 0 to 1; once confirmed, the
 * whole row comes apart, the band's tint fading as it goes. */
export function paint(
  grid: Grid,
  area: Area,
  effect: Effect,
  progress: number,
  finale: number,
  now: number,
  under: Grid | null = null,
  settle = 0,
): void {
  const tail = effect === "dust" ? 0.42 : 0.3;
  let v = finale > 0 ? 1 + finale * tail : progress + settle * tail;
  if (under && finale > 0 && effect !== "bury") {
    for (const y of lines(area))
      for (let x = area.left; x <= area.right; x++) {
        const u = under.at(x, y),
          cell = grid.at(x, y);
        if (!u?.bg || !cell) continue;
        grid.put(x, y, u.ch, u.fg, u.bold);
        cell.bg = palette.mix(u.bg, cell.bg ?? palette.colors.surface, Math.round(finale * 100));
      }
    v = finale * (1 + tail);
    under = null;
  }
  const letters: Letter[] = [];
  for (const y of lines(area))
    for (let x = area.left; x <= area.right; x++) {
      const c = grid.at(x, y);
      if (c && c.ch !== " " && c.ch !== "") letters.push({ x, y, ...c });
    }
  const along = (x: number) => (area.right - x) / Math.max(1, area.right - area.left),
    tick = Math.floor(now / tick_ms);
  switch (effect) {
    case "dust":
      return dust(grid, area, letters, along, v, under);
    case "burn":
      return burn(grid, area, along, v, tick, under);
    case "bury":
      return bury(grid, area, progress, finale, tick);
  }
}

/** The row crumbles into braille dots that drift right, into the part
 * already gone, where `under` shows through. */
function dust(
  grid: Grid,
  area: Area,
  letters: Letter[],
  along: (x: number) => number,
  v: number,
  under: Grid | null,
): void {
  if (v <= 0) return;
  const c = palette.colors,
    found = new Map<number, { bits: number; age: number }>(),
    begins = (x: number, y: number) => along(x) * 0.86 + hash(x, y, 1) * 0.05 + (y === area.y ? 0.02 : 0);
  for (const l of letters) {
    const start = begins(l.x, l.y),
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
  // The band shows once its cell has crumbled, faint at first; dust drifts around it.
  if (under)
    for (const y of lines(area))
      for (let x = area.left; x <= area.right; x++) {
        const u = under.at(x, y),
          cell = grid.at(x, y),
          age = v - begins(x, y);
        if (!u?.bg || !cell || age < 0.016) continue;
        grid.put(x, y, u.ch, age < 0.06 ? c.faint : u.fg, u.bold);
        cell.bg = age < 0.06 ? palette.mix(u.bg, cell.bg ?? c.surface, 50) : u.bg;
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

/** A fire front: letters ahead of it warm up, behind it they glow, then go
 * to ash, or to `under`, glowing as it shows. */
function burn(grid: Grid, area: Area, along: (x: number) => number, v: number, tick: number, under: Grid | null): void {
  if (v <= 0) return;
  const c = palette.colors,
    ember = palette.mix(c.hot, c.surface, 45);
  for (const y of lines(area))
    for (let x = area.left; x <= area.right; x++) {
      const cell = grid.at(x, y);
      if (!cell) continue;
      const a = v - (along(x) * 0.8 + hash(x, y, 0) * 0.04 + (y === area.y ? 0.035 : 0)),
        text = cell.ch !== " ",
        u = under?.at(x, y);
      if (a < -0.07) continue;
      if (u?.bg && a >= 0.12) {
        grid.put(x, y, u.ch, a < 0.2 && u.ch !== " " ? ember : u.fg, u.bold);
        cell.bg = a < 0.2 ? palette.mix(u.bg, cell.bg ?? c.surface, 50) : u.bg;
        continue;
      }
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
  for (const y of lines(area))
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

/** A removed worktree's row while Git is still deleting it, once its
 * ending has played: "Deleting..." with its dots pulsing, and a short
 * stretch of a bar sweeping back and forth, since Git says nothing of how
 * far it got. */
export function progress(grid: Grid, area: Area, now: number): void {
  const c = palette.colors,
    { y } = area,
    left = area.left + 2;
  for (const row of lines(area)) for (let x = left; x <= area.right; x++) grid.put(x, row, " ", c.text);
  grid.text(left, y, "Deleting", c.text);
  for (let i = 0; i < 3; i++) grid.put(left + 8 + i, y, ".", sidebar.pulse(i, now));
  // The bar has a line of its own, or follows the words on a one-line row.
  const bar = area.lines > 1 ? { y: y + 1, x: left } : { y, x: left + 13 },
    room = area.right - 1 - bar.x + 1,
    span = Math.min(8, room),
    travel = Math.max(1, room - span),
    step = Math.floor(now / tick_ms) % (2 * travel),
    from = step < travel ? step : 2 * travel - step;
  for (let i = 0; i < room; i++) {
    const lit = i >= from && i < from + span;
    grid.put(bar.x + i, bar.y, lit ? "━" : "─", lit ? c.accent : c.line);
  }
}
