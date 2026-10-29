import { test, expect } from "bun:test";
import {
  Process,
  Work,
  Snapshot,
  Tracker,
  fromJSON,
  Alarm,
  delta,
  owner,
  leaders,
  record,
  standouts,
  signal,
  history_bucket_ms,
  history_capacity,
  type Point,
  type Reading,
  type Root,
} from "./resources";
import * as gpu from "./gpu";
import * as native from "./resource_os";
import * as json from "../json";
test("resource snapshots restore concrete integers after JSON transport", () => {
  const snapshot = new Snapshot(),
    work = new Work(1),
    process = new Process(2, 9007199254740993n, "worker");
  snapshot.host_memory = 4096n;
  work.memory = 512n;
  work.read = 0n;
  process.memory = 256n;
  process.written = 1n;
  work.processes.push(process);
  work.history.push({ at: 10, samples: 1, cpu: 0, memory: 512n, io: 0n, gpus: [], processes: [] });
  work.history.push({
    at: 11,
    samples: 3,
    cpu: 0,
    memory: 512n,
    io: 0n,
    gpus: [
      { index: 0, util: 50, memory: 1n },
      { index: 3, util: null, memory: 9007199254740993n },
    ],
    processes: [
      Object.assign(new Process(7, 9007199254740993n, "train"), {
        gpu: 50,
        gpu_devices: [{ index: 0, util: 50, memory: 1n }],
      }),
    ],
  });
  Object.assign(work, {
    gpu: 150,
    gpu_memory: 1n,
    gpu_shown: true,
    gpu_devices: [
      { index: 0, util: 50, memory: 1n },
      { index: 3, util: 100, memory: null },
    ],
    gpu_attribution: "list",
  });
  process.gpu_memory = 1n;
  snapshot.gpus.push({ index: 0, name: "GPU", util: null, used: 2n, total: 9007199254740993n });
  snapshot.gpu_memory_kind = "VRAM";
  snapshot.workspaces.push(work);
  const bytes = json.stringify(snapshot),
    restored = fromJSON(json.parse(bytes));
  expect(restored).toEqual(snapshot);
  expect(restored.workspace(1).processes[0].start).toBe(9007199254740993n);
  expect(restored.workspace(1).read).toBe(0n);
  expect(restored.workspace(1).written).toBeNull();
  expect(restored.workspace(1).processes[0].gpu).toBeNull();
  expect(restored.gpus[0].total).toBe(9007199254740993n);
  expect(json.stringify(restored)).toBe(bytes);
  expect(fromJSON(null)).toEqual(new Snapshot());
});
test("a process from a provider the viewer doesn't know restores as no agent", () => {
  const processes = [
    { pid: 1, start: 1, name: "future", provider: "future" },
    { pid: 2, start: 1, name: "codex", provider: "codex" },
  ];
  const restored = fromJSON({ workspaces: [{ id: 1, processes }] } as any);
  expect(restored.workspace(1).processes.map(p => p.provider)).toEqual([null, "codex"]);
});
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
  expect([fresh.cpu, fresh.read, fresh.written, fresh.memory]).toEqual([null, null, null, 50n]);
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
  expect(delta(old, { ...next, value: { ...next.value, start: 10n } }).cpu).toBeNull();
  expect(delta(old, { ...next, workspace: 2 }).cpu).toBeNull();
  expect(delta(old, { ...next, value: { ...next.value, read: 1n } }).read).toBeNull();
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
        pane: null,
        session: null,
      },
      {
        key: 0,
        pid: 11,
        start: 2n,
        workspace: 2,
        agent_pid: 0,
        provider: null,
        pane: null,
        session: null,
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
  for (const pid of [100, 1, 51]) expect(selected.some(p => p.pid === pid)).toBe(true);
});

test("workspace GPU figures come from the source and stay shown through a pause", () => {
  let util = 40;
  const source: gpu.Source = {
      vendor: "nvidia",
      memory_kind: "VRAM",
      read: () =>
        [0, 1].map(index => ({
          vendor: "nvidia" as const,
          index,
          name: "GPU",
          minor: index,
          mig: false,
          util: util >> index,
          used: 2n << 30n,
          total: 48n << 30n,
          processes: util ? [{ pid: process.pid, memory: (2n << 30n) << BigInt(index) }] : [],
          samples: util ? [{ pid: process.pid, util: util >> index }] : [],
        })),
      close() {},
    },
    sampler = new gpu.Sampler(() => source),
    tracker = new Tracker();
  // This test process holds no device file; vouch for it as a CUDA client.
  sampler.read();
  sampler.held.set(process.pid, native.counters(process.pid)!.start);
  Object.assign(tracker, {
    gpu: sampler,
    workspaces: [1, 2],
    roots: [
      { key: 0, pid: process.pid, start: null, workspace: 1, agent_pid: 0, provider: null, pane: 1, session: null },
    ],
  });
  tracker.sample(1000);
  let view = tracker.pending.view;
  const work = view.workspace(1);
  expect([work.gpu, work.gpu_memory, work.gpu_shown]).toEqual([60, 6n << 30n, true]);
  expect([work.gpu_devices, work.gpu_attribution]).toEqual([
    [
      { index: 0, util: 40, memory: 2n << 30n },
      { index: 1, util: 20, memory: 4n << 30n },
    ],
    "process",
  ]);
  expect(work.processes.find(p => p.pid === process.pid)).toMatchObject({
    gpu: 60,
    parent: process.ppid,
    pane: 1,
    session: null,
  });
  expect(work.history.at(-1)?.gpus).toEqual(work.gpu_devices);
  expect(view.workspace(2)).toMatchObject({ gpu: 0, gpu_memory: 0n, gpu_shown: false });
  expect(view.gpus.map(g => g.index)).toEqual([0, 1]);
  expect(view.gpu_memory_kind).toBe("VRAM");
  util = 0;
  for (const at of [2000, 1000 + gpu.hold_ms]) {
    tracker.batch = tracker.pending;
    tracker.current = tracker.pending.view;
    tracker.sample(at);
    view = tracker.pending.view;
    expect(view.workspace(1)).toMatchObject({ gpu: 0, gpu_memory: 0n, gpu_shown: at < 1000 + gpu.hold_ms });
  }
  // The reading at 2000 joined the first bucket: GPU use averaged, memory at its peak.
  expect(view.workspace(1).history.map(p => p.samples)).toEqual([2, 1]);
  expect(view.workspace(1).history[0].gpus[0]).toEqual({ index: 0, util: 20, memory: 2n << 30n });
});

