/** Opt-in aggregate timings and a bounded timeline; no I/O in measured spans. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

export const names = [
  "daemon.collect",
  "daemon.import",
  "daemon.observers",
  "daemon.trackers.schedule",
  "daemon.launcher",
  "daemon.recovery",
  "daemon.publish",
  "daemon.viewer_sync",
  "agent.foregrounds",
  "agent.cwd",
  "agent.detect",
  "agent.screen",
  "agent.usage.reconcile",
  "agent.usage.poll",
  "agent.usage.ingest",
  "agent.usage.results",
  "agent.provider.results",
  "runtime.changed",
  "agent.codex.snapshot",
  "workspace.resources.sample",
  "workspace.resources.inventory",
  "workspace.resources.host",
  "workspace.resources.gpu",
  "workspace.git",
  "workspace.worktrees",
  "workspace.ports",
  "viewer.sync",
  "viewer.prepare",
  "viewer.acknowledge",
  "viewer.wait",
  "viewer.pacer.quiet_answer",
  "viewer.maintenance",
  "viewer.session",
  "viewer.resources",
  "viewer.surface",
  "viewer.compose",
  "viewer.compare",
  "viewer.present",
  "viewer.retained",
  "viewer.composite",
  "viewer.replay",
  "surface.capture",
  "surface.receive",
  "native.encode",
  "native.execute",
  "native.decode",
  "native.info",
  "native.title",
  "native.tick",
  "native.surface",
  "native.live_text",
  "native.other",
  "wire.encode",
  "wire.decode",
  "terminal.feed",
  "terminal.snapshot",
  "pty.drain",
] as const;
export type Name = (typeof names)[number];
const ids = Object.fromEntries(names.map((name, id) => [name, id])) as Record<Name, number>;

export class Recorder {
  private totals = new Float64Array(names.length * 4);
  private events: Float64Array;
  private written = 0;
  constructor(readonly capacity = 0) {
    if (!Number.isInteger(capacity) || capacity < 0) throw Error("InvalidTelemetryCapacity");
    this.events = new Float64Array(capacity * 3);
  }
  record(name: Name, start: number, end: number, bytes = 0) {
    const id = ids[name],
      index = id * 4,
      duration = Math.max(0, end - start);
    this.totals[index]++;
    this.totals[index + 1] += duration;
    this.totals[index + 2] = Math.max(this.totals[index + 2], duration);
    this.totals[index + 3] += bytes;
    if (this.capacity) {
      const event = (this.written++ % this.capacity) * 3;
      this.events[event] = id;
      this.events[event + 1] = start;
      this.events[event + 2] = duration;
    }
  }
  snapshot() {
    const metrics = names.map((name, i) => ({
      name,
      calls: this.totals[i * 4],
      wall_ms: this.totals[i * 4 + 1],
      max_ms: this.totals[i * 4 + 2],
      bytes: this.totals[i * 4 + 3],
    }));
    const traceEvents = [];
    for (let i = Math.max(0, this.written - this.capacity); i < this.written; i++) {
      const offset = (i % this.capacity) * 3;
      traceEvents.push({
        name: names[this.events[offset]],
        ph: "X",
        pid: process.pid,
        tid: threadId,
        ts: (performance.timeOrigin + this.events[offset + 1]) * 1000,
        dur: this.events[offset + 2] * 1000,
      });
    }
    return { metrics, traceEvents, dropped_events: Math.max(0, this.written - this.capacity) };
  }
}

const directory = process.env.CORGI_TELEMETRY_DIR;
export const enabled = !!directory;
const recorder = enabled ? new Recorder(process.env.CORGI_TELEMETRY_TRACE ? 65536 : 0) : null;
type Worker = { postMessage(message: { telemetry: true }): void };
const workers = new Set<WeakRef<Worker>>();
export function attach(worker: Worker): void {
  if (enabled) workers.add(new WeakRef(worker));
}
export function detach(worker: Worker | null): void {
  if (enabled) for (const ref of workers) if (!ref.deref() || ref.deref() === worker) workers.delete(ref);
}
export function begin(): number {
  return enabled ? performance.now() : 0;
}
export function end(name: Name, start: number, bytes = 0): void {
  if (recorder) recorder.record(name, start, performance.now(), bytes);
}
export function count(name: Name): void {
  if (recorder) {
    const now = performance.now();
    recorder.record(name, now, now);
  }
}
export function native(request: object, start: number, bytes: number): void {
  if (!recorder) return;
  const op = "op" in request ? request.op : null;
  let name: Name;
  switch (op) {
    case "info":
      name = "native.info";
      break;
    case "tick":
      name = "native.tick";
      break;
    case "surface":
      name = "native.surface";
      break;
    case "liveText":
      name = "native.live_text";
      break;
    default:
      name = "native.other";
  }
  end(name, start, bytes);
}
/** Called outside timing windows, or on normal process exit. */
export function flush(): void {
  if (!recorder || !directory) return;
  for (const ref of workers) {
    const worker = ref.deref();
    try {
      if (worker) worker.postMessage({ telemetry: true });
      else workers.delete(ref);
    } catch {
      workers.delete(ref);
    }
  }
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${process.pid}-${threadId}.json`),
      JSON.stringify({
        pid: process.pid,
        thread: threadId,
        worker_count: workers.size,
        at: performance.now(),
        epoch_ms: performance.timeOrigin,
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
        ...recorder.snapshot(),
      }),
    );
  } catch {
    /* Diagnostics must not interrupt the application. */
  }
}
if (enabled) {
  if (isMainThread) process.on("SIGUSR2", flush);
  process.on("exit", flush);
}
