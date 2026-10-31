import * as tricks from "./tricks";
import * as palette from "./palette";
import * as text from "./text";
import * as trickStyle from "./trick_style";
import type { Brand } from "./process_name";
import { Rect } from "./layout";

export type Decoration = Pick<tricks.Decoration, "color" | "marker" | "suffix" | "content">;
export function decoration(
  views: tricks.View[],
  agent: Partial<Omit<tricks.Agent, "state">> & { state?: string },
  surface: tricks.Surface = "sidebar",
): Decoration {
  const result: Decoration = { suffix: [] };
  const children: tricks.Element[] = [];
  for (const view of views) {
    if (view.kind !== "decorate" || (view.surface ?? "sidebar") !== surface || !tricks.matches(view.where, agent))
      continue;
    if (view.color) result.color = view.color;
    if (view.marker) result.marker = view.marker;
    if (result.suffix.length && view.suffix.length) result.suffix.push({ text: " " });
    result.suffix.push(...view.suffix.map(span => ({ ...span, color: span.color ?? view.color })));
    if (view.suffix.length)
      children.push({ kind: "text", spans: view.suffix.map(span => ({ ...span, color: span.color ?? view.color })) });
    if (view.content) children.push(tint(view.content, view.color));
    if (view.content) result.content = view.content;
  }
  if (result.content) {
    result.content = { kind: "row", children };
    result.suffix = [];
  }
  return result;
}
function tint(node: tricks.Element, color?: tricks.Color): tricks.Element {
  if (node.kind === "row" || node.kind === "column")
    return { ...node, children: node.children.map(child => tint(child, color)) };
  return { ...node, spans: node.spans.map(span => ({ ...span, color: span.color ?? color })) };
}
export interface Hit {
  action: string;
  slot: string;
  rect: Rect;
  covered: number;
}
export interface Controls {
  hits: Hit[];
  focus: string | null;
  popover?: { rect: Rect; anchor: { x: number; y: number } } | null;
}
export function containsPopover(controls: Controls, x: number, y: number) {
  const popup = controls.popover;
  return (
    !!popup &&
    (popup.rect.contains(x, y) ||
      (x >= popup.anchor.x && x < popup.rect.x && y >= popup.anchor.y && y <= popup.anchor.y + 1))
  );
}
export function measure(node: tricks.Element): { w: number; h: number } {
  if (node.kind === "text" || node.kind === "button")
    return { w: width(node.spans) + (node.kind === "button" ? 4 : 0), h: 1 };
  const sizes = node.children.map(measure);
  return node.kind === "row"
    ? {
        w: sizes.reduce((n, s) => n + s.w, Math.max(0, sizes.length - 1)),
        h: Math.max(0, ...sizes.map(s => s.h)),
      }
    : { w: Math.max(0, ...sizes.map(s => s.w)), h: sizes.reduce((n, s) => n + s.h, 0) };
}
export function content(patch: Decoration): tricks.Element {
  return patch.content ?? { kind: "text", spans: patch.suffix };
}
export function contentSize(patch: Decoration) {
  return patch.content ? measure(patch.content) : { w: width(patch.suffix), h: Number(patch.suffix.length > 0) };
}
/** Native layout and hit testing reuse the cached tree; no trick code runs here. */
export function draw(
  w: text.Writer,
  node: tricks.Element,
  area: Rect,
  icons: Icon[] | null = null,
  covered = 0,
  controls: Controls | null = null,
  color: tricks.Color = "text",
  offset = 0,
): void {
  if (area.w <= 0 || area.h <= 0) return;
  if (node.kind === "row" || node.kind === "column") {
    let used = 0;
    for (const child of node.children) {
      const size = measure(child);
      const row = node.kind === "row";
      const rect = row
        ? new Rect(area.x + used, area.y, Math.min(size.w, area.w - used), area.h)
        : new Rect(area.x, area.y + used, area.w, Math.min(size.h, area.h - used));
      draw(w, child, rect, icons, covered, controls, color, offset);
      used += row ? size.w + 1 : size.h;
      if (used >= (row ? area.w : area.h)) break;
    }
    return;
  }
  const button = node.kind === "button";
  const cols = width(node.spans) + (button ? 4 : 0);
  // A clipped control must never be clickable as though it were complete.
  if (button && cols > area.w) return;
  w.write(w.cup(area.y + 1, area.x + 1));
  const focused = button && controls?.focus === (node.slot ?? node.action);
  if (focused) w.write("\x1b[7m");
  if (button) w.write(fg("accent") + "[ ");
  write(
    w,
    node.spans,
    area.w - (button ? 4 : 0),
    icons ? { icons, x: area.x + offset + (button ? 2 : 0), y: area.y, covered } : undefined,
    color,
  );
  if (button) {
    w.write(fg("accent") + " ]");
    controls?.hits.push({
      action: node.action,
      slot: node.slot ?? node.action,
      rect: new Rect(area.x + offset, area.y, cols, 1),
      covered,
    });
  }
  if (focused) w.write("\x1b[27m");
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
export function pane(
  w: text.Writer,
  patch: Decoration,
  area: Rect,
  icons: Icon[] | null,
  covered: number,
  controls: Controls | null = null,
): Rect[] {
  const boxes = overlays(
    w,
    patch.content || patch.suffix.length
      ? [
          {
            kind: "overlay",
            anchor: "top-right",
            lines: patch.suffix.length ? [patch.suffix] : [],
            content: patch.content,
          },
        ]
      : [],
    area,
    icons,
    covered,
    controls,
  );
  if (patch.marker && area.w > 0 && area.h > 0) {
    w.write(`\x1b[${area.y + 1};${area.x + 1}H\x1b[0m${fg(patch.marker)}▎\x1b[0m`);
    boxes.push(new Rect(area.x, area.y, 1, 1));
  }
  return boxes;
}
/** Cards inside the panes and below Corgi's dialogs. */
export function overlays(
  w: text.Writer,
  views: tricks.View[],
  area: Rect,
  icons: Icon[] | null = null,
  covered = 0,
  controls: Controls | null = null,
): Rect[] {
  const result: Rect[] = [],
    offsets = new Map<string, number>();
  if (area.w < 4 || area.h < 3) return result;
  for (const view of views) {
    if (view.kind !== "overlay" || (!view.lines.length && !view.content)) continue;
    const node: tricks.Element = view.content ?? {
      kind: "column",
      children: view.lines.map(spans => ({ kind: "text", spans })),
    };
    const size = measure(node);
    const offset = offsets.get(view.anchor) ?? 1;
    const height = Math.min(12, size.h, area.h - offset - 1);
    if (height <= 0) continue;
    const cols = Math.min(62, area.w - 2, size.w + 2);
    const x = view.anchor.endsWith("right") ? area.x + area.w - cols - 1 : area.x + 1;
    const y = view.anchor.startsWith("bottom") ? area.y + area.h - offset - height : area.y + offset;
    for (let row = 0; row < height; row++) {
      w.write(`\x1b[${y + row + 1};${x + 1}H\x1b[0m${palette.bg("surface")}`);
      w.splat(" ", cols);
    }
    draw(w, node, new Rect(x + 1, y, cols - 2, height), icons, covered + result.length + 1, controls);
    w.write("\x1b[0m");
    result.push(new Rect(x, y, cols, height));
    offsets.set(view.anchor, offset + height + 1);
  }
  return result;
}
