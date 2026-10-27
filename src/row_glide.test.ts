import { test, expect } from "bun:test";
import { inflateSync } from "node:zlib";
import * as rowGlide from "./row_glide";
import { colors } from "./palette";
import { Terminal } from "./pane/terminal";
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
  expect(out.startsWith("\x1b7\x1b[5;1H\x1b_Ga=T,f=100,i=730120,p=1,Y=5,y=0,h=40,z=-1,C=1,q=2,m=0;")).toBe(true);
  const png = Buffer.from(out.slice(out.indexOf("m=0;") + 4, out.indexOf("\x1b\\")), "base64"),
    chunks: Record<string, Buffer> = {};
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at))
    chunks[png.toString("latin1", at + 4, at + 8)] = png.subarray(at + 8, at + 8 + png.readUInt32BE(at));
  expect([chunks.IHDR.readUInt32BE(0), chunks.IHDR.readUInt32BE(4)]).toEqual([300, 40]);
  // Every pixel is the one palette entry: the accent at alpha 52.
  expect(inflateSync(chunks.IDAT).every(i => i === 0)).toBe(true);
  expect([...chunks.PLTE, ...chunks.tRNS]).toEqual([...colors.accent, 52]);
  // Large cells don't ask the terminal to inflate zlib data.
  expect(rowGlide.place(0, 4, 30, 2, clip, 0.2, { width: 22, height: 46 })).not.toContain("o=z");
  // Above the list's first row, it is cropped to what is in the list.
  expect(rowGlide.place(0, 2.5, 30, 2, clip, 0.2, cell)).toContain("\x1b[4;1H\x1b_Ga=T");
  expect(rowGlide.place(0, 2.5, 30, 2, clip, 0.2, cell)).toContain(",Y=0,y=10,h=30,");
  expect(rowGlide.place(0, 19.5, 30, 2, clip, 0.2, cell)).toContain(",Y=10,y=0,h=10,");
  expect(rowGlide.place(0, 0, 30, 2, clip, 0.2, cell)).toBe("");
  expect(rowGlide.place(0, 5, 30, 2, clip, 0, cell)).toBe("");
});
test("hiding the tint retains its cached image data", () => {
  const terminal = new Terminal(100, 30);
  try {
    terminal.feed(rowGlide.place(0, 4, 30, 2, { top: 3, bottom: 20 }, 0.2, cell));
    terminal.feed(rowGlide.hide);
    terminal.feed("\x1b_Ga=p,i=730120,p=1,C=1,q=0\x1b\\");
    const reply = Buffer.from(terminal.native({ op: "takePending" })).toString();
    expect(reply).toBe("\x1b_Gi=730120,p=1;OK\x1b\\");
  } finally {
    terminal.destroy();
  }
});
