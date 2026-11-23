// `conversation.grep` for the daemon's clients: `corgi grep` on a worker thread,
// one search at a time. This thread takes the index lock for each search and lets
// it go only once the worker is done with it, so a stopped worker can't keep it.
import * as path from "node:path";
import { nativeFiles } from "./build_assets";
import * as grep from "./conversation_grep";
import * as cacheIndex from "./conversation_grep_cache";
import * as grepCommand from "./grep_command";
import type { Location, Options } from "./conversation_grep";
import type * as output from "./conversation_grep_output";
import type { Client } from "./peer";
import type { GrepLine, GrepSummary, Request } from "./protocol";
import type { Runtime } from "./runtime";

/** Bytes of matches one search sends, well under what a connection buffers before it closes. */
export const budget = 1024 * 1024;
/** A streamed batch waits this long after the last, and for the client's queue to empty. */
const batch_ms = 80;
/** A search answers this soon after it arrives, however long it waited its turn. */
const deadline_ms = 30_000;
/** A worker that hasn't stopped this long after a cancel is stopped. */
const cancel_ms = 2_000;
/** A worker idle this long is stopped, letting go of the conversations it read. */
const idle_ms = 30_000;
const tick_ms = 50;

/** A search as the worker runs it. */
export type Search = {
  type: "search";
  id: number;
  cache: string;
  options: Options;
  display: output.Options;
  /** The account folders to search, found on this thread: a worker sees the
   * environment the daemon started with, not what it has since. */
  locations: Location[];
  /** This search holds the index lock, so it may write the index. */
  locked: boolean;
  /** Bytes of lines it may send. */
  cap: number;
  /** Only read the conversations, for the searches after it. */
  warm: boolean;
};
export type Command = Search | { type: "cancel"; id: number };
export type Event =
  | { type: "lines"; id: number; lines: GrepLine[] }
  | { type: "done"; id: number; summary: GrepSummary }
  | { type: "cancelled"; id: number }
  | { type: "failed"; id: number; error: string };
/** A worker thread, as the searches use it. */
export interface Thread {
  post(command: Command): void;
  /** Stops it; the spawn's `closed` runs once it has. */
  stop(): void;
}
export type Spawn = (events: { message(event: Event): void; closed(): void }) => Thread;
export type Result = { matches: GrepLine[]; summary: GrepSummary };

type Job = {
  id: number;
  client: Client;
  key: string;
  search: Omit<Search, "type" | "id" | "locked" | "locations">;
  more: ((value: object) => void) | null;
  /** Lines not yet sent. */
  pending: GrepLine[];
  sent_at: number;
  /** When it arrived, which its deadline counts from. */
  at: number;
  /** The worker has it: only then is there a search there to cancel or wait out. */
  posted: boolean;
  settled: boolean;
  resolve(result: Result): void;
  reject(error: Error): void;
};

function spawnWorker(events: { message(event: Event): void; closed(): void }): Thread {
  // A compiled bundle's import.meta.url belongs to the main entrypoint.
  const entry = nativeFiles ? "./conversation_grep_worker.js" : "./conversation_grep_worker.ts";
  const worker = new Worker(new URL(entry, import.meta.url)) as Worker & { unref(): void };
  worker.onmessage = (event: MessageEvent<Event>) => events.message(event.data);
  worker.onerror = () => worker.terminate();
  worker.addEventListener("close", () => events.closed());
  worker.unref();
  return { post: command => worker.postMessage(command), stop: () => worker.terminate() };
}

/** Where `value` points: a workspace ID with its worktrees, an absolute path, or '*'. */
function scope(runtime: Runtime, value: string): grepCommand.Scope {
  if (value === "*") return { root: "*", folders: [] };
  if (path.isAbsolute(value)) return { root: grepCommand.real(value), folders: [] };
  const ws = /^\d+$/.test(value) ? runtime.workspaces.get(Number(value)) : undefined;
  if (!ws) throw Error("InvalidWorkspace");
  return grepCommand.scope({
    id: ws.id,
    name: ws.name(),
    cwd: ws.cwd,
    worktrees: (ws.worktrees?.entries ?? []).map(e => e.path),
  });
}

