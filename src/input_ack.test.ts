import { expect, test } from "bun:test";
import { Acknowledgements, settle_ms } from "./input_ack";

test("late receipts advance after a settling interval and are scoped to one terminal lifetime", () => {
  const ack = new Acknowledgements();
  const first = ack.sent(0);
  const second = ack.sent(20);
  expect(ack.advance(settle_ms - 1)).toBe(false);
  expect(ack.advance(settle_ms)).toBe(true);
  expect(ack.ack).toEqual(first);
  expect(ack.waiting).toBe(true);
  ack.advance(20 + settle_ms);
  expect(ack.ack).toEqual(second);
  expect(ack.waiting).toBe(false);
  expect(new Acknowledgements().ack.epoch).not.toBe(first.epoch);
});
