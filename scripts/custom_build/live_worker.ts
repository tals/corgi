/** The live view's drawing: a `View` keeps the state the run's events build
 * and draws it on a `Screen`. Run as a worker (`live.ts` starts it), it draws
 * on the terminal while the run's synchronous git calls hold the main thread,
 * so spinners and clocks never freeze. */
import { writeSync } from "node:fs";
import tty from "node:tty";
import type { LiveEvent } from "./live_events";
import { card, clock, doneLine, finaleFrameMs, fireworks, frame, outcomeCard, problems } from "./live_render";
import { apply, initial, type LiveState } from "./live_state";
import { Screen } from "./screen";
import * as term from "./term";

type End = Extract<LiveEvent, { t: "end" }>;
/** At most 10 frames a second. */
export const frameMs = 100;
/** A run that took longer than this sends a desktop notification at its end. */
const notifyAfterMs = 60_000;
/** `--verbose` pins the view only on a terminal this tall; below, it draws
 * inline, so a short pane keeps the frame's footer. */
const pinnedRows = 20;
export const pinned = (verbose: boolean, rows: number): boolean => verbose && rows >= pinnedRows;

export type ViewOptions = {
  write: (s: string) => void;
  rows: () => number;
  cols: () => number;
  verbose: boolean;
  color: boolean;
  /** The command, for the card of an end without a run (an error before it began). */
  command?: string;
  now?: () => number;
  /** Test hook: draws the card in place of `live_render.card`. */
  card?: typeof card;
  /** Plays the fireworks before the card of a run that fully succeeded. */
  finale?: boolean;
  /** How the fireworks wait between frames (a test hook). */
  wait?: (ms: number) => Promise<void>;
};

export class View {
  private s: LiveState = initial();
  private readonly screen: Screen;
  private readonly verbose: boolean;
  private readonly now: () => number;
  private lastDraw = -Infinity;
  /** The frame on screen and the size it was drawn at, to skip drawing it again. */
  private shown = "";
  /** The tab progress written last. */
  private progress = "";
  /** Verbose: log text after its last line break. */
  private partial = "";
  private asking = false;
  private done = false;

  constructor(private readonly o: ViewOptions) {
    this.verbose = pinned(o.verbose, o.rows());
    this.now = o.now ?? Date.now;
    this.screen = new Screen({ write: o.write, rows: o.rows, cols: o.cols, verbose: this.verbose });
  }

  /** Takes an event at `at`; draws when the last frame is at least `frameMs` old. */
  event(e: LiveEvent, at = this.now()): void {
    if (this.done) return;
    this.s = apply(this.s, e, at);
    if (e.t === "log" && this.verbose) this.log(e.text);
    if (this.now() - this.lastDraw >= frameMs) this.draw();
  }

  /** The timer's frame, for spinners and clocks: drawn when it changed. */
  tick(): void {
    this.draw();
  }

  /** The terminal changed size: lay the frame out again now. */
  resized(): void {
    this.shown = "";
    this.draw();
  }

  /** Shows the frame as it is now and stops drawing, so `question` can be
   * asked below it; notifies, since the run waits for an answer. */
  ask(question: string): void {
    if (this.done) return;
    this.draw();
    this.screen.suspend();
    this.screen.keep([question]);
    this.asking = true;
    this.o.write(term.notify(`custom-build: ${question.trim()} (waiting)`));
  }

  /** Draws again below the question and its answer. */
  answered(answer: string | null): void {
    if (this.done || !this.asking) return;
    if (answer !== null) this.screen.keep([answer]);
    this.asking = false;
    this.screen.resume();
    this.shown = "";
    this.draw();
  }

