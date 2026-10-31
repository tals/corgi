//! A provider's brand mark, or its glyph when the host cannot show images.
import { Provider, adapter } from "./providers";
import { fg, type Token } from "./palette";
import { Writer, displayWidth, writeEllipsis } from "./text";

/** Places a brand mark at a cell; returns "" when it cannot. */
export type Marks = (provider: Provider, col: number, row: number) => string;

/** The glyph a provider shows where its mark can't, in a brand-ish token. */
const glyph_tokens: Partial<Record<Provider, Token>> = { claude: "hot" };
/** Writes `provider`'s mark in the two cells at `col`, `row`: a placed image
 * when `marks` can place one, else its glyph. Leaves the background alone
 * and the foreground changed. */
export function writeMark(w: Writer, provider: Provider, col: number, row: number, marks: Marks | null): void {
  const placed = marks?.(provider, col, row) ?? "";
  w.write(`\x1b[${row + 1};${col + 1}H`);
  if (placed) {
    w.write("  " + placed);
    return;
  }
  const glyph = adapter(provider).glyph;
  w.write(fg(glyph_tokens[provider] ?? "text"));
  writeEllipsis(w, glyph, 2);
  w.splat(" ", 2 - Math.min(2, displayWidth(glyph)));
}
