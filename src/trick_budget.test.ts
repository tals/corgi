import { expect, test } from "bun:test";
import * as budget from "./trick_budget";
import type { Counters } from "./trackers/resource_os";

const counters = (cpu_ns: bigint, memory = 1n, start = 1n): Counters => ({
  start,
  cpu_ns,
  memory,
  read: null,
  written: null,
});
test("CPU allows short bursts, replenishes while idle, and stops sustained work", () => {
  const b = new budget.Budget(0);
  expect(b.check(new Map([[1, counters(700_000_000n)]]), 1000)).toBeNull();
  expect(b.check(new Map([[1, counters(700_000_000n)]]), 8000)).toBeNull();
  expect(b.check(new Map([[1, counters(1_400_000_000n)]]), 9000)).toBeNull();
  expect(b.check(new Map([[1, counters(2_100_000_000n)]]), 10000)).toBe("CpuLimit");
});
test("memory and CPU include children, and reused PIDs have a fresh baseline", () => {
  expect(
    new budget.Budget(0).check(
      new Map([
        [1, counters(0n, budget.memory_limit)],
        [2, counters(0n)],
      ]),
      1000,
    ),
  ).toBe("MemoryLimit");
  const b = new budget.Budget(0);
  expect(b.check(new Map([[1, counters(600_000_000n)]]), 1000)).toBeNull();
  expect(b.check(new Map([[1, counters(600_000_000n, 1n, 2n)]]), 2000)).toBe("CpuLimit");
  expect(new budget.Budget().check(new Map(Array.from({ length: 9 }, (_, i) => [i, counters(0n)])))).toBe(
    "ProcessLimit",
  );
});
test("the resource sampler includes the trick process", () => {
  expect(budget.sample(process.pid).get(process.pid)?.memory).toBeGreaterThan(0n);
});