  /** Replaces the view with the card for `e` and puts the terminal back.
   * Throws when it couldn't: the caller then restores and prints `plain(e)`. */
  finish(e: End): void {
    const lines = this.end(e);
    if (lines) this.screen.finish([...lines, ...this.closing(e)]);
  }
  /** Like `finish`, then fireworks below the card for a run that succeeded:
   * a rebuild that built its binary (problems or not), or any other run with
   * no problems; not under a pinned `--verbose` view. Their last frame stays,
   * with the rebuild's done line under it. */
  async finishShow(e: End): Promise<void> {
    const lines = this.end(e);
    if (!lines) return;
    const s = this.s,
      success = e.ok && s.command !== null && (!!e.binary || !problems(s)),
      show =
        this.o.finale && this.o.color && !this.verbose && success
          ? fireworks(this.o.cols(), this.o.color, Math.floor(this.now()))
          : [],
      wait = this.o.wait ?? Bun.sleep;
    if (!show.length) return this.screen.finish([...lines, ...this.closing(e)]);
    // The card goes to the scrollback first; the show plays below it, and its
    // last frame stays as the end.
    this.screen.print(lines);
    for (const frame of show.slice(0, -1)) {
      this.screen.draw(frame);
      await wait(finaleFrameMs);
    }
    this.screen.finish([...show[show.length - 1], ...this.closing(e)]);
  }
  /** The rebuild's done line, last under the card (or the fireworks). */
  private closing(e: End): string[] {
    return this.s.command === null ? [] : doneLine(e, { width: this.o.cols(), color: this.o.color });
  }
  /** Ends the view on `e` and returns its card; null when it had ended already. */
  private end(e: End): string[] | null {
    if (this.done) return null;
    const now = this.now();
    this.s = apply(this.s, e, now);
    if (this.asking) this.answered(null);
    if (this.partial) this.screen.log([this.partial]);
    this.partial = "";
    let out = "";
    if (!e.ok) out += term.tabProgress("error", this.percent(now));
    const s = this.s,
      ms = e.activeMs !== undefined ? e.activeMs - s.clock.activeMs : this.invocation(now);
    if (ms > notifyAfterMs) out += term.notify(notice(s, e, ms));
    if (out) this.o.write(out);
    this.done = true;
    // Without a begin there is no run to show: the outcome's card alone.
    const width = this.o.cols(),
      lines =
        s.command === null
          ? outcomeCard(e, { width, color: this.o.color, command: this.o.command ?? null })
          : (this.o.card ?? card)(s, { width, color: this.o.color });
    return lines;
  }

  /** Whether `--verbose` pinned the view (it then needs the cursor moved below the log). */
  get pinned(): boolean {
    return this.verbose;
  }

  private log(text: string) {
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop()!;
    if (parts.length) this.screen.log(parts);
  }

  /** Time this invocation has run. */
  private invocation(now: number): number {
    return this.s.clock.sinceMs === null ? 0 : Math.max(0, now - this.s.clock.sinceMs);
  }

  /** How far the run is: its time against the estimate, or without one the stages done. */
  private percent(now: number): number {
    const s = this.s,
      total = s.estimate.totalMs;
    if (total) return Math.min(99, ((s.clock.activeMs + this.invocation(now)) / total) * 100);
    return s.stages.length ? (s.stages.filter(st => st.state === "done").length / s.stages.length) * 100 : 0;
  }

  private draw() {
    if (this.done || this.asking || this.s.command === null) return;
    const now = this.now(),
      s = this.s,
      stopped =
        s.ended?.ok === false || s.stages.some(st => (s.items[st.name] ?? []).some(it => it.state === "failed")),
      progress = term.tabProgress(stopped ? "error" : "on", this.percent(now)),
      lines = frame(s, {
        width: this.o.cols(),
        nowMs: now,
        color: this.o.color,
        verbose: this.verbose,
        rows: this.screen.room(),
      }),
      shown = `${this.o.cols()}x${this.o.rows()}\n${lines.join("\n")}`;
    this.lastDraw = now;
    if (progress !== this.progress) this.o.write((this.progress = progress));
    if (shown === this.shown) return;
    this.shown = shown;
    this.screen.draw(lines);
  }
}

/** The end `e` as the plain output prints it: its headline, lines and report. */
export function plain(e: End): string[] {
  const lines = [`custom-build: ${e.headline}`, ...e.lines];
  if (e.report && !e.lines.some(line => line.includes(e.report!))) lines.push(`  report: ${e.report}`);
  return lines;
}
/** What puts the terminal back after a view that couldn't finish, then prints
 * `e` as plain output: a pinned view first moves the cursor below its log. */
