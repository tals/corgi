import * as details from "./connectivity_details";
import * as palette from "./palette";
import * as text from "./text";
import { Rect } from "./layout";

export interface Header {
  machine: string;
  rect: Rect;
}
export interface Card {
  rect: Rect;
  lines: details.Line[];
}
export class Hover {
  private target: Header | null = null;
  private since = 0;
  private updated = -Infinity;
  card: Card | null = null;
  get machine(): string | null {
    return this.target?.machine ?? null;
  }
  due(): number {
    return this.target && !this.card ? this.since + 1000 : Infinity;
  }
  clear(): void {
    this.target = null;
    this.card = null;
    this.updated = -Infinity;
  }
  move(header: Header | null, x: number, y: number, now: number): void {
    if (this.card?.rect.contains(x, y)) return;
    if (!header) return this.clear();
    if (header.machine !== this.target?.machine || header.rect.y !== this.target.rect.y) {
      this.clear();
      this.since = now;
    }
    this.target = header;
  }
  update(connection: details.Connection | null, cols: number, rows: number, now: number): Card | null {
    if (!this.target || !connection || connection.name !== this.target.machine || cols < 32 || rows < 12) {
      this.clear();
      return null;
    }
    if (now - this.since < 1000) return null;
    const width = Math.min(76, cols - 2);
    const lines =
      this.card && this.card.rect.w === width && now - this.updated < 1000
        ? this.card.lines
        : details.lines(connection, width - 4, now);
    if (lines !== this.card?.lines) this.updated = now;
    const height = Math.min(rows - 2, lines.length + 2);
    const rect = new Rect(
      Math.max(1, Math.min(this.target.rect.x + this.target.rect.w, cols - width - 1)),
      Math.max(1, Math.min(this.target.rect.y, rows - height - 1)),
      width,
      height,
    );
    return (this.card = { rect, lines });
  }
}

export function draw(w: text.Writer, card: Card): void {
  const { rect, lines } = card;
  const style = new palette.Style({ fg: "text", bg: "surface" }).sgr();
  for (let y = 0; y < rect.h; y++) {
    w.write(w.cup(rect.y + y + 1, rect.x + 1) + style);
    w.splat(" ", rect.w);
  }
  lines.slice(0, rect.h - 2).forEach((line, i) => {
    w.write(w.cup(rect.y + i + 2, rect.x + 3));
    w.write(new palette.Style({ fg: line.color ?? "text", bg: "surface", bold: line.heading ?? false }).sgr());
    text.writeEllipsis(w, line.text, rect.w - 4);
    w.write(details.heat(line, rect.x + 2 + w.column, rect.y + i + 1, rect.w - 4));
  });
  w.write("\x1b[0m\x1b[?25l");
}
