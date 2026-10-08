export type RGB = { r: number; g: number; b: number };
function color(text: string): RGB | null {
  const m = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(text);
  if (m) {
    const parts = m.slice(1).map(s => Math.floor((parseInt(s, 16) * 255) / (16 ** s.length - 1)));
    return { r: parts[0], g: parts[1], b: parts[2] };
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
  }
  return null;
}
export class Theme {
  foreground: RGB | null = null;
  background: RGB | null = null;
  palette: (RGB | null)[] = Array(16).fill(null);
  merge(other: Theme) {
    if (other.foreground) this.foreground = other.foreground;
    if (other.background) this.background = other.background;
    other.palette.forEach((v, i) => {
      if (v) this.palette[i] = v;
    });
  }
  complete() {
    return !!this.foreground && !!this.background && this.palette.every(Boolean);
  }
  accept(body: string) {
    const fields = body.split(";");
    if (fields[0] === "4" && fields.length === 3 && /^\d+$/.test(fields[1])) {
      const n = Number(fields[1]),
        c = color(fields[2]);
      if (n >= 16 || !c) return false;
      this.palette[n] = c;
      return true;
    }
    if (["10", "11"].includes(fields[0]) && fields.length === 2) {
      const c = color(fields[1]);
      if (!c) return false;
      if (fields[0] === "10") this.foreground = c;
      else this.background = c;
      return true;
    }
    return false;
  }
}
