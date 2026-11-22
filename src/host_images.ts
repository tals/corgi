//! Corgi's own pictures on the host terminal, as Kitty images. A module
//! makes an `Image` from its pixels and shows it in each frame that wants it.
//! A frame only lists what it shows. Presenting it brings the host's `Store`
//! in line with that list, as the frame differ does for text: the images the
//! host lacks are sent, a picture is placed or taken off only where the list
//! changed, and images no frame shows any more are freed.
import type { Cell } from "./fork_hero";
import { Rect } from "./layout";

/** Pixels in a form Kitty takes: PNG, or raw RGBA rows. A PNG may carry an
 * animation, which hosts that can't play show as its first frame. */
export type Pixels = { png: Uint8Array; animation?: Animation } | { rgba: Uint8Array; width: number; height: number };
export interface Animation {
  /** How long the first frame shows, in ms. */
  delay: number;
  /** Pictures drawn at (`x`, `y`) over frame `base` (1-based, 0 for a clear
   * canvas), each shown for `delay` ms. */
  frames: { png: Uint8Array; x: number; y: number; base: number; delay: number }[];
}
/** Where a frame shows an image: its corner at cell (`col`, `row`), `x` and
 * `y` pixels further in. `region` is the part of it shown, in its pixels;
 * `cols` and `rows` scale it into that many cells. Below z 0 it goes under
 * text but over cell backgrounds. */
export interface Place {
  col: number;
  row: number;
  x?: number;
  y?: number;
  region?: Rect;
  cols?: number;
  rows?: number;
  z?: number;
  /** It belongs to a card drawn over the rest, so nothing covers it. */
  top?: boolean;
}

/** Corgi's other Kitty ids (the badge, moonlander) sit far below these. */
let next_id = 0x10000000;

/** One of Corgi's pictures: pixels that never change, under an id no other
 * picture shares. New content is a new image. */
export class Image {
  readonly id = next_id++;
  readonly width: number;
  readonly height: number;
  /** The host refused it; frames go without. */
  failed = false;
  constructor(readonly pixels: Pixels) {
    if ("rgba" in pixels) [this.width, this.height] = [pixels.width, pixels.height];
    else {
      // A PNG's size follows its header.
      const png = pixels.png,
        header = png.length >= 24 ? new DataView(png.buffer, png.byteOffset, 24) : null;
      [this.width, this.height] = header ? [header.getUint32(16), header.getUint32(20)] : [0, 0];
    }
  }
}

/** A picture on the screen: `image` at a cell, with the Kitty keys that say
 * which part of it shows and how. */
interface Placement {
  image: Image;
  row: number;
  col: number;
  keys: string;
}
const key = (p: Placement) => `${p.image.id} ${p.row};${p.col}${p.keys}`;
const place = (p: Placement, id: number) =>
  `\x1b[${p.row + 1};${p.col + 1}H\x1b_Ga=p,i=${p.image.id},p=${id}${p.keys},C=1,q=1\x1b\\`;

/** One frame's pictures: what it shows and where, and the cells drawn over
 * them. */
export class Frame {
  private shown: { image: Image; at: Place }[] = [];
  private covered: Rect[] = [];
  private cut: Placement[] | null = null;
  /** The images the host holds for the frame. */
  readonly images = new Set<Image>();
  constructor(readonly cell: Cell) {}
  /** Shows `image` at `at`, less whatever the frame covers. */
  show(image: Image, at: Place): void {
    if (image.failed) return;
    this.images.add(image);
    this.shown.push({ image, at });
    this.cut = null;
  }
  /** Has the host keep `image` though the frame shows none of it. */
  keep(image: Image): void {
    if (!image.failed) this.images.add(image);
  }
  /** Cells drawn over the frame's pictures, which are cut around them. */
  cover(box: Rect): void {
    if (box.w <= 0 || box.h <= 0) return;
    this.covered.push(
      new Rect(box.x * this.cell.width, box.y * this.cell.height, box.w * this.cell.width, box.h * this.cell.height),
    );
    this.cut = null;
  }
  /** The frame's pictures as placed: each cut into the pieces left showing. */
  placements(): readonly Placement[] {
    if (this.cut) return this.cut;
    const { width, height } = this.cell,
      out: Placement[] = [];
    for (const { image, at } of this.shown) {
      const scaled = at.cols !== undefined && at.rows !== undefined,
        source = at.region ?? new Rect(0, 0, image.width, image.height),
        left = at.col * width + (at.x ?? 0),
        top = at.row * height + (at.y ?? 0),
        area = scaled
          ? new Rect(left, top, at.cols! * width, at.rows! * height)
          : new Rect(left, top, source.w, source.h),
        holes = at.top ? [] : this.covered.filter(hole => overlap(area, hole)),
        tail = (scaled ? `,c=${at.cols},r=${at.rows}` : "") + `,z=${at.z ?? 1}`;
      if (holes.length === 0 || area.w <= 0 || area.h <= 0) {
        out.push({ image, row: at.row, col: at.col, keys: region(at.region) + offset(at.x ?? 0, at.y ?? 0) + tail });
        continue;
      }
      // A scaled picture can't be cut by the pixel: it is left out.
      if (scaled) continue;
      let pieces = [area];
      for (const hole of holes) pieces = pieces.flatMap(piece => piece.cut(hole));
      for (const piece of pieces)
        out.push({
          image,
          row: Math.floor(piece.y / height),
          col: Math.floor(piece.x / width),
          keys:
            region(new Rect(source.x + piece.x - left, source.y + piece.y - top, piece.w, piece.h)) +
            offset(piece.x % width, piece.y % height) +
            tail,
        });
    }
    return (this.cut = out);
  }
  /** The frame's placements as written to a host that shows nothing yet. */
  commands(): string {
    return this.placements()
      .map((p, i) => place(p, i + 1))
      .join("");
  }
}
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const region = (r: Rect | undefined) => (r ? `,x=${r.x},y=${r.y},w=${r.w},h=${r.h}` : "");
const offset = (x: number, y: number) => (x ? `,X=${x}` : "") + (y ? `,Y=${y}` : "");

