//! The card that says why a paste brought no image and what fixes it. It
//! opens above the focused pane's caret, pointing at where the paste would
//! have landed, until Esc, a click or the next key. Corgi captures the
//! mouse, so Ghostty opens its links only on Cmd+Shift-click, which skips
//! the capture; a plain click reaches Corgi, which copies the link.
//! Mirrors paste_card.zig.
import * as i18n from "./i18n";
import * as palette from "./palette";
import { Style } from "./palette";
import { Rect, View as LayoutView } from "./layout";
import { download_url, type Notice } from "./host_clipboard";
import type { Pane } from "./mirror";
import { Writer, displayWidth, writeEllipsis, ellipsis, wrap, sat } from "./text";

const titleLabel = () => i18n.t` Image not pasted `;
const keycap = " esc ";
const closeLabel = () => i18n.t` close `;
const downloadLabel = () => i18n.t`Download: `;
const copiedLabel = () => i18n.t` Copied to clipboard `;
const openHint = () => i18n.t` ⇧⌘-click opens · click copies `;
/** Columns between the border and the text. */
const pad = 3;
const partText = (part: { text: { text(): string } | string }) =>
  typeof part.text === "string" ? part.text : part.text.text();
function hasLink(notice: Notice): boolean {
  return notice.fix().some(part => part.kind === "link");
}
let text: string, border: string, heading: string, quiet: string, pointer: string, check: string;
export let styles: Record<
  "text" | "border" | "heading" | "quiet" | "pointer" | "check" | "open_hint" | "title",
  string
>;
palette.derived(() => {
  text = new Style({ fg: "text", bg: "surface" }).sgr();
  border = new Style({ fg: "line", bg: "surface" }).sgr();
  heading = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  quiet = new Style({ fg: "faint", bg: "surface" }).sgr();
  pointer = new Style({ fg: "line" }).sgr();
  check = new Style({ fg: "accent", bg: "surface" }).sgr();
  styles = {
    text,
    border,
    heading,
    quiet,
    pointer,
    check,
    get open_hint() {
      return openHint();
    },
    get title() {
      return titleLabel();
    },
  };
});

export interface Caret {
  x: number;
  y: number;
}
export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The arrow at the caret: below the card, or above it when the card sits under the caret. */
  arrow: { x: number; y: number; glyph: string } | null;
}
function fixWidth(notice: Notice): number {
  return notice.fix().reduce((n, part) => n + displayWidth(partText(part)), 0);
}
/** The card's width around `inner` columns of text. The top border holds
 * the title and the close hint with a dash either side. */
function frameWidth(inner: number): number {
  return Math.max(
    inner + 2 * pad + 2,
    2 + displayWidth(titleLabel()) + 1 + displayWidth(keycap) + displayWidth(closeLabel()) + 2,
  );
}
type Part = { kind: "text" | "key" | "link"; text: string };
/** Wrap the sentence as a whole, retaining the key and link spans on each line. */
function content(notice: Notice, width: number) {
  const body = wrap(notice.body.text(), width),
    parts = notice.fix().map(part => ({ kind: part.kind, text: partText(part) })),
    sentence = parts.map(part => part.text).join("");
  let offset = 0;
  const fix = wrap(sentence, width).map(line => {
    const start = sentence.indexOf(line, offset),
      end = start + line.length,
      row: Part[] = [];
    let position = 0;
    for (const part of parts) {
      const next = position + part.text.length,
        value = part.text.slice(Math.max(0, start - position), Math.min(part.text.length, end - position));
      if (next > start && position < end && value) row.push({ kind: part.kind, text: value });
      position = next;
    }
    offset = end;
    return row;
  });
  const fixRow = 3 + body.length,
    downloadRow = fixRow + fix.length,
    height = downloadRow + (hasLink(notice) ? 1 : 0) + 2;
  return { body, fix, fixRow, downloadRow, height };
}
/** Above the caret when the pane has room, else below it, else at the
 * pane's foot without an arrow when the caret is unknown. A narrow pane
 * wraps the explanation and shortens the download link. */