export function fallback(e: End, pinnedRows: number | null): string {
  return `${term.restore()}${pinnedRows ? `\x1b[${pinnedRows};1H\n` : "\n"}${plain(e).join("\n")}\n`;
}

/** The desktop notification's text for the end `e` after `ms` of running. */
function notice(s: LiveState, e: End, ms: number): string {
  if (/^stopped\b/.test(e.headline)) return `custom-build ${e.headline}`;
  if (!e.ok) return `custom-build: ${e.headline}`;
  const took = e.activeMs ?? ms,
    last = (s.estimate.last ?? s.base.last)?.activeMs,
    compare =
      e.activeMs && last ? ` (${clock(Math.abs(last - e.activeMs))} ${last >= e.activeMs ? "faster" : "slower"})` : "";
  return `custom-build: ${e.headline} in ${clock(took)}${compare}`;
}

/** What `live.ts` sends the worker. */
export type ToWorker =
  | { t: "init"; shared: SharedArrayBuffer; verbose: boolean; color: boolean; command?: string }
  | { t: "event"; e: LiveEvent; at: number }
  | { t: "ask"; question: string }
  | { t: "answered"; answer: string | null }
  | { t: "finish"; e: End };
/** What the worker sends back: `ok` false when the card couldn't be drawn. */
export type FromWorker = { t: "finished"; ok: boolean };
/** Slots of the array both threads share: a lock around terminal writes, a
 * count of questions the view has made room for, and whether the main thread
 * took the terminal over for good (it is exiting). */
export const slot = { lock: 0, asked: 1, stopped: 2 } as const;
export const sharedSize = 3 * Int32Array.BYTES_PER_ELEMENT;

/** Takes the write lock, waiting up to `ms`; false when it couldn't. */
export function lock(shared: Int32Array, ms = Infinity): boolean {
  const until = performance.now() + ms;
  while (Atomics.compareExchange(shared, slot.lock, 0, 1) !== 0) {
    const left = until - performance.now();
    if (left <= 0) return false;
    Atomics.wait(shared, slot.lock, 1, Math.min(left, 50));
  }
  return true;
}
export function unlock(shared: Int32Array): void {
  Atomics.store(shared, slot.lock, 0);
  Atomics.notify(shared, slot.lock);
}

const pause = new Int32Array(new SharedArrayBuffer(4));
/** Writes all of `text` to `fd`, waiting out a terminal that is full for now. */
export function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let at = 0,
    tries = 0;
  while (at < bytes.length) {
    try {
      at += writeSync(fd, bytes, at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || ++tries > 200) throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

/** The terminal's size as it is now, read again on every call. A worker gets
 * no resize events, and its `process.stdout` keeps the size it started with:
 * Bun handles SIGWINCH on the main thread, which the run's git calls block.
 * A stream of the worker's own asks the terminal (`_refreshSize`). */
export function terminalSize(fd = 1): () => { rows: number; cols: number } {
  let stream: (tty.WriteStream & { _refreshSize?: () => void }) | null = null;
  try {
    if (tty.isatty(fd)) stream = new tty.WriteStream(fd);
  } catch {}
  return () => {
    try {
      stream?._refreshSize?.();
    } catch {}
    return {
      rows: stream?.rows || process.stdout.rows || 24,
      cols: stream?.columns || process.stdout.columns || 80,
    };
  };
}

export type Port = {
  onmessage: (m: MessageEvent<ToWorker>) => void | Promise<void>;
  postMessage: (m: FromWorker) => void;
};
/** Serves `live.ts`'s messages on `port`, drawing with a view `make` gives. */
export function serve(port: Port, make: (o: ViewOptions) => View = o => new View(o)): void {
  let view: View | null = null,
    shared = new Int32Array(new SharedArrayBuffer(sharedSize)),
    timer: ReturnType<typeof setInterval> | null = null,
    size = { rows: 24, cols: 80 },
    measure = () => size;
  /** Reads the terminal's size; a change lays the frame out again. */
  const remeasure = () => {
    const was = size;
    size = measure();
    if (view && (size.rows !== was.rows || size.cols !== was.cols)) view.resized();
  };
  const write = (text: string) => {
    if (Atomics.load(shared, slot.stopped) || !lock(shared)) return;
    try {
      // The main thread may have taken over while this waited.
      if (!Atomics.load(shared, slot.stopped)) writeAll(1, text);
    } catch {
    } finally {
      unlock(shared);
    }
  };
  port.onmessage = async ({ data: m }) => {
    let ok = true;
    try {
      switch (m.t) {
        case "init":
          shared = new Int32Array(m.shared);
          measure = terminalSize();
          size = measure();
          view = make({
            write,
            rows: () => size.rows,
            cols: () => size.cols,
            verbose: m.verbose,
            color: m.color,
            finale: true,
            ...(m.command ? { command: m.command } : {}),
          });
          timer = setInterval(() => {
            remeasure();
            view?.tick();
          }, frameMs);
          break;
        case "event":
          remeasure();
          view?.event(m.e, m.at);
          break;
        case "ask":
          view?.ask(m.question);
          break;
        case "answered":
          view?.answered(m.answer);
          break;
        case "finish":
          if (timer) clearInterval(timer);
          remeasure();
          await view?.finishShow(m.e);
          break;
      }
    } catch {
      // A view that fails stops drawing; the run goes on. A failed card
      // is the main thread's to replace.
      ok = false;
    } finally {
      // The main thread waits for these, whatever happened.
      if (m.t === "ask") {
        Atomics.add(shared, slot.asked, 1);
        Atomics.notify(shared, slot.asked);
      }
      if (m.t === "finish") port.postMessage({ t: "finished", ok: ok && !!view });
    }
  };
}

if (!Bun.isMainThread) serve(self as unknown as Port);
