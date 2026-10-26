//! Viewer-independent terminal adapter for Moonlander's shared engine and renderer.
import { deflateSync } from "node:zlib";
import * as moonlander from "./moonlander";
import * as scene from "./scene";
import * as faces from "./faces";
import * as hull from "./hull";
import * as palette from "../palette";
import * as keyboard from "../keyboard";
import { masks } from "./glyphs";
import type { Cell } from "../fork_hero";

export type Rasterize = (atlas: faces.Atlas) => Uint8Array | Promise<Uint8Array>;
function lines(screen: scene.Screen) {
  return Array.from({ length: screen.rows }, (_, row) => {
    let line = "",
      previous = "";
    for (const cell of screen.cells.slice(row * screen.cols, (row + 1) * screen.cols)) {
      const style = `${cell.fg}/${cell.bg}/${cell.bold}/${cell.alpha}`;
      if (style !== previous) {
        const fg =
          cell.alpha < 1
            ? palette.fgRgb(palette.mix(palette.colors[cell.bg], palette.colors[cell.fg], cell.alpha * 100))
            : palette.fg(cell.fg);
        line += `\x1b[0m${fg}${palette.bg(cell.bg)}${cell.bold ? "\x1b[1m" : ""}`;
        previous = style;
      }
      line += cell.glyph;
    }
    return line + "\x1b[0m";
  });
}

