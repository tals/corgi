/** Network faults for remote machines: the sandbox's proxies, behind its
 * private control socket, or, when a developer turns them on, this viewer's
 * own SSH connections to a real machine. */
import { createConnection } from "node:net";
import { Transform, type TransformCallback } from "node:stream";
export interface Faults {
  latency_ms: number;
  bandwidth_kib: number;
  outage_until: number;
  hang_seconds: number;
  hang_every_seconds: number;
  next_hang_at: number;
  accepted: number;
}
export interface Command {
  machine?: string;
  latency_ms?: number;
  bandwidth_kib?: number;
  outage_seconds?: number;
  hang_seconds?: number;
  hang_every_seconds?: number;
  drop?: boolean;
}
export function request(path: string, command: Command = {}): Promise<Record<string, Faults>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let data = "";
    const timer = setTimeout(() => socket.destroy(Error("SandboxControlTimedOut")), 1500);
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      reject(Error("SandboxControlClosed"));
    });
    socket.on("data", bytes => {
      data += bytes.toString();
      if (data.length > 65536) return socket.destroy(Error("SandboxReplyTooLarge"));
      if (!data.includes("\n")) return;
      try {
        const value = JSON.parse(data.slice(0, data.indexOf("\n")));
        if (value.error) reject(Error(value.error));
        else resolve(value);
      } catch (error) {
        reject(error);
      }
      socket.destroy();
    });
  });
}

/** Start-to-start cadence; manual outages do not move the recurring schedule. */
export class Policy {
  readonly state: Faults = {
    latency_ms: 0,
    bandwidth_kib: 0,
    outage_until: 0,
    hang_seconds: 5,
    hang_every_seconds: 0,
    next_hang_at: 0,
    accepted: 0,
  };
  private manualUntil = 0;
  private repeatingUntil = 0;

  apply(command: Command, now = Date.now()): void {
    const s = this.state;
    if (command.latency_ms !== undefined) s.latency_ms = command.latency_ms;
    if (command.bandwidth_kib !== undefined) s.bandwidth_kib = command.bandwidth_kib;
    if (command.hang_seconds !== undefined) s.hang_seconds = command.hang_seconds;
    if (command.hang_every_seconds !== undefined) s.hang_every_seconds = command.hang_every_seconds;
    if (command.hang_seconds !== undefined || command.hang_every_seconds !== undefined) {
      this.repeatingUntil = 0;
      s.next_hang_at = s.hang_every_seconds && s.hang_seconds ? now + s.hang_every_seconds * 1000 : 0;
    }
    if (command.outage_seconds !== undefined)
      this.manualUntil = command.outage_seconds ? now + command.outage_seconds * 1000 : 0;
    this.tick(now);
  }

  tick(now = Date.now()): boolean {
    const s = this.state;
    if (s.next_hang_at && now >= s.next_hang_at) {
      const period = s.hang_every_seconds * 1000;
      const start = s.next_hang_at + Math.floor((now - s.next_hang_at) / period) * period;
      this.repeatingUntil = start + s.hang_seconds * 1000;
      s.next_hang_at = start + period;
    }
    const until = Math.max(this.manualUntil, this.repeatingUntil);
    s.outage_until = until > now ? until : 0;
    return s.outage_until > 0;
  }
}

/** Bytes one direction may hold before its writer waits. */
const window = 1024 * 1024;
/** One direction of a connection under `policy`: each chunk waits out the
 * lag and the bandwidth, in order, and none leaves during an outage, which
 * keeps the connection open. */
export class Shaper extends Transform {
  private queue: { due: number; chunk: Buffer }[] = [];
  private held = 0;
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiting: TransformCallback | null = null;
  private ending: TransformCallback | null = null;
  constructor(private readonly policy: Policy) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const { latency_ms, bandwidth_kib } = this.policy.state;
    // A shorter lag never lets a later chunk overtake an earlier one.
    let due = Math.max(performance.now() + latency_ms, this.last);
    if (bandwidth_kib) due += (chunk.length * 1000) / (bandwidth_kib * 1024);
    this.last = due;
    this.queue.push({ due, chunk });
    this.held += chunk.length;
    if (this.held < window) done();
    else this.waiting = done;
    this.pump();
  }
  override _flush(done: TransformCallback): void {
    this.ending = done;
    this.pump();
  }
  override _destroy(error: Error | null, done: (error: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    done(error);
  }
  private pump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.destroyed) return;
    const now = performance.now(),
      held = this.policy.tick();
    while (!held && this.queue.length && this.queue[0].due <= now) {
      const { chunk } = this.queue.shift()!;
      this.held -= chunk.length;
      this.push(chunk);
    }
    if (this.waiting && this.held < window) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting();
    }
    if (this.queue.length) this.timer = setTimeout(() => this.pump(), held ? 100 : this.queue[0].due - now);
    else if (this.ending) {
      const ending = this.ending;
      this.ending = null;
      ending();
    }
  }
}

/** Faults a developer turned on for real machines in this viewer. Off, nothing
 * is in a machine's path; turning them on or off reconnects it. */
export class Local {
  private policies = new Map<string, Policy>();
  private connections = new Map<string, Set<() => void>>();
  /** Machines last reached by forwarding a socket, past this lab's reach. */
  private forwarded = new Set<string>();
  /** Whether faults turned on for `machine` would reach its connections. */
  shapes(machine: string): boolean {
    return !this.forwarded.has(machine);
  }
  /** `machine` forwards a socket, as an older profile does: faults can't reach it. */
  forwards(machine: string): void {
    this.forwarded.add(machine);
    this.policies.delete(machine);
  }
  enabled(machine: string): boolean {
    return this.policies.has(machine);
  }
  enable(machine: string, on: boolean): void {
    if (on === this.enabled(machine)) return;
    if (on) this.policies.set(machine, new Policy());
    else this.policies.delete(machine);
    this.drop(machine);
  }
  faults(): Record<string, Faults> {
    const out: Record<string, Faults> = {};
    for (const [machine, policy] of this.policies) {
      policy.tick();
      out[machine] = { ...policy.state };
    }
    return out;
  }
  apply(command: Command): void {
    if (!command.machine) return;
    if (command.drop) this.drop(command.machine);
    this.policies.get(command.machine)?.apply(command);
  }
  /** Tracks a connection to `machine`, which `drop` ends with `close`. With
   * faults on, its two directions pass through the returned shapers. */
  connect(machine: string, close: () => void): { up: Shaper; down: Shaper; done: () => void } | { done: () => void } {
    this.forwarded.delete(machine);
    let open = this.connections.get(machine);
    if (!open) this.connections.set(machine, (open = new Set()));
    open.add(close);
    const done = () => {
      open.delete(close);
      if (!open.size && this.connections.get(machine) === open) this.connections.delete(machine);
    };
    const policy = this.policies.get(machine);
    if (!policy) return { done };
    policy.state.accepted++;
    return { up: new Shaper(policy), down: new Shaper(policy), done };
  }
  drop(machine: string): void {
    for (const close of [...(this.connections.get(machine) ?? [])]) close();
  }
}
export const local = new Local();
