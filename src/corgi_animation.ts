//! Viewer-local corgi motion policies mirrored from corgi_animation.zig.
import { randomBytes } from "node:crypto";
import * as palette from "./palette";
import * as frames from "./corgi_frames";
export class Random {
  state: bigint[];
  constructor(seed: bigint = 0n) {
    let value = seed;
    this.state = Array.from({ length: 4 }, () => {
      value = BigInt.asUintN(64, value + 0x9e3779b97f4a7c15n);
      let z = BigInt.asUintN(64, (value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n);
      z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
      return z ^ (z >> 31n);
    });
  }
  next(): bigint {
    const rotate = (v: bigint, n: bigint) => BigInt.asUintN(64, (v << n) | (v >> (64n - n)));
    const s = this.state,
      r = BigInt.asUintN(64, rotate(BigInt.asUintN(64, s[0] + s[3]), 23n) + s[0]),
      t = BigInt.asUintN(64, s[1] << 17n);
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotate(s[3], 45n);
    return r;
  }
  float(): number {
    const rand = this.next(),
      leading = (v: bigint) => (v === 0n ? 64 : 64 - v.toString(2).length);
    let lz = leading(rand);
    if (lz >= 12) {
      lz = 12;
      while (lz < 1022) {
        const additional = leading(this.next());
        lz += additional;
        if (additional !== 64) break;
      }
      lz = Math.min(lz, 1022);
    }
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE((BigInt(1022 - lz) << 52n) | (rand & 0xfffffffffffffn));
    return bytes.readDoubleLE();
  }
  int(n: number): number {
    const mask = 0xffffffffn,
      limit = BigInt(n),
      threshold = (0x100000000n - limit) % limit;
    for (;;) {
      const product = (this.next() & mask) * limit;
      if ((product & mask) >= threshold) return Number(product >> 32n);
    }
  }
  boolean() {
    return (this.next() & 1n) !== 0n;
  }
}
export class Throw {
  speed = 1.6;
  lift = 1.1;
  spin = 0;
  seed = 0n;
  constructor(fields: Partial<Throw> = {}) {
    Object.assign(this, fields);
  }
  static random(r: Random) {
    const seed = r.next(),
      kind = r.int(3);
    if (kind === 0) {
      const speed = 1.5 + 0.4 * r.float();
      return new Throw({
        speed,
        lift: -(0.4 + 0.4 * r.float()),
        spin: -speed * (0.5 + 0.5 * r.float()),
        seed,
      });
    }
    const angle = ((kind === 1 ? 15 + 35 * r.float() : 30 + 15 * r.float()) * Math.PI) / 180,
      force = kind === 1 ? 1.8 + 0.8 * r.float() : 2.6 + 0.8 * r.float(),
      speed = force * Math.cos(angle);
    return new Throw({
      speed,
      lift: force * Math.sin(angle) * (kind === 1 ? 1 : -1),
      spin: kind === 1 ? speed * (0.5 + 0.5 * r.float()) : 0,
      seed,
    });
  }
}
const gait_right = ["~[/\\]o>", "~[||]o>", "~[\\/]o>", "~[||]o>"],
  gait_left_carry = ["●‹o[/\\]~", "●‹o[||]~", "●‹o[\\/]~", "●‹o[||]~"];
const dots = [
  [0x40, 4, 2, 1],
  [0x80, 0x20, 0x10, 8],
];
export class Ball {
  x = 12;
  y = 1;
  vx: number;
  vy: number;
  spin: number;
  random: Random;
  constructor(value: Throw) {
    this.vx = value.speed;
    this.vy = value.lift;
    this.spin = value.spin;
    this.random = new Random(value.seed);
  }
  resting() {
    return this.y === 0 && this.vx === 0 && this.vy === 0;
  }
  reachable() {
    return Math.round(this.y) <= 1;
  }
  bounce(normal: [number, number], kept: [number, number]): boolean {
    const askew = ((this.random.float() - 0.5) * 10 * Math.PI) / 180,
      nx = normal[0] * Math.cos(askew) - normal[1] * Math.sin(askew),
      ny = normal[0] * Math.sin(askew) + normal[1] * Math.cos(askew),
      into = this.vx * nx + this.vy * ny;
    if (into >= 0) return false;
    const share = kept[0] + (kept[1] - kept[0]) * this.random.float(),
      along = this.vx * ny - this.vy * nx,
      slip = along + this.spin,
      rub = -Math.sign(slip) * Math.min((2 / 7) * Math.abs(slip), 0.15 * (1 + share) * -into),
      out = -share * into;
    this.spin += 2.5 * rub;
    this.vx = (along + rub) * ny + out * nx;
    this.vy = -(along + rub) * nx + out * ny;
    return true;
  }
  land() {
    this.y = 0;
    this.bounce([0, 1], [0.7, 0.9]);
    this.vy = Math.abs(this.vy);
    if (this.vy < 0.3) {
      this.vy = 0;
      this.vx -= (2 / 7) * (this.vx + this.spin);
      this.spin = -this.vx;
    }
  }
  step(width: number, near: number) {
    const foot = 2 * width - 3,
      far = 2 * width - 1,
      rolling = this.y === 0 && this.vy === 0;
    if (rolling) {
      const drag = 0.6 / (2 * width - 12);
      this.vx = Math.abs(this.vx) <= 0.25 ? 0 : this.vx - Math.sign(this.vx) * drag;
      this.spin = -this.vx;
    } else {
      this.vy -= 0.16;
      this.y += this.vy;
      if (this.y >= 3) {
        this.y = 3;
        this.bounce([0, -1], [0.7, 0.9]);
      } else if (this.y <= 0 && this.x <= foot) this.land();
    }
    this.x += this.vx;
    const surface = Math.min(this.x, far) - foot;
    if (surface > 0 && this.y < surface) {
      const depth = (surface - this.y) / 2;
      this.x -= depth;
      this.y = Math.max(0, this.y + depth);
      this.bounce([-Math.SQRT1_2, Math.SQRT1_2], rolling ? [0.25, 0.65] : [0.7, 0.9]);
    } else if (this.y < 0) this.land();
    if (this.x >= far) {
      this.x = far;
      this.bounce([-1, 0], [0.7, 0.9]);
      this.vx = -Math.abs(this.vx);
    } else if (this.x <= near) {
      this.x = near;
      this.bounce([1, 0], [0.7, 0.9]);
      this.vx = Math.abs(this.vx);
    }
  }
  dot() {
    const col = Math.round(this.x),
      row = Math.round(this.y);
    return { cell: Math.floor(col / 2), dots: dots[col % 2][row] };
  }
}
export function chase(width: number, value: Throw, ticks: number) {
  const ball = new Ball(value),
    result: {
      ball: Ball;
      dog: { x: number; pose: string } | null;
      landed: number;
      caught: number;
      stop: number;
    } = { ball, dog: null, landed: 0, caught: 0, stop: 0 };
  let up: number | null = null,
    x = 0,
    ran = false;
  for (let tick = 0; tick <= 1000; tick++) {
    const cell = ball.dot().cell,
      ready = result.landed > 0 && tick >= result.landed + 4;
    if (up !== null) {
      if (tick - up >= 4 && (tick - up) % 2 === 0) {
        ran = cell > x + 7 && x + 8 < width;
        if (ran) x++;
      }
    } else if (ready && cell >= x + 7) up = tick;
    if (tick === ticks) {
      result.ball = Object.assign(Object.create(Ball.prototype), ball);
      if (up !== null) result.dog = { x, pose: ran ? gait_right[x % 4] : gait_right[1] };
    }
    const near = up !== null ? x + 7 : 6;
    if ((ready && cell <= near && ball.reachable()) || tick === 1000) {
      result.caught = tick + 1;
      result.stop = x;
      return result;
    }
    ball.step(width, 2 * near);
    if (ball.y === 0 && !result.landed) result.landed = tick + 1;
  }
  return result;
}
export function fetchScene(width: number, value: Throw, tick: number) {
  let p = tick;
  const stage = (duration: number) => {
    if (p < duration) return true;
    p -= duration;
    return false;
  };
  const rest = "~ᐯ•ᴥ•ᐯ",
    held = "~ᐯ•●•ᐯ";
  if (stage(16)) return { dog: Math.floor(p / 2) === 4 ? "~ᐯ◡ᴥ◡ᐯ" : rest, x: 0, ball: null };
  const run = chase(width, value, p);
  if (stage(run.caught))
    return {
      dog: run.dog?.pose ?? (p > run.landed ? "~ᐯ•ᴥ•ᐱ" : rest),
      x: run.dog?.x ?? 0,
      ball: run.ball.dot(),
    };
  p = Math.floor(p / 2);
  const stop = run.stop,
    turn = stop > 0 ? 2 : 0;
  if (stage(2)) return { dog: "~[||]o●", x: stop, ball: null };
  if (stage(5)) return { dog: held, x: stop, ball: null };
  if (stage(turn)) return { dog: gait_left_carry[1], x: stop - 1, ball: null };
  if (stage(stop)) return { dog: gait_left_carry[p % 4], x: stop - 1 - p, ball: null };
  if (stage(3)) return { dog: held, x: 0, ball: null };
  return { dog: rest, x: 0, ball: null };
}
export function fetchTicks(width: number, value: Throw) {
  const run = chase(width, value, 0);
  return 16 + run.caught + 2 * ((run.stop > 0 ? 2 : 0) + run.stop + 13);
}
const fetchPace = (width: number, value: Throw) => Math.max(fetchTicks(width, value), 192);
export const wagTail = (step: number) => ["~", "-", "~", "^"][step % 4];
export function writeFetch(width: number, value: Throw, tick: number): string {
  const scene = fetchScene(width, value, tick),
    dog = [...scene.dog];
  let at = 0,
    out = "";
  for (let col = 0; col < width; col++) {
    const ball = scene.ball?.cell === col ? scene.ball.dots : 0;
    if (col === width - 1)
      out +=
        (ball ? "" : palette.fg("faint")) +
        String.fromCodePoint(0x2800 + (0x60 | ball)) +
        (ball ? "" : palette.fg("text"));
    else if (ball) out += String.fromCodePoint(0x2800 + ball);
    else if (col >= scene.x) {
      const glyph = dog[at++] ?? " ";
      out += glyph === "~" ? wagTail(Math.floor(tick / 4)) : glyph;
    } else out += " ";
  }
  return out;
}
const frame = (room: number, value: string) => [...value].slice(0, Math.max(0, room)).join("");
export type Routine = "idle" | "sniff" | "fetch";
export class Playback {
  static minimum_idle_ms = 10000;
  static retry_ms = 2000;
  static activity_probability_percent = 35;
  static max_activity_ms = 9600;
  active = false;
  routine: Routine = "idle";
  started_ms = 0;
  deadline_ms = 0;
  random = new Random();
  throw = new Throw();
  enter(routine: Routine, now: number) {
    this.routine = routine;
    this.started_ms = now;
    if (routine === "fetch") this.throw = Throw.random(this.random);
    this.deadline_ms =
      now +
      (routine === "idle" ? 10000 : routine === "sniff" ? (1 + this.random.int(2)) * frames.sniff.length * 200 : 9600);
  }
  update(active: boolean, now: number) {
    const before = this.active;
    this.active = active;
    if (!active) return;
    if (!before) {
      this.enter((["idle", "sniff", "fetch"] as Routine[])[this.random.int(3)], now);
      return;
    }
    if (now < this.deadline_ms) return;
    if (this.routine !== "idle") this.enter("idle", now);
    else if (this.random.int(100) < 35) this.enter(this.random.boolean() ? "sniff" : "fetch", now);
    else this.deadline_ms = now + 2000;
  }
  write(room: number, now: number): string {
    const elapsed = Math.max(0, now - this.started_ms);
    if (this.routine === "idle") return frame(room, frames.wag[Math.floor(elapsed / 200) % frames.wag.length]);
    if (this.routine === "sniff") return frame(room, frames.sniff[Math.floor(elapsed / 200) % frames.sniff.length]);
    if (room >= 18)
      return writeFetch(room, this.throw, Math.floor((Math.min(elapsed, 9599) * fetchPace(room, this.throw)) / 9600));
    const phase = Math.floor((Math.min(elapsed, 9599) * 4) / 9600);
    return (
      (room > 0 ? wagTail(Math.floor(elapsed / 300)) : "") +
      frame(room - 1, ["ᐯ•ᴥ•ᐯ", "ᐯ•ᴥ•ᐱ", "ᐯ•●•ᐯ", "ᐯ•ᴥ•ᐯ"][phase])
    );
  }
}
export class Fetch {
  thrown_ms: number | null = null;
  throw = new Throw();
  throwBall(room: number, now: number) {
    if (room < 18 || this.tick(room, now) !== null) return;
    this.thrown_ms = now;
    this.throw = Throw.random(new Random(randomBytes(8).readBigUInt64LE()));
  }
  tick(room: number, now: number): number | null {
    if (this.thrown_ms === null) return null;
    const elapsed = Math.max(0, now - this.thrown_ms);
    if (room < 18 || elapsed >= 9600) return null;
    const at = 16 + Math.floor((elapsed * fetchPace(room, this.throw)) / 9600);
    return at < fetchTicks(room, this.throw) ? at : null;
  }
  write(room: number, now: number) {
    const at = this.tick(room, now);
    return (
      palette.fg("text") +
      (at !== null
        ? writeFetch(room, this.throw, at)
        : frame(room, frames.wag[Math.floor(Math.max(0, now) / 200) % frames.wag.length]))
    );
  }
}
export const herd_width = 18;
export const walk_left = ["‹o[/\\]~", "‹o[||]~", "‹o[\\/]~", "‹o[||]~"];
const herd_word = "Compacting",
  curl = [
    { after: 2, pose: "ᐯ◡ᴥ◡ᐯ" },
    { after: 2, pose: "ᐯ◡ᴥ◡ᐯ" },
    { after: 3, pose: "◡ᴥ◡" },
    { after: 2, pose: "•ᴥ•" },
    { after: 1, pose: "•.•" },
    { after: 0, pose: "..." },
    { after: 0, pose: "…" },
  ];
export function herdScene(width: number, step: number) {
  const gaps = [1, 2, 0, 2, 1, 0, 2, 1, 1],
    spread = [0];
  let sum = 0;
  for (const [i, gap] of gaps.entries()) {
    sum += gap;
    spread.push(i + 1 + Math.floor((sum * (width - 11)) / 10));
  }
  const roundup = width - 9;
  if (step < roundup) {
    const nose = width - step,
      letters = [...spread];
    letters[9] = Math.min(spread[9], nose - 1);
    for (let i = 9; i > 0; i--) letters[i - 1] = Math.min(spread[i - 1], letters[i] - 1);
    return {
      letters,
      lit: letters.map((at, i) => at === i || at < spread[i]),
      dog: walk_left[step % 4],
      x: nose,
    };
  }
  const p = step - roundup,
    pose = p >= 10 ? curl[Math.min(p - 10, curl.length - 1)] : null;
  return {
    letters: Array.from({ length: 10 }, (_, i) => i),
    lit: Array(10).fill(true),
    dog: pose?.pose ?? (p === 6 ? "~ᐯ◡ᴥ◡ᐯ" : "~ᐯ•ᴥ•ᐯ"),
    x: pose ? 10 + pose.after : 11,
  };
}
export function writeHerd(width: number, step: number) {
  const scene = herdScene(width, step),
    dog = [...scene.dog];
  let at = 0,
    letter = 0,
    out = "";
  let current: palette.Token | null = null;
  const tint = (color: palette.Token) => {
    if (color === current) return "";
    current = color;
    return palette.fg(color);
  };
  for (let col = 0; col < width; col++) {
    if (col >= scene.x && at < dog.length) {
      const glyph = dog[at++];
      out += tint("text") + (glyph === "~" ? wagTail(Math.floor(step / 2)) : glyph);
    } else if (letter < 10 && scene.letters[letter] === col) {
      out += tint(scene.lit[letter] ? "text" : "faint") + herd_word[letter++];
    } else out += " ";
  }
  return out;
}
export type Dig = "restoring" | "forking";
export const Dig = {
  lead: 17,
  wordWidth: (dig: Dig) => (dig === "restoring" ? 10 : 8),
  width: (dig: Dig) => (dig === "restoring" ? 27 : 25),
};
/** An unfocused dormant pane's title: the corgi asleep where it will dig,
 * then what wakes it. */
export const Asleep = { word: "Click to resume", wordWidth: 15, width: 32 };
export function writeAsleep(width: number): string {
  const word = "\x1b[1m" + palette.fg("accent") + Asleep.word;
  if (width < Asleep.width) return word;
  return " ".repeat(7) + palette.fg("muted") + "~ᐯ◡ᴥ◡ᐯ " + palette.fg("faint") + "ᶻz " + word;
}
const blend = (from: palette.Rgb, to: palette.Rgb, amount: number) =>
  from.map((v, i) => Math.round(v + (to[i] - v) * amount)) as palette.Rgb;
/** Unearth's dirt: its color, letters still buried, the pile behind the
 * corgi by height, and the clods it throws. */
export const dirt: palette.Rgb = [150, 126, 96],
  buried = ["⣶", "⣿", "⣷", "⣾", "⣿", "⣶", "⣷", "⣿", "⣾", "⣶"],
  pile = [" ", "⣀", "⣤", "⣶", "⣿"],
  clods = ["⠄", "⠂", "⠁", "⠁", "⠂"];
export function writeUnearth(width: number, shown_ms: number, dig: Dig): string {
  const word = [...(dig === "restoring" ? "Restoring…" : "Forking…")],
    restored = palette.colors.accent;
  if (width < Dig.width(dig)) return "\x1b[1m" + palette.fg("accent") + word.join("");
  const step = Math.floor(Math.max(0, shown_ms) / 80),
    cells = Array.from({ length: Dig.width(dig) }, () => ({
      glyph: " ",
      color: dirt,
      bold: false,
    })),
    heights = [0, 0, 0, 0];
  for (const [i, letter] of word.entries()) {
    const age = step - i * 2;
    cells[17 + i] =
      age < 0
        ? { glyph: buried[i % 10], color: dirt, bold: false }
        : age < 2
          ? { glyph: age === 0 ? "⣤" : "⠤", color: dirt, bold: false }
          : {
              glyph: letter,
              color: age === 2 ? dirt : age === 3 ? blend(dirt, restored, 0.5) : restored,
              bold: true,
            };
    if (age < 0) continue;
    if (age < 5) cells[8 - age] = { glyph: clods[age], color: dirt, bold: false };
    else {
      const column = [1, 0, 3, 2][i % 4];
      heights[column] = Math.min(heights[column] + 1, 4);
    }
  }
  for (const [i, h] of heights.entries()) cells[i].glyph = pile[h];
  const dug = word.length * 2 + 2;
  let col = 9;
  let dog: string;
  if (step < dug) dog = step % 2 ? "~[/\\]o›" : "~[\\/]o›";
  else {
    col++;
    cells[15] = {
      glyph: wagTail(Math.floor(step / 2)),
      color: palette.colors.text,
      bold: false,
    };
    dog = step - dug < 5 ? "ᐱ•ᴥ•ᐱ" : "ᐯ•ᴥ•ᐯ";
  }
  for (const glyph of dog) cells[col++] = { glyph, color: palette.colors.text, bold: false };
  let bold: boolean | null = null;
  let color: palette.Rgb | null = null;
  let out = "";
  for (const cell of cells) {
    if (bold !== cell.bold) {
      bold = cell.bold;
      out += bold ? "\x1b[1m" : "\x1b[22m";
    }
    if (color === null || color.some((v, i) => v !== cell.color[i])) {
      color = cell.color;
      out += palette.fgRgb(color);
    }
    out += cell.glyph;
  }
  return out;
}
export type Mode = "awake" | "asleep" | "herding" | "content";
export class Sleep {
  background = palette.colors.bg;
  bright = false;
  selected = false;
  puff_ms: number | null = null;
  constructor(fields: Partial<Sleep> = {}) {
    Object.assign(this, fields);
  }
}
export const puff_steps = 5,
  puff_step_ms = 900,
  puff_duration_ms = 4500,
  dream_period_ms = 11000;
export function pick(sleepers: bigint[], period: bigint, skip: bigint | null): bigint | null {
  let best: bigint | null = null,
    bestScore = 0n;
  for (const key of sleepers) {
    if (key === skip) continue;
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(key);
    const score = Bun.hash.wyhash(bytes, period);
    if (best === null || score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}
export type Dream = { key: bigint; puff_ms: number };
export function dreamer(sleepers: bigint[], now_ms: number): { key: bigint; puff_ms: number } | null {
  const keys = sleepers,
    now = Math.max(0, now_ms),
    period = BigInt(Math.floor(now / 11000)),
    elapsed = now % 11000;
  if (elapsed >= 4500) return null;
  const previous = period > 0n && keys.length > 1 ? pick(keys, period - 1n, null) : null,
    key = pick(keys, period, previous);
  return key === null ? null : { key, puff_ms: elapsed };
}
export function puffAmount(puff_ms: number | null, col: number): number | null {
  if (puff_ms === null || puff_ms >= 4500 || col < 7) return null;
  const step = Math.floor(puff_ms / 900),
    t = Math.floor((puff_ms % 900) / 150) / 6,
    shift = t * t * (3 - 2 * t),
    amount = col - 7 === step ? (1 - shift) * (1 - step / 5) : col - 7 === step + 1 ? shift * (1 - (step + 1) / 5) : 0;
  return amount > 0 ? amount : null;
}
export function idle(width: number, sleep: Sleep | Partial<Sleep> = {}): string {
  const s = new Sleep(sleep),
    grey = s.selected ? palette.colors.muted : palette.colors.faint,
    body = s.bright || s.selected ? grey : blend(s.background, grey, 0.42),
    sprite = ["~", "ᐯ", "◡", "ᴥ", "◡", "ᐯ"];
  let out = palette.fgRgb(body);
  for (let col = 0; col < width; col++) {
    if (col < 6) out += sprite[col];
    else {
      const amount = puffAmount(s.puff_ms, col);
      out +=
        amount !== null
          ? palette.fgRgb(blend(s.background, grey, amount)) + ((col - 7) % 2 === 0 ? "ᶻ" : "z") + palette.fgRgb(body)
          : " ";
    }
  }
  return out;
}
export class Presentation {
  static reveal_duration_ms = 450;
  static reveal_feather = 3;
  playback = new Playback();
  mode: Mode = "content";
  last_corgi: { mode: Mode; at_ms: number } | null = null;
  reveal_started_ms: number | null = null;
  herd_started_ms = 0;
  update(mode: Mode, now: number) {
    this.playback.update(mode === "awake", now);
    if (mode === "herding") {
      if (this.mode !== "herding") this.herd_started_ms = now;
      this.last_corgi = null;
      this.reveal_started_ms = null;
    } else if (mode !== "content") {
      this.last_corgi = { mode, at_ms: now };
      this.reveal_started_ms = null;
    } else if (this.mode === "asleep") {
      this.last_corgi = null;
      this.reveal_started_ms = null;
    } else if (this.mode === "awake" && this.last_corgi) this.reveal_started_ms = now;
    if (this.reveal_started_ms !== null && now - this.reveal_started_ms >= 450) {
      this.reveal_started_ms = null;
      this.last_corgi = null;
    }
    this.mode = mode;
  }
  skipReveal() {
    if (this.mode === "content") {
      this.reveal_started_ms = null;
      this.last_corgi = null;
    }
  }
  revealPosition(room: number, now: number) {
    return this.reveal_started_ms === null
      ? room + 3
      : ((room + 3) * Math.max(0, Math.min(450, now - this.reveal_started_ms))) / 450;
  }
  revealedColumns(room: number, now: number) {
    return Math.min(room, Math.floor(this.revealPosition(room, now)));
  }
  writeHerding(room: number, now: number) {
    return writeHerd(room, Math.floor(Math.max(0, now - this.herd_started_ms) / 110));
  }
  writeCorgi(room: number, working: boolean, sleep: Sleep) {
    const pose = this.last_corgi;
    if (!pose) return "";
    if (pose.mode === "asleep" && !working) return idle(room, sleep);
    return palette.fg("text") + (pose.mode === "asleep" ? new Playback() : this.playback).write(room, pose.at_ms);
  }
  hide() {
    this.playback.active = false;
    this.mode = "content";
    this.last_corgi = null;
    this.reveal_started_ms = null;
  }
}
const slots = Array.from({ length: 256 }, () => ({
  key: null as bigint | null,
  seen: false,
  presentation: new Presentation(),
}));
export function beginFrame() {
  for (const slot of slots) slot.seen = false;
}
export function endFrame() {
  for (const slot of slots) if (!slot.seen) slot.presentation.hide();
}
export function observe(key: bigint, mode: Mode, now: number): Presentation | null {
  const id = key;
  let slot = slots.find(s => s.key === id);
  if (!slot) {
    if (mode === "content") return null;
    slot = slots.find(s => !s.seen && !s.presentation.last_corgi);
    if (!slot) throw Error("AnimationCapacity");
    slot.key = id;
    slot.presentation = new Presentation();
    slot.presentation.playback.random = new Random(randomBytes(8).readBigUInt64LE());
  }
  slot.seen = true;
  slot.presentation.update(mode, now);
  return slot.presentation;
}
