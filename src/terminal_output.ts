import { n, ptr } from "./native_ffi";
import { ReadyLoop, WRITE } from "./fd_loop";

const max_bytes = 16 * 1024 * 1024;
const max_records = 128;
const write_budget = 256 * 1024;

/** Ordered terminal bytes. The viewer only diffs another frame after these drain. */
export class Output {
  private queue: Uint8Array[] = [];
  private offset = 0;
  private bytes = 0;
  private retained = 0;
  private failure: Error | null = null;
  private waiters = new Set<() => void>();
  private flags: number;
  private loop = new ReadyLoop();
  private registration;
  private closed = false;
  constructor(readonly fd: number) {
    this.flags = n.probe_flags(fd, -1);
    this.registration = this.loop.watch(fd, () => this.flush());
  }
  get pending(): number {
    return this.bytes;
  }
  check(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw Error("OutputClosed");
  }
  write(data: string | Uint8Array): void {
    this.check();
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (!bytes.length) return;
    if (this.retained + bytes.length > max_bytes || this.queue.length >= max_records) throw Error("OutputBackpressure");
    this.queue.push(bytes);
    this.bytes += bytes.length;
    this.retained += bytes.length;
    this.flush();
  }
  private flush(): void {
    if (this.closed || this.failure) return;
    let budget = write_budget;
    while (this.queue.length && budget > 0) {
      const bytes = this.queue[0].subarray(this.offset),
        count = n.probe_write(this.fd, ptr(bytes), Math.min(bytes.length, budget));
      if (count > 0) {
        this.offset += count;
        this.bytes -= count;
        budget -= count;
        if (this.offset === this.queue[0].length) {
          this.retained -= this.queue.shift()!.length;
          this.offset = 0;
        }
      } else if (count === -4) continue;
      else if (count === -11 || count === -35) break;
      else {
        this.failure = Error("WriteFailed");
        break;
      }
    }
    this.registration.arm(this.bytes && !this.failure ? WRITE : 0);
    if (!this.bytes || this.failure) {
      for (const waiter of this.waiters) waiter();
    }
  }
  async drain(): Promise<void> {
    this.check();
    if (!this.bytes) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        if (this.failure) reject(this.failure);
        else resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        reject(Error("OutputTimeout"));
      }, 5000);
      this.waiters.add(done);
    });
  }
  async finish(reset: string): Promise<void> {
    try {
      this.write(reset);
      await this.drain();
    } catch (error) {
      try {
        this.emergency(reset);
      } catch {}
      throw error;
    }
  }
  /** A terminating process cannot wait for queued frames or asynchronous readiness. */
  emergency(data: string): void {
    this.close();
    // Cancel an incomplete escape sequence before resetting terminal modes.
    writeSync(this.fd, "\x18\x1b\\" + data, 500);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failure ??= Error("OutputClosed");
    for (const waiter of this.waiters) waiter();
    this.registration.close();
    this.loop.close();
    n.probe_flags(this.fd, this.flags);
    this.queue = [];
    this.bytes = 0;
    this.retained = 0;
  }
}

let stdout: Output | null = null;
export function start(): Output {
  if (stdout) throw Error("OutputOpen");
  return (stdout = new Output(1));
}
export async function drain(): Promise<void> {
  await stdout?.drain();
}
export function stop(): void {
  stdout?.close();
  stdout = null;
}
export function ready(): boolean {
  stdout?.check();
  return !stdout?.pending;
}
export function emergency(data: string): void {
  const output = stdout;
  stdout = null;
  if (output) output.emergency(data);
  else writeSync(1, "\x18\x1b\\" + data, 500);
}
export function write(data: string | Uint8Array): void {
  if (stdout) return stdout.write(data);
  writeSync(1, data, 0);
}
/** Only emergency restoration waits synchronously, with a fixed deadline. */
function writeSync(fd: number, data: string | Uint8Array, wait_ms: number): void {
  const bytes = typeof data === "string" ? Buffer.from(data) : data,
    flags = n.probe_flags(fd, -1),
    until = performance.now() + wait_ms;
  n.probe_nonblock(fd);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const part = bytes.subarray(offset),
        written = n.probe_write(fd, ptr(part), part.length);
      if (written > 0) offset += written;
      else if (written === -4) continue;
      else if ((written === -11 || written === -35) && performance.now() < until)
        n.probe_writable(fd, Math.max(1, Math.ceil(until - performance.now())));
      else throw Error("WriteFailed");
    }
  } finally {
    n.probe_flags(fd, flags);
  }
}
