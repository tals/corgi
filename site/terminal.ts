/**
 * A terminal just big enough for what Corgi draws: cursor moves, SGR and
 * clears; titles, hyperlinks, pointer shapes and images are skipped. The
 * recorder reads Corgi's frames through it, and the page reads the rows it
 * has Corgi draw live.
 *
 * A cell is [text, fg, bg, bold, underline, underline color], with colors
 * named by palette token where Corgi's palette has them and #rrggbb otherwise.
 */
import * as palette from "../src/palette";

export type Cell = [string, string | null, string | null, boolean, number, string | null];
const tokens = new Map(Object.entries(palette.colors).map(([token, rgb]) => [rgb.join(","), token]));
const color = (rgb: number[]) =>
  tokens.get(rgb.join(",")) ?? "#" + rgb.map(n => n.toString(16).padStart(2, "0")).join("");
export const blankCell = (): Cell => [" ", null, null, false, 0, null];
/** Sequences the terminal skipped, for the recorder to report. */
export const unknown = new Set<string>();

export class Screen {
  grid: Cell[][] = [];
  x = 0;
  y = 0;
  saved: [number, number] = [0, 0];
  fg: string | null = null;
  bg: string | null = null;
  bold = false;
  inverse = false;
  ul = 0;
  ulc: string | null = null;
  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.clear();
  }
  clear() {
    this.grid = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, blankCell));
  }
  reset() {
    this.fg = this.bg = this.ulc = null;
    this.bold = this.inverse = false;
    this.ul = 0;
  }
  put(ch: string) {
    if (this.y >= 0 && this.y < this.rows && this.x >= 0 && this.x < this.cols)
      this.grid[this.y][this.x] = this.inverse
        ? [ch, this.bg ?? "bg", this.fg ?? "text", this.bold, this.ul, this.ulc]
        : [ch, this.fg, this.bg, this.bold, this.ul, this.ulc];
    this.x += 1;
  }
  sgr(params: string) {
    const parts = params ? params.split(";") : ["0"];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.includes(":")) {
        const sub = p.split(":");
        const rgb = () =>
          sub
            .slice(2)
            .filter(s => s !== "")
            .map(Number)
            .slice(-3);
        if (sub[0] === "4") this.ul = Number(sub[1] || 0);
        else if (sub[0] === "58") this.ulc = color(rgb());
        else if (sub[0] === "38") this.fg = color(rgb());
        else if (sub[0] === "48") this.bg = color(rgb());
        continue;
      }
      const n = Number(p || 0);
      if (n === 0) this.reset();
      else if (n === 1) this.bold = true;
      else if (n === 22) this.bold = false;
      else if (n === 7) this.inverse = true;
      else if (n === 27) this.inverse = false;
      else if (n === 4) this.ul = 1;
      else if (n === 24) this.ul = 0;
      else if ((n === 38 || n === 48 || n === 58) && parts[i + 1] === "2") {
        const c = color([Number(parts[i + 2]), Number(parts[i + 3]), Number(parts[i + 4])]);
        if (n === 38) this.fg = c;
        else if (n === 48) this.bg = c;
        else this.ulc = c;
        i += 4;
      } else if (n === 39) this.fg = null;
      else if (n === 49) this.bg = null;
      else if (n === 59) this.ulc = null;
      else unknown.add(`SGR ${n}`);
    }
  }
  feed(data: string) {
    const chars = Array.from(data);
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === "\x1b") {
        const next = chars[i + 1];
        if (next === "[") {
          let j = i + 2,
            priv = "",
            params = "";
          if (/[?>=]/.test(chars[j])) priv = chars[j++];
          while (j < chars.length && /[0-9;:]/.test(chars[j])) params += chars[j++];
          while (j < chars.length && /[ -/]/.test(chars[j])) j++;
          const final = chars[j];
          i = j;
          if (priv) continue;
          const nums = params.split(";");
          switch (final) {
            case "H":
              this.y = Number(nums[0] || 1) - 1;
              this.x = nums.length > 1 ? Number(nums[1] || 1) - 1 : 0;
              break;
            case "J":
              this.clear();
              break;
            case "m":
              this.sgr(params);
              break;
            case "C":
              this.x += Number(params || 1);
              break;
            case "G":
              this.x = Number(params || 1) - 1;
              break;
            default:
              unknown.add(`CSI ${params}${final}`);
          }
          continue;
        }
        if (next === "]" || next === "_" || next === "P" || next === "^") {
          let j = i + 2;
          while (j < chars.length && chars[j] !== "\x07" && !(chars[j] === "\x1b" && chars[j + 1] === "\\")) j++;
          i = chars[j] === "\x07" ? j : j + 1;
          continue;
        }
        if (next === "7") this.saved = [this.x, this.y];
        else if (next === "8") [this.x, this.y] = this.saved;
        i += 1;
        continue;
      }
      if (c === "\n") {
        this.y += 1;
        this.x = 0;
      } else if (c === "\r") this.x = 0;
      else this.put(c);
    }
  }
}
export function grid(ansi: string, cols: number, rows: number): Cell[][] {
  const s = new Screen(cols, rows);
  s.feed(ansi);
  return s.grid;
}
/** One row of Corgi's drawing, as cells. */
export const row = (ansi: string, cols: number) => grid(ansi, cols, 1)[0];
