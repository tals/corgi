//! Long work on another computer, as its daemon runs it: a request starts a
//! job and answers with its id and what it had within a moment; each poll
//! brings its progress and the results since the last; a cancel ends it. A
//! job dies with its connection, or once nothing has polled it for a while.
//! The daemon's side is `Jobs`; a viewer follows one with `follow`. Finding a
//! line deep in a file runs this way, and so may any read that takes a while
//! or answers in parts: nothing here knows what a job does.
import * as errors from "./errors";

/** What a job's work gets: when to stop, and where its news goes. */
export interface Job {
  /** Set once the job is cancelled, its connection gone or the daemon stopping. */
  readonly signal: AbortSignal;
  /** The latest word on how far along it is, which the next poll carries. */
  progress(value: unknown): void;
  /** A result for the next poll; each is delivered once. */
  emit(value: unknown): void;
}
/** A poll's answer: the latest progress, the results since the last poll,
 * and whether the job is over, with why when it failed. */
export interface Poll {
  progress: unknown;
  results: unknown[];
  done: boolean;
  error: string | null;
}
/** The most a poll waits for news: well inside the silence a connection allows. */
export const wait_limit = 2000;
/** How long a job outlives its last poll. */
export const idle_ms = 30_000;

interface Entry {
  owner: object;
  progress: unknown;
  results: unknown[];
  done: boolean;
  error: string | null;
  control: AbortController;
  /** A poll waiting for news. */
  waiting: (() => void) | null;
  idle: ReturnType<typeof setTimeout> | null;
}
/** The jobs a daemon runs, each for the connection that started it. */
export class Jobs {
  private entries = new Map<number, Entry>();
  private next = 1;
  constructor(private idle = idle_ms) {}
  get size(): number {
    return this.entries.size;
  }
  /** Starts `run` for `owner` and answers as a first poll of `wait` ms
   * would, with the job's id. What `run` returns, when anything, is its
   * last result. */
  async begin(owner: object, run: (job: Job) => Promise<unknown>, wait = 0): Promise<{ job: number } & Poll> {
    const id = this.next++,
      control = new AbortController(),
      entry: Entry = {
        owner,
        progress: null,
        results: [],
        done: false,
        error: null,
        control,
        waiting: null,
        idle: null,
      };
    this.entries.set(id, entry);
    const job: Job = {
      signal: control.signal,
      progress: value => {
        entry.progress = value;
      },
      emit: value => {
        entry.results.push(value);
        this.wake(entry);
      },
    };
    void Promise.resolve()
      .then(() => run(job))
      .then(
        value => {
          if (value !== undefined) entry.results.push(value);
        },
        error => {
          entry.error = errors.name(error) ?? String(error);
        },
      )
      .finally(() => {
        entry.done = true;
        this.wake(entry);
      });
    return { job: id, ...(await this.poll(owner, id, wait)) };
  }
  /** Job `id`'s news, waiting up to `wait` ms for a result or its end;
   * progress alone doesn't cut the wait short, so polls stay few. Throws
   * `UnknownJob` for one that isn't `owner`'s, or is gone. */
  async poll(owner: object, id: number, wait = 0): Promise<Poll> {
    const entry = this.entry(owner, id);
    this.touch(id, entry);
    if (!entry.done && entry.results.length === 0 && wait > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(finish, Math.min(wait, wait_limit));
        function finish() {
          clearTimeout(timer);
          if (entry.waiting === finish) entry.waiting = null;
          resolve();
        }
        // A second poll on the same job takes over from the first.
        entry.waiting?.();
        entry.waiting = finish;
      });
    }
    const out = { progress: entry.progress, results: entry.results.splice(0), done: entry.done, error: entry.error };
    // Its last news delivered, or the owner gone meanwhile, nothing keeps it.
    if (entry.done || this.entries.get(id) !== entry) this.remove(id, entry);
    else this.touch(id, entry);
    return out;
  }
  /** Ends job `id`; nothing for one already gone. */
  cancel(owner: object, id: number): void {
    const entry = this.entries.get(id);
    if (entry && entry.owner === owner) this.end(id, entry, "Cancelled");
  }
  /** Ends every job of `owner`, whose connection closed. */
  drop(owner: object): void {
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.end(id, entry, "ConnectionClosed");
  }
  /** Ends every job: the daemon is stopping. */
  close(): void {
    for (const [id, entry] of this.entries) this.end(id, entry, "ServerShutdown");
  }
  private entry(owner: object, id: number): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) throw Error("UnknownJob");
    return entry;
  }
  private end(id: number, entry: Entry, reason: string): void {
    this.remove(id, entry);
    if (!entry.done) {
      entry.done = true;
      entry.error = reason;
    }
    entry.control.abort(Error(reason));
    this.wake(entry);
  }
  private remove(id: number, entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = null;
    if (this.entries.get(id) === entry) this.entries.delete(id);
  }
  private touch(id: number, entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => this.end(id, entry, "Idle"), this.idle);
    entry.idle.unref?.();
  }
  private wake(entry: Entry): void {
    entry.waiting?.();
  }
}

/** Sends a job's polls and cancel to its daemon. */
export type Call = (op: "job.poll" | "job.cancel", payload: { job: number; wait?: number }) => Promise<unknown>;
export interface Following {
  signal?: AbortSignal;
  progress?: (value: unknown) => void;
  result?: (value: unknown) => void;
  /** How long each poll waits for news. */
  wait?: number;
}
/** How long a viewer's polls wait by default: progress shows a few times a second. */
export const poll_wait = 250;
/** A job as a daemon answered a start or a poll. */
export function polled(reply: unknown): { job: number } & Poll {
  const r = (reply ?? {}) as Record<string, unknown>;
  return {
    job: typeof r.job === "number" ? r.job : 0,
    progress: r.progress ?? null,
    results: Array.isArray(r.results) ? r.results : [],
    done: r.done === true,
    error: typeof r.error === "string" ? r.error : null,
  };
}
/** Runs a job to its end: `start` sends the request that begins it, whose
 * reply carries its id and first news; polls follow until it's done. Its
 * progress and results go to `on` as they come. An abort cancels the job on
 * the daemon and throws `Aborted`; a job that failed throws its error. */
export async function follow(call: Call, start: () => Promise<unknown>, on: Following = {}): Promise<void> {
  const signal = on.signal,
    wait = on.wait ?? poll_wait;
  let aborted!: () => void;
  const abort = new Promise<never>((_, reject) => {
    aborted = () => reject(Error("Aborted"));
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
  // Nothing waits on a race the job won.
  abort.catch(() => {});
  let job = 0;
  try {
    let news = polled(await Promise.race([start(), abort]));
    job = news.job;
    for (;;) {
      if (news.progress !== null) on.progress?.(news.progress);
      for (const result of news.results) on.result?.(result);
      if (news.done) {
        if (news.error !== null) throw Error(news.error);
        return;
      }
      news = polled(await Promise.race([call("job.poll", { job, wait }), abort]));
    }
  } catch (error) {
    if (job && errors.is(error, "Aborted")) void call("job.cancel", { job }).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", aborted);
  }
}
