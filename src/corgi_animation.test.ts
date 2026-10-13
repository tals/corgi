import { test, expect } from "bun:test";
import * as a from "./corgi_animation";
import * as p from "./palette";
import * as frames from "./corgi_frames";
import { displayWidth } from "./text";
const plain = (s: string) => s.replace(/\x1b\[[^m]*m/g, "");
const len = (s: string) => [...s].length;
const windup = 16,
  react = 4;
const playback = (seed: number) => {
  const x = new a.Playback();
  x.random = new a.Random(BigInt(seed));
  return x;
};
test("the corgi perks up as the ball lands, chases it while it moves, and pauses to hold it", () => {
  const value = new a.Throw(),
    run = a.chase(18, value, 0);
  expect(a.chase(18, value, run.landed - 1).ball.y).toBeGreaterThan(0);
  expect(a.chase(18, value, run.landed).ball.y).toBe(0);
  expect(a.fetchScene(18, value, windup + run.landed).dog).toBe("~ᐯ•ᴥ•ᐯ");
  expect(a.fetchScene(18, value, windup + run.landed + 1).dog).toBe("~ᐯ•ᴥ•ᐱ");
  expect(a.fetchScene(18, value, windup + run.landed + react).dog).toBe("~[||]o>");
  expect(a.chase(18, value, run.caught - 1).ball.resting()).toBe(false);
  let tick = windup;
  while (a.fetchScene(18, value, tick).dog !== "~ᐯ•●•ᐯ") tick++;
  expect(a.fetchScene(18, value, tick - 1).dog).toBe("~[||]o●");
  for (let i = tick; i < tick + 10; i++) expect(a.fetchScene(18, value, i).dog).toBe("~ᐯ•●•ᐯ");
  expect(a.fetchScene(18, value, tick + 10).dog).toBe("●‹o[||]~");
});
test("the corgi catches the ball low at its nose, and waits beside it while it is high", () => {
  const r = new a.Random(11n);
  let waited = false;
  for (const width of [18, 26, 40])
    for (let n = 0; n < 40; n++) {
      const value = a.Throw.random(r);
      let before = a.fetchScene(width, value, windup);
      for (let tick = windup + 1; tick < a.fetchTicks(width, value); tick++) {
        const scene = a.fetchScene(width, value, tick),
          ball = before.ball!,
          reachable = (ball.dots & 0xe4) !== 0,
          nose = before.x + len(before.dog);
        if (!scene.ball) {
          expect(scene.dog).toBe("~[||]o●");
          expect(scene.x).toBe(before.x);
          expect(reachable && ball.cell === nose).toBe(true);
          break;
        }
        waited ||= before.dog === "~[||]o>" && ball.cell === nose && !reachable;
        before = scene;
      }
    }
  expect(waited).toBe(true);
});
test("every throw carries off, from lobs under the ceiling to smashes that bounce off it", () => {
  const r = new a.Random(1n);
  let under = false,
    smashed = false;
  for (let n = 0; n < 100; n++) {
    const value = a.Throw.random(r);
    expect(value.speed).toBeGreaterThanOrEqual(1);
    const ball = new a.Ball(value);
    let hits = 0,
      tick = 0;
    for (; tick < 1000 && !ball.resting(); tick++) {
      ball.step(40, 12);
      if (ball.y === 3) hits++;
    }
    expect(tick).toBeLessThan(1000);
    under ||= hits === 0;
    smashed ||= value.lift < -1 && hits >= 3;
  }
  expect(under && smashed).toBe(true);
});
test("a roll skips before it rolls, the slant kicks it up, and lights while the ball is over it", () => {
  let skipped = false,
    kicked = false;
  for (let seed = 0; seed < 30; seed++) {
    const value = new a.Throw({
      speed: 1.8,
      lift: -0.6,
      spin: -1.4,
      seed: BigInt(seed),
    });
    let landed = false;
    for (let tick = windup; tick < a.fetchTicks(26, value); tick++) {
      const ball = a.fetchScene(26, value, tick).ball;
      if (!ball) break;
      if (ball.dots & 0xc0) landed = true;
      else if (landed && ball.cell < 24) skipped = true;
      const out = a.writeFetch(26, value, tick);
      if (ball.cell === 25) {
        kicked ||= !!(ball.dots & 0x1b);
        expect(plain(out).endsWith(String.fromCodePoint(0x2800 + (0x60 | ball.dots)))).toBe(true);
        expect(out).not.toContain(p.fg("faint"));
      } else expect(out.endsWith(p.fg("faint") + "⡠" + p.fg("text"))).toBe(true);
    }
  }
  expect(skipped && kicked).toBe(true);
});
test("sleeping corgi keeps a still face and fits its width while puffing", () => {
  for (const width of [0, 1, 5, 6, 7, 8, 12, 22, 80]) {
    let puffed = false;
    for (let elapsed = 0; elapsed <= a.puff_duration_ms; elapsed += 50) {
      const text = plain(a.idle(width, new a.Sleep({ puff_ms: elapsed }))),
        letters = [...text].filter(x => x === "z" || x === "ᶻ").length;
      expect(len(text)).toBe(width);
      expect(letters).toBeLessThanOrEqual(2);
      if (elapsed === a.puff_duration_ms) expect(letters).toBe(0);
      if (width >= 6) expect(text.startsWith("~ᐯ◡ᴥ◡ᐯ")).toBe(true);
      puffed ||= letters > 0;
    }
    expect(puffed).toBe(width > 7);
  }
});
test("activities finish whole loops within budget and rest for at least ten seconds", () => {
  for (let seed = 0; seed < 100; seed++)
    for (const routine of ["sniff", "fetch", "bone"] as const) {
      const x = playback(seed);
      x.active = true;
      x.enter(routine, 100);
      const duration = x.deadline_ms - 100;
      expect(duration).toBeLessThanOrEqual(a.Playback.max_activity_ms);
      if (routine === "sniff") expect([frames.sniff.length * 200, frames.sniff.length * 400]).toContain(duration);
      x.update(true, x.deadline_ms - 1);
      expect(x.routine).toBe(routine);
      const end = x.deadline_ms;
      x.update(true, end);
      expect(x.routine).toBe("idle");
      x.update(true, end + a.Playback.minimum_idle_ms - 1);
      expect(x.routine).toBe("idle");
    }
});
test("random starts cover all routines and redraws do not reroll decisions", () => {
  const seen = new Set();
  let resumed = false,
    stayed = false;
  for (let seed = 0; seed < 100; seed++) {
    const x = playback(seed);
    x.update(true, 0);
    seen.add(x.routine);
    x.enter("idle", 0);
    x.update(true, 10000);
    resumed ||= x.routine !== "idle";
    stayed ||= x.routine === "idle";
    const sparse = playback(0);
    Object.assign(sparse, structuredClone(x));
    sparse.random = Object.assign(new a.Random(), structuredClone(x.random));
    for (let ms = 1; ms < 2000; ms++) x.update(true, 10000 + ms);
    sparse.update(true, 11999);
    expect(x).toEqual(sparse);
  }
  expect([...seen].sort()).toEqual(["bone", "fetch", "idle"]);
  expect(resumed && stayed).toBe(true);
});
test("each chance to play fetches or digs up a bone five times in a hundred", () => {
  const counts = new Map<string, number>();
  for (let roll = 0; roll < 100; roll++) {
    const routine = a.Playback.choose(roll);
    counts.set(routine, (counts.get(routine) ?? 0) + 1);
  }
  expect(Object.fromEntries(counts)).toEqual({ fetch: 5, bone: 5, idle: 90 });
});
const digging = (room: number, value: a.Bone) =>
  Array.from({ length: a.boneTicks(value.tries) + 1 }, (_, tick) => plain(a.writeBone(room, value, tick)));
test("the corgi digs up a bone, steps back to sniff it, chews it, and trots home", () => {
  const value = new a.Bone({ tries: 1, seed: 5n }),
    scenes = digging(22, value),
    at = (pattern: RegExp) => scenes.findIndex(scene => pattern.test(scene));
  for (const scene of scenes) expect(displayWidth(scene)).toBe(22);
  expect(scenes[0]).toStartWith("~ᐯ•ᴥ•ᐯ");
  expect(scenes.at(-1)!.slice(1)).toBe("ᐯ•ᴥ•ᐯ" + " ".repeat(16));
  const dug = at(/~\[(\\\/|\/\\)\]o›/),
    out = at(/ε=з/),
    sniffed = at(/ᐯ•ˑ•ᐯ  ε=з/),
    chewed = at(/ᐯ◡ᴥ◡ᐯ  =з/);
  expect(dug).toBeGreaterThan(0);
  expect(out).toBeGreaterThan(dug);
  expect(sniffed).toBeGreaterThan(out);
  expect(chewed).toBeGreaterThan(sniffed);
  expect(scenes.some(scene => scene.includes("∘"))).toBe(false);
  // The bone comes out the color of the pile behind the corgi, and the pile settles by the end.
  expect(a.writeBone(22, value, at(/ε/))).toContain(p.fgRgb(a.dirt) + "ε");
  expect(a.writeBone(22, value, out).split(p.fgRgb(a.dirt))[1]).toMatch(/^[\u2801-\u28ff]/);
  expect(a.writeBone(22, value, a.boneTicks(1))).not.toContain(p.fgRgb(a.dirt));
});
test("a second try digs past a pebble when the row has room, and every dig fits its budget", () => {
  const value = new a.Bone({ tries: 2, seed: 9n }),
    scenes = digging(22, value),
    pebble = scenes.findIndex(scene => scene.includes("∘")),
    bone = scenes.findIndex(scene => scene.includes("ε=з"));
  expect(pebble).toBeGreaterThan(0);
  expect(bone).toBeGreaterThan(pebble);
  expect(scenes.at(-1)!.slice(1, 6)).toBe("ᐯ•ᴥ•ᐯ");
  expect(a.boneTicks(2) * a.bone_tick_ms).toBeLessThanOrEqual(a.Playback.max_activity_ms);
  for (const room of [a.bone_width, a.bone_two_tries_width - 1]) {
    const narrow = digging(room, value);
    expect(narrow.some(scene => scene.includes("∘"))).toBe(false);
    expect(narrow.some(scene => scene.includes("ε=з"))).toBe(true);
    for (const scene of narrow) expect(displayWidth(scene)).toBe(room);
  }
  for (const room of [0, 1, 6, a.bone_width - 1])
    for (let tick = 0; tick < a.boneTicks(1); tick += 7)
      expect(displayWidth(plain(a.writeBone(room, value, tick)))).toBeLessThanOrEqual(room);
  const tries = new Set<number>(),
    r = new a.Random(3n);
  for (let n = 0; n < 20; n++) tries.add(a.Bone.random(r).tries);
  expect([...tries].sort()).toEqual([1, 2]);
});
test("delayed activity transition still gets a full idle rest", () => {
  const x = playback(0);
  x.active = true;
  x.enter("fetch", 0);
  x.update(true, 100000);
  expect(x.routine).toBe("idle");
  expect(x.deadline_ms).toBe(110000);
});
test("every throw fits the row, bounces off its walls, and keeps clear of the corgi", () => {
  const r = new a.Random(7n);
  for (const width of [18, 22, 40, 80, 294]) {
    let far = false,
      ceiling = false;
    const catches = new Set();
    for (let n = 0; n < 12; n++) {
      const value =
          n === 0
            ? new a.Throw({ speed: 0, lift: 0.5 })
            : n === 1
              ? new a.Throw({ speed: 2.2, lift: 0.6 })
              : n === 2
                ? new a.Throw({ speed: 1, lift: 1.6 })
                : a.Throw.random(r),
        ticks = a.fetchTicks(width, value);
      for (let tick = 0; tick < ticks; tick++) {
        const scene = a.fetchScene(width, value, tick),
          dw = len(scene.dog);
        expect(scene.x + dw).toBeLessThan(width);
        if (scene.ball) {
          expect(scene.ball.cell).toBeLessThan(width);
          expect(scene.ball.cell < scene.x || scene.ball.cell >= scene.x + dw).toBe(true);
          far ||= scene.ball.cell === width - 1;
          ceiling ||= !!(scene.ball.dots & 9);
        }
        const text = plain(a.writeFetch(width, value, tick));
        expect(len(text)).toBe(width);
        expect(/[~\-^]/.test(text)).toBe(true);
      }
      const last = a.fetchScene(width, value, ticks - 1);
      expect(last.dog).toBe("~ᐯ•ᴥ•ᐯ");
      expect(last.x === 0 && last.ball === null).toBe(true);
      catches.add(a.chase(width, value, 0).stop);
    }
    expect(far && ceiling).toBe(true);
    expect(catches.size).toBeGreaterThanOrEqual(6);
  }
});
test("each fetch throws anew and finishes within the activity budget", () => {
  const x = playback(3);
  let previous = new a.Throw();
  for (let n = 0; n < 20; n++) {
    x.enter("fetch", 0);
    expect(x.throw).not.toEqual(previous);
    previous = x.throw;
    for (const width of [18, 26, 40, 80]) {
      const text = plain(x.write(width, a.Playback.max_activity_ms - 1));
      expect(text.endsWith("⡠")).toBe(true);
      expect(text.slice(1, -1).trimEnd()).toBe("ᐯ•ᴥ•ᐯ");
    }
  }
});
test("the corgi herds the word together, sits, and curls into the ellipsis", () => {
  const cases: [number, string][] = [
    [0, "C o  mp  a ct  i n  g "],
    [7, "C o  mp  acting‹o[||]^"],
    [12, "Compacting‹o[/\\]~     "],
    [19, "Compacting -ᐯ◡ᴥ◡ᐯ     "],
    [23, "Compacting  ᐯ◡ᴥ◡ᐯ     "],
    [25, "Compacting   ◡ᴥ◡      "],
    [27, "Compacting •.•        "],
    [29, "Compacting…           "],
    [1000, "Compacting…           "],
  ];
  for (const [tick, text] of cases) expect(plain(a.writeHerd(22, tick))).toBe(text);
  expect(
    a
      .writeHerd(22, 7)
      .startsWith(p.fg("text") + "C " + p.fg("faint") + "o  mp  a" + p.fg("text") + "cting" + p.fg("faint") + "‹o"),
  ).toBe(true);
  expect(a.writeHerd(22, 29)).toBe(p.fg("text") + "Compacting…" + " ".repeat(11));
});
test("herding fits every width with letters in order and clear of the corgi", () => {
  for (const width of [18, 19, 22, 40, 80, 294]) {
    let packed = false,
      scattered = false,
      out = "";
    for (let step = 0; step < width + 30; step++) {
      const scene = a.herdScene(width, step),
        dw = len(scene.dog);
      for (let i = 0; i < scene.letters.length; i++) {
        const at = scene.letters[i];
        if (i) expect(at).toBeGreaterThan(scene.letters[i - 1]);
        expect(at < scene.x || at >= scene.x + dw).toBe(true);
      }
      expect(scene.letters.at(-1)!).toBeLessThanOrEqual(width - 2);
      packed ||= scene.letters.at(-1) === 9;
      scattered ||= scene.letters.at(-1) === width - 2;
      out = a.writeHerd(width, step);
      expect(len(plain(out))).toBe(width);
    }
    expect(packed && scattered).toBe(true);
    expect(out.startsWith(p.fg("text") + "Compacting…")).toBe(true);
  }
});
test("each compaction herds from the start and ends without a reveal", () => {
  const x = new a.Presentation();
  x.update("awake", 0);
  x.update("herding", 100);
  expect(x.herd_started_ms).toBe(100);
  expect(x.last_corgi).toBeNull();
  x.update("herding", 500);
  expect(x.herd_started_ms).toBe(100);
  x.update("content", 600);
  expect(x.reveal_started_ms).toBeNull();
  x.update("herding", 700);
  expect(x.herd_started_ms).toBe(700);
});
const blend = (amount: number) => p.colors.bg.map((v, i) => Math.round(v + (p.colors.faint[i] - v) * amount)) as p.Rgb;
test("a puff starts lit, fades as it rises, and seen sleepers are dim", () => {
  const lit = a.idle(22, new a.Sleep({ bright: true, puff_ms: 0 }));
  expect(lit.startsWith(p.fg("faint") + "~ᐯ◡ᴥ◡ᐯ")).toBe(true);
  expect(lit).toContain(p.fg("faint") + "ᶻ");
  const half = a.idle(22, new a.Sleep({ puff_ms: 450 }));
  expect(half).toContain(p.fgRgb(blend(0.5)) + "ᶻ");
  expect(half).toContain(p.fgRgb(blend(0.4)) + "z");
  expect(a.idle(22, new a.Sleep({ puff_ms: 2700 }))).toContain(p.fgRgb(blend(0.4)) + "z");
  expect(a.idle(22)).toBe(p.fgRgb(blend(0.42)) + "~ᐯ◡ᴥ◡ᐯ" + " ".repeat(16));
});
test("the corgi is gray: faint awake or asleep, muted asleep on a selected row", () => {
  const x = new a.Presentation();
  x.update("awake", 0);
  expect(x.writeCorgi(20, 0, true, new a.Sleep()).startsWith(p.fg("faint"))).toBe(true);
  expect(a.idle(6, new a.Sleep({ bright: true }))).toBe(p.fg("faint") + "~ᐯ◡ᴥ◡ᐯ");
  expect(a.idle(6, new a.Sleep({ background: p.colors.selected, selected: true }))).toBe(p.fg("muted") + "~ᐯ◡ᴥ◡ᐯ");
  const out = a.writeUnearth(a.Dig.width("restoring"), 3000, "restoring");
  expect(out).toContain(p.fg("accent") + "Restoring…");
  expect(out).toContain(p.fg("faint") + "ᐯ•ᴥ•ᐯ~");
});
test("one sleeper dreams per period, holds through its puff, and rarely repeats", () => {
  expect(a.dreamer([], 0)).toBeNull();
  const keys = [17n, 34n, 51n, 68n, 85n, 102n, 119n, 136n, 153n],
    seen = new Set();
  let previous: bigint | null = null,
    repeats = 0;
  for (let period = 1; period < 300; period++) {
    const start = period * a.dream_period_ms,
      dream = a.dreamer(keys, start + 100)!;
    expect(dream.puff_ms).toBe(100);
    expect(a.dreamer(keys, start + 4499)!.key).toBe(dream.key);
    expect(a.dreamer(keys, start + 4500)).toBeNull();
    const top = a.pick(keys, BigInt(period - 1), null);
    let woke = false;
    const awake = keys.filter(key => {
      if (!woke && key !== dream.key && key !== top) {
        woke = true;
        return false;
      }
      return true;
    });
    expect(a.dreamer(awake, start + 100)!.key).toBe(dream.key);
    seen.add(dream.key);
    if (previous === dream.key) repeats++;
    previous = dream.key;
  }
  expect(seen.size).toBe(keys.length);
  expect(repeats).toBeLessThan(15);
  for (let period = 0; period < 5; period++) expect(a.dreamer([7n], period * a.dream_period_ms)!.key).toBe(7n);
});

test("sidebar intensity dims non-fetch corgis on the row background and zero hides fetch too", () => {
  const x = new a.Presentation();
  x.update("awake", 0);
  x.playback.enter("idle", 0);
  for (const background of [p.colors.bg, p.colors.selected, p.colors.surface]) {
    const sleep = new a.Sleep({ background });
    expect(a.intensityColor(background, 0)).toEqual(background);
    expect(a.intensityColor(background, 50)).toEqual(p.colors.faint);
    expect(a.intensityColor(background, 100)).toEqual(p.colors.text);
    sleep.intensity = 25;
    expect(x.writeCorgi(20, 0, true, sleep)).toStartWith(p.fgRgb(a.intensityColor(background, 25)));
    sleep.intensity = 100;
    expect(x.writeCorgi(20, 0, true, sleep)).toStartWith(p.fg("text"));
    sleep.intensity = 0;
    expect(x.writeCorgi(20, 0, true, sleep)).toBe("");
    expect(a.idle(20, sleep)).not.toContain("ᐯ");
  }
  x.playback.enter("bone", 0);
  expect(x.writeCorgi(20, 0, true, new a.Sleep({ intensity: 5 }))).toStartWith(p.fg("text"));
  x.playback.enter("fetch", 0);
  expect(x.writeCorgi(20, 0, true, new a.Sleep({ intensity: 5 }))).toStartWith(p.fg("text"));
  expect(x.writeCorgi(20, 0, true, new a.Sleep({ intensity: 100 }))).toStartWith(p.fg("text"));
  expect(x.writeCorgi(20, 0, true, new a.Sleep({ intensity: 0 }))).toBe("");
});
test("content reveal paints over a corgi that keeps playing and cancels when a corgi returns", () => {
  const x = new a.Presentation();
  x.update("asleep", 0);
  x.update("content", 50);
  expect(x.last_corgi).toBeNull();
  expect(x.reveal_started_ms).toBeNull();
  expect(x.revealedColumns(20, 50)).toBe(20);
  x.update("awake", 100);
  x.playback.enter("idle", 100);
  x.update("content", 200);
  expect(x.last_corgi).toBe("awake");
  expect(x.revealedColumns(20, 200)).toBe(0);
  expect(x.writeCorgi(20, 200, true, new a.Sleep())).toEndWith(frames.wag[0]);
  expect(x.writeCorgi(20, 300, true, new a.Sleep())).toEndWith(frames.wag[1]);
  x.update("content", 425);
  expect(x.revealedColumns(20, 425)).toBe(11);
  expect(x.revealedColumns(40, 425)).toBe(21);
  x.update("awake", 430);
  expect(x.reveal_started_ms).toBeNull();
  expect(x.last_corgi).toBe("awake");
  x.update("content", 500);
  x.update("content", 950);
  expect(x.last_corgi).toBeNull();
  expect(x.reveal_started_ms).toBeNull();
  x.update("awake", 1000);
  x.update("content", 1010);
  x.skipReveal();
  expect(x.last_corgi).toBeNull();
  expect(x.reveal_started_ms).toBeNull();
  x.update("awake", 1020);
  x.update("content", 1030);
  x.update("asleep", 1040);
  expect(x.reveal_started_ms).toBeNull();
  expect(x.last_corgi).toBe("asleep");
  x.hide();
  x.update("content", 1100);
  expect(x.reveal_started_ms).toBeNull();
});
test("the corgi digs the word out from the left, then turns and wags", () => {
  for (const [ms, text] of [
    [0, "        ⠄~[\\/]o› ⣤⣿⣷⣾⣿⣶⣷⣿⣾⣶"],
    [700, "⣀⣀  ⠂ ⠁ ⠄~[\\/]o› Rest⣤⣶⣷⣿⣾⣶"],
    [1700, "⣤⣶⣤⣤ ⠁   ~[/\\]o› Restoring…"],
    [3000, "⣶⣶⣤⣤      ᐯ•ᴥ•ᐯ~ Restoring…"],
  ] as [number, string][])
    expect(plain(a.writeUnearth(a.Dig.width("restoring"), ms, "restoring"))).toBe(text);
  expect(a.writeUnearth(a.Dig.width("restoring"), 700, "restoring")).toContain(p.fg("accent") + "Res");
  expect(plain(a.writeUnearth(a.Dig.width("restoring") - 1, 0, "restoring"))).toBe("Restoring…");
});
test("a fork's corgi digs out its own, shorter word", () => {
  for (const [ms, text] of [
    [0, "        ⠄~[\\/]o› ⣤⣿⣷⣾⣿⣶⣷⣿"],
    [3000, "⣤⣤⣤⣤      ᐯ•ᴥ•ᐯ~ Forking…"],
  ] as [number, string][])
    expect(plain(a.writeUnearth(a.Dig.width("forking"), ms, "forking"))).toBe(text);
  expect(plain(a.writeUnearth(a.Dig.width("forking") - 1, 0, "forking"))).toBe("Forking…");
});