const imageId = 730202;
const queryId = 730201;
const hideFace = `\x1b_Ga=d,d=i,i=${imageId},q=2\x1b\\`;
const removeFace = `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
/** The hull is one image per flight tilt, sent the first time the ship takes it. */
const hullFirst = 730210,
  hullLast = hullFirst + hull.tiles - 1;
const hideHull = `\x1b_Ga=d,d=r,x=${hullFirst},y=${hullLast},q=2\x1b\\`;
const removeHull = `\x1b_Ga=d,d=R,x=${hullFirst},y=${hullLast},q=2\x1b\\`;
/** Ghostty's ED2 also deletes stored images, including an unplaced atlas. */
export function clearText(cols: number, rows: number): string {
  let out = `\x1b[0m${palette.bg("bg")}`;
  for (let row = 0; row < rows; row++) out += `\x1b[${row + 1};1H${" ".repeat(cols)}`;
  return out;
}
export function upload(png: Uint8Array, id = imageId): string {
  const data = Buffer.from(png).toString("base64");
  let out = "";
  for (let offset = 0; offset < data.length; offset += 4096) {
    const end = Math.min(offset + 4096, data.length),
      more = Number(end < data.length);
    out +=
      (offset === 0 ? `\x1b_Ga=t,t=d,f=100,i=${id},m=${more};` : `\x1b_Gm=${more};`) +
      data.slice(offset, end) +
      "\x1b\\";
  }
  return out;
}
function facePieces(items: faces.Placement[], atlas: faces.Atlas, ox: number, oy: number): string[] {
  return items.map((p, i) => {
    const x = p.x + ox * atlas.cw,
      y = p.y + oy * atlas.ch,
      col = Math.floor(x / atlas.cw),
      row = Math.floor(y / atlas.ch);
    return `\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${imageId},p=${i + 1},x=${p.sx},y=${p.sy},w=${p.w},h=${p.h},X=${x - col * atlas.cw},Y=${y - row * atlas.ch},z=1,C=1,q=1\x1b\\`;
  });
}

/** Each piece of the hull keeps its placement id, so placing it again moves
 * it in place. Its z of 0 is over the text and under the face. */
function hullPieces(tile: number, items: faces.Placement[], cell: Cell, ox: number, oy: number): string[] {
  return items.map((p, i) => {
    const x = p.x + ox * cell.width,
      y = p.y + oy * cell.height,
      col = Math.floor(x / cell.width),
      row = Math.floor(y / cell.height);
    return `\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${hullFirst + tile},p=${i + 1},x=${p.sx},y=${p.sy},w=${p.w},h=${p.h},X=${x - col * cell.width},Y=${y - row * cell.height},C=1,q=1\x1b\\`;
  });
}

export interface Options {
  /** How to draw the hull; `image` falls back to braille without Kitty graphics. */
  hull?: hull.Style;
  /** Bits per pixel of the hull's tiles: 2 for 4 alpha levels, 4 for 16. */
  bits?: faces.Bits;
  /** Each flight lands itself on a pad about a second in. */
  autoland?: boolean;
  /** Simulation ticks per frame; defaults to normal speed. */
  speed?: number;
}

export class State {
  readonly engine: moonlander.Engine;
  cell: Cell | null = null;
  supported = false;
  private size: { cols: number; rows: number };
  private options: moonlander.Options;
  private atlas: faces.Atlas | null = null;
  private ready = false;
  private building = "";
  private generation = 0;
  private closed = false;
  private last: number | null = null;
  /** When the first frame was drawn, and whether the terminal has said if
   * it does Kitty graphics; the ship waits for its images from then. */
  private started: number | null = null;
  private answered = false;
  private faceRefused = false;
  private writes: string[] = [];
  private rasterize: Rasterize;
  readonly hullStyle: hull.Style;
  private hullBits: faces.Bits;
  /** Each tilt's tile: `sent` once its upload is queued, `ready` once the
   * terminal has it, for the cell size, scale and color in `tileKey`. */
  private tiles = new Map<number, "sent" | "ready">();
  private sprites = new Map<number, hull.Sprite>();
  private tileKey = "";
  private lastTile: number | null = null;
  /** The terminal refused a tile, so the hull stays braille. */
  private hullRefused = false;
  /** With autoland the first flight, rather than the title, waits for the
   * terminal before it starts. */
  private holding: boolean;
  private speed: number;
  constructor(
    cols: number,
    rows: number,
    private changed = () => {},
    rasterize?: Rasterize,
    options: Options = {},
  ) {
    this.hullStyle = options.hull ?? "image";
    this.hullBits = options.bits ?? 4;
    this.speed = options.speed ?? 1;
    this.size = { cols: Math.max(72, Math.min(200, cols)), rows: Math.max(24, Math.min(70, rows)) };
    this.options = { size: () => this.size, aspect: 2.2, autoland: options.autoland };
    this.engine = moonlander.create(this.options);
    this.holding = options.autoland ?? false;
    if (this.holding) this.engine.launch(1);
    else this.engine.title();
    this.rasterize = rasterize ?? (atlas => faces.rasterize(atlas, masks));
  }
  static query() {
    return `\x1b[16t\x1b[14t\x1b_Ga=q,i=${queryId},t=d,f=24,s=1,v=1;AAAA\x1b\\`;
  }
  takeWrites(): string[] {
    return this.writes.splice(0);
  }
  close(): string {
    this.closed = true;
    this.generation++;
    this.writes = [];
    return removeFace + removeHull;
  }
  release(): void {
    this.engine.keys.up = false;
    if (this.engine.game.state === "flying") this.engine.game.paused = true;
  }
  key(byte: number): boolean {
    if (byte === 27 || byte === 113 || byte === 3) return true;
    const inputs: Record<number, moonlander.Input> = {
      13: "advance",
      10: "advance",
      32: "thrust",
      119: "thrust",
      115: "cut",
      97: "left",
      100: "right",
      112: "pause",
      114: "restart",
    };
    const input = inputs[byte];
    if (input) this.engine.press(input);
    return false;
  }
  sequence(sequence: string): boolean {
    const key = keyboard.decode(sequence);
    if (!key) return false;
    if (key.mods.ctrl) return key.codepoint === 99;
    if (key.mods.alt || key.mods.super) return false;
    const inputs: Record<number, moonlander.Input> = {
      [keyboard.arrow_up]: "thrust",
      [keyboard.arrow_down]: "cut",
      [keyboard.arrow_left]: "left",
      [keyboard.arrow_right]: "right",
    };
    const input = inputs[key.codepoint];
    if (input) this.engine.press(input);
    else return this.key(key.codepoint);
    return false;
  }
  click(x: number, y: number): boolean {
    if (y === 0 && x >= 2 && x < 10) return true;
    if (this.engine.game.state !== "flying" || this.engine.game.paused) this.engine.press("advance");
    return false;
  }
  reply(sequence: string, cols: number, rows: number): boolean {
    const pixels = /^\x1b\[(6|4);(\d+);(\d+)t$/.exec(sequence);
    if (pixels) {
      const window = pixels[1] === "4",
        width = window ? Math.floor(Number(pixels[3]) / cols) : Number(pixels[3]),
        height = window ? Math.floor(Number(pixels[2]) / rows) : Number(pixels[2]);
      if (width > 0 && width <= 128 && height > 0 && height <= 256) this.cell = { width, height };
      return true;
    }
    const result = /^\x1b_G([^;]+);([\s\S]*)\x1b\\$/.exec(sequence);
    if (!result) return false;
    const fields = new Map(result[1].split(",").map(field => field.split("=", 2)) as [string, string][]);
    if (fields.get("i") === String(queryId)) {
      this.supported = result[2] === "OK";
      this.answered = true;
      return true;
    }
    const id = Number(fields.get("i"));
    if (id >= hullFirst && id <= hullLast) {
      const tile = id - hullFirst;
      if (result[2] === "OK") {
        if (this.tiles.get(tile) === "sent") this.tiles.set(tile, "ready");
      } else if (result[2].startsWith("ENOENT")) {
        // The terminal lost the tile; send it again.
        this.tiles.delete(tile);
      } else this.hullRefused = true;
      this.changed();
      return true;
    }
    if (id !== imageId) return false;
    if (this.atlas) {
      this.ready = result[2] === "OK";
      if (!this.ready) this.faceRefused = true;
      this.changed();
    }
    return true;
  }
  private async prepare(cell: Cell): Promise<void> {
    const key = `${cell.width}/${cell.height}/${palette.colors.strong.join(",")}`;
    if (this.building === key || this.closed) return;
    this.building = key;
    const generation = ++this.generation,
      atlas = faces.layout(cell.width, cell.height);
    try {
      const alpha = await this.rasterize(atlas),
        png = await faces.encode(
          atlas,
          alpha,
          [...palette.colors.strong],
          4,
          raw => new Uint8Array(deflateSync(raw, { level: 9 })),
        );
      if (this.closed || generation !== this.generation) return;
      this.atlas = atlas;
      this.ready = false;
      this.writes.push(removeFace + upload(png));
      this.changed();
    } catch {
      // A failed image keeps the text passenger visible.
      if (generation === this.generation) {
        this.ready = false;
        this.changed();
      }
    }
  }
  /** Sends tile `index` once, the first time the ship takes its tilt. */
  private sendTile(cell: Cell, index: number): void {
    const key = `${cell.width}/${cell.height}/${this.engine.world.K}/${palette.colors.text.join(",")}/${this.hullBits}`;
    if (key !== this.tileKey) {
      if (this.tileKey) this.writes.push(removeHull);
      this.tileKey = key;
      this.tiles.clear();
      this.sprites.clear();
      this.lastTile = null;
    }
    if (this.tiles.has(index) || this.closed) return;
    this.tiles.set(index, "sent");
    const sprite = hull.sprite(this.engine, cell.width, cell.height, index);
    this.sprites.set(index, sprite);
    faces
      .encode(
        { width: sprite.w, height: sprite.h },
        sprite.alpha,
        [...palette.colors.text],
        this.hullBits,
        raw => new Uint8Array(deflateSync(raw, { level: 9 })),
      )
      .then(png => {
        if (this.closed || key !== this.tileKey) return;
        this.writes.push(upload(png, hullFirst + index));
        this.changed();
      })
      .catch(() => {
        // A failed tile keeps the braille hull.
        this.hullRefused = true;
        this.changed();
      });
  }
  frame(
    cols: number,
    rows: number,
    cell: Cell | null = this.cell,
    supported = this.supported,
    now = performance.now(),
  ): string {
    this.cell = cell;
    this.supported = supported;
    this.size = { cols: Math.max(72, Math.min(200, cols)), rows: Math.max(24, Math.min(70, rows)) };
    if (cell) this.options.aspect = cell.height / cell.width;
    const w = this.engine.world,
      resized = w.cols !== this.size.cols || w.rows !== this.size.rows || w.K !== this.options.aspect / 2;
    if (resized && this.holding) this.engine.launch(1);
    else if (resized && this.engine.game.state === "title") this.engine.title();
    if (supported && cell) void this.prepare(cell);
    const dt = this.last === null ? 0 : (now - this.last) / 1000;
    this.last = now;
    let out = "\x1b[?2026h\x1b[?1003h\x1b[?25l" + clearText(cols, rows);
    if (cols < 72 || rows < 24 || cols < this.engine.world.cols || rows < this.engine.world.rows) {
      const message =
        cols < 72 || rows < 24
          ? "Moonlander needs 72 columns × 24 rows. Resize, or q to go back."
          : `Resize to ${w.cols} × ${w.rows} to continue, or r to restart.`;
      return (
        out + `\x1b[1;1H${palette.fg("text")}${message.slice(0, cols)}` + hideHull + hideFace + "\x1b[0m\x1b[?2026l"
      );
    }
    // Repeat ticks so the engine's stall cap still allows the full multiplier.
    if (!this.holding) for (let i = 0; i < this.speed; i++) this.engine.tick(dt);
    // The hull image shows the ship's tilt once the terminal has its tile;
    // until the terminal has any, braille does.
    const L = this.engine.lander;
    let tile: number | null = null;
    if (this.hullStyle === "image" && supported && cell && L && !this.hullRefused) {
      const want = hull.tile(L.a);
      // The tilts either side go too, so a turn finds its tile waiting.
      for (const index of [want, want - 1, want + 1]) if (index >= 0 && index < hull.tiles) this.sendTile(cell, index);
      // Until the terminal has it, the nearest tile it has stands in, on the
      // side the ship is turning from.
      const from = this.lastTile !== null && this.lastTile < want ? -1 : 1;
      for (let d = 0; d < hull.tiles && tile === null; d++)
        for (const index of [want + d * from, want - d * from])
          if (tile === null && this.tiles.get(index) === "ready") tile = index;
    }
    const style = tile !== null ? "image" : this.hullStyle === "image" ? hull.fallback : this.hullStyle,
      // The face turns with the hull as shown, even while a new tilt's tile is on its way.
      turned = tile !== null ? hull.angle(tile) : hull.drawn(style, L?.a ?? 0);
    // At the start the ship waits for its images, rather than show braille
    // and text that then snap to them: until the terminal says whether it
    // does Kitty graphics, and if it does, until the face and hull arrive.
    this.started ??= now;
    const waiting = supported
      ? ((!this.ready && !this.faceRefused) || (this.hullStyle === "image" && tile === null && !this.hullRefused)) &&
        now - this.started < 1000
      : !this.answered && now - this.started < 250;
    if (waiting) tile = null;
    else this.holding = false;
    const screen = scene.render(this.engine, waiting || (this.ready && supported), waiting ? "image" : style),
      rendered = lines(screen),
      ox = Math.floor((cols - this.engine.world.cols) / 2),
      oy = Math.floor((rows - this.engine.world.rows) / 2);
    rendered.forEach((line, row) => {
      out += `\x1b[${row + oy + 1};${ox + 1}H${line}`;
    });
    out += `\x1b[1;3H${palette.fg("muted")}[ back ]`;
    if (tile !== null) this.lastTile = tile;
    const pieces =
      tile === null || !cell
        ? []
        : hullPieces(
            tile,
            hull.placements(this.engine, this.sprites.get(tile)!, cell.width, cell.height, screen.occludes),
            cell,
            ox,
            oy,
          );
    const face =
      this.ready && supported && this.atlas && !waiting
        ? facePieces(
            faces.placements(this.engine, this.atlas, screen.occludes, style !== "image", turned),
            this.atlas,
            ox,
            oy,
          )
        : [];
    return out + "\x1b[0m" + hideHull + pieces.join("") + hideFace + face.join("") + "\x1b[?2026l";
  }
}
