import { spawn, type ChildProcess } from "node:child_process";
import type { Client, Event, Inference, Input, Place, Saved } from "../adapter";

/** A one-shot `goose run`: instructions on stdin, the run's stdout as the
 * answer. Tool-less-ness and the output shape are bench-verified, not yet
 * proven; see the adapter's proof-of-concept notes. */
export class GooseInference implements Client {
  readonly ready = true;
  private events: Event[] = [];
  private waiters: (() => void)[] = [];
  private done = false;
  private ended = false;
  private proc: ChildProcess | null = null;
  private constructor() {}
  static start(at: Place, r: Inference): Client {
    const client = new GooseInference();
    const proc = spawn(at.executable, ["run"], { cwd: at.cwd, stdio: ["pipe", "pipe", "pipe"] });
    client.proc = proc;
    let text = "";
    proc.stdout.on("data", chunk => {
      text += chunk;
    });
    const finish = () => {
      if (client.ended) return;
      client.ended = true;
      client.done = true;
      if (text.trim()) client.events.push({ kind: "message", session: "", text });
      client.events.push({ kind: "ended" });
      client.notify();
    };
    proc.on("error", finish);
    proc.on("close", finish);
    proc.stdin.on("error", () => {});
    proc.stdin.end(r.instructions);
    return client;
  }
  static restore(_saved: Saved, _live: boolean): Client {
    const client = new GooseInference();
    client.done = true;
    client.ended = true;
    client.events.push({ kind: "ended" });
    return client;
  }
  private notify() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
  send(input: Input): void {
    if (input.kind === "interrupt") this.close();
  }
  take(): Event[] {
    const events = this.events;
    this.events = [];
    return events;
  }
  async wait(deadline: number): Promise<void> {
    if (this.events.length > 0 || this.done) return;
    await new Promise<void>(resolve => {
      this.waiters.push(resolve);
      setTimeout(
        () => {
          const at = this.waiters.indexOf(resolve);
          if (at >= 0) this.waiters.splice(at, 1);
          resolve();
        },
        Math.max(0, deadline - Date.now()),
      );
    });
  }
  close(): void {
    if (this.proc && !this.done) this.proc.kill();
    this.done = true;
    this.notify();
  }
  save(_live: boolean): Saved {
    return { state: {}, handles: [] };
  }
  processes(): number[] {
    return this.proc?.pid !== undefined && !this.done ? [this.proc.pid] : [];
  }
}
