import { expect, test } from "bun:test";
import { Policy } from "./remote_policy";

test("recurring hangs run on a start-to-start cadence and can be disabled mid-hang", () => {
  const policy = new Policy();
  policy.apply({ hang_seconds: 5, hang_every_seconds: 30 }, 1000);
  expect(policy.tick(30999)).toBe(false);
  expect(policy.tick(31000)).toBe(true);
  expect(policy.state.outage_until).toBe(36000);
  expect(policy.tick(36000)).toBe(false);
  expect(policy.tick(61000)).toBe(true);
  policy.apply({ hang_every_seconds: 0 }, 62000);
  expect(policy.tick(62000)).toBe(false);
  expect(policy.state.next_hang_at).toBe(0);
  expect(policy.tick(91000)).toBe(false);
});

test("manual outages overlap recurring hangs, and delayed ticks skip missed cycles", () => {
  const policy = new Policy();
  policy.apply({ hang_seconds: 5, hang_every_seconds: 30 }, 0);
  policy.apply({ outage_seconds: 10 }, 28000);
  expect(policy.tick(35000)).toBe(true);
  expect(policy.tick(38000)).toBe(false);
  expect(policy.tick(122000)).toBe(true);
  expect(policy.state.outage_until).toBe(125000);
  expect(policy.state.next_hang_at).toBe(150000);
  policy.apply({ hang_every_seconds: 0, outage_seconds: 0 }, 123000);
  expect(policy.tick(123000)).toBe(false);
});
