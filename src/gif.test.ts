import { test, expect } from "bun:test";
import * as gif from "./gif";

/** A red 20x10 canvas, then a blue square drawn over it at (12, 2). */
export const blink = Buffer.from(
  "R0lGODlhFAAKAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEFAAfACwAAAAAFAAKAAAIIQAPCBxIsKDBgwgTKixo4GBDgw8XSpxIsWJEghcrapQYEAAh+QQFAAAAACwMAAIABAAEAAAICwCBCRwoEBDBgQEBADs=",
  "base64",
);

test("each frame becomes a still of its own rectangle", async () => {
  const a = gif.animation(blink)!;
  expect(a).toMatchObject({ width: 20, height: 10 });
  expect(a.frames.map(({ still, ...f }) => f)).toEqual([
    { left: 0, top: 0, width: 20, height: 10, delay: 200, disposal: 1 },
    // A delay too short to show plays at 100 ms.
    { left: 12, top: 2, width: 4, height: 4, delay: 100, disposal: 1 },
  ]);
  const square = await new Bun.Image(a.frames[1].still).png().buffer();
  expect([square.readUInt32BE(16), square.readUInt32BE(20)]).toEqual([4, 4]);
});

test("a single frame, a cut-off file or another format isn't an animation", () => {
  const end = blink.lastIndexOf(0x2c);
  expect(gif.animation(blink.subarray(0, end))).toBeNull();
  expect(gif.animation(blink.subarray(0, blink.length - 4))).toBeNull();
  expect(gif.animation(Buffer.from("GIF87a"))).toBeNull();
  expect(gif.animation(Buffer.from("\x89PNG\r\n\x1a\n"))).toBeNull();
});