/** `q` as `corgi grep` runs it: its defaults, then what `q` sets. */
export function prepare(runtime: Runtime, q: Request<"conversation.grep">): Job["search"] {
  const { options, display } = grepCommand.defaults();
  // A returned conversation is narrowed by ID, whatever age or workspace found it.
  const where = q.session ? { root: "*", folders: [] } : scope(runtime, q.workspace);
  options.workspace = display.workspace = where.root;
  options.folders = where.folders;
  options.patterns = q.patterns;
  options.case = q.case;
  options.fixed = q.fixed;
  options.word = q.word;
  options.line = q.line;
  if (q.session) {
    options.session = q.session;
    options.age = 0;
  } else if (q.max_age !== null) options.age = q.max_age * 1000;
  if (q.provider) options.provider = q.provider;
  if (q.limit !== null) options.limit = q.limit;
  if (q.max_count !== null) options.maxCount = q.max_count;
  if (q.context !== null) options.context = q.context;
  if (q.before !== null) options.before = q.before;
  if (q.after !== null) options.after = q.after;
  options.tools = q.tools;
  if (q.only_matching) options.context = options.before = options.after = 0;
  display.json = true;
  display.onlyMatching = q.only_matching;
  display.list = q.list;
  display.count = q.count;
  if (q.max_line !== null) display.maxLineChars = q.max_line;
  // The byte budget bounds the output instead.
  display.maxOutputChars = 0;
  if (!options.patterns.length && !q.warm) throw Error("MissingPattern");
  if (options.maxCount === 0) throw Error("InvalidCount");
  return { cache: cacheIndex.directory(), options, display, cap: budget, warm: q.warm };
}

