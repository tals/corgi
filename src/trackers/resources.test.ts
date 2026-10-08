import { test, expect } from "bun:test";
import {
  Process,
  Work,
  Alarm,
  delta,
  owner,
  leaders,
  type Reading,
  type Root,
} from "./resources";
test("new process baselines preserve established workspace rates", () => {
  const established = Object.assign(new Process(1, 1n, "worker"), {
      cpu: 45,
      memory: 100n,
      read: 200n,
      written: 0n,
    }),
    newcomer = Object.assign(new Process(2, 2n, "child"), { memory: 50n });
  for (const first of [false, true]) {
    const w = new Work(1);
    w.add(first ? newcomer : established);
    w.add(first ? established : newcomer);
    expect([w.cpu, w.memory, w.read, w.written]).toEqual([45, 150n, 200n, 0n]);
  }
  const fresh = new Work(1);
  fresh.add(newcomer);
  expect([fresh.cpu, fresh.read, fresh.written, fresh.memory]).toEqual([
    null,
    null,
    null,
    50n,
  ]);
});
test("deltas ignore PID reuse, reassignment, first samples and counter resets", () => {
  const old: Reading = {
      pid: 4,
      workspace: 1,
      identity_start: 8n,
      at: 1000,
      value: {
        start: 9n,
        cpu_ns: 100n,
        memory: 10n,
        read: 100n,
        written: 200n,
      },
    },
    next: Reading = {
      ...old,
      at: 3000,
      value: { ...old.value, cpu_ns: 4000000100n, read: 2100n },
    };
  expect(delta(old, next)).toMatchObject({ cpu: 200, read: 1000n });
  expect(delta(null, next).cpu).toBeNull();
  expect(
    delta(old, { ...next, value: { ...next.value, start: 10n } }).cpu,
  ).toBeNull();
  expect(delta(old, { ...next, workspace: 2 }).cpu).toBeNull();
  expect(
    delta(old, { ...next, value: { ...next.value, read: 1n } }).read,
  ).toBeNull();
});
test("pressure requires sustained evidence and clears with hysteresis", () => {
  const a = new Alarm();
  expect(a.update(true, false, 0)).toBe(false);
  expect(a.update(false, true, 9000)).toBe(false);
  expect(a.update(true, false, 10000)).toBe(false);
  expect(a.update(true, false, 20000)).toBe(true);
  expect(a.update(false, true, 21000)).toBe(true);
  expect(a.update(false, true, 50999)).toBe(true);
  expect(a.update(false, true, 51000)).toBe(false);
});
test("ownership chooses the nearest root and bounds ancestry cycles", () => {
  const inventory = [
      { pid: 10, parent: 1, start: 1n, name: "" },
      { pid: 11, parent: 10, start: 2n, name: "" },
      { pid: 12, parent: 11, start: 3n, name: "" },
      { pid: 20, parent: 21, start: 4n, name: "" },
      { pid: 21, parent: 20, start: 5n, name: "" },
    ],
    index = new Map(inventory.map((p, i) => [p.pid, i])),
    roots: Root[] = [
      {
        key: 0,
        pid: 10,
        start: 1n,
        workspace: 1,
        agent_pid: 0,
        provider: null,
      },
      {
        key: 0,
        pid: 11,
        start: 2n,
        workspace: 2,
        agent_pid: 0,
        provider: null,
      },
    ];
  expect(owner(12, inventory, index, roots)?.workspace).toBe(2);
  expect(owner(20, inventory, index, roots)).toBeNull();
  inventory[1].start = 99n;
  expect(owner(12, inventory, index, roots)).toBeNull();
});
test("bounded process details retain leaders for every resource", () => {
  const list = Array.from({ length: 100 }, (_, i) =>
      Object.assign(new Process(i + 1, 1n, "fixture"), {
        cpu: i,
        memory: BigInt(100 - i),
        read: i === 50 ? 1000000n : 0n,
        written: 0n,
      }),
    ),
    selected = leaders(list);
  expect(selected.length).toBeLessThanOrEqual(64);
  for (const pid of [100, 1, 51])
    expect(selected.some((p) => p.pid === pid)).toBe(true);
});
