import { expect, test } from "bun:test";
import { Opening, limit } from "./opening";

test("keys and pastes for a pane still opening come back in the order typed, once", () => {
  const opening = new Opening(-1);
  opening.type([108, 115]);
  opening.type([13]);
  opening.pasteStart();
  opening.paste([97]);
  opening.paste([98]);
  opening.type([27]);
  expect(opening.take()).toEqual([{ keys: [108, 115, 13] }, { paste: [97, 98] }, { keys: [27] }]);
  expect(opening.take()).toEqual([]);
});

test("a large paste joins the one it continues", () => {
  const opening = new Opening(-1);
  opening.pasteStart();
  opening.paste([97]);
  expect(opening.paste(new Uint8Array(512 * 1024).fill(98))).toBe(true);
  const [chunk] = opening.take();
  expect("paste" in chunk && chunk.paste.length).toBe(512 * 1024 + 1);
});

test("what doesn't fit is refused whole, and what came before is kept", () => {
  const opening = new Opening(-1);
  expect(opening.type(new Array(limit - 1).fill(97))).toBe(true);
  expect(opening.paste([98, 99])).toBe(false);
  expect(opening.type([100])).toBe(true);
  expect(opening.type([101])).toBe(false);
  expect(opening.take().flatMap(chunk => ("keys" in chunk ? chunk.keys : chunk.paste)).length).toBe(limit);
});
