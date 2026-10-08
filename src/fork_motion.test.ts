import { test, expect } from "bun:test";
import { inflateSync } from "node:zlib";
import * as f from "./fork_motion";
import { colors } from "./palette";
const hero = { motion: { start: 0, cell: { width: 18, height: 40 } } };
test("the spring overshoots, then settles on its end", () => {
  expect(f.spring(0)).toBe(0);
  expect(f.spring(1)).toBe(1);
  const peak = Math.max(
    ...Array.from({ length: 100 }, (_, i) => f.spring(i / 100)),
  );
  expect(peak).toBeGreaterThan(1.05);
  expect(peak).toBeLessThan(1.25);
});
test("without motion the hero is at rest; with it, blank until it starts", () => {
  const rest = f.frameAt({}, 0);
  expect(rest.placed).toBe(0);
  expect(rest.text.at(-1)?.glyph).toBe("copy");
  expect(f.frameAt(hero, -1).len).toBe(0);
  expect(f.moving(hero, 639)).toBe(true);
  expect(f.moving(hero, 640)).toBe(false);
  expect(f.frameAt(hero, 640).len).toBe(rest.len);
  expect(f.frameAt(hero, 640).placed).toBe(0);
});
test("the node leads the growing line, then the branches lift apart", () => {
  let last = -Infinity;
  for (let t = 0; t < 197; t += 10) {
    const frame = f.frameAt(hero, t);
    expect(frame.placed).toBe(1);
    expect(frame.placements[0].x).toBeGreaterThanOrEqual(last);
    last = frame.placements[0].x;
  }
  const early = f.frameAt(hero, 347),
    late = f.frameAt(hero, 467);
  expect(early.placed).toBe(4);
  expect(late.placements[0].y).toBeLessThan(early.placements[0].y);
  expect(late.placements[1].crop!.h).toBeGreaterThan(
    early.placements[1].crop!.h,
  );
  expect(
    late.placements[0].image !== early.placements[0].image ||
      late.placements[0].image === 730108,
  ).toBe(true);
});
test("placements land inside their anchor cell, and only while moving", () => {
  for (let t = 0; t <= 640; t += 7) {
    const drawn = f.draw(30, 3, { ...hero, glyphs: true }, t);
    for (const m of drawn.matchAll(/,X=(\d+),Y=(\d+)/g)) {
      expect(Number(m[1])).toBeLessThan(18);
      expect(Number(m[2])).toBeLessThan(40);
    }
    if (t >= 640) expect(drawn).not.toContain("a=p");
  }
});
test("the hero at rest is text: node glyphs where the host draws them, dots elsewhere", () => {
  const native = f.draw(0, 0, { glyphs: true }, 0),
    fallback = f.draw(0, 0, {}, 0);
  expect(native.split("\uf5f2").length - 1).toBe(2);
  expect(native).not.toContain("\x1b_G");
  expect(fallback.split("●").length - 1).toBe(2);
  expect(fallback).not.toContain("\uf5f2");
});
test("images go out compressed, once each, and unpack to their pixels", () => {
  const sent = f.upload({ width: 9, height: 20 });
  expect(sent.split("a=t,").length - 1).toBe(16);
  const pixels = inflateSync(
    Buffer.from(
      sent.slice(sent.indexOf(";") + 1, sent.indexOf("\x1b\\")),
      "base64",
    ),
  );
  expect(pixels.length).toBe(9 * 20 * 4);
  const center = (10 * 9 + 4) * 4;
  expect([...pixels.subarray(center, center + 3)]).toEqual(colors.muted);
  expect(pixels[center + 3]).toBe(255);
  expect(pixels[3]).toBe(0);
});
