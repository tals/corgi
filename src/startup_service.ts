import { basename } from "node:path";
import * as startup from "./startup";
import * as os from "./os";
import * as native from "./trackers/resource_os";
import type { Client } from "./peer";
import type { Runtime, Pane } from "./runtime";
import type { Foreground } from "./detection";
import type { Request } from "./protocol";

type Process = { pid: number; start: bigint; group: number; pane: number; root: number; lines: string[] };
const processes = new WeakMap<Runtime, Map<string, Process>>();
function running(p: Process): boolean {
  return native.counters(p.pid)?.start === p.start && basename(os.processPath(p.pid) ?? "") === "mise";
}
export function update(runtime: Runtime, client: Client, q: Request<"startup">) {
  if (!runtime.pane(q.pane)) throw Error("NoPane");
  if (!q.id || q.id.length > 80 || q.detail.length > 4096) throw Error("Overflow");
  const previous = client.startup_wait;
  if (previous && (previous.id !== q.id || previous.pane !== q.pane || previous.provider !== q.provider))
    throw Error("AlreadyAttached");
  let wait = runtime.startup_waits.find(w => w.id === q.id) ?? previous;
  if (wait && (wait.pane !== q.pane || wait.provider !== q.provider)) throw Error("AlreadyAttached");
  const detail = startup.clean(q.detail);
  if (!wait)
    wait = {
      id: q.id,
      pane: q.pane,
      provider: q.provider,
      phase: q.phase,
      detail,
      started_at: Math.max(0, Math.min(Date.now(), Number(q.started_at))),
      cancelled: false,
    };
  if (!runtime.startup_waits.includes(wait)) {
    runtime.startup_waits.push(wait);
    runtime.changed();
  }
  client.startup_wait = wait;
  if (wait.phase !== q.phase || wait.detail !== detail) {
    wait.phase = q.phase;
    wait.detail = detail;
    runtime.changed();
  }
  return { ok: true as const, cancelled: wait.cancelled };
}
/** Observe a mise shim after exec, without intercepting the agent's terminal. */
export function observe(runtime: Runtime, pane: Pane, front: Foreground | null | undefined) {
  const job = front?.job;
  if (!job || basename(os.processPath(job.pid) ?? "") !== "mise") return;
  const start = native.counters(job.pid)?.start;
  if (start === undefined) return;
  const id = `mise:${job.pid}:${start}`;
  if (runtime.startup_waits.some(w => w.pane === pane.id && w.id !== id)) return;
  let tracked = processes.get(runtime);
  if (!tracked) processes.set(runtime, (tracked = new Map()));
  const lines = pane.terminal.text().split(/\r?\n/).map(startup.clean),
    previous = tracked.get(id);
  const before = new Set(previous?.lines ?? lines);
  const detail = lines.filter(line => !before.has(line) && /^mise\s/i.test(line)).at(-1);
  tracked.set(id, { pid: job.pid, start, group: front.pgid, pane: pane.id, root: pane.terminal.pid, lines });
  const wait = runtime.startup_waits.find(w => w.id === id);
  if (!wait) {
    runtime.startup_waits.push({
      id,
      pane: pane.id,
      provider: job.provider,
      phase: "agent",
      detail: "",
      started_at: Date.now(),
      cancelled: false,
    });
    runtime.changed();
  } else if (detail !== undefined && wait.detail !== detail) {
    wait.phase = startup.installing(detail) ? "installing" : "agent";
    wait.detail = detail;
    runtime.changed();
  }
}
/** Reporter connections own preparation; process identities own waits after exec. */
export function collect(runtime: Runtime, clients: Client[]) {
  const kept = new Set<string>();
  for (const client of clients) {
    const wait = client.startup_wait;
    if (!client.dead && wait && runtime.pane(wait.pane)) {
      kept.add(wait.id);
      if (!runtime.startup_waits.some(w => w.id === wait.id)) {
        runtime.startup_waits.push(wait);
        runtime.changed();
      }
    }
  }
  for (const [id, process] of processes.get(runtime) ?? []) {
    if (runtime.pane(process.pane)?.terminal.pid === process.root && running(process)) kept.add(id);
    else processes.get(runtime)!.delete(id);
  }
  if (runtime.startup_waits.some(w => !kept.has(w.id))) {
    runtime.startup_waits = runtime.startup_waits.filter(w => kept.has(w.id));
    runtime.changed();
  }
}
export function kill(runtime: Runtime, id: string) {
  const wait = runtime.startup_waits.find(w => w.id === id);
  if (!wait) throw Error("NoProcess");
  const child = processes.get(runtime)?.get(id);
  if (child) {
    const pane = runtime.pane(child.pane);
    if (!pane || !running(child) || pane.terminal.pid !== child.root || os.processGroup(child.pid) !== child.group)
      throw Error("NoProcess");
    process.kill(-child.group, "SIGKILL");
  }
  wait.cancelled = true;
  runtime.changed();
}
