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
/** Digging up a bone: a mound fades in ahead, and the corgi trots over and
 * digs it away a dot at a time, throwing each clod onto a pile behind it. The
 * bone comes out dirt-colored; the corgi steps back, sniffs it, chews it
 * down, and trots home while the pile settles. On a second try the first
 * mound holds only a pebble, and another fades in further along. */
export const bone_tick_ms = 40,
  bone_width = 16,
  bone_two_tries_width = 22;
export class Bone {
  tries: 1 | 2 = 1;
  seed = 0n;
  constructor(fields: Partial<Bone> = {}) {
    Object.assign(this, fields);
  }
  static random(r: Random) {
    return new Bone({ tries: r.boolean() ? 2 : 1, seed: r.next() });
  }
}
type Find = { x: number; bone: boolean; glyphs: string[]; revealed: (number | null)[]; eaten: number; shown: boolean };
type Mound = { dot: number; heights: number[]; born: number; find: Find };
type Beat = [ticks: number, pose: string, wag?: number];
/** The row as dot columns: the settled pile, mounds, clods in flight, and the corgi. */
class Ground {
  pile: number[];
  mounds: Mound[] = [];
  clods: { x: number; y: number; vx: number; vy: number }[] = [];
  dog = { x: 0, pose: "~ᐯ•ᴥ•ᐯ", wag: 0 };
  tick = 0;
  dust = 0;
  constructor(
    room: number,
    readonly random: Random,
  ) {
    this.pile = Array(room * 2).fill(0);
  }
  pose(x: number, pose: string, wag = 0) {
    this.dog = { x, pose, wag };
  }
  bury(x: number, bone: boolean): Mound {
    const find: Find = {
      x,
      bone,
      glyphs: bone ? ["ε", "=", "з"] : [" ", "∘", " "],
      revealed: [null, null, null],
      eaten: 0,
      shown: true,
    };
    const mound = { dot: 2 * x, heights: [1, 2, 3, 3, 2, 1], born: this.tick, find };
    this.mounds.push(mound);
    return mound;
  }
  /** One stroke: the dot nearest the nose flies off behind the corgi. */
  dig(mound: Mound, from: number): boolean {
    const i = mound.heights.findIndex(h => h > 0);
    if (i < 0) return false;
    mound.heights[i]--;
    const r = this.random;
    this.clods.push({ x: from, y: 0.6, vx: -(0.45 + r.float() * 0.5), vy: 0.8 + r.float() * 0.5 });
    const cell = i >> 1;
    if (mound.heights[2 * cell] + mound.heights[2 * cell + 1] === 0) mound.find.revealed[cell] ??= this.tick;
    return true;
  }
  step() {
    for (const clod of this.clods) {
      clod.x += clod.vx;
      clod.y += clod.vy;
      clod.vy -= 0.3;
    }
    this.clods = this.clods.filter(clod => {
      if (clod.y > 0) return clod.x > -2;
      const at = Math.round(clod.x);
      if (at >= 0 && at < this.pile.length) this.settle(at);
      return false;
    });
  }
  /** A landed clod rolls downhill until the slope holds it. */
  settle(at: number) {
    const p = this.pile;
    for (;;) {
      const height = p[at] + 1,
        left = at > 0 ? p[at - 1] : Infinity,
        right = at < p.length - 1 ? p[at + 1] : Infinity,
        low = Math.min(left, right);
      if (height <= 4 && height - low <= 1) {
        p[at] = height;
        return;
      }
      if (low >= p[at]) return;
      at = left < right ? at - 1 : right < left ? at + 1 : this.random.boolean() ? at - 1 : at + 1;
    }
  }
}
function* beats(ground: Ground, x: number, list: Beat[]) {
  for (const [ticks, pose, wag] of list)
    for (let i = 0; i < ticks; i++) {
      ground.pose(x, pose, wag);
      yield;
    }
}
function* trot(ground: Ground, from: number, to: number) {
  for (let x = from; x <= to; x++) yield* beats(ground, x, [[2, gait_right[x % 4], 1]]);
}
/** Nose against the mound, paws flickering, until the mound is gone. */
function* digOut(ground: Ground, mound: Mound, x: number) {
  for (let k = 0; k % 2 !== 0 || ground.dig(mound, 2 * x - 1); k++) {
    ground.pose(x, k % 4 < 2 ? "~[\\/]o›" : "~[/\\]o›");
    yield;
  }
  yield* beats(ground, x, [[2, "~[||]o›"]]);
}
/** Two cells back from the bone: perks up, sniffs it, chews it down, and trots home. */
function* eat(ground: Ground, find: Find) {
  const x = find.x - 8;
  yield* beats(ground, x, [
    [6, "~ᐱ•ᴥ•ᐱ", 2],
    [3, "~ᐯ•ω•ᐯ"],
    [2, "~ᐯ•ˑ•ᐯ"],
    [3, "~ᐯ•ω•ᐯ"],
    [3, "~ᐯ•ˑ•ᐯ"],
    [4, "~ᐯ◡ᴥ◡ᐯ", 2],
  ]);
  for (let k = 0; k < 24; k++) {
    ground.pose(x, k % 6 < 3 ? "~ᐯ◡ω◡ᐯ" : "~ᐯ◡ᴥ◡ᐯ", 1);
    find.eaten = Math.min(3, Math.floor((k + 2) / 6));
    ground.dust = Math.min(1, k / 40);
    yield;
  }
  find.shown = false;
  for (let at = x; at >= 0; at--)
    for (let i = 0; i < 2; i++) {
      ground.pose(at, walk_left[at % 4], 1);
      ground.dust = Math.min(1, ground.dust + 0.04);
      yield;
    }
  ground.dust = 1;
  yield* beats(ground, 0, [
    [3, "~ᐯ◡ᴥ◡ᐯ", 1],
    [3, "~ᐯ•ᴥ•ᐯ", 1],
  ]);
}
function* digUp(ground: Ground, tries: 1 | 2) {
  const first = ground.bury(13, tries === 1);
  yield* beats(ground, 0, [
    [3, "~ᐯ•ᴥ•ᐯ"],
    [3, "~ᐯ•ω•ᐯ"],
    [2, "~ᐯ•ˑ•ᐯ"],
    [2, "~ᐯ•ω•ᐯ"],
    [4, "~ᐱ•ᴥ•ᐱ", 2],
  ]);
  yield* trot(ground, 0, 6);
  yield* digOut(ground, first, 6);
  if (tries === 1) return yield* eat(ground, first.find);
  yield* beats(ground, 6, [
    [9, "~ᐯ•ᴥ•ᐱ"],
    [3, "~ᐯ•ω•ᐯ"],
    [2, "~ᐯ•ˑ•ᐯ"],
  ]);
  const second = ground.bury(19, true);
  yield* beats(ground, 6, [
    [3, "~ᐯ•ω•ᐯ"],
    [4, "~ᐱ•ᴥ•ᐱ", 2],
  ]);
  yield* trot(ground, 6, 12);
  yield* digOut(ground, second, 12);
  yield* eat(ground, second.find);
}
const bone_runs = new Map<number, number>();
/** Ticks until the corgi is back home; it then sits and wags. */
export function boneTicks(tries: 1 | 2): number {
  let ticks = bone_runs.get(tries);
  if (ticks === undefined) {
    const ground = new Ground(bone_two_tries_width, new Random()),
      run = digUp(ground, tries);
    for (ticks = 0; !run.next().done; ticks++) {
      ground.tick = ticks + 1;
      ground.step();
    }
    bone_runs.set(tries, ticks);
  }
  return ticks;
}
/** A dig `tick` ticks in. Rows too narrow for a second mound dig once. */
export function boneScene(room: number, value: Bone, tick: number): Ground {
  const ground = new Ground(room, new Random(value.seed)),
    run = digUp(ground, room >= bone_two_tries_width ? value.tries : 1);
  for (let t = 0; t <= tick; t++) {
    ground.tick = t;
    run.next();
    ground.step();
  }
  return ground;
}
export function writeBone(room: number, value: Bone, tick: number, background = palette.colors.bg): string {
  if (room < bone_width) {
    const run = boneTicks(1),
      phase = Math.floor((Math.min(tick, run - 1) * 4) / run);
    return (
      (room > 0 ? wagTail(Math.floor(tick / 4)) : "") + frame(room - 1, ["ᐯ•ω•ᐯ", "ᐯ•ᴥ•ᐱ", "ᐯ◡ω◡ᐯ", "ᐯ•ᴥ•ᐯ"][phase])
    );
  }
  const ground = boneScene(room, value, tick),
    text = palette.colors.text,
    cells = Array.from({ length: room }, () => ({ glyph: " ", color: text })),
    pile: number[] = Array(room).fill(0),
    mound: number[] = Array(room).fill(0),
    clods: number[] = Array(room).fill(0),
    risen: number[] = Array(room).fill(1);
  const unearthed = (age: number) => (age < 2 ? dirt : age < 4 ? blend(dirt, text, 0.5) : text);
  const raise = (into: number[], dot: number, height: number) => {
    for (let row = 0; row < Math.min(4, height); row++) into[dot >> 1] |= dots[dot & 1][row];
  };
  ground.pile.forEach((height, dot) => raise(pile, dot, height));
  for (const m of ground.mounds)
    m.heights.forEach((height, i) => {
      if (height === 0) return;
      raise(mound, m.dot + i, height);
      risen[(m.dot + i) >> 1] = Math.min(1, (ground.tick - m.born + 1) / 8);
    });
  for (const clod of ground.clods) {
    const dot = Math.round(clod.x);
    if (dot >= 0 && dot < 2 * room) clods[dot >> 1] |= dots[dot & 1][Math.max(0, Math.min(3, Math.round(clod.y)))];
  }
  const settled = 1 - ground.dust;
  for (let i = 0; i < room; i++) {
    const bits = pile[i] | mound[i] | clods[i];
    if (bits === 0) continue;
    const amount = mound[i] ? risen[i] * settled : pile[i] ? settled : 1;
    cells[i] = { glyph: String.fromCodePoint(0x2800 + bits), color: blend(background, dirt, amount) };
  }
  for (const { find } of ground.mounds) {
    if (!find.shown) continue;
    find.glyphs.slice(find.eaten).forEach((glyph, k) => {
      const at = find.revealed[find.eaten + k];
      if (glyph === " " || at === null) return;
      const age = ground.tick - at;
      cells[find.x + k] = {
        glyph,
        color: find.bone ? unearthed(age) : blend(background, age < 2 ? dirt : palette.colors.faint, settled),
      };
    });
  }
  const { x, pose, wag } = ground.dog;
  [...pose].forEach((glyph, j) => {
    if (x + j < 0 || x + j >= room) return;
    cells[x + j] = {
      glyph: glyph === "~" && wag ? wagTail(Math.floor(ground.tick / (wag === 2 ? 2 : 4))) : glyph,
      color: text,
    };
  });
  let color: palette.Rgb | null = null;
  let out = "";
  for (const cell of cells) {
    if (cell.glyph !== " " && (color === null || cell.color.some((v, i) => v !== color![i]))) {
      color = cell.color;
      out += palette.fgRgb(color);
    }
    out += cell.glyph;
  }
  return out;
}
export type Routine = "idle" | "sniff" | "fetch" | "bone";
export class Playback {
  static minimum_idle_ms = 10000;
  static retry_ms = 2000;
  /** Out of 100 at each chance to play; the rest stay idle. Sniff is out of the rotation for now. */
  static odds: [Routine, number][] = [
    ["fetch", 5],
    ["bone", 5],
  ];
  static max_activity_ms = 9600;
  active = false;
  routine: Routine = "idle";
  started_ms = 0;
  deadline_ms = 0;
  random = new Random();
  throw = new Throw();
  bone = new Bone();
  static choose(roll: number): Routine {
    for (const [routine, percent] of Playback.odds) {
      if (roll < percent) return routine;
      roll -= percent;
    }
    return "idle";
  }
  enter(routine: Routine, now: number) {
    this.routine = routine;
    this.started_ms = now;
    if (routine === "fetch") this.throw = Throw.random(this.random);
    if (routine === "bone") this.bone = Bone.random(this.random);
    this.deadline_ms = now + this.duration(routine);
  }
  private duration(routine: Routine): number {
    switch (routine) {
      case "idle":
        return Playback.minimum_idle_ms;
      case "sniff":
        return (1 + this.random.int(2)) * frames.sniff.length * 200;
      case "fetch":
        return Playback.max_activity_ms;
      case "bone":
        return boneTicks(this.bone.tries) * bone_tick_ms;
    }
  }
  update(active: boolean, now: number) {
    const before = this.active;
    this.active = active;
    if (!active) return;
    if (!before) {
      this.enter(Playback.choose(this.random.float() * 100), now);
      return;
    }
    if (now < this.deadline_ms) return;
    if (this.routine !== "idle") this.enter("idle", now);
    else {
      const routine = Playback.choose(this.random.int(100));
      if (routine === "idle") this.deadline_ms = now + Playback.retry_ms;
      else this.enter(routine, now);
    }
  }
  write(room: number, now: number, background = palette.colors.bg): string {
    const elapsed = Math.max(0, now - this.started_ms);
    if (this.routine === "idle") return frame(room, frames.wag[Math.floor(elapsed / 200) % frames.wag.length]);
    if (this.routine === "sniff") return frame(room, frames.sniff[Math.floor(elapsed / 200) % frames.sniff.length]);
    if (this.routine === "bone") return writeBone(room, this.bone, Math.floor(elapsed / bone_tick_ms), background);
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
      palette.fg(at !== null ? "text" : "faint") +
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
      finished: false,
    };
  }
  const p = step - roundup,
    pose = p >= 10 ? curl[Math.min(p - 10, curl.length - 1)] : null;
  return {
    letters: Array.from({ length: 10 }, (_, i) => i),
    lit: Array(10).fill(true),
    dog: pose?.pose ?? (p === 6 ? "~ᐯ◡ᴥ◡ᐯ" : "~ᐯ•ᴥ•ᐯ"),
    x: pose ? 10 + pose.after : 11,
    finished: p >= 10 + curl.length - 1,
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
      out += tint(scene.finished ? "text" : "faint") + (glyph === "~" ? wagTail(Math.floor(step / 2)) : glyph);
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
      color: palette.colors.faint,
      bold: false,
    };
    dog = step - dug < 5 ? "ᐱ•ᴥ•ᐱ" : "ᐯ•ᴥ•ᐯ";
  }
  for (const glyph of dog) cells[col++] = { glyph, color: palette.colors.faint, bold: false };
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
  intensity = 50;
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
  const s = new Sleep(sleep);
  if (s.intensity === 0) return " ".repeat(width);
  const grey = intensityColor(s.background, s.intensity, s.selected ? palette.colors.muted : palette.colors.faint),
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
/** Brightness on the row's actual background; 50 preserves today's gray. */
export function intensityColor(background: palette.Rgb, intensity: number, normal = palette.colors.faint): palette.Rgb {
  return intensity <= 50
    ? blend(background, normal, intensity / 50)
    : blend(normal, palette.colors.text, (intensity - 50) / 50);
}
/** The setup preview's uninterrupted idle loop, with the sidebar's brightness. */
export function writeWag(room: number, now: number, intensity: number, background = palette.colors.bg): string {
  if (intensity === 0) return " ".repeat(room);
  return (
    palette.fgRgb(intensityColor(background, intensity)) +
    frame(room, frames.wag[Math.floor(Math.max(0, now) / 200) % frames.wag.length])
  );
}
export class Presentation {
  static reveal_duration_ms = 450;
  static reveal_feather = 3;
  playback = new Playback();
  mode: Mode = "content";
  last_corgi: Mode | null = null;
  reveal_started_ms: number | null = null;
  herd_started_ms = 0;
  update(mode: Mode, now: number) {
    this.playback.update(mode === "awake", now);
    if (mode === "herding") {
      if (this.mode !== "herding") this.herd_started_ms = now;
      this.last_corgi = null;
      this.reveal_started_ms = null;
    } else if (mode !== "content") {
      this.last_corgi = mode;
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
    return writeHerd(room, this.herdStep(now));
  }
  /** Whether the corgi has curled into the ellipsis, leaving the row past it free. */
  herded(room: number, now: number) {
    // Rounding up takes room - 9 steps, sitting 10, then the curl.
    return this.herdStep(now) >= room - 9 + 10 + curl.length - 1;
  }
  private herdStep(now: number) {
    return Math.floor(Math.max(0, now - this.herd_started_ms) / 110);
  }
  /** A reveal paints over the corgi while it keeps playing. */
  writeCorgi(room: number, now: number, working: boolean, sleep: Sleep) {
    const pose = this.last_corgi;
    if (!pose || sleep.intensity === 0) return "";
    if (pose === "asleep" && !working) return idle(room, sleep);
    const playback = pose === "asleep" ? new Playback() : this.playback;
    const playful = playback.routine === "fetch" || playback.routine === "bone";
    const color = playful ? palette.colors.text : intensityColor(sleep.background, sleep.intensity);
    return palette.fgRgb(color) + playback.write(room, now, sleep.background);
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
