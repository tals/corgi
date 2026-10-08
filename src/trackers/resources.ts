import * as native from "./resource_os";
import type { Provider } from "../providers";
import type { Runtime } from "../runtime";
import * as clock from "../clock";
import { Failure } from "../failure";
import { nativeFiles } from "../build_assets";
export const history_capacity = 48,
  process_capacity = 64;
export type Sort = "cpu" | "memory" | "io";
const max64 = (1n << 64n) - 1n;
const sat = (a: bigint, b: bigint) => (a + b > max64 ? max64 : a + b);
export function cpuText(value: number | null) {
  return value === null ? "" : value >= 10000 ? (value / 1000).toFixed(0) + "k%" : value.toFixed(0) + "%";
}
export function memoryText(value: bigint | number | null) {
  if (value === null) return "";
  const n = BigInt(value);
  return n >= 1073741824n ? (Number(n) / 1073741824).toFixed(1) + "G" : (n / 1048576n).toString() + "M";
}
export function ioText(value: bigint | number | null) {
  if (value === null) return "";
  const n = BigInt(value);
  return n >= 1000000000n
    ? (Number(n) / 1000000000).toFixed(0) + "G/s"
    : n >= 1000000n
      ? (Number(n) / 1000000).toFixed(0) + "M/s"
      : (n / 1000n).toString() + "K/s";
}
export type Point = {
  at: number;
  cpu: number | null;
  memory: bigint | null;
  io: bigint | null;
};
export class Process {
  provider: Provider | null = null;
  cpu: number | null = null;
  memory = 0n;
  read: bigint | null = null;
  written: bigint | null = null;
  constructor(
    public pid: number,
    public start: bigint,
    public name: string,
  ) {}
  static less(sort: Sort, left: Process, right: Process) {
    const value = (p: Process) =>
      sort === "cpu"
        ? (p.cpu ?? -1)
        : sort === "memory"
          ? Number(p.memory)
          : p.read !== null && p.written !== null
            ? Number(sat(p.read, p.written))
            : -1;
    const l = value(left),
      r = value(right);
    return l === r ? left.pid < right.pid : l > r;
  }
}
export class Work {
  known = false;
  partial = false;
  count = 0;
  cpu: number | null = null;
  memory: bigint | null = null;
  read: bigint | null = null;
  written: bigint | null = null;
  cpu_pressure = false;
  processes: Process[] = [];
  history: Point[] = [];
  constructor(public id: number) {}
  add(p: Process) {
    this.memory = sat(this.memory ?? 0n, p.memory);
    if (p.cpu !== null) this.cpu = (this.cpu ?? 0) + p.cpu;
    if (p.read !== null) this.read = sat(this.read ?? 0n, p.read);
    if (p.written !== null) this.written = sat(this.written ?? 0n, p.written);
  }
}
export class Snapshot {
  sampled_at = 0;
  interval_ms = 2000;
  host_cpu: number | null = null;
  host_memory = 0n;
  cores = 1;
  memory_pressure: native.MemoryPressure = "unknown";
  memory_kind = process.platform === "linux" ? "RSS" : "footprint";
  workspaces: Work[] = [];
  workspace(id: number) {
    return this.workspaces.find(w => w.id === id) ?? new Work(id);
  }
  forViewer(detail: number | null) {
    return Object.assign(new Snapshot(), this, {
      workspaces: this.workspaces.map(w =>
        Object.assign(new Work(w.id), w, detail === w.id ? {} : { processes: [], history: [] }),
      ),
    });
  }
}
export type Root = {
  key: number;
  pid: number;
  start: bigint | null;
  workspace: number;
  agent_pid: number;
  provider: Provider | null;
};
export type Reading = {
  pid: number;
  workspace: number;
  identity_start: bigint;
  at: number;
  value: native.Counters;
};
export class Alarm {
  active = false;
  since: number | null = null;
  clear_since: number | null = null;
  update(high: boolean, low: boolean, now: number) {
    if (!this.active) {
      this.clear_since = null;
      if (!high) {
        this.since = null;
        return false;
      }
      this.since ??= now;
      if (now - this.since >= 10000) this.active = true;
    } else {
      this.since = null;
      if (!low) this.clear_since = null;
      else {
        this.clear_since ??= now;
        if (now - this.clear_since >= 30000) {
          this.active = false;
          this.clear_since = null;
        }
      }
    }
    return this.active;
  }
}
export function owner(
  pid: number,
  inventory: native.Identity[],
  index: Map<number, number>,
  roots: Root[],
): Root | null {
  let current = pid;
  for (let i = 0; i < 128; i++) {
    const root = roots.find(r => r.pid === current),
      position = index.get(current);
    if (position === undefined) return null;
    const identity = inventory[position];
    if (root) return root.start !== null && root.start === identity.start ? root : null;
    if (identity.parent <= 1 || identity.parent === current) return null;
    current = identity.parent;
  }
  return null;
}
export function rate(old: bigint | null, next: bigint | null, ms: number) {
  if (old === null || next === null || next < old) return null;
  const n = ((next - old) * 1000n) / BigInt(ms);
  return n > max64 ? max64 : n;
}
export function delta(old: Reading | null | undefined, next: Reading) {
  const empty = {
    cpu: null as number | null,
    read: null as bigint | null,
    written: null as bigint | null,
  };
  if (
    !old ||
    old.workspace !== next.workspace ||
    old.identity_start !== next.identity_start ||
    old.value.start !== next.value.start ||
    next.at <= old.at ||
    next.at - old.at > 10000
  )
    return empty;
  const ms = next.at - old.at;
  return {
    cpu: next.value.cpu_ns >= old.value.cpu_ns ? Number(next.value.cpu_ns - old.value.cpu_ns) / (ms * 10000) : null,
    read: rate(old.value.read, next.value.read, ms),
    written: rate(old.value.written, next.value.written, ms),
  };
}
export function leaders(list: Process[]) {
  if (list.length <= process_capacity) return list;
  const out: Process[] = [];
  for (const sort of ["cpu", "memory", "io"] as const) {
    list.sort((a, b) => (Process.less(sort, a, b) ? -1 : Process.less(sort, b, a) ? 1 : 0));
    for (const p of list.slice(0, Math.floor(process_capacity / 3))) if (!out.some(x => x.pid === p.pid)) out.push(p);
  }
  return out;
}
export type Batch = {
  view: Snapshot;
  readings: Reading[];
  host: native.Host;
  health: { id: number; cpu: Alarm }[];
};
const batch = (): Batch => ({
  view: new Snapshot(),
  readings: [],
  host: { busy: 0n, total: 0n, cores: 1, memory: 0n, pressure: "unknown" },
  health: [],
});
export type SampleRequest = {
  roots: Root[];
  workspaces: number[];
  origins: Map<number, { pid: number; start: bigint }>;
  batch: Batch;
  current: Snapshot;
  interval_ms: number;
  at: number;
};
export type SampleResult = { pending: Batch; origins: SampleRequest["origins"] };
// Structured clone retains bigint and Maps, but strips class prototypes.
export function restoreSnapshot(view: Snapshot): Snapshot {
  return Object.assign(new Snapshot(), view, {
    workspaces: view.workspaces.map(work =>
      Object.assign(new Work(work.id), work, {
        processes: work.processes.map(p => Object.assign(new Process(p.pid, p.start, p.name), p)),
      }),
    ),
  });
}
export function restoreBatch(value: Batch): Batch {
  return {
    ...value,
    view: restoreSnapshot(value.view),
    health: value.health.map(h => ({ id: h.id, cpu: Object.assign(new Alarm(), h.cpu) })),
  };
}
export class Tracker {
  current = new Snapshot();
  batch = batch();
  pending = batch();
  roots: Root[] = [];
  origins = new Map<number, { pid: number; start: bigint }>();
  workspaces: number[] = [];
  thread: Promise<void> | null = null;
  done = false;
  stopping = false;
  next_refresh = 0;
  last_started = 0;
  interval_ms = 2000;
  private worker: (Worker & { unref(): void }) | null = null;
  private complete: (() => void) | null = null;
  private failure = new Failure();
  deinit() {
    this.stopping = true;
    this.worker?.terminate();
    this.worker = null;
    this.complete?.();
    this.complete = null;
    this.origins.clear();
  }
  tick(runtime: Runtime, detailed: boolean) {
    let changed = false;
    if (this.thread) {
      if (!this.done) return false;
      this.thread = null;
      const valid = this.roots.every(
        root =>
          runtime.panes.some(
            p =>
              !p.terminal.exited &&
              p.terminal.pid === root.pid &&
              p.id * 2 === root.key &&
              runtime.workspaces.owner(p.id)?.id === root.workspace,
          ) ||
          runtime.sessions.some(
            s =>
              !s.exited &&
              (s.child?.pid ?? s.child?.id) === root.pid &&
              s.workspace_id === root.workspace &&
              s.id * 2 + 1 === root.key,
          ),
      );
      if (valid) {
        this.batch = this.pending;
        this.current = this.batch.view;
        changed = true;
      }
    }
    const now = clock.milliTimestamp(),
      interval = detailed ? 1000 : 2000;
    if (now < Math.min(this.next_refresh, this.last_started + interval)) return changed;
    this.interval_ms = interval;
    this.last_started = now;
    this.next_refresh = now + interval;
    this.workspaces = runtime.workspaces.items.map(w => w.id);
    this.roots = runtime.panes
      .filter(p => !p.terminal.exited)
      .flatMap(p => {
        const w = runtime.workspaces.owner(p.id);
        return w
          ? [
              {
                key: p.id * 2,
                pid: p.terminal.pid,
                start: null,
                workspace: w.id,
                agent_pid: p.detection.pid,
                provider: p.agent().provider,
              },
            ]
          : [];
      });
    for (const s of runtime.sessions) {
      const pid = s.child?.pid ?? s.child?.id;
      if (!s.exited && s.workspace_id && pid)
        this.roots.push({
          key: s.id * 2 + 1,
          pid,
          start: null,
          workspace: s.workspace_id,
          agent_pid: pid,
          provider: s.provider,
        });
    }
    this.done = false;
    this.thread = new Promise<void>(resolve => {
      this.complete = resolve;
    });
    try {
      if (!this.worker) {
        // A compiled bundle's import.meta.url belongs to the main entrypoint.
        const entry = nativeFiles ? "./trackers/resources_worker.js" : "./resources_worker.ts";
        this.worker = new Worker(new URL(entry, import.meta.url)) as Worker & { unref(): void };
        this.worker.onmessage = (event: MessageEvent<SampleResult | { error: string }>) => {
          if ("error" in event.data) this.sampleFailed(event.data.error);
          else {
            this.pending = restoreBatch(event.data.pending);
            this.origins = event.data.origins;
            this.failure.clear();
            this.sampleDone();
          }
        };
        this.worker.onerror = event => {
          this.worker?.terminate();
          this.worker = null;
          this.sampleFailed(event.message);
        };
        this.worker.unref();
      }
      this.worker.postMessage({
        roots: this.roots,
        workspaces: this.workspaces,
        origins: this.origins,
        batch: this.batch,
        current: this.current,
        interval_ms: this.interval_ms,
        at: now,
      } satisfies SampleRequest);
    } catch (error) {
      this.sampleFailed(error);
    }
    return changed;
  }
  private sampleDone() {
    this.done = true;
    this.complete?.();
    this.complete = null;
  }
  private sampleFailed(error: unknown) {
    if (this.failure.changed(error)) console.warn("resource sample failed:", error);
    this.pending = batch();
    this.pending.view.sampled_at = clock.milliTimestamp();
    this.pending.view.interval_ms = this.interval_ms;
    this.sampleDone();
  }
  stop() {
    if (this.thread) {
      if (!this.done) return false;
      this.thread = null;
    } else if (!this.current.sampled_at && !this.batch.readings.length) return false;
    this.current = new Snapshot();
    this.batch = batch();
    this.pending = batch();
    this.roots = [];
    this.workspaces = [];
    this.next_refresh = 0;
    this.last_started = 0;
    return true;
  }
  sample(now = clock.milliTimestamp()) {
    const inventory = native.inventory(this.roots.map(r => r.pid)),
      index = new Map(inventory.items.map((p, i) => [p.pid, i])),
      roots = this.roots.map(r => ({ ...r }));
    for (const k of this.origins.keys()) if (!roots.some(r => r.key === k)) this.origins.delete(k);
    for (const root of roots) {
      const origin = this.origins.get(root.key);
      if (origin?.pid === root.pid) root.start = origin.start;
      if (root.start === null) {
        const i = index.get(root.pid);
        if (i !== undefined) {
          root.start = inventory.items[i].start;
          this.origins.set(root.key, { pid: root.pid, start: root.start });
        }
      }
    }
    const previous = new Map(this.batch.readings.map(r => [r.pid, r])),
      host = native.host(),
      host_cpu =
        this.batch.host.total > 0n && host.total > this.batch.host.total && host.busy >= this.batch.host.busy
          ? Math.min(100, (100 * Number(host.busy - this.batch.host.busy)) / Number(host.total - this.batch.host.total))
          : null,
      readings: Reading[] = [],
      works = this.workspaces.map(id =>
        Object.assign(new Work(id), {
          known: true,
          partial: inventory.truncated,
        }),
      ),
      health = this.workspaces.map(
        id =>
          this.batch.health.find(h => h.id === id) ?? {
            id,
            cpu: new Alarm(),
          },
      );
    for (const identity of inventory.items) {
      if (this.stopping) throw Error("Stopped");
      const root = owner(identity.pid, inventory.items, index, roots);
      if (!root) continue;
      const work = works.find(w => w.id === root.workspace);
      if (!work) continue;
      work.count++;
      const value = native.counters(identity.pid);
      if (!value) {
        work.partial = true;
        continue;
      }
      const reading: Reading = {
        pid: identity.pid,
        workspace: root.workspace,
        identity_start: identity.start,
        at: now,
        value,
      };
      readings.push(reading);
      const proc = Object.assign(
        new Process(identity.pid, value.start, identity.name),
        delta(previous.get(identity.pid), reading),
        { memory: value.memory },
      );
      if (identity.pid === root.agent_pid) proc.provider = root.provider;
      work.add(proc);
      work.processes.push(proc);
    }
    works.forEach((work, i) => {
      for (const root of roots)
        if (
          root.workspace === work.id &&
          (root.start === null || !index.has(root.pid) || inventory.items[index.get(root.pid)!].start !== root.start)
        )
          work.partial = true;
      if (!work.count && !work.partial) {
        work.cpu = 0;
        work.memory = work.read = work.written = 0n;
      }
      const share = (work.cpu ?? 0) / Math.max(1, host.cores),
        high = !work.partial && host_cpu !== null && host_cpu >= 90 && share >= 25,
        low = work.cpu === null || host_cpu === null || host_cpu < 75 || share < 15;
      work.cpu_pressure = health[i].cpu.update(high, low, now) && work.cpu !== null;
      work.processes = leaders(work.processes);
      work.history = [
        ...this.current.workspace(work.id).history.slice(-(history_capacity - 1)),
        {
          at: now,
          cpu: work.cpu,
          memory: work.memory,
          io: work.read !== null && work.written !== null ? sat(work.read, work.written) : null,
        },
      ];
    });
    this.pending = {
      view: Object.assign(new Snapshot(), {
        sampled_at: now,
        interval_ms: this.interval_ms,
        host_cpu,
        host_memory: host.memory,
        cores: host.cores,
        memory_pressure: host.pressure,
        workspaces: works,
      }),
      readings,
      host,
      health,
    };
  }
}
