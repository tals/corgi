import { expect, test } from "bun:test";
import { Acknowledgements, settle_ms } from "./input_ack";
import { Receipts } from "./instant_receipts";

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

test("screen acknowledgements and command receipts can race without confirming another terminal's input", () => {
  for (const screenFirst of [false, true]) {
    const receipts = new Receipts();
    const receipt = { epoch: "one", sequence: 4n };
    if (screenFirst) receipts.receive(receipt);
    receipts.delivered(3, receipt);
    if (!screenFirst) receipts.receive(receipt);
    expect(receipts.through).toBe(3);
    receipts.delivered(4, { epoch: "two", sequence: 1n });
    receipts.receive({ epoch: "one", sequence: 999n });
    expect(receipts.through).toBe(3);
    receipts.receive({ epoch: "two", sequence: 1n });
    expect(receipts.through).toBe(4);
  }
});
