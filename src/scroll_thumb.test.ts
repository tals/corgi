import { expect, test } from "bun:test";
import { thumb } from "./scroll_thumb";

test("the thumb shrinks with the overflow and travels the track", () => {
  expect(thumb(10, 10, 0)).toBeNull();
  expect(thumb(10, 20, 0)).toEqual({ start: 0, len: 5 });
  expect(thumb(10, 20, 10)).toEqual({ start: 5, len: 5 });
  expect(thumb(4, 400, 396)).toEqual({ start: 3, len: 1 });
});
