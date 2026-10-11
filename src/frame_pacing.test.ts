import { test, expect } from "bun:test";
import { Pacer, onlyAnswers, request, answer } from "./frame_pacing";

test("one request is out at a time", () => {
  const p = new Pacer();
  expect(p.stamp(0)).toBe(request);
  expect(p.stamp(30)).toBe("");
  p.answered();
  expect(p.stamp(90)).toBe(request);
});
test("frames wait once an answer is half a second late, until it arrives", () => {
  const p = new Pacer();
  p.stamp(0);
  p.answered();
  p.stamp(1000);
  expect(p.waiting(1499)).toBe(false);
  expect(p.waiting(1500)).toBe(true);
  expect(p.waiting(3000)).toBe(true);
  p.answered();
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
  p.answered();
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
  p.answered();
  p.stamp(10);
  expect(p.unanswered()).toBe(true);
  p.answered();
  expect(p.unanswered()).toBe(false);
});
test("only answers are not typing", () => {
  expect(onlyAnswers(Buffer.from(answer))).toBe(true);
  expect(onlyAnswers(Buffer.from(answer + answer))).toBe(true);
  expect(onlyAnswers(Buffer.from(answer + "a"))).toBe(false);
  expect(onlyAnswers(Buffer.from("\x1b[0"))).toBe(false);
  expect(onlyAnswers(new Uint8Array())).toBe(false);
});
