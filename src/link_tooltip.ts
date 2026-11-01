import * as i18n from "./i18n";
import type { Target as AgentTarget } from "./sidebar";
import type { Cell } from "./fork_hero";
import type { Link as TerminalLink } from "./pane/hyperlinks";
import { Rect } from "./layout";
import * as palette from "./palette";
import { Writer, displayWidth } from "./text";
export interface Source {
  updateRender(): void;
  hyperlinks(): TerminalLink[];
}
export interface Link {
  source: Source;
  id: bigint;
  uri: string;
  x: number;
  y: number;
}
/** A link in a terminal drawn inside `rect`, at screen coordinates (`x`, `y`). */
export function at(source: Source, rect: Rect, x: number, y: number): Link | null {
  if (!rect.contains(x, y)) return null;
  source.updateRender();
  const link = source
    .hyperlinks()
    .find(link => link.row === y - rect.y && link.start <= x - rect.x && x - rect.x < link.end);
  return link ? { source, id: link.id, uri: link.uri, x, y } : null;
}
export function sameLink(a: Link | null | undefined, b: Link | null | undefined): boolean {
  return a?.source === b?.source && a?.id === b?.id && a?.uri === b?.uri;
}
/** A picture of a linked image, `width` by `height` pixels on a host whose
 * cells measure `cell`. One shrunk to fit the screen keeps the picture it
 * shrinks as `of`, and covers whole cells. */
export interface Thumbnail {
  width: number;
  height: number;
  cell: Cell;
  of?: Thumbnail;
}
export interface Card {
  link: Link;
  copied: boolean;
  thumbnail: Thumbnail | null;
}
/** The path a file:// link names, which the card copies instead of the URL. */
export function filePath(uri: string): string | null {
  if (!/^file:/i.test(uri)) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}
/** The cells a thumbnail covers. */
export function thumbnailCells(t: Thumbnail): { cols: number; rows: number } {
  return { cols: Math.ceil(t.width / t.cell.width), rows: Math.ceil(t.height / t.cell.height) };
}
export interface Target {
  link?: Link;
  resource?: number | null;
  git?: number | null;
  worktree?: number | null;
  usage?: boolean;
  conversation?: number;
  agent?: AgentTarget | null;
}
function same(a: Target, b: Target) {
  return (
    sameLink(a.link, b.link) &&
    (a.resource ?? null) === (b.resource ?? null) &&
    (a.git ?? null) === (b.git ?? null) &&
    (a.worktree ?? null) === (b.worktree ?? null) &&
    (a.usage ?? false) === (b.usage ?? false) &&
    (a.conversation ?? 0) === (b.conversation ?? 0) &&
    JSON.stringify(a.agent ?? null) === JSON.stringify(b.agent ?? null)
  );
}
function delay(target: Target | null): number {
  return target?.resource != null || target?.link != null ? 150 : 500;
}
/** The card under or over the link at `anchor`, with `thumbnail` under a
 * rule below its copy row. A thumbnail that fits neither below nor above the
 * link gets null, and the card goes without it. */
export function geometry(
  width: number,
  height: number,
  anchor: { x: number; y: number },
  thumbnail: Thumbnail | null = null,
): Rect | null {
  const cells = thumbnail ? thumbnailCells(thumbnail) : { cols: 0, rows: 0 };
  const w = Math.max(
      17,
      ...[i18n.t` ✓  Copied`, i18n.t` ⧉  Copy path`, i18n.t` ⧉  Copy link`].map(label => displayWidth(label) + 4),
      cells.cols + 2,
    ),
    h = 3 + (thumbnail ? cells.rows + 1 : 0);
  if (width < w || height < h + 1) return null;
  const below = anchor.y + h < height;
  if (thumbnail && !below && anchor.y < h) return null;
  return new Rect(Math.max(0, Math.min(anchor.x, width - w)), below ? anchor.y + 1 : Math.max(0, anchor.y - h), w, h);
}
/** `t`, shrunk if it must be for its card to fit beside `anchor` on a
 * `width` by `height` screen; null when even a small one wouldn't. */
export function fit(width: number, height: number, anchor: { x: number; y: number }, t: Thumbnail): Thumbnail | null {
  if (geometry(width, height, anchor, t)) return t;
  // The card adds a border, a copy row and a rule to the picture's rows.
  const space = { cols: width - 2, rows: Math.max(height - anchor.y - 5, anchor.y - 4) };
  const scale = Math.min((space.cols * t.cell.width) / t.width, (space.rows * t.cell.height) / t.height),
    cols = Math.min(space.cols, Math.max(1, Math.round((t.width * scale) / t.cell.width))),
    rows = Math.min(space.rows, Math.max(1, Math.round((t.height * scale) / t.cell.height)));
  if (rows < 3) return null;
  const shrunk = { width: cols * t.cell.width, height: rows * t.cell.height, cell: t.cell, of: t };
  return geometry(width, height, anchor, shrunk) ? shrunk : null;
}
export function copyAt(rect: Rect, x: number, y: number): boolean {
  return y === rect.y + 1 && x > rect.x && x < rect.x + rect.w - 1;
}
export function draw(w: Writer, rect: Rect, card: Card, hovered: boolean): void {
  const border = new palette.Style({ fg: "line", bg: "surface" }).sgr();
  const rule = "─".repeat(rect.w - 2);
  const label = card.copied
    ? i18n.t` ✓  Copied`
    : filePath(card.link.uri) !== null
      ? i18n.t` ⧉  Copy path`
      : i18n.t` ⧉  Copy link`;
  w.write(border + `\x1b[${rect.y + 1};${rect.x + 1}H┌${rule}┐`);
  w.write(`\x1b[${rect.y + 2};${rect.x + 1}H│`);
  w.write(new palette.Style({ fg: "strong", bg: hovered ? "selected" : "surface" }).sgr());
  w.write(label);
  w.splat(" ", rect.w - 2 - displayWidth(label));
  w.write(border + "│");
  if (rect.h > 3) w.write(`\x1b[${rect.y + 3};${rect.x + 1}H├${rule}┤`);
  // The thumbnail draws over these rows.
  for (let y = rect.y + 3; y < rect.y + rect.h - 1; y++)
    w.write(`\x1b[${y + 1};${rect.x + 1}H│${" ".repeat(rect.w - 2)}│`);
  w.write(`\x1b[${rect.y + rect.h};${rect.x + 1}H└${rule}┘\x1b[0m`);
}
export class State {
  suppressed = true;
  target: Target | null = null;
  since = 0;
  shown = false;
  copied_until = 0;
  cancel() {
    this.suppressed = true;
    this.target = null;
    this.shown = false;
    this.copied_until = 0;
  }
  move() {
    this.suppressed = false;
    this.target = null;
    this.shown = false;
    this.copied_until = 0;
  }
  due(now: number) {
    return !this.suppressed && this.target !== null && !this.shown && now - this.since >= delay(this.target);
  }
  ready(target: Target | null, now: number) {
    if (this.suppressed || !target) {
      this.target = null;
      this.shown = false;
      this.copied_until = 0;
      return false;
    }
    if (!this.target || !same(this.target, target)) {
      this.target = target;
      this.since = now;
      this.shown = false;
      this.copied_until = 0;
      return false;
    }
    this.shown = now - this.since >= delay(target);
    return this.shown;
  }
}
