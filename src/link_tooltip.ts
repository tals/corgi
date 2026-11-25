import * as i18n from "./i18n";
import * as viewerRef from "./viewer_ref";
import type { Cell } from "./fork_hero";
import type { Image } from "./host_images";
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
  /** A file path found in plain text (see `file_ref.ts`). */
  path?: boolean;
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
  return link ? { source, id: link.id, uri: link.uri, path: link.path === true, x, y } : null;
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
  /** Its picture, once loaded. */
  image?: Image;
}
export interface Card {
  link: Link;
  copied: boolean;
  thumbnail: Thumbnail | null;
  open_image?: string;
  keys: Keys;
}
/** The keycaps of the card's actions under the current shortcuts; null where unbound. */
export interface Keys {
  copy: string | null;
  open: string | null;
}
export const no_keys: Keys = { copy: null, open: null };
/** A card's rows: Copy always, then Open when the image opens here. */
export interface Rows {
  open: boolean;
  keys: Keys;
}
export function rows(card: Card): Rows {
  return { open: !!card.open_image, keys: card.keys };
}
export type Button = "copy" | "open";
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
  /** The link names a file on this machine, which a peek shows. */
  file?: boolean;
  resource?: viewerRef.Workspace | null;
  git?: viewerRef.Workspace | null;
  worktree?: viewerRef.Workspace | null;
  usage?: boolean;
  conversation?: number;
  agent?: viewerRef.Agent | null;
}
function same(a: Target, b: Target) {
  return (
    sameLink(a.link, b.link) &&
    // A link found to name a file turns from a copy card into a peek.
    (a.file ?? false) === (b.file ?? false) &&
    (a.resource ?? null) === (b.resource ?? null) &&
    (a.git ?? null) === (b.git ?? null) &&
    (a.worktree ?? null) === (b.worktree ?? null) &&
    (a.usage ?? false) === (b.usage ?? false) &&
    (a.conversation ?? 0) === (b.conversation ?? 0) &&
    (a.agent ?? null) === (b.agent ?? null)
  );
}
/** How long the pointer rests on a target before its card opens; a file's
 * peek waits as a link's card does. */
function delay(target: Target | null): number {
  return target?.resource != null || target?.link != null ? 150 : 500;
}
/** The keycap column: wide enough for each shown row's key, or a ✓. */
function capWidth(r: Rows): number {
  const keys = [r.keys.copy, r.open ? r.keys.open : null].filter(key => key !== null);
  return Math.max(3, ...keys.map(key => displayWidth(key) + 2));
}
/** The card under or over the link at `anchor`: its action rows, then
 * `thumbnail` under a rule. A thumbnail that fits neither below nor above
 * the link gets null, and the card goes without it. */
export function geometry(
  width: number,
  height: number,
  anchor: { x: number; y: number },
  thumbnail: Thumbnail | null = null,
  r: Rows = { open: false, keys: no_keys },
): Rect | null {
  const cells = thumbnail ? thumbnailCells(thumbnail) : { cols: 0, rows: 0 };
  const labels = [i18n.t`Copied`, i18n.t`Copy path`, i18n.t`Copy link`, ...(r.open ? [openLabel()] : [])];
  const w = Math.max(17, 4 + capWidth(r) + Math.max(...labels.map(displayWidth)) + 1, cells.cols + 2),
    h = 3 + Number(r.open) + (thumbnail ? cells.rows + 1 : 0);
  if (width < w || height < h + 1) return null;
  const below = anchor.y + h < height;
  if ((thumbnail || r.open) && !below && anchor.y < h) return null;
  return new Rect(Math.max(0, Math.min(anchor.x, width - w)), below ? anchor.y + 1 : Math.max(0, anchor.y - h), w, h);
}
/** `t`, shrunk if it must be for its card to fit beside `anchor` on a
 * `width` by `height` screen; null when even a small one wouldn't. */
export function fit(
  width: number,
  height: number,
  anchor: { x: number; y: number },
  t: Thumbnail,
  r: Rows = { open: false, keys: no_keys },
): Thumbnail | null {
  if (geometry(width, height, anchor, t, r)) return t;
  // The card adds a border, its action rows and a rule to the picture's rows.
  const space = { cols: width - 2, rows: Math.max(height - anchor.y - 5, anchor.y - 4) - Number(r.open) };
  const scale = Math.min((space.cols * t.cell.width) / t.width, (space.rows * t.cell.height) / t.height),
    cols = Math.min(space.cols, Math.max(1, Math.round((t.width * scale) / t.cell.width))),
    rows = Math.min(space.rows, Math.max(1, Math.round((t.height * scale) / t.cell.height)));
  if (rows < 3) return null;
  const shrunk = { width: cols * t.cell.width, height: rows * t.cell.height, cell: t.cell, of: t };
  return geometry(width, height, anchor, shrunk, r) ? shrunk : null;
}
export function copyAt(rect: Rect, x: number, y: number): boolean {
  return y === rect.y + 1 && x > rect.x && x < rect.x + rect.w - 1;
}
/** The row or picture at (`x`, `y`) that acts: Copy, or Open on its row
 * or the picture of an image that opens here. */
export function buttonAt(rect: Rect, card: Card, x: number, y: number): Button | null {
  if (copyAt(rect, x, y)) return "copy";
  if (!card.open_image || x <= rect.x || x >= rect.x + rect.w - 1) return null;
  if (y === rect.y + 2) return "open";
  return card.thumbnail && y > rect.y + 3 && y < rect.y + rect.h - 1 ? "open" : null;
}
function openLabel(): string {
  return i18n.t`Open image`;
}
export function draw(w: Writer, rect: Rect, card: Card, hovered: Button | null): void {
  const border = new palette.Style({ fg: "line", bg: "surface" }).sgr();
  const rule = "─".repeat(rect.w - 2);
  const cap = capWidth(rows(card));
  const label = card.copied
    ? i18n.t`Copied`
    : card.link.path || filePath(card.link.uri) !== null
      ? i18n.t`Copy path`
      : i18n.t`Copy link`;
  w.write(border + `\x1b[${rect.y + 1};${rect.x + 1}H┌${rule}┐`);
  // A keycap where the row's shortcut is bound, as menus show them; a ✓ once copied.
  const button = (y: number, key: string | null, label: string, name: Button) => {
    const style = new palette.Style({ fg: "strong", bg: hovered === name ? "selected" : "surface" }).sgr();
    w.write(`\x1b[${y + 1};${rect.x + 1}H│${style} `);
    if (name === "copy" && card.copied) w.write(" ✓ ");
    else if (key !== null) w.write(palette.keycap + ` ${key} ` + style);
    w.splat(" ", cap - (name === "copy" && card.copied ? 3 : key === null ? 0 : displayWidth(key) + 2));
    w.write(" " + label);
    w.splat(" ", rect.w - 4 - cap - displayWidth(label));
    w.write(border + "│");
  };
  button(rect.y + 1, card.keys.copy, label, "copy");
  if (card.open_image) button(rect.y + 2, card.keys.open, openLabel(), "open");
  if (card.thumbnail) {
    const top = rect.y + 2 + Number(!!card.open_image);
    w.write(`\x1b[${top + 1};${rect.x + 1}H├${rule}┤`);
    // The thumbnail draws over these rows.
    for (let y = top + 1; y < rect.y + rect.h - 1; y++)
      w.write(`\x1b[${y + 1};${rect.x + 1}H│${" ".repeat(rect.w - 2)}│`);
  }
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