test("history keeps a point per bucket: rates averaged, memory at its peak", () => {
  const point = (at: number, cpu: number, memory: bigint, io: bigint, gpus: Point["gpus"] = []): Point => ({
    at,
    samples: 1,
    cpu,
    memory,
    io,
    gpus,
    processes: [],
  });
  let history: Point[] = [];
  history = record(history, point(0, 10, 100n, 10n, [{ index: 0, util: 90, memory: 5n }]));
  history = record(history, point(1000, 30, 50n, 20n, [{ index: 1, util: 30, memory: 1n }]));
  history = record(history, point(history_bucket_ms - 1, 20, 70n, 30n));
  expect(history).toEqual([
    {
      at: 0,
      samples: 3,
      cpu: 20,
      memory: 100n,
      io: 20n,
      gpus: [
        { index: 0, util: 30, memory: 5n },
        { index: 1, util: 10, memory: 1n },
      ],
      processes: [],
    },
  ]);
  history = record(history, point(history_bucket_ms, 0, 0n, 0n));
  expect(history.map(p => p.at)).toEqual([0, history_bucket_ms]);
  for (let at = 2; at <= history_capacity + 1; at++)
    history = record(history, point(at * history_bucket_ms, 0, 0n, 0n));
  expect(history).toHaveLength(history_capacity);
});

test("history points keep the processes leading each figure and each device", () => {
  const proc = (pid: number, fields: Partial<Process>) =>
    Object.assign(new Process(pid, BigInt(pid), `p${pid}`), fields);
  // Six busy on CPU, one on each device, and one idle that leads nothing.
  const cpu = Array.from({ length: 6 }, (_, i) => proc(i + 1, { cpu: 10 + i, memory: 1n }));
  const devices = [0, 1, 2].map(index =>
    proc(100 + index, { gpu: 5, gpu_memory: 1n, gpu_devices: [{ index, util: 5, memory: 1n }] }),
  );
  const kept = standouts([...cpu, ...devices, proc(200, {})]).map(p => p.pid);
  expect(kept).toContain(101);
  expect(kept).toContain(102);
  expect(kept).not.toContain(200);
  // Memory ties keep the lowest PIDs, so the first CPU process stays by memory.
  expect(kept.filter(pid => pid < 100)).toEqual([1, 2, 3, 4, 5, 6]);
  // A bucket averages each leader's rates over its readings and keeps its peak memory.
  const first: Point = {
      at: 0,
      samples: 1,
      cpu: 0,
      memory: 0n,
      io: 0n,
      gpus: [],
      processes: [proc(1, { cpu: 40, memory: 9n, read: 4n, written: 0n })],
    },
    second: Point = { ...first, at: 1000, processes: [proc(1, { cpu: 20, memory: 3n, read: 0n, written: 2n })] };
  const [merged] = record([first], second);
  expect(merged.processes[0]).toMatchObject({ cpu: 30, memory: 9n, read: 2n, written: 1n });
});

test("a signal reaches only a process the snapshot shows, and only while it is that process", async () => {
  const child = Bun.spawn(["sleep", "30"]),
    start = native.counters(child.pid)!.start,
    view = new Snapshot(),
    work = new Work(1);
  work.processes.push(new Process(child.pid, start, "sleep"));
  view.workspaces.push(work);
  try {
    expect(() => signal(view, 2, child.pid, start, "term")).toThrow("NoProcess");
    expect(() => signal(view, 1, child.pid, start + 1n, "term")).toThrow("NoProcess");
    expect(() => signal(view, 1, process.pid, start, "term")).toThrow("NoProcess");
    signal(view, 1, child.pid, start, "term");
    expect(await child.exited).not.toBe(0);
    expect(child.signalCode).toBe("SIGTERM");
  } finally {
    child.kill();
  }
});
