import * as telemetry from "../telemetry";
import * as native from "./resource_os";
import * as gpu from "./gpu";
import { Provider } from "../providers";
import type { Runtime } from "../runtime";
import * as clock from "../clock";
import { Failure } from "../failure";
import { nativeFiles } from "../build_assets";
import type { Wire } from "../protocol";
export const history_capacity = 48,
  process_capacity = 64,
  /** Each history point covers this long. */
  history_bucket_ms = 5000;
export type Sort = "cpu" | "memory" | "io" | "gpu" | "gpu_memory";
const max64 = (1n << 64n) - 1n;
const sat = (a: bigint, b: bigint) => (a + b > max64 ? max64 : a + b);
export function cpuText(value: number | null) {
  return value === null ? "" : value >= 10000 ? (value / 1000).toFixed(0) + "k%" : value.toFixed(0) + "%";
}
export function memoryText(value: bigint | null) {
  if (value === null) return "";
  return value >= 1073741824n ? (Number(value) / 1073741824).toFixed(1) + "G" : (value / 1048576n).toString() + "M";
}
export function ioText(value: bigint | null) {
  if (value === null) return "";
  return value >= 1000000000n
    ? (Number(value) / 1000000000).toFixed(0) + "G/s"
    : value >= 1000000n
      ? (Number(value) / 1000000).toFixed(0) + "M/s"
      : (value / 1000n).toString() + "K/s";
}
/** Readings over one bucket: CPU, I/O and GPU utilization averaged over its
 * `samples`, memory at its peak. */
export type Point = {
  at: number;
  samples: number;
  cpu: number | null;
  memory: bigint | null;
  io: bigint | null;
  /** The workspace's figures on each device it used. */
  gpus: gpu.Share[];
  /** The processes that led each figure, and each device, over the bucket. */
  processes: Process[];
};
/** How many processes a history point keeps per figure, and per device. */
export const point_leaders = 5,
  device_leaders = 2;
const mean = (old: number | null, next: number | null, n: number) =>
  old === null ? next : next === null ? old : old + (next - old) / n;
const meanBig = (old: bigint | null, next: bigint | null, n: number) =>
  old === null ? next : next === null ? old : (old * BigInt(n - 1) + next) / BigInt(n);
const peak = (old: bigint | null, next: bigint | null) =>
  old === null ? next : next === null ? old : old > next ? old : next;
/** Shares over a bucket of `n` readings: a device missing from a reading was idle for it. */
function mergeShares(old: gpu.Share[], next: gpu.Share[], n: number): gpu.Share[] {
  const indices = [...new Set([...old, ...next].map(d => d.index))].sort((a, b) => a - b);
  return indices.map(index => {
    const was = old.find(d => d.index === index),
      now = next.find(d => d.index === index);
    return {
      index,
      util: mean(was ? was.util : 0, now ? now.util : 0, n),
      memory: peak(was?.memory ?? null, now?.memory ?? null),
    };
  });
}
/** Processes over a bucket of `n` readings, as `record` treats the workspace;
 * one missing from a reading had nothing to lead with in it. */
function mergeProcesses(old: Process[], next: Process[], n: number): Process[] {
  const key = (p: Process) => `${p.pid}:${p.start}`,
    keys = [...new Set([...old, ...next].map(key))];
  return keys.map(k => {
    const was = old.find(p => key(p) === k),
      now = next.find(p => key(p) === k),
      p = (now ?? was)!;
    return Object.assign(new Process(p.pid, p.start, p.name), {
      provider: p.provider,
      parent: p.parent,
      pane: p.pane,
      session: p.session,
      cpu: mean(was ? was.cpu : 0, now ? now.cpu : 0, n),
      memory: peak(was?.memory ?? null, now?.memory ?? null) ?? 0n,
      read: meanBig(was ? was.read : 0n, now ? now.read : 0n, n),
      written: meanBig(was ? was.written : 0n, now ? now.written : 0n, n),
      gpu: was?.gpu == null && now?.gpu == null ? null : mean(was?.gpu ?? 0, now?.gpu ?? 0, n),
      gpu_memory: peak(was?.gpu_memory ?? null, now?.gpu_memory ?? null),
      gpu_devices: mergeShares(was?.gpu_devices ?? [], now?.gpu_devices ?? [], n),
    });
  });
}
/** The processes leading any figure, or any device's utilization or memory. */
export function standouts(list: Process[]): Process[] {
  const keep = new Set<Process>(),
    lead = (value: (p: Process) => number | null | undefined, count: number) =>
      list
        .filter(p => (value(p) ?? 0) > 0)
        .sort((a, b) => value(b)! - value(a)! || a.pid - b.pid)
        .slice(0, count)
        .forEach(p => keep.add(p));
  for (const sort of ["cpu", "memory", "io", "gpu", "gpu_memory"] as const)
    lead(p => Process.value(sort, p), point_leaders);
  for (const index of new Set(list.flatMap(p => p.gpu_devices.map(d => d.index)))) {
    const on = (p: Process) => p.gpu_devices.find(d => d.index === index);
    lead(p => on(p)?.util, device_leaders);
    lead(p => {
      const memory = on(p)?.memory;
      return memory == null ? null : Number(memory);
    }, device_leaders);
  }
  return list.filter(p => keep.has(p));
}
/** `history` with `next` folded into its last point while both fall in one
 * bucket, else appended. */
