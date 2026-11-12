/** The live view as the run's main thread sees it: a sink for the run's
 * events, its questions, and its end. On a terminal the view runs in a worker
 * (`live_worker.ts`) so it keeps drawing while git calls block this thread;
 * `inline` draws in this thread instead, for tests. Nothing here throws into
 * the run, and the terminal is put back however the process ends. */
import type { LiveEvent, Sink } from "./live_events";
import type { card } from "./live_render";
import {
  fallback,
  frameMs,
  type FromWorker,
  lock,
  pinned,
  sharedSize,
  slot,
  type ToWorker,
  View,
  writeAll,
} from "./live_worker";
import * as term from "./term";

type End = Extract<LiveEvent, { t: "end" }>;
/** How long the run waits for the worker: to make room for a question, and to write the card. */
const askWaitMs = 2000;
/** Room for the fireworks too, which play before a successful run's card. */
const finishWaitMs = 5000;
const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

interface Backend {
  send(e: LiveEvent): void;
  ask(question: string, ask: (q: string) => string | null): string | null;
  finish(e: End): Promise<void>;
}

export class Live {
  private last: End | null = null;
  /** Takes the run's events; never throws. */
  readonly sink: Sink = e => {
    try {
      if (e.t === "end") this.last = e;
      this.backend.send(e);
    } catch {}
  };

  private constructor(private readonly backend: Backend) {}

  static start(o: {
    verbose: boolean;
    color: boolean;
    /** The command, for the card of an error before the run began. */
    command?: string;
    inline?: { write: (s: string) => void; rows: number; cols: number; card?: typeof card };
    /** Test hook: the worker script, in place of `live_worker.ts`. */
    script?: URL;
  }): Live {
    return new Live(o.inline ? inline(o.inline, o) : worker(o));
  }

  /** The end the run sent, if it sent one. */
  get received(): End | null {
    return this.last;
  }

  /** Asks `question` with `ask` below the view, which waits meanwhile. */
  ask(question: string, ask: (q: string) => string | null): string | null {
    return this.backend.ask(question, ask);
  }

  /** Replaces the view with the card for `e` and puts the terminal back. */
  async end(e: End): Promise<void> {
    try {
      await this.backend.finish(e);
    } catch {}
  }
}

/** A view drawn in this thread, into `write`. */
function inline(
  screen: { write: (s: string) => void; rows: number; cols: number; card?: typeof card },
  o: { verbose: boolean; color: boolean; command?: string },
): Backend {
  const write = (s: string) => {
      try {
        screen.write(s);
      } catch {}
    },
    view = new View({
      write,
      rows: () => screen.rows,
      cols: () => screen.cols,
      verbose: o.verbose,
      color: o.color,
      ...(o.command ? { command: o.command } : {}),
      ...(screen.card ? { card: screen.card } : {}),
    }),
    timer = setInterval(() => view.tick(), frameMs);
  timer.unref();
  return {
    send: e => view.event(e),
    ask: (question, ask) => {
      view.ask(question);
      let answer: string | null = null;
      try {
        return (answer = ask(question));
      } finally {
        view.answered(answer);
      }
    },
    finish: async e => {
      clearInterval(timer);
      try {
        view.finish(e);
      } catch {
        write(fallback(e, view.pinned ? screen.rows : null));
      }
    },
  };
}

/** A view drawn by a worker on stdout. This thread restores the terminal
 * when the process exits before the view ended: on a crash, `process.exit`,
 * or a signal. */
function worker(o: { verbose: boolean; color: boolean; command?: string; script?: URL }): Backend {
  const shared = new Int32Array(new SharedArrayBuffer(sharedSize)),
    w = new Worker(o.script ?? new URL("./live_worker.ts", import.meta.url)),
    rows = process.stdout.rows || 24,
    // The worker decides the same at its start, from the same terminal.
    pinnedView = pinned(o.verbose, rows);
  let alive = true,
    over = false;
  const post = (m: ToWorker) => {
    if (!alive) return;
    try {
      w.postMessage(m);
    } catch {
      alive = false;
    }
  };
  w.addEventListener("error", () => void (alive = false));
  w.addEventListener("close", () => void (alive = false));
  // An unfinished view never keeps the process alive.
  (w as unknown as { unref(): void }).unref();
  post({
    t: "init",
    shared: shared.buffer as SharedArrayBuffer,
    verbose: o.verbose,
    color: o.color,
    ...(o.command ? { command: o.command } : {}),
  });

  /** Takes the terminal from the worker for good and writes `text`. */
  const takeOver = (text: string) => {
    Atomics.store(shared, slot.stopped, 1);
    lock(shared, 200);
    try {
      writeAll(1, text);
    } catch {}
  };
  const onExit = () => {
    if (over) return;
    over = true;
    // A pinned view leaves the cursor in the scroll region: the prompt goes below it.
    takeOver(term.restore() + (pinnedView ? `\x1b[${process.stdout.rows || rows};1H\n` : ""));
  };
  /** Puts the terminal back and ends the process for a signal, unless another
   * handler does (the harness kills its process group first; the exit hook
   * then restores). Without a listener, Bun would end without the exit hook. */
  const onSignal = (signal: NodeJS.Signals) => {
    if (process.listenerCount(signal) > 1) return;
    onExit();
    process.exit(exitCodes[signal as keyof typeof exitCodes] ?? 1);
  };
  const signals = Object.keys(exitCodes) as NodeJS.Signals[];
  process.on("exit", onExit);
  for (const signal of signals) process.on(signal, onSignal);
  const unhook = () => {
    process.off("exit", onExit);
    for (const signal of signals) process.off(signal, onSignal);
  };

  return {
    send: e => post({ t: "event", e, at: Date.now() }),
    ask: (question, ask) => {
      const seen = Atomics.load(shared, slot.asked);
      post({ t: "ask", question });
      // The question must come below the frame and with the cursor shown.
      if (alive) Atomics.wait(shared, slot.asked, seen, askWaitMs);
      let answer: string | null = null;
      try {
        return (answer = ask(question));
      } finally {
        post({ t: "answered", answer });
      }
    },
    finish: async e => {
      if (over) return;
      const finished =
        alive &&
        (await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), finishWaitMs);
          w.addEventListener("message", (m: MessageEvent<FromWorker>) => {
            if (m.data?.t === "finished") {
              clearTimeout(timer);
              // A card that failed is replaced below, as for a worker that never answered.
              resolve(m.data.ok === true);
            }
          });
          w.addEventListener("error", () => {
            clearTimeout(timer);
            resolve(false);
          });
          post({ t: "finish", e });
        }));
      over = true;
      unhook();
      // The view is gone or failed: put the terminal back and print the outcome as plain output would.
      if (!finished) takeOver(fallback(e, pinnedView ? process.stdout.rows || rows : null));
      w.terminate();
    },
  };
}
