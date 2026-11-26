//! The rule between the sidebar's lists: a band in the selected gray around
//! the drag grip, lined above and below in the grip's gray, that fades into
//! the panel toward both ends so the headings beside them keep the eye.
//! Hosts that show Kitty images get it as one image under the row's text,
//! smooth to the pixel; the rest get it cell by cell.
import { crc32, deflateSync } from "node:zlib";
import * as hostImages from "./host_images";
import * as palette from "./palette";
import { bgRgb, colors, fgRgb, mix } from "./palette";
import type { Cell } from "./fork_hero";

/** How strong the band is at `x`, in cells from the row's start, from 0 to
 * 1: whole across the grip and two cells either side, then easing out to
 * nothing by each end, the panel's edge a column before the row and the
 * border just after it. */
export function strength(x: number, cells: number, start: number, grip: number): number {
  const center = start + (grip - 1) / 2,
    full = 3,
    reach = Math.max(1, (x < center ? center + 1 : cells - center) - full),
    t = Math.min(1, Math.max(0, Math.abs(x - center) - full) / reach);
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/** The band cell by cell, `grip` from `start`: each cell's fill, text and
 * underline step toward the panel, and the text color carries the overline. */
export function cells(count: number, start: number, grip: string, panel: string): string {
  let out = "";
  for (let x = 0; x < count; x++) {
    const ch = grip[x - start] ?? " ",
      share = Math.round(100 * strength(x, count, start, grip.length));
    if (share < 3) {
      out += panel + ch;
      continue;
    }
    const ink = mix(colors.bg, colors.muted, share);
    out += "\x1b[0;4;53m" + bgRgb(mix(colors.bg, colors.selected, share)) + fgRgb(ink) + palette.underlineRgb(ink) + ch;
  }
  return out;
}

/** The lines' thickness in pixels, about an underline's. */
const line = (cell: Cell) => Math.max(1, Math.round(cell.height / 16));

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** The band's pixels, `count` cells wide and a cell tall: the selected gray
 * with the lines in the grip's gray along its top and bottom edges, each
 * column as strong as `strength` at its middle. */
export function pixels(count: number, start: number, grip: number, cell: Cell): Uint8Array {
  const width = count * cell.width,
    height = cell.height,
    t = line(cell),
    stride = 1 + width * 4,
    out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const [r, g, b] = y < t || y >= height - t ? colors.muted : colors.selected;
    for (let px = 0; px < width; px++) {
      const at = y * stride + 1 + px * 4;
      out[at] = r;
      out[at + 1] = g;
      out[at + 2] = b;
      out[at + 3] = Math.round(255 * strength((px + 0.5) / cell.width - 0.5, count, start, grip));
    }
  }
  return out;
}
/** The band as a PNG, base64: PNG rather than o=z, which Ghostty 1.3.1
 * crashes inflating over 64 KiB. */
function png(count: number, start: number, grip: number, cell: Cell): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(count * cell.width);
  ihdr.writeUInt32BE(cell.height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(pixels(count, start, grip, cell))),
    chunk("IEND", new Uint8Array()),
  ]);
}
const key = (count: number, start: number, grip: number, cell: Cell) =>
  `${count}:${start}:${grip}:${cell.width}x${cell.height}:${colors.selected}:${colors.muted}`;

/** The band as last drawn, and the size, grip and colors it was drawn for. */
let drawn: { key: string; image: hostImages.Image } | null = null;

/** Shows the band, `count` cells wide with a `grip` cells wide grip from
 * `start`, at column `col` of row `row`, under the row's text. False when
 * the host refused it, so the row draws it cell by cell. */
export function place(
  frame: hostImages.FrameImages,
  col: number,
  row: number,
  count: number,
  start: number,
  grip: number,
): boolean {
  const cell = frame.cell;
  if (drawn?.key !== key(count, start, grip, cell))
    drawn = { key: key(count, start, grip, cell), image: new hostImages.Image({ png: png(count, start, grip, cell) }) };
  return frame.show(drawn.image, { col, row, z: -1 });
}
