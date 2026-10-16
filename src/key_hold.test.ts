import { expect, test } from "bun:test";
import { KeyHold, Spring } from "./key_hold";

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

test("a hold with shorter gaps notices a tap's release sooner", () => {
  const quick = new KeyHold(800, 220, 150, 80),
    shared = new KeyHold(800, 220);
  quick.press(0);
  shared.press(0);
  expect(quick.held(470)).toBe(true);
  expect(quick.held(500)).toBe(false);
  expect(shared.held(500)).toBe(true);
  expect(shared.held(700)).toBe(false);
});