/** What presenting a frame writes: `send` ahead of it, `draw` inside its
 * update (or `redraw`, every picture again, when the host's screen is drawn
 * from nothing), and `free` after it. */
export interface Writes {
  send: string;
  draw: string;
  redraw: string;
  free: string;
}

/** The pictures a host terminal holds and shows. */
export class Store {
  private held = new Set<Image>();
  /** What is on the screen, by `key`, each under its Kitty placement id. */
  private placed = new Map<string, { placement: Placement; id: number }>();
  private spare: number[] = [];
  private next_placement = 1;
  private failures = new Map<number, { count: number; at: number }>();
  /** Deletes owed for refused images, in case the host still has them. */
  private dropped = "";
  private drawn: Frame | null = null;
  /** Starts the next frame, for cells of `cell` pixels. */
  frame(cell: Cell): Frame {
    return (this.drawn = new Frame(cell));
  }
  /** Whether the last frame started shows other pictures than the host. */
  get changed(): boolean {
    const wanted = new Set((this.drawn?.placements() ?? []).map(key));
    return wanted.size !== this.placed.size || [...wanted].some(k => !this.placed.has(k));
  }
  /** Brings the host in line with the last frame started. */
  present(): Writes {
    const frame = this.drawn,
      wanted = new Map((frame?.placements() ?? []).map(p => [key(p), p]));
    let send = this.dropped,
      draw = "",
      free = "";
    this.dropped = "";
    for (const image of frame?.images ?? [])
      if (!this.held.has(image)) {
        this.held.add(image);
        send += transmit(image.id, image.pixels);
      }
    // A picture that moved keeps its placement id: placing it again moves it.
    const gone = new Map<Image, number[]>();
    for (const [k, { placement, id }] of this.placed)
      if (!wanted.has(k)) {
        this.placed.delete(k);
        gone.set(placement.image, [...(gone.get(placement.image) ?? []), id]);
      }
    for (const [k, placement] of wanted)
      if (!this.placed.has(k)) {
        const id = gone.get(placement.image)?.pop() ?? this.spare.pop() ?? this.next_placement++;
        this.placed.set(k, { placement, id });
        draw += place(placement, id);
      }
    let removed = "";
    for (const [image, ids] of gone)
      for (const id of ids) {
        removed += `\x1b_Ga=d,d=i,i=${image.id},p=${id},q=2\x1b\\`;
        this.spare.push(id);
      }
    for (const image of this.held)
      if (!frame?.images.has(image)) {
        this.held.delete(image);
        this.failures.delete(image.id);
        free += `\x1b_Ga=d,d=I,i=${image.id},q=2\x1b\\`;
      }
    let all = "";
    for (const { placement, id } of this.placed.values()) all += place(placement, id);
    return { send, draw: removed + draw, redraw: removed + all, free };
  }
  /** The host answered a command about image `id` with an error: it lost
   * the image, or never took it. It is sent again; after three refusals in
   * a row the frames go without it. */
  refused(id: number, now = performance.now()): boolean {
    const image = [...this.held].find(held => held.id === id);
    if (!image) return false;
    const last = this.failures.get(id),
      count = last && now - last.at < retry_ms ? last.count + 1 : 1;
    this.failures.set(id, { count, at: now });
    if (count >= 3) image.failed = true;
    this.held.delete(image);
    this.dropped += `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
    for (const [k, { placement, id: placement_id }] of this.placed)
      if (placement.image === image) {
        this.placed.delete(k);
        this.spare.push(placement_id);
      }
    return true;
  }
  /** Frees every picture, for a viewer leaving the host. */
  close(): string {
    this.drawn = null;
    const { send, draw, free } = this.present();
    return send + draw + free;
  }
}

/** Refusals further apart than this aren't the same failure. */
const retry_ms = 10_000;

function transmit(id: number, pixels: Pixels): string {
  if ("rgba" in pixels) return chunks(`a=t,t=d,f=32,s=${pixels.width},v=${pixels.height},i=${id}`, pixels.rgba);
  let out = chunks(`a=t,t=d,f=100,i=${id}`, pixels.png);
  const animation = pixels.animation;
  if (!animation?.frames.length) return out;
  for (const f of animation.frames)
    out += chunks(`a=f,t=d,f=100,i=${id},x=${f.x},y=${f.y},c=${f.base},z=${f.delay}`, f.png, 2);
  return out + `\x1b_Ga=a,i=${id},r=1,z=${animation.delay},q=2\x1b\\\x1b_Ga=a,i=${id},s=3,v=1,q=2\x1b\\`;
}
/** Kitty takes a payload in chunks of 4096 base64 bytes. The host answers an
 * error about the image itself; one that can't animate still shows it. */
function chunks(keys: string, data: Uint8Array, quiet: 1 | 2 = 1): string {
  const base64 = Buffer.from(data).toString("base64");
  let out = "";
  for (let offset = 0; offset < base64.length; offset += 4096) {
    const end = Math.min(offset + 4096, base64.length),
      more = Number(end < base64.length);
    out +=
      (offset === 0 ? `\x1b_G${keys},q=${quiet},m=${more};` : `\x1b_Gm=${more};`) +
      base64.slice(offset, end) +
      "\x1b\\";
  }
  return out;
}
