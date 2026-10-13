import { test, expect } from "bun:test";
import { inflateSync } from "node:zlib";
import * as rowGlide from "./row_glide";
import { colors } from "./palette";
const cell = { width: 10, height: 20 };
test("the tint glides to where the row lands and fades there, and the row shows as it arrives", () => {
  expect(rowGlide.position(4, 9, 0)).toBe(4);
  expect(rowGlide.position(4, 9, rowGlide.glide_ms / 2)).toBe(6.5);
  expect(rowGlide.position(4, 9, rowGlide.glide_ms * 2)).toBe(9);
  expect(rowGlide.opacity(0)).toBe(0);
  expect(rowGlide.opacity(rowGlide.glide_ms)).toBeCloseTo(0.2);
  expect(rowGlide.opacity(rowGlide.glide_ms + rowGlide.land_ms)).toBe(0);
  expect(rowGlide.fade(0)).toBe(1);
  expect(rowGlide.fade(rowGlide.glide_ms / 2)).toBe(1);
  expect(rowGlide.fade(rowGlide.glide_ms)).toBeGreaterThan(0);
  expect(rowGlide.fade(rowGlide.glide_ms)).toBeLessThan(1);
  expect(rowGlide.fade(rowGlide.glide_ms + 200)).toBeNull();
  expect(rowGlide.tint(0)).toBeCloseTo(0.2);
  expect(rowGlide.tint(rowGlide.tint_ms)).toBe(0);
});
test("the tint is placed by the pixel under the text and cut to the list", () => {
  const clip = { top: 3, bottom: 20 };
  const out = rowGlide.place(0, 4.25, 30, 2, clip, 0.2, cell);
  expect(
    out.startsWith("\x1b7\x1b[5;1H\x1b_Ga=T,f=32,o=z,s=300,v=40,i=730120,p=1,Y=5,y=0,h=40,z=-1,C=1,q=2,m=0;"),
  ).toBe(true);
  const data = out.slice(out.indexOf("m=0;") + 4, out.indexOf("\x1b\\"));
  const pixels = inflateSync(Buffer.from(data, "base64"));
  expect(pixels.length).toBe(300 * 40 * 4);
  expect([...pixels.subarray(0, 4)]).toEqual([...colors.accent, 52]);
  // Above the list's first row, it is cropped to what is in the list.
  expect(rowGlide.place(0, 2.5, 30, 2, clip, 0.2, cell)).toContain("\x1b[4;1H\x1b_Ga=T");
  expect(rowGlide.place(0, 2.5, 30, 2, clip, 0.2, cell)).toContain(",Y=0,y=10,h=30,");
  expect(rowGlide.place(0, 19.5, 30, 2, clip, 0.2, cell)).toContain(",Y=10,y=0,h=10,");
  expect(rowGlide.place(0, 0, 30, 2, clip, 0.2, cell)).toBe("");
  expect(rowGlide.place(0, 5, 30, 2, clip, 0, cell)).toBe("");
});
