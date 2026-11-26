import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { colors } from "./palette";
import * as gripBand from "./grip_band";
import * as hostImages from "./host_images";
import { Rect } from "./layout";

// A 26-cell row with the grip, " ⠶⠶⠶ ", from cell 11: its dots at 12 to 14.
const count = 26,
  start = 11,
  grip = 5;
const at = (x: number) => gripBand.strength(x, count, start, grip);

test("the band is whole around the grip and eases out to nothing at each end", () => {
  for (let x = 10; x <= 16; x++) expect(at(x)).toBe(1);
  // Gone a column before the row on the left and at the border on the right.
  expect(at(-1)).toBeCloseTo(0);
  expect(at(count)).toBeCloseTo(0);
  for (let x = 10; x > -1; x--) expect(at(x - 1)).toBeLessThanOrEqual(at(x));
  for (let x = 16; x < count; x++) expect(at(x + 1)).toBeLessThanOrEqual(at(x));
});

test("the image is the band to the pixel: the selected gray, lined in the grip's gray at its edges", () => {
  const cell = { width: 10, height: 20 };
  const rows = gripBand.pixels(count, start, grip, cell),
    stride = 1 + count * cell.width * 4,
    pixel = (px: number, y: number) => Array.from(rows.slice(y * stride + 1 + px * 4, y * stride + 5 + px * 4));
  const middle = 13 * cell.width + 5;
  expect(pixel(middle, 10)).toEqual([...colors.selected, 255]);
  expect(pixel(middle, 0)).toEqual([...colors.muted, 255]);
  expect(pixel(middle, 19)).toEqual([...colors.muted, 255]);
  // Each pixel column a little fainter than the one before it, out to nothing.
  for (let px = middle; px > 0; px--) expect(pixel(px - 1, 10)[3]).toBeLessThanOrEqual(pixel(px, 10)[3]);
  expect(pixel(0, 10)[3]).toBeLessThan(8);
});

test("the band is one PNG under the row's text, cut around what covers it", () => {
  const frame = new hostImages.FrameImages({ width: 10, height: 20 });
  expect(gripBand.place(frame, 1, 13, count, start, grip)).toBe(true);
  const [shown] = frame.images,
    pixels = shown.pixels as { png: Uint8Array },
    png = Buffer.from(pixels.png),
    idat = png.indexOf("IDAT");
  expect([shown.width, shown.height]).toEqual([count * 10, 20]);
  expect(inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)))).toEqual(
    Buffer.from(gripBand.pixels(count, start, grip, frame.cell)),
  );
  expect(frame.commands()).toBe(`\x1b[14;2H\x1b_Ga=p,i=${shown.id},p=1,z=-1,C=1,q=1\x1b\\`);
  // A menu over the row's middle splits it in two, each showing its part.
  frame.cover(new Rect(10, 12, 6, 4));
  expect(frame.commands()).toBe(
    `\x1b[14;2H\x1b_Ga=p,i=${shown.id},p=1,x=0,y=0,w=90,h=20,z=-1,C=1,q=1\x1b\\` +
      `\x1b[14;17H\x1b_Ga=p,i=${shown.id},p=2,x=150,y=0,w=110,h=20,z=-1,C=1,q=1\x1b\\`,
  );
  // The same band again is the same image; another size or theme is a new one.
  const again = new hostImages.FrameImages(frame.cell);
  gripBand.place(again, 1, 13, count, start, grip);
  expect([...again.images]).toEqual([shown]);
  const larger = new hostImages.FrameImages({ width: 12, height: 24 });
  gripBand.place(larger, 1, 13, count, start, grip);
  expect([...larger.images][0]).not.toBe(shown);
  // A host that refused it leaves the row to its cells.
  const refused = new hostImages.FrameImages(larger.cell);
  [...larger.images][0].failed = true;
  expect(gripBand.place(refused, 1, 13, count, start, grip)).toBe(false);
});
