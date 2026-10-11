import { test, expect } from "bun:test";
import { Pacer, onlyAnswers, request, answer, column_ms } from "./frame_pacing";

test("one request is out at a time", () => {
  const p = new Pacer();
  expect(p.stamp(0)).toBe(request);
  expect(p.stamp(30)).toBe("");
  p.answered(40);
  expect(p.stamp(90)).toBe(request);
});
test("frames wait once an answer is half a second late, until it arrives", () => {
  const p = new Pacer();
  p.stamp(0);
  p.answered(20);
  p.stamp(1000);
  expect(p.waiting(1499)).toBe(false);
  expect(p.waiting(1500)).toBe(true);
  expect(p.waiting(3000)).toBe(true);
  p.answered(3000);
  expect(p.waiting(3000)).toBe(false);
});
test("a host that has never answered is never waited on", () => {
  const p = new Pacer();
  p.stamp(0);
  expect(p.waiting(2000)).toBe(false);
  expect(p.unanswered()).toBe(false);
  expect(p.stamp(2000)).toBe("");
});
test("a request unanswered for five seconds is asked again", () => {
  const p = new Pacer();
  p.stamp(0);
  p.answered(20);
  p.stamp(1000);
  expect(p.waiting(5999)).toBe(true);
  expect(p.waiting(6000)).toBe(false);
  expect(p.stamp(6000)).toBe(request);
  expect(p.waiting(6500)).toBe(true);
});
test("a leaving viewer waits only for answers the host sends", () => {
  const p = new Pacer();
  p.stamp(0);
  expect(p.unanswered()).toBe(false);
  p.answered(5);
  p.stamp(10);
  expect(p.unanswered()).toBe(true);
  p.answered(15);
  expect(p.unanswered()).toBe(false);
});
test("answers keep a running mean and deviation, per column", () => {
  const p = new Pacer();
  expect(p.timing).toBeNull();
  p.stamp(0);
  p.answered(20);
  expect(p.timing).toEqual({ mean: 20, sd: 0 });
  p.stamp(100);
  p.answered(140);
  expect(p.timing!.mean).toBeCloseTo(22.5);
  expect(p.timing!.sd).toBeCloseTo(Math.sqrt((7 / 8) * 20 * 2.5));
  expect(p.columns).toEqual([{ at: 0, timing: p.timing, lost: false }]);
  // The next column starts at column_ms.
  p.stamp(column_ms);
  p.answered(column_ms + 900);
  expect(p.columns.map(c => c.at)).toEqual([0, 1]);
  expect(p.late).toBe(1);
  expect(p.slowest).toBe(900);
});
test("a lost request marks its column", () => {
  const p = new Pacer();
  p.stamp(0);
  p.answered(10);
  p.stamp(100);
  p.waiting(5100);
  expect(p.lost).toBe(1);
  expect(p.columns.at(-1)).toEqual({ at: 2, timing: null, lost: true });
  // An answer to a request already given up on is not timed.
  p.answered(5200);
  expect(p.timing).toEqual({ mean: 10, sd: 0 });
});
test("only answers are not typing", () => {
  expect(onlyAnswers(Buffer.from(answer))).toBe(true);
  expect(onlyAnswers(Buffer.from(answer + answer))).toBe(true);
  expect(onlyAnswers(Buffer.from(answer + "a"))).toBe(false);
  expect(onlyAnswers(Buffer.from("\x1b[0"))).toBe(false);
  expect(onlyAnswers(new Uint8Array())).toBe(false);
});
