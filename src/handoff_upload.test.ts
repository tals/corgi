import { expect, test } from "bun:test";
import * as handoffUpload from "./handoff_upload";

test("a handoff crosses in parts no larger than one request carries, and comes out whole", async () => {
  const uploads = new handoffUpload.Uploads(),
    owner = {},
    text = JSON.stringify({ items: "é".repeat(handoffUpload.part_chars * 2 + 10) }),
    sizes: number[] = [];
  const reply = await handoffUpload.send(async p => {
    sizes.push(p.part.length);
    const whole = uploads.add(owner, p);
    return { path: whole === null ? "" : whole };
  }, text);
  expect(sizes).toHaveLength(3);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(handoffUpload.part_chars);
  expect(reply).toEqual({ path: text });
  expect(uploads.size).toBe(0);
  // A short one is a single request.
  expect(await handoffUpload.send(async p => uploads.add(owner, p), "{}")).toBe("{}");
});

test("an upload is its connection's, bounded, and goes with it", () => {
  const uploads = new handoffUpload.Uploads(),
    owner = {},
    other = {};
  expect(uploads.add(owner, { upload: "a", part: "{", last: false })).toBeNull();
  expect(() => uploads.add(other, { upload: "a", part: "}", last: true })).toThrow("UnknownUpload");
  uploads.drop(owner);
  expect(uploads.size).toBe(0);
  const big = "x".repeat(handoffUpload.part_chars);
  expect(() => {
    for (let i = 0; ; i++) uploads.add(owner, { upload: "b", part: big, last: false });
  }).toThrow("TooLarge");
  expect(uploads.size).toBe(0);
});
