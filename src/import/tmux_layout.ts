import { Rect, max_panes } from "../layout";
export class Geometry {
  panes: { id: number; rect: Rect }[] = [];
  get count() {
    return this.panes.length;
  }
  find(id: string): Rect | null {
    if (!/^%\d+$/.test(id) || Number(id.slice(1)) > 0xffffffff) return null;
    return this.panes.find(p => p.id === Number(id.slice(1)))?.rect ?? null;
  }
}
export function checksum(text: string): number {
  let sum = 0;
  for (const byte of Buffer.from(text)) sum = (((sum >>> 1) | (sum << 15)) + byte) & 0xffff;
  return sum;
}
export function parse(text: string): Geometry {
  const fail = () => {
    throw Error("InvalidTmuxLayout");
  };
  if (!/^[0-9a-fA-F]{4},/.test(text) || parseInt(text.slice(0, 4), 16) !== checksum(text.slice(5))) fail();
  const body = text.slice(5),
    geometry = new Geometry();
  let pos = 0;
  function take(char: string): boolean {
    if (body[pos] !== char) return false;
    pos++;
    return true;
  }
  function expect(char: string) {
    if (!take(char)) fail();
  }
  function number(max = 65535): number {
    const match = /^\d+/.exec(body.slice(pos));
    if (!match) return fail() as never;
    pos += match[0].length;
    const n = Number(match[0]);
    if (n > max) fail();
    return n;
  }
  function cell(depth: number): void {
    if (depth >= max_panes) fail();
    const w = number();
    expect("x");
    const h = number();
    expect(",");
    const x = number();
    expect(",");
    const y = number();
    if (!w || !h) fail();
    const close = take("{") ? "}" : take("[") ? "]" : null;
    if (close) {
      cell(depth + 1);
      while (take(",")) cell(depth + 1);
      expect(close);
    } else {
      expect(",");
      const id = number(0xffffffff);
      if (geometry.count === max_panes) throw Error("TooManyPanes");
      if (geometry.panes.some(p => p.id === id)) fail();
      geometry.panes.push({ id, rect: new Rect(x, y, w, h) });
    }
  }
  cell(0);
  if (pos !== body.length) fail();
  return geometry;
}
