import * as tricks from "./tricks";
import * as palette from "./palette";
import * as text from "./text";
import { Rect } from "./layout";

export type Decoration = Pick<tricks.Decoration, "color" | "marker" | "suffix">;
export function decoration(
  views: tricks.View[],
  agent: Partial<Omit<tricks.Agent, "state">> & { state?: string },
): Decoration {
  const result: Decoration = { suffix: [] };
  for (const view of views) {
    if (view.kind !== "decorate" || !tricks.matches(view.where, agent)) continue;
    if (view.color) result.color = view.color;
    if (view.marker) result.marker = view.marker;
    result.suffix.push(...view.suffix);
  }
  return result;
}
export function rgb(color: tricks.Color): palette.Rgb {
  if (color.startsWith("#")) return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) as palette.Rgb;
  return palette.colors[color as palette.Token];
}
export function fg(color: tricks.Color) {
  return palette.fgRgb(rgb(color));
}
export function width(spans: tricks.Span[]) {
  return spans.reduce((n, s) => n + text.displayWidth(s.text), 0);
}
export function write(w: text.Writer, spans: tricks.Span[], room: number) {
  for (const span of spans) {
    if (room <= 0) break;
    const clipped = text.clipped(span.text, room);
    w.write(fg(span.color ?? "text") + clipped);
    room -= text.displayWidth(clipped);
    if (clipped.length < span.text.length) break;
  }
}
/** Read-only cards, inside the panes and below Corgi's dialogs. */
export function overlays(w: text.Writer, views: tricks.View[], area: Rect): Rect[] {
  const result: Rect[] = [],
    offsets = new Map<string, number>();
  if (area.w < 4 || area.h < 3) return result;
  for (const view of views) {
    if (view.kind !== "overlay" || !view.lines.length) continue;
    const offset = offsets.get(view.anchor) ?? 1;
    const height = Math.min(view.lines.length, area.h - offset - 1);
    if (height <= 0) continue;
    const cols = Math.min(62, area.w - 2, Math.max(...view.lines.map(line => width(line))) + 2);
    const x = view.anchor.endsWith("right") ? area.x + area.w - cols - 1 : area.x + 1;
    const y = view.anchor.startsWith("bottom") ? area.y + area.h - offset - height : area.y + offset;
    for (let row = 0; row < height; row++) {
      w.write(`\x1b[${y + row + 1};${x + 1}H\x1b[0m${palette.bg("surface")}`);
      w.splat(" ", cols);
      w.write(`\x1b[${y + row + 1};${x + 2}H`);
      write(w, view.lines[row], cols - 2);
    }
    w.write("\x1b[0m");
    result.push(new Rect(x, y, cols, height));
    offsets.set(view.anchor, offset + height + 1);
  }
  return result;
}