export function record(history: Point[], next: Point): Point[] {
  const last = history.at(-1);
  if (!last || Math.floor(last.at / history_bucket_ms) !== Math.floor(next.at / history_bucket_ms))
    return [...history.slice(-(history_capacity - 1)), next];
  const n = last.samples + 1;
  return [
    ...history.slice(0, -1),
    {
      at: last.at,
      samples: n,
      cpu: mean(last.cpu, next.cpu, n),
      memory: peak(last.memory, next.memory),
      io: meanBig(last.io, next.io, n),
      gpus: mergeShares(last.gpus, next.gpus, n),
      processes: standouts(mergeProcesses(last.processes, next.processes, n)),
    },
  ];
}
export class Process {
  provider: Provider | null = null;
  cpu: number | null = null;
  memory = 0n;
  read: bigint | null = null;
  written: bigint | null = null;
  /** Null for a process the GPU source doesn't list. */
  gpu: number | null = null;
  gpu_memory: bigint | null = null;
  /** Its figures on each device it uses. */
  gpu_devices: gpu.Share[] = [];
  /** Its parent's pid, and the pane or background session it runs under. */
  parent = 0;
  pane: number | null = null;
  session: number | null = null;
  constructor(
    public pid: number,
    public start: bigint,
    public name: string,
  ) {}
  static less(sort: Sort, left: Process, right: Process) {
    const l = Process.value(sort, left),
      r = Process.value(sort, right);
    return l === r ? left.pid < right.pid : l > r;
  }
  static value(sort: Sort, p: Process) {
    switch (sort) {
      case "cpu":
        return p.cpu ?? -1;
      case "memory":
        return Number(p.memory);
      case "io":
        return p.read !== null && p.written !== null ? Number(sat(p.read, p.written)) : -1;
      case "gpu":
        return p.gpu ?? -1;
      case "gpu_memory":
        return p.gpu_memory === null ? -1 : Number(p.gpu_memory);
    }
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
  /** Null without a GPU source. */
  gpu: number | null = null;
  gpu_memory: bigint | null = null;
  /** Whether the workspace has used a GPU lately; only then do its figures show. */
  gpu_shown = false;
  /** Its figures on each device it uses, by index. */
  gpu_devices: gpu.Share[] = [];
  /** The least exact way any of its devices was read. */
  gpu_attribution: gpu.Attribution | null = null;
  processes: Process[] = [];
  history: Point[] = [];
  constructor(public id: number) {}
  add(p: Process) {
    this.memory = sat(this.memory ?? 0n, p.memory);
    if (p.cpu !== null) this.cpu = (this.cpu ?? 0) + p.cpu;
    if (p.read !== null) this.read = sat(this.read ?? 0n, p.read);
    if (p.written !== null) this.written = sat(this.written ?? 0n, p.written);
    if (p.gpu !== null) this.gpu = (this.gpu ?? 0) + p.gpu;
    if (p.gpu_memory !== null) this.gpu_memory = sat(this.gpu_memory ?? 0n, p.gpu_memory);
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
  gpus: gpu.Gpu[] = [];
  gpu_memory_kind = "";
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
export function fromJSON(value: Wire<Snapshot> | null | undefined): Snapshot {
  if (!value) return new Snapshot();
  const nullable = (n: number | bigint | null | undefined) => (n === null || n === undefined ? null : BigInt(n));
  const share = (s: Wire<gpu.Share>) => ({ index: s.index, util: s.util ?? null, memory: nullable(s.memory) });
  const restoreProcess = (p: Wire<Process>) =>
    Object.assign(new Process(p.pid, BigInt(p.start), p.name), {
      provider: Provider.parse(p.provider),
      cpu: p.cpu ?? null,
      memory: BigInt(p.memory ?? 0),
      read: nullable(p.read),
      written: nullable(p.written),
      gpu: p.gpu ?? null,
      gpu_memory: nullable(p.gpu_memory),
      gpu_devices: (p.gpu_devices ?? []).map(share),
      parent: p.parent ?? 0,
      pane: p.pane ?? null,
      session: p.session ?? null,
    });
  const restoreWork = (w: Wire<Work>) =>
    Object.assign(new Work(w.id), w, {
      memory: nullable(w.memory),
      read: nullable(w.read),
      written: nullable(w.written),
      gpu: w.gpu ?? null,
      gpu_memory: nullable(w.gpu_memory),
      gpu_shown: w.gpu_shown ?? false,
      gpu_devices: (w.gpu_devices ?? []).map(share),
      gpu_attribution: w.gpu_attribution ?? null,
      processes: (w.processes ?? []).map(restoreProcess),
      history: (w.history ?? []).map(point => ({
        at: point.at,
        samples: point.samples ?? 1,
        cpu: point.cpu ?? null,
        memory: nullable(point.memory),
        io: nullable(point.io),
        gpus: (point.gpus ?? []).map(share),
        processes: (point.processes ?? []).map(restoreProcess),
      })),
    });
  return Object.assign(new Snapshot(), value, {
    host_memory: BigInt(value.host_memory ?? 0),
    gpus: (value.gpus ?? []).map(g => ({
      index: g.index,
      name: g.name,
      util: g.util ?? null,
      used: nullable(g.used),
      total: nullable(g.total),
    })),
    gpu_memory_kind: value.gpu_memory_kind ?? "",
    workspaces: (value.workspaces ?? []).map(restoreWork),
  });
}
export type Root = {
  key: number;
  pid: number;
  start: bigint | null;
  workspace: number;
  agent_pid: number;
  provider: Provider | null;
  pane: number | null;
  session: number | null;
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
export type Signal = "term" | "kill";
/** Sends `signal` to a process the snapshot shows in `workspace`, if it is
 * still that process rather than a later one given its pid. */
export function signal(view: Snapshot, workspace: number, pid: number, start: bigint, signal: Signal): void {
  const shown = view.workspaces.find(w => w.id === workspace)?.processes.some(p => p.pid === pid && p.start === start);
  if (!shown || pid === process.pid || native.counters(pid)?.start !== start) throw Error("NoProcess");
  process.kill(pid, signal === "term" ? "SIGTERM" : "SIGKILL");
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
  const out: Process[] = [],
    sorts: Sort[] = list.some(p => p.gpu_memory !== null || p.gpu !== null)
      ? ["cpu", "memory", "io", "gpu", "gpu_memory"]
      : ["cpu", "memory", "io"];
  for (const sort of sorts) {
    list.sort((a, b) => (Process.less(sort, a, b) ? -1 : Process.less(sort, b, a) ? 1 : 0));
    for (const p of list.slice(0, Math.floor(process_capacity / sorts.length)))
      if (!out.some(x => x.pid === p.pid)) out.push(p);
  }
  return out;
}
export type Batch = {
  view: Snapshot;
  readings: Reading[];
  host: native.Host;
  health: { id: number; cpu: Alarm; gpu: gpu.Hold }[];
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
  const process = (p: Process) => Object.assign(new Process(p.pid, p.start, p.name), p);
  return Object.assign(new Snapshot(), view, {
    workspaces: view.workspaces.map(work =>
      Object.assign(new Work(work.id), work, {
        processes: work.processes.map(process),
        history: work.history.map(point => ({ ...point, processes: point.processes.map(process) })),
      }),
    ),
  });
}
export function restoreBatch(value: Batch): Batch {
  return {
    ...value,
    view: restoreSnapshot(value.view),
    health: value.health.map(h => ({
      id: h.id,
      cpu: Object.assign(new Alarm(), h.cpu),
      gpu: Object.assign(new gpu.Hold(), h.gpu),
    })),
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
  /** GPU readings; set in the Worker, where blocking calls are safe. */
  gpu: gpu.Sampler | null = null;
  private worker: (Worker & { unref(): void }) | null = null;
  private complete: (() => void) | null = null;
  private failure = new Failure();
  close() {
    this.stopping = true;
    telemetry.detach(this.worker);
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
              s.client.processes?.()[0] === root.pid &&
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
                pane: p.id,
                session: null,
              },
            ]
          : [];
      });
    for (const s of runtime.sessions) {
      const pid = s.client.processes?.()[0];
      if (!s.exited && s.workspace_id && pid)
        this.roots.push({
          key: s.id * 2 + 1,
          pid,
          start: null,
          workspace: s.workspace_id,
          agent_pid: pid,
          provider: s.provider,
          pane: null,
          session: s.id,
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
        telemetry.attach(this.worker);
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
          telemetry.detach(this.worker);
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
    // Holding NVML open keeps the driver initialized.
    this.worker?.postMessage({ release: true });
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
    const telemetry_started = telemetry.begin();
    const inventory_started = telemetry.begin();
    const inventory = native.inventory(this.roots.map(r => r.pid));
    telemetry.end("workspace.resources.inventory", inventory_started);
    const index = new Map(inventory.items.map((p, i) => [p.pid, i])),
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
    const previous = new Map(this.batch.readings.map(r => [r.pid, r]));
    const host_started = telemetry.begin();
    const host = native.host();
    telemetry.end("workspace.resources.host", host_started);
    const host_cpu =
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
            gpu: new gpu.Hold(),
          },
      );
    for (const identity of inventory.items) {
      if (this.stopping) throw Error("Stopped");
      const root = owner(identity.pid, inventory.items, index, roots);
      if (!root) continue;
      const work = works.find(w => w.id === root.workspace);
      if (!work) continue;
      work.count++;
      const value = inventory.counters(identity.pid);
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
        { memory: value.memory, parent: identity.parent, pane: root.pane, session: root.session },
      );
      if (identity.pid === root.agent_pid) proc.provider = root.provider;
      work.processes.push(proc);
    }
    const graphics_started = telemetry.begin();
    const graphics = this.sampleGpu(works);
    telemetry.end("workspace.resources.gpu", graphics_started);
    for (const work of works) for (const proc of work.processes) work.add(proc);
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
      if (graphics) {
        work.gpu ??= 0;
        work.gpu_memory ??= 0n;
        work.gpu_shown = health[i].gpu.update(work.gpu_memory > 0n || work.gpu > 0, now);
      }
      const share = (work.cpu ?? 0) / Math.max(1, host.cores),
        high = !work.partial && host_cpu !== null && host_cpu >= 90 && share >= 25,
        low = work.cpu === null || host_cpu === null || host_cpu < 75 || share < 15;
      work.cpu_pressure = health[i].cpu.update(high, low, now) && work.cpu !== null;
      work.processes = leaders(work.processes);
      work.history = record(this.current.workspace(work.id).history, {
        at: now,
        samples: 1,
        cpu: work.cpu,
        memory: work.memory,
        io: work.read !== null && work.written !== null ? sat(work.read, work.written) : null,
        gpus: work.gpu_devices.map(d => ({ ...d })),
        processes: standouts(work.processes),
      });
    });
    this.pending = {
      view: Object.assign(new Snapshot(), {
        sampled_at: now,
        interval_ms: this.interval_ms,
        host_cpu,
        host_memory: host.memory,
        cores: host.cores,
        memory_pressure: host.pressure,
        gpus: graphics ? gpu.gpus(graphics.devices) : [],
        gpu_memory_kind: graphics?.source.memory_kind ?? "",
        workspaces: works,
      }),
      readings,
      host,
      health,
    };
    telemetry.end("workspace.resources.sample", telemetry_started);
  }
  /** Fills in each workspace process's GPU usage; null without a GPU source. */
  private sampleGpu(works: Work[]) {
    const graphics = this.gpu?.read() ?? null;
    if (!graphics) return null;
    const held = this.gpu!.held,
      owned = new Map(works.flatMap(w => w.processes.map(p => [p.pid, { work: w, proc: p }] as const))),
      files = new Map<number, number[] | null>(),
      opened = (pid: number) => {
        if (!files.has(pid)) files.set(pid, native.nvidiaFiles(pid));
        return files.get(pid)!;
      };
    for (const [pid, start] of held) if (owned.get(pid)?.proc.start !== start) held.delete(pid);
    const { usage, modes } = gpu.attribute(graphics.devices, {
      ours: new Set(owned.keys()),
      exists: native.exists,
      holds: pid => {
        if (held.has(pid)) return true;
        if (!opened(pid)?.length) return false;
        held.set(pid, owned.get(pid)!.proc.start);
        return true;
      },
      holders: device =>
        device.minor === null ? [] : [...owned.keys()].filter(pid => opened(pid)?.includes(device.minor!)),
    });
    const rank: gpu.Attribution[] = ["process", "list", "device"];
    for (const [pid, u] of usage) {
      const { work, proc } = owned.get(pid)!;
      proc.gpu = u.util;
      proc.gpu_memory = u.memory;
      proc.gpu_devices = u.devices;
      for (const share of u.devices) {
        const total = gpu.find(work.gpu_devices, share.index);
        if (share.util !== null) total.util = (total.util ?? 0) + share.util;
        if (share.memory !== null) total.memory = sat(total.memory ?? 0n, share.memory);
        const mode = modes[graphics.devices.findIndex(d => d.index === share.index)];
        if (work.gpu_attribution === null || rank.indexOf(mode) > rank.indexOf(work.gpu_attribution))
          work.gpu_attribution = mode;
      }
    }
    return graphics;
  }
}
