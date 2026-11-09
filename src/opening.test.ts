import { expect, test } from "bun:test";
import { Opening, limit } from "./opening";
import { Machine } from "./machine";
import { transport } from "./fixtures/transport";

const machine = () => new Machine(transport(async () => ({ ok: true })));

test("keys for a pane still opening come back in the order typed, once", () => {
  const opening = new Opening(-1, machine());
  opening.type([108, 115]);
  opening.type([13]);
  expect(opening.take()).toEqual([108, 115, 13]);
  expect(opening.take()).toEqual([]);
});

test("keys that don't fit are refused whole, and what came before is kept", () => {
  const opening = new Opening(-1, machine());
  expect(opening.type(new Uint8Array(limit - 1).fill(97))).toBe(true);
  expect(opening.type([98, 99])).toBe(false);
  expect(opening.type([100])).toBe(true);
  expect(opening.type([101])).toBe(false);
  expect(opening.take().length).toBe(limit);
});
