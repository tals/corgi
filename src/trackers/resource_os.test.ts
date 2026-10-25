import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "../os";
import { parseStat, counters, inventory, host, nvidiaFiles, exists } from "./resource_os";
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
  const processes = inventory();
  expect(processes.items.some(p => p.pid === process.pid)).toBe(true);
  expect(processes.counters(process.pid)?.start).toBe(c!.start);
  expect(host().cores).toBeGreaterThan(0);
});
test("the inventory names each process", () => {
  expect(inventory().items.find(p => p.pid === process.pid)?.name).toBe("bun");
});
test.skipIf(process.platform !== "linux")("a resource scan collects adjacent counters without retaining them", () => {
  const reads = spyOn(fs, "readFileSync"),
    tree = spyOn(os, "processTree").mockReturnValue([process.pid, process.ppid]),
    statReads = () => reads.mock.calls.filter(call => call[0] === `/proc/${process.pid}/stat`).length;
  try {
    const first = inventory([process.pid]),
      identity = first.items.find(p => p.pid === process.pid)!,
      reading = first.counters(process.pid)!;
    expect(reading.start).toBe(identity.start);
    expect(first.counters(process.pid)).toBe(reading);
    expect(first.counters(0x7ffffff0)).toBeNull();
    expect(statReads()).toBe(1);
    const paths = reads.mock.calls.map(call => call[0]);
    for (const pid of [process.pid, process.ppid])
      expect(paths[paths.indexOf(`/proc/${pid}/stat`) + 1]).toBe(`/proc/${pid}/io`);
    counters(process.pid);
    expect(statReads()).toBe(2);
    const second = inventory([process.pid]);
    expect(second.counters(process.pid)).not.toBe(reading);
    expect(statReads()).toBe(3);
  } finally {
    reads.mockRestore();
    tree.mockRestore();
  }
});
// Only Linux lists a process's open files under /proc; elsewhere the answer is null.
test.skipIf(process.platform !== "linux")("a process without GPU device files holds none open", () => {
  // Not this process: a resources Worker in the same test run may hold NVML open.
  const child = Bun.spawn(["sleep", "5"]);
  try {
    expect(nvidiaFiles(child.pid)).toEqual([]);
  } finally {
    child.kill();
  }
  expect(nvidiaFiles(0x7ffffff0)).toBeNull();
  expect(exists(process.pid)).toBe(true);
});
