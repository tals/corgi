import { expect, test } from "bun:test";
import { KeyHold, repeat_gap_ms } from "./key_hold";

test("a hold with shorter gaps notices a tap's release sooner, once it knows the repeat delay", () => {
  const quick = new KeyHold(800, 220, 150, 80),
    shared = new KeyHold(800, 220, repeat_gap_ms, repeat_gap_ms);
  // The assumed delay stands in from the first press.
  quick.press(0);
  expect(quick.held(470)).toBe(true);
  expect(quick.held(500)).toBe(false);
  for (const hold of [quick, shared]) {
    hold.reset();
    hold.press(1000);
    hold.press(1300);
    hold.reset();
    hold.press(5000);
  }
  expect(quick.held(5370)).toBe(true);
  expect(quick.held(5400)).toBe(false);
  expect(shared.held(5500)).toBe(true);
  expect(shared.held(5600)).toBe(false);
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

test("a mouse release lets go at once", () => {
  const hold = new KeyHold(1000, 220);
  hold.down(0);
  hold.release(200);
  expect(hold.held(201)).toBe(false);
});
