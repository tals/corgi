//! Fork hero motion and host-cell-sized Kitty graphics.
import { deflateSync } from "node:zlib";
import * as palette from "./palette";
export const width = 12;
const junction = 4,
  node_col = 11,
  corners = 6,
  stem_rows = 2;
const grow_ms = 0.38 * 520,
  pause_ms = 120,
  peel_ms = 0.62 * 520;
export const total_ms = 640,
  lead_ms = 40;
export type Cell = { width: number; height: number };
export type Motion = { start: number; cell: Cell };
export type Hero = { glyphs?: boolean; motion?: Motion | null };
type Glyph = "fade" | "line" | "half" | "junction" | "top_corner" | "bottom_corner" | "original" | "copy";
type Placement = {
  image: number;
  placement: number;
  x: number;
  y: number;
  z: number;
  crop?: { y: number; h: number };
};
class Frame {
  text: { col: number; row: number; glyph: Glyph }[] = [];
  placements: Placement[] = [];
  get len() {
    return this.text.length;
  }
  get placed() {
    return this.placements.length;
  }
  add(col: number, row: number, glyph: Glyph) {
    this.text.push({ col, row, glyph });
  }
  place(p: Omit<Placement, "z"> & { z?: number }) {
    this.placements.push({ z: 2, ...p });
  }
}
const first_id = 730100,
  last_id = 730115;
