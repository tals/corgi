import * as tricks from "./tricks";
import * as palette from "./palette";
import * as text from "./text";
import * as trickStyle from "./trick_style";
import type { Brand } from "./process_name";
import { Rect } from "./layout";

export type Decoration = Pick<tricks.Decoration, "color" | "marker" | "suffix">;
export function decoration(
  views: tricks.View[],
  agent: Partial<Omit<tricks.Agent, "state">> & { state?: string },
  surface: tricks.Surface = "sidebar",
): Decoration {
  const result: Decoration = { suffix: [] };
  for (const view of views) {
    if (view.kind !== "decorate" || (view.surface ?? "sidebar") !== surface || !tricks.matches(view.where, agent))
      continue;
    if (view.color) result.color = view.color;
    if (view.marker) result.marker = view.marker;
    if (result.suffix.length && view.suffix.length) result.suffix.push({ text: " " });
    result.suffix.push(...view.suffix.map(span => ({ ...span, color: span.color ?? view.color })));
  }
  return result;
}
export const rgb = trickStyle.rgb;
export function fg(color: tricks.Color) {
  return palette.fgRgb(rgb(color));
}
export function width(spans: tricks.Span[]) {
  return spans.reduce((n, s) => n + (s.icon ? 2 : text.displayWidth(s.text)), 0);
}
export interface Icon {
  brand: Brand;
  x: number;
  y: number;
  covered: number;
}
export function write(
  w: text.Writer,
  spans: tricks.Span[],
  room: number,
  at?: { icons: Icon[]; x: number; y: number; covered: number },
  color: tricks.Color = "text",
) {
  let used = 0;
  for (const span of spans) {
    if (room <= 0) break;
    w.write((span.bold ? "\x1b[1m" : "\x1b[22m") + (span.italic ? "\x1b[3m" : "\x1b[23m"));
    if (span.icon) {
      if (room < 2) break;
      if (at) {
        at.icons.push({ brand: span.icon, x: at.x + used, y: at.y, covered: at.covered });
        w.splat(" ", 2);
      } else {
        const fallback = text.clipped(span.text, 2);
        w.write(fg(span.color ?? color) + fallback);
        w.splat(" ", 2 - text.displayWidth(fallback));
      }
      room -= 2;
      used += 2;
      continue;
    }
    const clipped = text.clipped(span.text, room);
    w.write(fg(span.color ?? color) + clipped);
    room -= text.displayWidth(clipped);
    used += text.displayWidth(clipped);
    if (clipped.length < span.text.length) break;
  }
  w.write("\x1b[22;23m");
}
/** A pane's appended content is a small overlay; its terminal stays opaque. */
export function pane(w: text.Writer, patch: Decoration, area: Rect, icons: Icon[] | null, covered: number): Rect[] {
  const boxes = overlays(
    w,
    patch.suffix.length ? [{ kind: "overlay", anchor: "top-right", lines: [patch.suffix] }] : [],
    area,
    icons,
    covered,
  );
  if (patch.marker && area.w > 0 && area.h > 0) {
    w.write(`\x1b[${area.y + 1};${area.x + 1}H\x1b[0m${fg(patch.marker)}▎\x1b[0m`);
    boxes.push(new Rect(area.x, area.y, 1, 1));
  }
  return boxes;
}
/** Read-only cards, inside the panes and below Corgi's dialogs. */
export function overlays(
  w: text.Writer,
  views: tricks.View[],
  area: Rect,
  icons: Icon[] | null = null,
  covered = 0,
): Rect[] {
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
      write(
        w,
        view.lines[row],
        cols - 2,
        icons ? { icons, x: x + 1, y: y + row, covered: covered + result.length + 1 } : undefined,
      );
    }
    w.write("\x1b[0m");
    result.push(new Rect(x, y, cols, height));
    offsets.set(view.anchor, offset + height + 1);
  }
  return result;
}
