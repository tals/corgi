import { expect, test } from "bun:test";
import * as hostImages from "./host_images";
import * as palette from "./palette";
import { place, size } from "./tab_icons";

const cell = { width: 9, height: 18 };
/** The pixels of the one mark an upload sends. */
function pixels(upload: string): Uint8Array {
  const data = [...upload.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map(m => m[1]).join("");
  return Buffer.from(data, "base64");
}
/** The color of its most opaque pixel. */
function ink(rgba: Uint8Array): number[] {
  let best = 0;
  for (let at = 0; at < rgba.length; at += 4) if (rgba[at + 3] > rgba[best + 3]) best = at;
  return [...rgba.subarray(best, best + 3)];
}

test("a mark is sent the first time a tab shows it, then only placed", () => {
  const store = new hostImages.Store();
  const first = store.frame(cell);
  place(first, "bun", 5, 0, cell);
  const id = /i=(\d+)/.exec(first.commands())![1];
  expect(first.commands()).toBe(`\x1b[1;6H\x1b_Ga=p,i=${id},p=1,Y=2,z=1,C=1,q=1\x1b\\`);
  const sent = store.present().send;
  expect(sent).toStartWith(`\x1b_Ga=t,t=d,f=32,s=14,v=14,i=${id},q=1,m=0;`);
  expect(pixels(sent)).toHaveLength(14 * 14 * 4);
  // Later frames place it again; nothing is sent.
  const frame = store.frame(cell);
  place(frame, "bun", 5, 0, cell);
  place(frame, "bun", 17, 0, cell);
  expect(frame.commands()).toContain("p=2,");
  expect(store.present().send).toBe("");
  // Another brand sends only itself.
  place(store.frame(cell), "node", 17, 0, cell);
  const other = store.present();
  expect(other.send).toContain("a=t");
  expect(other.send).not.toContain(`i=${id},`);
  // The frame dropped the first mark: the host frees it.
  expect(other.free).toBe(`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`);
  expect(store.present()).toMatchObject({ send: "", draw: "", free: "" });
});

test("a new cell size draws the mark again, and leaving frees them all", () => {
  const store = new hostImages.Store();
  const shown = (at: typeof cell) => {
    const frame = store.frame(at);
    place(frame, "vim", 3, 0, at);
    return /i=(\d+)/.exec(frame.commands())![1];
  };
  const id = shown(cell);
  store.present();
  const again = shown({ width: 18, height: 36 });
  expect(again).not.toBe(id);
  expect(store.present()).toMatchObject({
    send: expect.stringContaining(`s=28,v=28,i=${again},`),
    free: `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`,
  });
  expect(store.close()).toEndWith(`\x1b_Ga=d,d=I,i=${again},q=2\x1b\\`);
});

test("a one-color mark that would barely show takes the tabs' ink; others keep their colors", () => {
  const store = new hostImages.Store();
  const big = { width: 18, height: 36 };
  place(store.frame(big), "rust", 3, 0, big);
  expect(ink(pixels(store.present().send))).toEqual(palette.colors.text);
  place(store.frame(big), "node", 3, 0, big);
  expect(ink(pixels(store.present().send))).toEqual([0x5f, 0xa0, 0x4e]);
});

test("a mark fills its two cells' box less a tenth at each edge, centered down the cell", () => {
  expect(size({ width: 9, height: 18 })).toEqual({ side: 14, top: 2 });
  expect(size({ width: 18, height: 37 })).toEqual({ side: 28, top: 4 });
  // Narrow cells give the width.
  expect(size({ width: 7, height: 20 })).toEqual({ side: 12, top: 4 });
});
