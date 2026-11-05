/**
 * Codepoint widths on the landing page, which has no native layer: Ghostty's
 * table, kept in widths.json as the ranges whose width isn't 1. package.json's
 * "browser" field puts this in place of src/viewer_native.ts for text.ts.
 */
//! The Omarchy panel runs this in Qt's QML engine (corgi-omarchy/tools/motion-build.ts):
//! no BigInt literals or `Intl`, and builtins Qt lacks only through
//! the Omarchy plugin's qml_shims.js.
import WIDTHS from "../widths.json";

let table: Uint8Array | null = null;
export function codepointWidths(): Uint8Array {
  if (!table) {
    table = new Uint8Array(0x110000).fill(1);
    for (const [from, to, width] of WIDTHS as [number, number, number][]) table.fill(width, from, to + 1);
  }
  return table;
}
