import { test, expect } from "bun:test";
import { parseStat, counters, inventory, host } from "./resource_os";
test("linux stat handles spaces and closing parentheses in process names", () => {
  const fields = Array(22).fill("0");
  fields[0] = "S";
  fields[1] = "7";
  fields[11] = "11";
  fields[12] = "13";
  fields[19] = "99";
  fields[21] = "4";
  const s = parseStat(8, "8 (a tricky) name) " + fields.join(" "))!;
  expect(s.identity.name).toBe("a tricky) name");
  expect(s.identity.parent).toBe(7);
  expect(s.identity.start).toBe(99n);
  expect(s.ticks).toBe(24n);
  expect(s.pages).toBe(4n);
});
test("native counters can sample this process", () => {
  const c = counters(process.pid);
  expect(c).not.toBeNull();
  expect(c!.memory).toBeGreaterThan(0n);
  expect(inventory().items.some(p => p.pid === process.pid)).toBe(true);
  expect(host().cores).toBeGreaterThan(0);
});
test("the inventory names each process", () => {
  expect(inventory().items.find(p => p.pid === process.pid)?.name).toBe("bun");
});
