import * as startup from "./startup";
import * as i18n from "./i18n";
import * as palette from "./palette";
import { Rect } from "./layout";
import { Writer, displayWidth, ellipsis } from "./text";
import type { Action } from "./action";

export function elapsed(wait: startup.Wait, now: number): string {
  const seconds = Math.max(0, Math.floor((now - wait.started_at) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function banner(waits: startup.Wait[], width: number, height: number, now: number) {
  const shown = waits.filter(w => now - w.started_at >= 500),
    count = shown.length;
  if (!count || width < 20 || height < 1) return null;
  const first = shown[0],
    title = i18n.t`${count} waiting`,
    text = ` ${title} · ${startup.label(first)} ${elapsed(first, now)} `,
    w = Math.min(width, 70, displayWidth(text));
  return { rect: new Rect(width - w, height - 1, w, 1), text: ellipsis(text, w) };
}
export function drawBanner(w: Writer, bar: NonNullable<ReturnType<typeof banner>>) {
  w.write(
    w.cup(bar.rect.y + 1, bar.rect.x + 1) +
      new palette.Style({ fg: "strong", bg: "surface" }).sgr() +
      bar.text +
      "\x1b[0m",
  );
}
export function geometry(width: number, height: number, count: number): Rect | null {
  if (width < 30 || height < 10) return null;
  const w = Math.min(width - 2, 86),
    h = Math.min(height - 2, Math.max(1, count) * 3 + 5);
  return new Rect(Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h);
}
const killLabel = () => i18n.t`[x Kill]`;
const killX = (rect: Rect) => rect.x + rect.w - 3 - displayWidth(killLabel());
export class State {
  selected: string | null = null;
  index(waits: startup.Wait[]) {
    return Math.max(
      0,
      waits.findIndex(w => w.id === this.selected),
    );
  }
  sync(waits: startup.Wait[]) {
    this.selected = waits[this.index(waits)]?.id ?? null;
  }
  move(waits: startup.Wait[], step: number) {
    if (waits.length) this.selected = waits[(this.index(waits) + step + waits.length) % waits.length].id;
  }
  key(key: string): Action | null {
    switch (key) {
      case "\x1b":
      case "q":
        return { name: "startup-close" };
      case "\x1b[A":
      case "k":
        return { name: "startup-prev" };
      case "\x1b[B":
      case "j":
      case "\t":
        return { name: "startup-next" };
      case "x":
        return this.selected ? { name: "startup-kill", value: this.selected } : null;
      case "\r":
        return this.selected ? { name: "startup-go", value: this.selected } : null;
      default:
        return null;
    }
  }
  private offset(rect: Rect, waits: startup.Wait[]) {
    return Math.max(0, this.index(waits) - Math.floor((rect.h - 5) / 3) + 1);
  }
  hit(rect: Rect, waits: startup.Wait[], x: number, y: number): Action | null {
    if (!rect.contains(x, y)) return { name: "startup-close" };
    if (y === rect.y + rect.h - 2) {
      if (x >= killX(rect) && this.selected) return { name: "startup-kill", value: this.selected };
      return this.selected ? { name: "startup-go", value: this.selected } : null;
    }
    const rows = Math.floor((rect.h - 5) / 3),
      index = Math.floor((y - rect.y - 2) / 3) + this.offset(rect, waits);
    if (y >= rect.y + 2 && y < rect.y + 2 + rows * 3 && waits[index])
      return { name: "startup-select", value: waits[index].id };
    return null;
  }
  draw(w: Writer, rect: Rect, waits: startup.Wait[], now: number) {
    this.sync(waits);
    const base = new palette.Style({ fg: "text", bg: "surface" }).sgr(),
      line = new palette.Style({ fg: "line", bg: "surface" }).sgr();
    for (let row = 0; row < rect.h; row++) {
      const edge = row === 0 || row === rect.h - 1;
      w.write(
        w.cup(rect.y + row + 1, rect.x + 1) +
          line +
          (row === 0 ? "┌" : row === rect.h - 1 ? "└" : "│") +
          (edge ? "─" : " ").repeat(rect.w - 2) +
          (row === 0 ? "┐" : row === rect.h - 1 ? "┘" : "│"),
      );
    }
    const at = (row: number, text: string, style = base, width = rect.w - 4) =>
      w.write(w.cup(rect.y + row + 1, rect.x + 3) + style + ellipsis(text, width));
    const count = waits.length;
    at(0, i18n.t` Startup waits (${count}) `);
    if (!count) at(2, i18n.t`Nothing is waiting`);
    const offset = this.offset(rect, waits),
      rows = Math.floor((rect.h - 5) / 3);
    for (const [i, wait] of waits.slice(offset, offset + rows).entries()) {
      const text = `${wait.id === this.selected ? "›" : " "} ${startup.label(wait)} · ${elapsed(wait, now)}`;
      at(2 + i * 3, text, new palette.Style({ fg: wait.cancelled ? "warm" : "strong", bg: "surface" }).sgr());
      at(3 + i * 3, `  ${wait.detail || i18n.t`Waiting for a response`}`);
    }
    at(
      rect.h - 2,
      i18n.t`↵ Show pane · Esc Close`,
      base,
      this.selected ? Math.max(0, killX(rect) - rect.x - 3) : rect.w - 4,
    );
    if (this.selected)
      w.write(
        w.cup(rect.y + rect.h - 1, killX(rect) + 1) +
          new palette.Style({ fg: "warm", bg: "surface" }).sgr() +
          killLabel(),
      );
    w.write("\x1b[0m");
  }
}
