/** A short command's progress on a terminal (`rollback`): its tasks as a
 * checklist redrawn in place, a spinner and clock on the running one, then
 * the outcome's card below the finished list. It draws from the main thread:
 * the only slow task (the dependency install) runs async, so the timer keeps
 * turning. The terminal is put back however the process ends. */
import type { LiveEvent } from "./live_events";
import { outcomeCard, type TaskLine, taskFrame } from "./live_render";
import { frameMs } from "./live_worker";
import { Screen } from "./screen";
import * as term from "./term";

type End = Extract<LiveEvent, { t: "end" }>;
const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

export class TaskView {
  private readonly tasks: TaskLine[] = [];
  private readonly screen: Screen;
  private readonly now: () => number;
  private readonly started: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private done = false;
  private unhook = () => {};

  constructor(
    private readonly o: {
      write: (s: string) => void;
      rows: () => number;
      cols: () => number;
      color: boolean;
      command: string;
      branch?: string | null;
      now?: () => number;
      /** Test hook: false leaves the process's exit and signal handlers alone. */
      hooks?: boolean;
    },
  ) {
    this.now = o.now ?? Date.now;
    this.started = this.now();
    this.screen = new Screen({ write: o.write, rows: o.rows, cols: o.cols, verbose: false });
    if (o.hooks !== false) this.hook();
  }

  /** Starts task `id`, or ends it as `state` with what it did. */
  task(id: string, state: TaskLine["state"], detail = ""): void {
    if (this.done) return;
    const now = this.now();
    let t = this.tasks.find(x => x.id === id);
    if (!t) this.tasks.push((t = { id, state, detail, startedMs: now, ms: null }));
    else {
      t.state = state;
      if (detail) t.detail = detail;
    }
    if (state !== "running") t.ms = now - t.startedMs;
    this.spin(this.tasks.some(x => x.state === "running"));
    this.draw();
  }

  /** Leaves the finished list in the scrollback with the card for `e` below
   * it, and puts the terminal back. */
  finish(e: End): void {
    if (this.done) return;
    this.done = true;
    this.spin(false);
    this.unhook();
    const width = this.o.cols(),
      list = this.tasks.length ? [...this.frame(), ""] : [];
    this.screen.finish([
      ...list,
      ...outcomeCard(e, {
        width,
        color: this.o.color,
        command: this.o.command,
        tookMs: e.ok ? this.now() - this.started : null,
      }),
    ]);
  }

  private frame(): string[] {
    return taskFrame(
      { command: this.o.command, branch: this.o.branch ?? null, tasks: this.tasks },
      { width: this.o.cols(), nowMs: this.now(), color: this.o.color },
    );
  }

  private draw() {
    if (!this.done) this.screen.draw(this.frame());
  }

  private spin(on: boolean) {
    if (on && !this.timer) {
      this.timer = setInterval(() => this.draw(), frameMs);
      this.timer.unref?.();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Puts the terminal back when the process ends before the view did. Bun
   * skips the exit hook on a signal without a listener, hence the listeners. */
  private hook() {
    const onExit = () => {
      if (!this.done) this.o.write(this.screen.restore());
    };
    const onSignal = (signal: NodeJS.Signals) => {
      if (process.listenerCount(signal) > 1) return;
      onExit();
      process.exit(exitCodes[signal as keyof typeof exitCodes] ?? 1);
    };
    const signals = Object.keys(exitCodes) as NodeJS.Signals[];
    process.on("exit", onExit);
    for (const signal of signals) process.on(signal, onSignal);
    this.unhook = () => {
      process.off("exit", onExit);
      for (const signal of signals) process.off(signal, onSignal);
    };
  }
}
