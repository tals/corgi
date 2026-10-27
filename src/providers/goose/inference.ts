import { spawn, type ChildProcess } from "node:child_process";
import type { Client, Event, Inference, Input, Place, Saved } from "../adapter";

/** A one-shot `goose run -t`: instructions and prompt combined as the
 * --text argument, the run's stdout as the answer. goose 1.50.1 rejects bare
 * stdin (it demands -i, -t, or --recipe) and --instructions takes a file and
 * conflicts with --text, so --text is the one-shot form. --no-profile loads
 * no default extensions, so private summaries run without tools or MCP. */
export class GooseInference implements Client {
  readonly ready = true;
  private events: Event[] = [];
  private waiters: (() => void)[] = [];
  private done = false;
  private ended = false;
  private proc: ChildProcess | null = null;
  private executable = "";
  private cwd = "";
  private instructions = "";
  private constructor() {}
  static start(at: Place, r: Inference): Client {
    const client = new GooseInference();
    client.executable = at.executable;
    client.cwd = at.cwd;
    client.instructions = r.instructions;
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
  /** A fresh run for one prompt: the harness only prompts a drained client,
   * so no live run is ever replaced here. */
  private run(text: string): void {
    this.events = [];
    this.done = false;
    this.ended = false;
    const proc = spawn(this.executable, ["run", "-t", this.instructions + "\n\n" + text, "--no-profile"], {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    let out = "";
    proc.stdout.on("data", chunk => {
      out += chunk;
    });
    const finish = (failed: boolean) => {
      if (this.ended) return;
      this.ended = true;
      this.done = true;
      if (out.trim()) this.events.push({ kind: "message", session: "", text: out });
      this.events.push({
        kind: "turn",
        session: "",
        turn: "",
        phase: "ended",
        outcome: failed ? "failed" : "completed",
      });
      this.events.push({ kind: "ended" });
      this.notify();
    };
    proc.on("error", () => finish(true));
    proc.on("close", code => finish(code !== 0));
  }
  send(input: Input): void {
    if (input.kind === "interrupt") this.close();
    else if (input.kind === "prompt") this.run(input.text);
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
