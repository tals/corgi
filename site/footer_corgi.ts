/**
 * The footer's sleeper, who wakes when tapped: he peeks with one eye, perks
 * up, wags, spins three turns scooting side to side, blows a heart, winds
 * down, yawns and naps again. Corgi's own sprites and puffs, as one row.
 */
import * as corgiAnimation from "../src/corgi_animation";
import * as palette from "../src/palette";

/** Cells he scoots each way while spinning. */
export const sway = 3;
/** The row: room to scoot left of his sleeping tail, then the sleeper's 16. */
export const width = sway + 16;

type Frame = { pose: string; ms: number; x: number; intensity: number; start: number };

const face = (tail = "~", eyes = "••", ears = "ᐯᐯ", nose = "ᴥ") => tail + ears[0] + eyes[0] + nose + eyes[1] + ears[1];
const right = (tail = "~", legs = "||") => `${tail}[${legs}]o>`;
const left = (tail = "~", legs = "||") => `‹o[${legs}]${tail}`;
const back = " ᐯ ~ ᐯ";
const asleep = face("~", "◡◡");
const tails = ["~", "-", "~", "^"];
const legs = ["/\\", "||", "\\/", "||"];

/** Brightness on the sidebar's scale: 21 is the sleeper's gray, 50 awake, 100 as bright as fetch. */
const dim = (awake: number) => (awake <= 0.5 ? 21 + awake * 58 : 50 + (awake - 0.5) * 100);

class Routine {
  frames: Frame[] = [];
  /** When he blows the heart. */
  heart_ms = 0;
  /** Where a tap while he's up starts over: the wag, not the waking. */
  again_ms = 0;
  t = 0;
  add(pose: string, ms: number, awake: number, x = 0) {
    this.frames.push({ pose, ms, x, intensity: dim(awake), start: this.t });
    this.t += ms;
    return this;
  }
  wag(n: number, ms: number, from: number, to = from, look = (tail: string) => face(tail)) {
    for (let i = 0; i < n; i++) this.add(look(tails[i % 4]), ms, from + ((to - from) * i) / Math.max(1, n - 1));
    return this;
  }
  /** One turn of the spin, scooting the way he faces: right while facing right, left while facing left. */
  turn(from: number, to: number) {
    const run = (pose: typeof right, a: number, b: number) => {
      const d = Math.sign(b - a);
      for (let x = a, i = 0; x !== b + d; x += d, i++)
        this.add(pose(["~", "~", "-", "-"][i % 4], legs[i % 4]), 60, 1, x);
    };
    if (to > from) {
      run(right, from, to);
      this.add(back, 100, 1, to).add(left("^"), 100, 1, to);
    } else {
      this.add(right(), 100, 1, from).add(back, 100, 1, from);
      run(left, from, to);
    }
    return this.add(face("~", "••", "ᐱᐱ"), 100, 1, to);
  }
}

const routine = new Routine()
  .add(face("~", "◡◡", "ᐯᐱ"), 160, 0.1)
  .add(asleep, 120, 0.15)
  .add(face("~", "-•"), 750, 0.4)
  .add(face(), 220, 0.6)
  .add(face("~", "••", "ᐱᐱ"), 280, 1);
routine.again_ms = routine.t;
routine
  .wag(6, 85, 1, 1, tail => face(tail, "◡◡", "ᐱᐱ"))
  .turn(0, sway)
  .turn(sway, -sway)
  .turn(-sway, 0)
  .add(face("~", "••", "ᐱᐱ", "з"), 180, 1);
routine.heart_ms = routine.t;
routine
  .add(face("~", "••", "ᐱᐱ", "з"), 220, 1)
  .add(face("^", "••", "ᐱᐱ"), 160, 1)
  .wag(6, 90, 1)
  .wag(5, 160, 0.85, 0.6)
  .wag(3, 260, 0.55, 0.5)
  .add(face("~", "--"), 350, 0.45)
  .add(face("~", "◡◡", "ᐯᐯ", "o"), 220, 0.45)
  .add(face("~", "◡◡", "ᐯᐯ", "O"), 650, 0.45)
  .add(face("~", "◡◡", "ᐯᐯ", "o"), 200, 0.4)
  .add(face("~", "--"), 400, 0.35)
  .add(asleep, 400, 0.3);

export const frames: readonly Frame[] = routine.frames;
export const duration_ms = routine.t;
/** The heart drifts along the zzz's cells, gone in this long. */
const heart_drift_ms = 1700;

export class Wake {
  started_ms: number | null = null;
  tap(now: number) {
    if (!this.awake(now)) this.started_ms = now;
    else if (now - this.started_ms! > routine.again_ms) this.started_ms = now - routine.again_ms;
  }
  awake(now: number) {
    return this.started_ms !== null && now - this.started_ms < duration_ms;
  }
  /** The row at `now`, or asleep and dreamless when there's no clock (reduced motion). */
  write(now: number | null): string {
    if (now !== null && this.awake(now)) return writeAwake(now - this.started_ms!);
    // Until he's first woken he dreams on the page's schedule; after a nap, within a second.
    const since =
      now === null ? null : this.started_ms === null ? now + 3500 : now - this.started_ms - duration_ms - 700;
    const dream = since === null || since < 0 ? null : corgiAnimation.dreamer([0n], since);
    return " ".repeat(sway) + corgiAnimation.idle(16, new corgiAnimation.Sleep({ puff_ms: dream?.puff_ms ?? null }));
  }
}

function writeAwake(elapsed: number): string {
  const frame = frames.find(f => elapsed < f.start + f.ms) ?? frames[frames.length - 1];
  const bg = palette.colors.bg;
  const cells: [string, palette.Rgb][] = Array.from({ length: width }, () => [" ", bg]);
  const body = corgiAnimation.intensityColor(bg, frame.intensity);
  [...frame.pose].forEach((ch, i) => {
    const col = sway + frame.x + i;
    if (ch !== " " && col >= 0 && col < width) cells[col] = [ch, body];
  });
  const heart = elapsed - routine.heart_ms;
  if (heart >= 0 && heart < heart_drift_ms)
    for (let col = 7; col < 13; col++) {
      const amount = corgiAnimation.puffAmount((heart * 4500) / heart_drift_ms, col);
      if (amount !== null && cells[sway + col][0] === " ")
        cells[sway + col] = ["♥︎", corgiAnimation.intensityColor(bg, 45 * amount, palette.colors.hot)];
    }
  return cells.map(([ch, color]) => (ch === " " ? " " : palette.fgRgb(color) + ch)).join("");
}