function branchId(up: boolean, k: number) {
  return first_id + 2 + (up ? 0 : corners + 1) + k;
}
export const remove = `\x1b_Ga=d,d=R,x=${first_id},y=${last_id},q=2\x1b\\`;
export function metrics(cell: Cell) {
  const cw = cell.width,
    ch = cell.height,
    t = Math.max(1, Math.floor((ch + 11) / 22));
  const h_top = Math.floor(Math.max(0, ch - t) / 2),
    v_left = Math.floor(Math.max(0, cw - t) / 2),
    cx = v_left + t / 2,
    cy = h_top + t / 2;
  return {
    cw,
    ch,
    t,
    h_top,
    v_left,
    cx,
    cy,
    r: Math.min(cx, cy, cw - cx, ch - cy),
  };
}
export function spring(x: number) {
  const zeta = 0.95 - 0.7 * 0.55,
    omega = 12,
    damped = omega * Math.sqrt(1 - zeta * zeta);
  const u = (v: number) =>
    1 - Math.exp(-zeta * omega * v) * (Math.cos(damped * v) + ((zeta * omega) / damped) * Math.sin(damped * v));
  return x >= 1 ? 1 : u(x) / u(1);
}
function ease(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}
export function moving(hero: Hero, now: number) {
  return !!hero.motion && now < hero.motion.start + total_ms;
}
function rest(f: Frame) {
  f.add(0, 1, "fade");
  for (let c = 1; c < junction; c++) f.add(c, 1, "line");
  f.add(junction, 1, "junction");
  f.add(junction, 0, "top_corner");
  f.add(junction, 2, "bottom_corner");
  for (let c = junction + 1; c < node_col; c++) {
    f.add(c, 0, "line");
    f.add(c, 2, "line");
  }
  f.add(node_col, 0, "original");
  f.add(node_col, 2, "copy");
  return f;
}
export function frameAt(hero: Hero, now: number) {
  const f = new Frame(),
    m = hero.motion;
  if (!m) return rest(f);
  const elapsed = now - m.start;
  if (elapsed < 0) return f;
  if (elapsed >= total_ms) return rest(f);
  const g = metrics(m.cell);
  f.add(0, 1, "fade");
  if (elapsed < grow_ms + pause_ms) {
    const tip = ease(Math.min(1, elapsed / grow_ms)) * (node_col * g.cw + g.cx);
    for (let c = 1; c < node_col; c++) {
      const covered = (tip - c * g.cw) / g.cw;
      if (covered >= 1) f.add(c, 1, "line");
      else if (covered >= 0.5) f.add(c, 1, "half");
    }
    f.place({
      image: first_id,
      placement: 1,
      x: Math.round(tip - g.cx),
      y: g.ch,
    });
    return f;
  }
  for (let c = 1; c < junction; c++) f.add(c, 1, "line");
  f.add(junction, 1, "half");
  const lift = spring((elapsed - grow_ms - pause_ms) / peel_ms) * g.ch,
    k = Math.min(corners, Math.round((Math.abs(lift) / (g.ch / 2)) * corners));
  const trunk = g.ch + g.h_top,
    x = junction * g.cw,
    up_top = g.ch - lift,
    down_top = g.ch + lift - stem_rows * g.ch,
    from = Math.max(0, Math.round(trunk - down_top));
  f.place({
    image: branchId(true, k),
    placement: 2,
    x,
    y: Math.round(up_top),
    crop: { y: 0, h: Math.max(1, Math.round(trunk + g.t - up_top)) },
  });
  f.place({
    image: branchId(false, k),
    placement: 3,
    x,
    y: Math.round(down_top) + from,
    crop: { y: from, h: Math.max(1, (stem_rows + 1) * g.ch - from) },
  });
  f.place({
    image: first_id + 1,
    placement: 4,
    x: node_col * g.cw,
    y: Math.round(g.ch + lift),
    z: 3,
  });
  f.place({
    image: first_id,
    placement: 5,
    x: node_col * g.cw,
    y: Math.round(up_top),
    z: 4,
  });
  return f;
}
export function draw(x: number, y: number, hero: Hero, now: number) {
  const f = frameAt(hero, now),
    style = (fg: palette.Token) => new palette.Style({ fg, bg: "surface" }).sgr();
  let out = "";
  const glyphs: Record<Glyph, string> = {
    fade: hero.glyphs ? "\uf5d3" : "─",
    line: "─",
    half: "╴",
    junction: "┤",
    top_corner: "╭",
    bottom_corner: "╰",
    original: hero.glyphs ? "\uf5f2" : "●",
    copy: hero.glyphs ? "\uf5f2" : "●",
  };
  for (const c of f.text)
    out += `\x1b[${y + c.row + 1};${x + c.col + 1}H${style(c.glyph === "original" ? "muted" : c.glyph === "copy" ? "accent" : "faint")}${glyphs[c.glyph]}`;
  const m = hero.motion;
  if (!m) return out;
  out += `\x1b7\x1b_Ga=d,d=r,x=${first_id},y=${last_id},q=2\x1b\\`;
  for (const p of f.placements) {
    const left = x * m.cell.width + p.x,
      top = y * m.cell.height + p.y,
      col = Math.floor(left / m.cell.width),
      row = Math.floor(top / m.cell.height);
    out += `\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${p.image},p=${p.placement},X=${left - col * m.cell.width},Y=${top - row * m.cell.height}`;
    if (p.crop) out += `,y=${p.crop.y},h=${p.crop.h}`;
    out += `,z=${p.z},C=1,q=2\x1b\\`;
  }
  return out + "\x1b8";
}
class Canvas {
  pixels: Buffer;
  constructor(
    public w: number,
    public h: number,
  ) {
    this.pixels = Buffer.alloc(w * h * 4);
  }
  fill(x0: number, y0: number, x1: number, y1: number, color: palette.Rgb, contains = (x: number, y: number) => true) {
    for (let py = Math.max(0, Math.floor(y0)); py < Math.min(this.h, Math.ceil(y1)); py++)
      for (let px = Math.max(0, Math.floor(x0)); px < Math.min(this.w, Math.ceil(x1)); px++) {
        let hits = 0;
        for (let sy = 0; sy < 4; sy++)
          for (let sx = 0; sx < 4; sx++) {
            const x = px + (sx + 0.5) / 4,
              y = py + (sy + 0.5) / 4;
            if (x >= x0 && x < x1 && y >= y0 && y < y1 && contains(x, y)) hits++;
          }
        const a = Math.floor((hits * 255) / 16),
          i = (py * this.w + px) * 4;
        if (hits && a >= this.pixels[i + 3]) {
          for (let j = 0; j < 3; j++) this.pixels[i + j] = color[j];
          this.pixels[i + 3] = a;
        }
      }
  }
  rect(x0: number, y0: number, x1: number, y1: number, color: palette.Rgb) {
    this.fill(x0, y0, x1, y1, color);
  }
}
function transmit(id: number, c: Canvas) {
  const encoded = deflateSync(c.pixels, { level: 1 }).toString("base64");
  let out = "";
  for (let off = 0; off < encoded.length; off += 4096) {
    const end = Math.min(off + 4096, encoded.length),
      more = Number(end < encoded.length);
    out += off === 0 ? `\x1b_Ga=t,t=d,f=32,o=z,s=${c.w},v=${c.h},i=${id},q=2,m=${more};` : `\x1b_Gm=${more};`;
    out += encoded.slice(off, end) + "\x1b\\";
  }
  return out;
}
export function upload(cell: Cell) {
  const g = metrics(cell);
  let out = "";
  for (const id of [first_id, first_id + 1]) {
    const c = new Canvas(g.cw, g.ch),
      color = palette.colors[id === first_id ? "muted" : "accent"];
    c.rect(0, g.h_top, Math.ceil(g.cx - g.r + g.t / 2), g.h_top + g.t, color);
    c.fill(0, 0, g.cw, g.ch, color, (x, y) => (x - g.cx) ** 2 + (y - g.cy) ** 2 <= g.r * g.r);
    out += transmit(id, c);
  }
  for (const up of [true, false])
    for (let k = 0; k <= corners; k++) {
      const c = new Canvas((node_col - junction) * g.cw, (stem_rows + 1) * g.ch),
        row = up ? 0 : stem_rows * g.ch,
        node_x = (node_col - junction) * g.cw,
        color = palette.colors.faint;
      if (k === 0) c.rect(0, row + g.h_top, node_x, row + g.h_top + g.t, color);
      else {
        const share = k / corners,
          ry = (g.ch / 2) * share,
          rx = (g.cw / 2) * share,
          cy = row + g.cy + (up ? ry : -ry),
          cx = g.cx + rx;
        if (up) c.rect(g.v_left, cy, g.v_left + g.t, c.h, color);
        else c.rect(g.v_left, 0, g.v_left + g.t, cy, color);
        c.fill(0, 0, g.cw, c.h, color, (x, y) => {
          const dx = x - cx,
            dy = y - cy;
          if (dx > 0 || (up ? dy > 0 : dy < 0)) return false;
          const f = (dx / rx) ** 2 + (dy / ry) ** 2 - 1,
            slope = Math.hypot((2 * dx) / (rx * rx), (2 * dy) / (ry * ry));
          return slope > 0 && Math.abs(f) / slope <= g.t / 2;
        });
        c.rect(g.cx + rx, row + g.h_top, node_x, row + g.h_top + g.t, color);
      }
      out += transmit(branchId(up, k), c);
    }
  return out;
}
