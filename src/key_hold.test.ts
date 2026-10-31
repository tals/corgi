import { expect, test } from "bun:test";
import { KeyHold, Spring, repeat_gap_ms } from "./key_hold";

test("a spring swings back past the start after a release, then rests there", () => {
  const s = new Spring({ omega: 18, zeta: 0.55 });
  let now = 1000;
  for (; now < 2000; now += 16) s.step(0.5, now);
  expect(s.x).toBe(0.5);
  let lowest = 1;
  let moving = true;
  for (; moving && now < 4000; now += 16) {
    moving = s.step(0, now);
    lowest = Math.min(lowest, s.x);
  }
  expect(lowest).toBeLessThan(-0.05);
  expect(moving).toBe(false);
  expect(s.x).toBe(0);
});

test("a stiff spring keeps up with a moving target, and stops with it", () => {
  const s = new Spring({ omega: 18, zeta: 0.55 });
  const held = { omega: 120, zeta: 1 };
  let now = 0;
  for (; now <= 120; now += 16) s.step(now / 800, now, held);
  // Within a few cells of where the hold is.
  expect(120 / 800 - s.x).toBeLessThan(0.05);
  let highest = s.x;
  for (; now <= 400; now += 16) {
    s.step(120 / 800, now, held);
    highest = Math.max(highest, s.x);
  }
  expect(highest).toBeLessThanOrEqual(120 / 800 + 0.002);
});

test("the same moments draw the same, however the frames fall", () => {
  const a = new Spring({ omega: 18, zeta: 0.55 }),
    b = new Spring({ omega: 18, zeta: 0.55 });
  a.step(1, 0);
  b.step(1, 0);
  for (let now = 16; now <= 320; now += 16) a.step(1, now);
  for (let now = 32; now <= 320; now += 32) b.step(1, now);
  expect(a.x).toBe(b.x);
});

test("a hold with shorter gaps notices a tap's release sooner, once it knows the repeat delay", () => {
  const quick = new KeyHold(800, 220, 150, 80, true),
    shared = new KeyHold(800, 220, repeat_gap_ms, repeat_gap_ms, true);
  for (const hold of [quick, shared]) {
    hold.press(0);
    hold.press(400);
    hold.reset();
    hold.press(5000);
  }
  expect(quick.held(5470)).toBe(true);
  expect(quick.held(5500)).toBe(false);
  expect(shared.held(5500)).toBe(true);
  expect(shared.held(5700)).toBe(false);
  // Without patience, the assumed delay stands in from the first press.
  const eager = new KeyHold(800, 220, 150, 80);
  eager.press(0);
  expect(eager.held(470)).toBe(true);
  expect(eager.held(500)).toBe(false);
});

test("the first repeat may come late while the host's delay is unknown", () => {
  const hold = new KeyHold(1500, 220, 150, 80, true);
  hold.press(0);
  hold.advance(600);
  expect(hold.held(600)).toBe(true);
  hold.press(660);
  expect(hold.progress).toBeCloseTo(660 / 1500, 5);
  // A tap's release shows only after the longest delay a host might use.
  const tap = new KeyHold(1500, 220, 150, 80, true);
  tap.press(0);
  expect(tap.held(1000)).toBe(true);
  expect(tap.held(1001)).toBe(false);
});

test("repeats at the release boundary stay quiet until the key is let go", () => {
  const hold = new KeyHold(1500, 400);
  hold.press(0);
  expect(hold.active).toBe(true);
  hold.quiet(1000);
  hold.reset();
  for (let now = 1250; now <= 5000; now += 250) {
    expect(hold.press(now)).toBe(false);
    expect(hold.active).toBe(false);
  }
  hold.press(5251);
  expect(hold.active).toBe(true);
});

test("slack keeps a hold through repeats a slow link delivers late", () => {
  const strict = new KeyHold(800, 220, 150, 80),
    slow = new KeyHold(800, 220, 150, 80);
  slow.slack = 300;
  for (const hold of [strict, slow]) {
    hold.press(0);
    hold.press(400);
    hold.press(430);
  }
  // A stall of 400 ms, then the held-back repeats arrive together.
  expect(strict.held(830)).toBe(false);
  expect(slow.held(830)).toBe(true);
  slow.press(830);
  expect(slow.progress).toBeCloseTo(1, 5);
});

test("repeats that arrive together count the time the key was down", () => {
  const hold = new KeyHold(1000, 220, 150, 80);
  hold.slack = 200;
  hold.press(0);
  hold.press(400);
  hold.advance(600);
  const stalled = hold.progress;
  hold.press(600);
  expect(stalled).toBeLessThan(0.5);
  expect(hold.progress).toBeCloseTo(0.6, 5);
});

test("a rise in slack reaches a hold already under way", () => {
  const hold = new KeyHold(1000, 220, 150, 80);
  hold.press(0);
  hold.press(400);
  expect(hold.held(600)).toBe(false);
  hold.slack = 300;
  expect(hold.held(600)).toBe(true);
  hold.press(600);
  expect(hold.progress).toBeCloseTo(0.6, 5);
});

test("a done hold stays quiet through repeats the link delivers late", () => {
  const hold = new KeyHold(400, 220, 150, 80);
  hold.slack = 300;
  hold.press(0);
  expect(hold.press(400)).toBe(true);
  hold.reset();
  // Held back past the gap but within the slack.
  hold.press(800);
  expect(hold.active).toBe(false);
});

test("a mouse release lets go at once, whatever the slack", () => {
  const hold = new KeyHold(1000, 220);
  hold.slack = 300;
  hold.down(0);
  hold.release(200);
  expect(hold.held(201)).toBe(false);
});