export function place(notice: Notice, pane: Rect, caret: Caret | null): Placement | null {
  const lines = Math.max(displayWidth(notice.body.text()), fixWidth(notice));
  const full = hasLink(notice) ? Math.max(lines, displayWidth(downloadLabel()) + download_url.length) : lines;
  const w = Math.min(frameWidth(full), pane.w);
  if (w < 24) return null;
  const h = content(notice, w - 2 * pad - 2).height;
  if (pane.h < h) return null;
  if (!caret) return { x: pane.x, y: pane.y + pane.h - h, w, h, arrow: null };
  const x = Math.min(Math.max(sat(caret.x, 2), pane.x), pane.x + pane.w - w);
  if (caret.y >= pane.y + h + 1)
    return { x, y: caret.y - 1 - h, w, h, arrow: { x: caret.x, y: caret.y - 1, glyph: "▾" } };
  if (caret.y + 2 + h <= pane.y + pane.h)
    return { x, y: caret.y + 2, w, h, arrow: { x: caret.x, y: caret.y + 1, glyph: "▴" } };
  return null;
}
/** The card in the focused pane, at its caret. */
export function locate(view: LayoutView, panes: Pane[], area: Rect, notice: Notice): Placement | null {
  if (view.model.count === 0) return null;
  for (const spot of view.placements(area)) {
    if (spot.id !== view.selection.tabs[view.selection.active].focus) continue;
    const p = panes.find(pane => pane.id === spot.id);
    if (!p) continue;
    const r = spot.rect;
    const c = p.terminal.caret();
    const caret = c && c.x < r.w && c.y < r.h ? { x: r.x + c.x, y: r.y + c.y } : null;
    return place(notice, r, caret);
  }
  return null;
}
/** Whether (`x`, `y`) is on one of the card's links: "Ghostty 1.4" in
 * the fix, or the download URL under it. */
export function linkAt(notice: Notice, at: Placement, x: number, y: number): boolean {
  if (!hasLink(notice)) return false;
  const left = at.x + 1 + pad,
    rows = content(notice, at.w - 2 * pad - 2),
    row = rows.fix[y - at.y - rows.fixRow];
  if (row) {
    let start = left;
    for (const part of row) {
      const end = start + displayWidth(part.text);
      if (part.kind === "link" && x >= start && x < end) return true;
      start = end;
    }
    return false;
  }
  if (y === at.y + rows.downloadRow) {
    const start = left + displayWidth(downloadLabel());
    return x >= start && x < start + Math.min(download_url.length, urlRoom(at));
  }
  return false;
}
function urlRoom(at: Placement): number {
  return sat(at.w - 2, 2 * pad + displayWidth(downloadLabel()));
}
/** Draws the card at `at`, leaving the cursor where it was. Its bottom
 * border says how to open the link, or that a click copied it. */
export function draw(notice: Notice, at: Placement, copied: boolean): string {
  const w = new Writer(),
    close = frameWidth(0) <= at.w ? closeLabel() : "",
    title = ellipsis(titleLabel(), at.w - displayWidth(keycap) - displayWidth(close) - 4),
    download = downloadLabel(),
    copied_label = copiedLabel(),
    open_hint = openHint(),
    rows = content(notice, at.w - 2 * pad - 2);
  w.write("\x1b7");
  const inner = at.w - 2;
  w.write(`\x1b[${at.y + 1};${at.x + 1}H${border}╭─${heading}${title}${border}`);
  w.write("─".repeat(Math.max(0, at.w - (2 + displayWidth(title) + displayWidth(keycap) + displayWidth(close) + 2))));
  w.write(palette.keycap + keycap + quiet + close + border + "─╮");
  for (let row = 1; row < at.h - 1; row++) {
    w.write(`\x1b[${at.y + row + 1};${at.x + 1}H│${text}`);
    w.splat(" ", inner);
    w.write(border + "│");
  }
  w.write(`\x1b[${at.y + at.h};${at.x + 1}H╰`);
  const label = copied ? 2 + displayWidth(copied_label) : hasLink(notice) ? displayWidth(open_hint) : 0;
  const shown = label > 0 && label + 2 <= inner;
  w.write("─".repeat(inner - (shown ? label + 1 : 0)));
  if (shown) {
    if (copied) w.write(" " + check + "✓" + text + copied_label + border);
    else w.write(quiet + open_hint + border);
    w.write("─");
  }
  w.write("╯");
  for (const [index, line] of rows.body.entries()) w.write(`\x1b[${at.y + 3 + index};${at.x + 2 + pad}H${text}` + line);
  for (const [index, line] of rows.fix.entries()) {
    w.write(`\x1b[${at.y + rows.fixRow + index + 1};${at.x + 2 + pad}H`);
    for (const part of line) {
      if (part.kind === "text") w.write(text + part.text);
      else if (part.kind === "link") writeLink(w, part.text, displayWidth(part.text));
      else w.write(heading + part.text);
    }
  }
  if (hasLink(notice)) {
    w.write(`\x1b[${at.y + rows.downloadRow + 1};${at.x + 2 + pad}H${text}` + download);
    writeLink(w, download_url, urlRoom(at));
  }
  if (at.arrow) w.write(`\x1b[${at.arrow.y + 1};${at.arrow.x + 1}H${pointer}${at.arrow.glyph}`);
  w.write("\x1b[0m\x1b8");
  return w.buffered();
}
/** A terminal hyperlink to Ghostty's download page, which the host opens
 * on the user's machine. */
function writeLink(w: Writer, label: string, room: number): void {
  w.write(text + "\x1b]8;;" + download_url + "\x1b\\\x1b[4m");
  writeEllipsis(w, label, room);
  w.write("\x1b[24m\x1b]8;;\x1b\\");
}