export class Searches {
  private queue: Job[] = [];
  private running: Job | null = null;
  private thread: Thread | null = null;
  /** The running search's index lock, held until its worker is done. */
  private release: (() => void) | null = null;
  /** The worker is stopping; nothing starts until it has. */
  private stopping = false;
  private next = 1;
  private cancelled_at = 0;
  private idle_since = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private spawn: Spawn = spawnWorker,
    private lock: (cache: string) => Promise<(() => void) | null> = cacheIndex.tryLock,
    private now: () => number = Date.now,
    private locate: () => Promise<Location[]> = () => grep.roots(),
  ) {}

  /** Runs `q` for `client` after the searches before it. A search on the same
   * client with the same nonempty `key` ends the earlier one with `Cancelled`. */
  async search(
    runtime: Runtime,
    client: Client,
    q: Request<"conversation.grep">,
    signal: AbortSignal,
    more: ((value: object) => void) | null,
  ): Promise<Result> {
    // A newer search ends the last under its key even when it's itself refused.
    if (q.key) this.stop(client, q.key);
    const search = prepare(runtime, q);
    this.ticking();
    return new Promise<Result>((resolve, reject) => {
      const job: Job = {
        id: this.next++,
        client,
        key: q.key,
        search,
        more,
        pending: [],
        sent_at: 0,
        at: this.now(),
        posted: false,
        settled: false,
        resolve,
        reject,
      };
      signal.addEventListener("abort", () => this.cancel(job, "Reloading"), { once: true });
      this.queue.push(job);
      void this.pump();
    });
  }
  /** Ends `client`'s search under `key`, running or waiting, as a newer one would. */
  stop(client: Client, key: string): void {
    // A search without a key has none to stop it by.
    if (!key) return;
    for (const job of [...this.queue, ...(this.running ? [this.running] : [])])
      if (job.client === client && job.key === key) this.cancel(job, "Cancelled");
  }
  /** Sends what's due, and ends searches, running or waiting, whose client
   * left or time ran out; a timer runs it while a worker does. */
  tick(): void {
    const job = this.running,
      now = this.now();
    for (const waiting of [...this.queue])
      if (waiting.client.dead) this.cancel(waiting, "Cancelled");
      else if (now - waiting.at > deadline_ms) this.cancel(waiting, "SearchTimedOut");
    if (job && !job.settled) {
      if (job.client.dead) this.cancel(job, "Cancelled");
      else if (now - job.at > deadline_ms) this.cancel(job, "SearchTimedOut");
      else this.flush(job);
    }
    if (job?.settled && job.posted && now - this.cancelled_at > cancel_ms) this.stopThread();
    if (!job && !this.queue.length && this.thread && now - this.idle_since > idle_ms) this.stopThread();
    if (!this.running && !this.queue.length && !this.thread && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  private settle(job: Job, result: Result | Error): void {
    if (job.settled) return;
    job.settled = true;
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
  }
  private cancel(job: Job, reason: string): void {
    if (job.settled) return;
    this.settle(job, Error(reason));
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    else if (job === this.running && job.posted) {
      this.cancelled_at = this.now();
      this.thread?.post({ type: "cancel", id: job.id });
    }
  }
  private async pump(): Promise<void> {
    if (this.running || this.stopping) return;
    const job = this.queue.shift();
    if (!job) return;
    if (job.client.dead) {
      this.settle(job, Error("Cancelled"));
      return this.pump();
    }
    this.running = job;
    // Until it's posted, `running` is this search's alone: nothing else starts,
    // and a stopping worker leaves it be.
    const leave = () => {
      if (this.running === job) this.running = null;
      return this.pump();
    };
    let locations: Location[],
      release: (() => void) | null = null;
    try {
      locations = await this.locate();
    } catch (error) {
      this.settle(job, error instanceof Error ? error : Error(String(error)));
      return leave();
    }
    try {
      release = await this.lock(job.search.cache);
    } catch {
      // Unlocked, the search reads changed transcripts without saving them.
    }
    if (job.settled || this.running !== job) {
      release?.();
      return leave();
    }
    this.release = release;
    job.posted = true;
    try {
      this.ensureThread().post({ type: "search", id: job.id, ...job.search, locations, locked: release !== null });
    } catch (error) {
      // A worker that can't start or take the search fails it, not the queue.
      this.settle(job, error instanceof Error ? error : Error(String(error)));
      this.finish();
    }
  }
  private ensureThread(): Thread {
    this.ticking();
    this.thread ??= this.spawn({ message: event => this.message(event), closed: () => this.closed() });
    return this.thread;
  }
  /** Runs `tick` while a search waits or runs, or a worker lives. */
  private ticking(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tick_ms);
    (this.timer as { unref?(): void }).unref?.();
  }
  private message(event: Event): void {
    const job = this.running;
    if (!job || event.id !== job.id) return;
    switch (event.type) {
      case "lines":
        if (job.settled) return;
        job.pending.push(...event.lines);
        this.flush(job);
        return;
      case "done":
        this.settle(job, { matches: job.pending, summary: event.summary });
        break;
      case "cancelled":
        this.settle(job, Error("Cancelled"));
        break;
      case "failed":
        this.settle(job, Error(event.error));
        break;
    }
    this.finish();
  }
  /** Sends what the running search found once the client's queue is empty, so
   * results never hold up what else it's sent. */
  private flush(job: Job): void {
    if (!job.more || job.settled || !job.pending.length) return;
    const now = this.now();
    if (job.client.queued > 0 || now - job.sent_at < batch_ms) return;
    job.more({ matches: job.pending });
    job.pending = [];
    job.sent_at = now;
  }
  /** The worker is done with the running search, or stopped. */
  private finish(): void {
    this.release?.();
    this.release = null;
    this.running = null;
    this.idle_since = this.now();
    void this.pump();
  }
  private stopThread(): void {
    if (!this.thread || this.stopping) return;
    this.stopping = true;
    this.thread.stop();
  }
  private closed(): void {
    this.thread = null;
    this.stopping = false;
    // A search still waiting for its lock goes to the next worker.
    if (this.running?.posted) {
      this.settle(this.running, Error("SearchFailed"));
      this.finish();
    } else void this.pump();
  }
}

export const searches = new Searches();
