import { test, expect } from "bun:test";
import { inflateSync } from "node:zlib";
import * as hostImages from "./host_images";
import { Rect } from "./layout";
import * as rowGlide from "./row_glide";
import { colors } from "./palette";
import { Terminal } from "./pane/terminal";
const cell = { width: 10, height: 20 };
test("the tint glides to where the row lands, lingers, then fades, and the row shows as it arrives", () => {
  expect(rowGlide.position(4, 9, 0)).toBe(4);
  expect(rowGlide.position(4, 9, rowGlide.glide_ms / 2)).toBe(6.5);
  expect(rowGlide.position(4, 9, rowGlide.glide_ms * 2)).toBe(9);
  expect(rowGlide.opacity(0)).toBe(0);
  expect(rowGlide.opacity(rowGlide.glide_ms)).toBeCloseTo(0.2);
  // It stays at full strength a while where it lands, then eases out.
  expect(rowGlide.opacity(rowGlide.glide_ms + rowGlide.linger_ms)).toBeCloseTo(0.2);
  expect(rowGlide.opacity(rowGlide.glide_ms + rowGlide.linger_ms + rowGlide.land_ms / 2)).toBeCloseTo(0.1);
  expect(rowGlide.opacity(rowGlide.glide_ms + rowGlide.linger_ms + rowGlide.land_ms)).toBe(0);
  expect(rowGlide.fade(0)).toBe(1);
  expect(rowGlide.fade(rowGlide.glide_ms / 2)).toBe(1);
  expect(rowGlide.fade(rowGlide.glide_ms)).toBeGreaterThan(0);
  expect(rowGlide.fade(rowGlide.glide_ms)).toBeLessThan(1);
  expect(rowGlide.fade(rowGlide.glide_ms + 200)).toBeNull();
  expect(rowGlide.tint(0)).toBeCloseTo(0.2);
  expect(rowGlide.tint(rowGlide.linger_ms)).toBeCloseTo(0.2);
  expect(rowGlide.tint(rowGlide.linger_ms + rowGlide.tint_ms / 2)).toBeCloseTo(0.1);
  expect(rowGlide.tint(rowGlide.linger_ms + rowGlide.tint_ms)).toBe(0);
  expect(rowGlide.total_ms).toBe(rowGlide.glide_ms + rowGlide.linger_ms + rowGlide.land_ms);
});
test("the tint is placed by the pixel under the text and cut to the list", () => {
  const clip = { top: 3, bottom: 20 };
  const glide = (y: number, alpha = 0.2, at = cell) => {
    const store = new hostImages.Store(),
      frame = store.frame(at);
    rowGlide.place(frame, 0, y, 30, 2, clip, alpha, at);
    return { placed: frame.commands(), sent: store.present().send };
  };
  const { placed, sent } = glide(4.25),
    id = rowGlide.sidebar_tint.drawn!.image.id;
  expect(placed).toBe(`\x1b[5;1H\x1b_Ga=p,i=${id},p=1,x=0,y=0,w=300,h=40,Y=5,z=-1,C=1,q=1\x1b\\`);
  expect(sent.startsWith(`\x1b_Ga=t,t=d,f=100,i=${id},q=1,m=0;`)).toBe(true);
  const png = Buffer.from(sent.slice(sent.indexOf("m=0;") + 4, sent.indexOf("\x1b\\")), "base64"),
    chunks: Record<string, Buffer> = {};
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at))
    chunks[png.toString("latin1", at + 4, at + 8)] = png.subarray(at + 8, at + 8 + png.readUInt32BE(at));
  expect([chunks.IHDR.readUInt32BE(0), chunks.IHDR.readUInt32BE(4)]).toEqual([300, 40]);
  // Every pixel is the one palette entry: the accent at alpha 52.
  expect(inflateSync(chunks.IDAT).every(i => i === 0)).toBe(true);
  expect([...chunks.PLTE, ...chunks.tRNS]).toEqual([...colors.accent, 52]);
  // Large cells don't ask the terminal to inflate zlib data.
  expect(glide(4, 0.2, { width: 22, height: 46 }).sent).not.toContain("o=z");
  // Above the list's first row, it is cropped to what is in the list.
  expect(glide(2.5).placed).toMatch(/\x1b\[4;1H\x1b_Ga=p,i=\d+,p=1,x=0,y=10,w=300,h=30,z=-1,/);
  expect(glide(19.5).placed).toContain(",x=0,y=0,w=300,h=10,Y=10,");
  expect(glide(0).placed).toBe("");
  expect(glide(5, 0).placed).toBe("");
});
test("taking the pictures off the screen keeps the tint's image data", () => {
  const terminal = new Terminal(100, 30),
    store = new hostImages.Store();
  try {
    // Shown, then wholly covered.
    for (const covered of [false, true]) {
      const frame = store.frame(cell);
      rowGlide.place(frame, 0, 4, 30, 2, { top: 3, bottom: 20 }, 0.2, cell);
      if (covered) frame.cover(new Rect(0, 0, 100, 30));
      const p = store.present();
      expect(p.draw).toContain(covered ? "a=d,d=i" : "a=p");
      terminal.feed(p.send + p.draw + p.free);
    }
    const id = rowGlide.sidebar_tint.drawn!.image.id;
    terminal.feed(`\x1b_Ga=p,i=${id},p=1,C=1,q=0\x1b\\`);
    const reply = Buffer.from(terminal.native({ op: "takePending" })).toString();
    expect(reply).toBe(`\x1b_Gi=${id},p=1;OK\x1b\\`);
  } finally {
    terminal.destroy();
  }
});
