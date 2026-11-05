import * as telemetry from "../telemetry";
import type { Runtime } from "../runtime";
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { Agent, Provider, Text } from "../agents";
import { adapter } from "../providers";
import type { TranscriptReader } from "../providers/adapter";
import { str, timestampMs, Text as Note } from "../providers/common";
import { Model } from "../providers/model";
import { parse } from "../json";
import { head } from "../transcript";
import { Counts, Tracker, type Window } from "./tokens";
import { Counter, Meter, Tokens, View } from "./live";
import { Reading } from "./context_window";
import { Tracker as Tools, View as Progress } from "../activity/tools";
import { Ended } from "../activity/background_tasks";
import * as checklist from "../activity/checklist";
import * as accounts from "../accounts";
import { max_actors } from "../conversations";
import { hydrate } from "../persist/checkpoint";
import { decodeChecklist } from "../protocol";
export type Request = {
  actor: number;
  workspace: number;
  since: number;
  agent: Agent;
  child: boolean;
  tracked_since: number;
};
/** A transcript file, and how far into it usage was counted. */
export type Position = { inode: number; device: number; offset: number };
export type RecordSink = (req: Request, record: unknown, bytes: number) => void;
export class Result {
  actor = 0;
  workspace = 0;
  since = 0;
  delta = new Counts();
  progress: Progress | null = null;
  name = new Text();
  seq = 0n;
  model = new Model();
  live = new View();
  context = new Reading();
  continued = new Text();
  update = new Text();
  update_at = 0;
  spoke_at = 0;
  ended = new Ended();
  checklist: checklist.List | null = null;
  fallback(agent: Agent, now: number) {
    return agent.provider ? (adapter(agent.provider).transcript?.fallback(this, agent, now) ?? false) : false;
  }
}
export class Tail {
  actor = 0;
  initial_until = 0;
  tracker = new Tracker();
  progress = new Tools();
  inode = 0;
  device = 0;
  offset = 0;
  partial = Buffer.alloc(0);
  discard = false;
  model = new Model();
  live = new Counter();
  context = new Reading();
  opened = false;
  catch_up = false;
  name = new Note();
  name_chosen = false;
  continued = new Note();
  update = new Note();
  update_at = 0;
  spoke_at = 0;
  ended = new Ended();
  checklist: checklist.List | null = null;
  /** Where the daemon before a handoff stopped counting, until the file opens.
   * XXX: Remove for next protocol bump. Only an older build's handoff carries one. */
  carried: Position | null = null;
  closeFile() {
    this.inode = 0;
    this.device = 0;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.discard = false;
  }
  close() {
    Object.assign(this, new Tail());
  }
  /** How far usage was counted: lines ending past it are not counted yet.
   * XXX: Remove for next protocol bump. Older builds count on from it. */
  position(): Position | null {
    if (this.carried) return this.carried;
    // A catch-up stopped halfway counted only part of what precedes initial_until.
    if (!this.inode || (this.catch_up && this.offset < this.initial_until)) return null;
    return { inode: this.inode, device: this.device, offset: Math.max(this.offset, this.initial_until) };
  }
  /** What a handoff carries: what the tail has read and where it stopped, so the next
   * daemon reads on from there. An unfinished line is read again. */
  capture() {
    return {
      actor: this.actor,
      meter: this.live.meter,
      position: this.position(),
      file: this.inode
        ? { inode: this.inode, device: this.device, offset: this.offset - this.partial.length, discard: this.discard }
        : null,
      initial_until: this.initial_until,
      catch_up: this.catch_up,
      tracker: this.tracker,
      progress: this.progress,
      counter: {
        previous: this.live.previous,
        child: this.live.child,
        owned_from: this.live.owned_from,
        catch_up: this.live.catch_up,
        ordinal: this.live.ordinal,
        baseline_next: this.live.baseline_next,
      },
      model: this.model.id,
      context: { ...this.context, model: this.context.model.id },
      name: this.name,
      name_chosen: this.name_chosen,
      continued: this.continued,
      update: this.update,
      update_at: this.update_at,
      spoke_at: this.spoke_at,
      ended: this.ended.items,
      checklist: this.checklist,
    };
  }
  /** The tail a handoff carried. An older build's has only its count and position. */
  static restore(saved: any) {
    if (!Number.isInteger(saved.actor) || (saved.ended !== undefined && !Array.isArray(saved.ended)))
      throw Error("InvalidCheckpoint");
    const t = new Tail(),
      counter = saved.counter ?? {};
    t.actor = saved.actor;
    t.opened = true;
    t.live.meter = hydrate(new Meter(), saved.meter);
    t.live.previous = counter.previous ? hydrate(new Tokens(), counter.previous) : null;
    t.live.owned_from = counter.owned_from == null ? null : BigInt(counter.owned_from);
    t.live.ordinal = counter.ordinal == null ? null : BigInt(counter.ordinal);
    for (const key of ["child", "catch_up", "baseline_next"] as const) t.live[key] = hydrate(false, counter[key]);
    if (saved.file) {
      Object.assign(t, hydrate({ inode: 0, device: 0, offset: 0 }, saved.file));
      t.discard = hydrate(false, saved.file.discard);
    } else if (saved.position) t.carried = hydrate({ inode: 0, device: 0, offset: 0 }, saved.position);
    t.initial_until = hydrate(0, saved.initial_until);
    t.catch_up = hydrate(false, saved.catch_up);
    t.tracker = Tracker.restore(saved.tracker);
    t.progress = Tools.restore(saved.progress);
    if (saved.model) t.model = Model.resolve(hydrate(new Note(), saved.model).text());
    if (saved.context) {
      const { model, ...reading } = saved.context;
      t.context = hydrate(new Reading(), reading);
      if (model) t.context.model = Model.resolve(hydrate(new Note(), model).text());
    }
    for (const key of ["name", "continued", "update"] as const) t[key] = hydrate(new Note(), saved[key]);
    t.name_chosen = hydrate(false, saved.name_chosen);
    t.update_at = hydrate(0, saved.update_at);
    t.spoke_at = hydrate(0, saved.spoke_at);
    if ((saved.ended?.length ?? 0) > Ended.limit) throw Error("InvalidCheckpoint");
    for (const id of saved.ended ?? []) t.ended.add(hydrate(new Note(), id).text());
    t.checklist = saved.checklist ? decodeChecklist(saved.checklist) : null;
    return t;
  }
  observeModel(message: any) {
    const id = str(message, "model");
    if (id && id !== "<synthetic>") this.model = Model.resolve(id);
  }
  ingest(req: Request, reader: TranscriptReader, bytes: Buffer | string, start_offset: number, sink?: RecordSink) {
    const telemetry_started = telemetry.begin();
    try {
      if (adapter(req.agent.provider!).caps.prompt_turns) this.progress.bind(req.agent.turnId());
      const input = typeof bytes === "string" ? Buffer.from(bytes) : bytes,
        found = new Counts();
      let start = 0;
      while (start < input.length) {
        const at = input.indexOf(10, start),
          complete = at >= 0,
          end = complete ? at : input.length,
          segment = input.subarray(start, end);
        start = end + Number(complete);
        if (!this.discard && this.partial.length + segment.length > 1024 * 1024) {
          this.live.meter.lose();
          this.partial = Buffer.alloc(0);
          this.discard = true;
        }
        if (!this.discard) this.partial = Buffer.concat([this.partial, segment]);
        if (!complete) continue;
        if (!this.discard)
          try {
            const value = parse(this.partial.toString()),
              appended = start_offset + start > this.initial_until,
              stamp = timestampMs(str(value, "timestamp")),
              delta = reader.record(this, req, value, appended, stamp);
            if (appended && stamp !== null && stamp > req.since) found.add(delta);
            if (appended) sink?.(req, value, this.partial.length);
          } catch {
            this.live.meter.lose();
          }
        this.partial = Buffer.alloc(0);
        this.discard = false;
      }
      return found;
    } finally {
      telemetry.end("agent.usage.ingest", telemetry_started);
    }
  }
  async poll(req: Request, reader: TranscriptReader, window?: Window, sink?: RecordSink) {
    const telemetry_started = telemetry.begin();
    try {
      const current = await lstat(req.agent.transcriptPath());
      // At EOF, historical counts survive revoked read access until more bytes need reading.
      if (
        this.inode !== 0 &&
        current.isFile() &&
        current.ino === this.inode &&
        current.dev === this.device &&
        current.size === this.offset
      )
        return new Counts();
      const file = await open(
        req.agent.transcriptPath(),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat(),
          named = await lstat(req.agent.transcriptPath());
        if (!stat.isFile()) throw Error("NotRegular");
        const resumed =
          this.inode !== 0 && stat.ino === this.inode && stat.dev === this.device && stat.size >= this.offset;
        if (!resumed) {
          const first = await head(file);
          adapter(req.agent.provider!).transcript?.verify?.(first, req.agent.sessionId());
          const carried = this.carried,
            continues =
              carried !== null &&
              stat.ino === carried.inode &&
              stat.dev === carried.device &&
              stat.size >= carried.offset;
          this.carried = null;
          this.initial_until = continues ? carried.offset : stat.size;
          this.offset = Math.max(0, this.initial_until - 256 * 1024);
          const catch_up = req.child && !this.opened && stat.size <= 2 * 1024 * 1024;
          if (catch_up) this.offset = 0;
          this.catch_up = catch_up;
          const retained = this.live.meter;
          this.live = new Counter();
          if (!continues) {
            this.live.meter = retained;
            if (this.opened) this.live.meter.lose();
          }
          this.opened = true;
          this.partial = Buffer.alloc(0);
          this.tracker = new Tracker();
          this.progress = new Tools();
          this.context = new Reading();
          reader.open(this, req, first, catch_up);
          // The carried count already covers the file up to initial_until; opening readies a new one.
          if (continues) this.live.meter = retained;
          this.discard = this.offset > 0;
        }
        this.inode = stat.ino;
        this.device = stat.dev;
        if (!named.isFile() || named.ino !== this.inode || named.dev !== this.device || stat.size < this.offset)
          throw Error("Replaced");
        if (stat.size === this.offset) return new Counts();
        const bytes = Buffer.alloc(65536),
          start = this.offset,
          { bytesRead } = await file.read(bytes, 0, bytes.length, this.offset);
        this.offset += bytesRead;
        // Visits during file I/O must also bound the bytes about to be counted.
        req.since = window?.since ?? req.since;
        return this.ingest(req, reader, bytes.subarray(0, bytesRead), start, sink);
      } finally {
        await file.close();
      }
    } finally {
      telemetry.end("agent.usage.poll", telemetry_started);
    }
  }
}
export class Worker {
  record?: RecordSink;
  stopping = false;
  pausing = false;
  paused = false;
  requests: Request[] = [];
  cursor = 0;
  results: Result[] = [];
  watchers = new Map<number, Tail>();
  private windows = new Map<number, Window>();
  /** Each provider's transcript reader, opened on first use. */
  readers = new Map<Provider, TranscriptReader | null>();
  timer: ReturnType<typeof setInterval> | null = null;
  running = false;
  static start() {
    const w = new Worker();
    w.activate();
    return w;
  }
  activate() {
    this.timer = setInterval(() => void this.run(), 250);
  }
  /** Stops reading between runs, so a handoff can apply what the worker found. */
  async pause() {
    this.pausing = true;
    const deadline = Date.now() + 5000;
    while (this.running) {
      if (Date.now() >= deadline) {
        this.pausing = false;
        throw Error("ReloadUsageBusy");
      }
      await Bun.sleep(1);
    }
    this.paused = true;
  }
  unpause() {
    this.pausing = false;
    this.paused = false;
  }
  /** What a handoff carries: each transcript's tail. The next daemon reads on from where the
   * tails stopped, so whatever they found must be applied first. */
  capture() {
    if (!this.paused || this.running || this.results.length) throw Error("UsageBusy");
    return [...this.watchers.values()].filter(t => t.opened).map(t => t.capture());
  }
  /** A worker that goes on reading where a handoff's left off, once activated. */
  static restore(saved: any) {
    if (!Array.isArray(saved) || saved.length > max_actors) throw Error("InvalidCheckpoint");
    const w = new Worker();
    for (const entry of saved) {
      const t = Tail.restore(entry);
      if (w.watchers.has(t.actor)) throw Error("InvalidCheckpoint");
      w.watchers.set(t.actor, t);
    }
    return w;
  }
  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.watchers.clear();
    for (const reader of this.readers.values()) reader?.close?.();
  }
  reader(p: Provider) {
    const others = () =>
      accounts
        .known()
        .filter(a => a.provider === p)
        .map(a => a.dir);
    if (!this.readers.has(p)) this.readers.set(p, adapter(p).transcript?.reader(others) ?? null);
    return this.readers.get(p)!;
  }
  reconcile(runtime: Runtime) {
    const telemetry_started = telemetry.begin();
    this.requests = [];
    this.windows.clear();
    const actors = new Set<number>(runtime.conversations.items.map(actor => actor.id)),
      followed = runtime.followed();
    for (const id of this.watchers.keys()) if (!actors.has(id)) this.watchers.delete(id);
    for (const actor of runtime.conversations.items) {
      const agent = actor.state,
        reader = agent.provider ? this.reader(agent.provider) : null;
      if (!reader || !agent.session.len || (!agent.transcript.len && !reader.name) || !followed.has(actor)) continue;
      const ws = runtime.workspaces.get(actor.workspace);
      if (!ws) continue;
      this.windows.set(ws.id, ws.away);
      this.requests.push({
        actor: actor.id,
        workspace: ws.id,
        since: ws.away.since,
        agent: agent.snapshot(),
        child: actor.parent !== null,
        tracked_since: actor.tracked_since,
      });
    }
    telemetry.end("agent.usage.reconcile", telemetry_started);
  }
  take() {
    const out = this.results;
    this.results = [];
    return out;
  }
  async run() {
    if (this.running || this.stopping || this.pausing) return;
    this.running = true;
    try {
      for (const reader of this.readers.values()) await reader?.refresh?.();
      const count = Math.min(64, this.requests.length);
      const batch = Array.from({ length: count }, (_, i) => this.requests[(this.cursor + i) % this.requests.length]);
      if (this.requests.length) this.cursor = (this.cursor + count) % this.requests.length;
      for (const queued of batch) {
        const window = this.windows.get(queued.workspace),
          req = { ...queued, since: window?.since ?? queued.since };
        const reader = this.reader(req.agent.provider!),
          existing = this.results.find(r => r.actor === req.actor);
        if (!reader || (!existing && this.results.length >= 64)) continue;
        let t = this.watchers.get(req.actor);
        if (!t) {
          t = new Tail();
          t.actor = req.actor;
          this.watchers.set(req.actor, t);
        }
        let delta = new Counts();
        if (req.agent.transcript.len)
          try {
            delta = await t.poll(req, reader, window, this.record);
          } catch {
            if (t.live.meter.value.known) t.live.meter.lose();
            t.closeFile();
            t.progress = new Tools();
          }
        if (
          !delta.any() &&
          !delta.tokens_known &&
          !t.progress.dirty &&
          !reader.name &&
          !t.model.id.len &&
          !t.name.len &&
          !t.continued.len &&
          !t.update.len &&
          !t.spoke_at &&
          !t.ended.len &&
          !t.checklist &&
          !t.context.at
        )
          continue;
        let r = existing;
        if (!r || r.since !== req.since || r.workspace !== req.workspace) {
          r = new Result();
          r.actor = req.actor;
          r.workspace = req.workspace;
          r.since = req.since;
        }
        r.delta.add(delta);
        r.seq = req.agent.last_seq;
        r.model = t.model;
        r.live = t.live.meter.view(Date.now());
        r.context = Object.assign(new Reading(), t.context);
        r.progress = t.progress.view();
        r.name = reader.name?.(req.agent.sessionId()) ?? t.name;
        r.continued = t.continued;
        r.update = t.update;
        r.update_at = t.update_at;
        r.spoke_at = t.spoke_at;
        r.ended = Object.assign(new Ended(), { items: [...t.ended.items] });
        r.checklist = t.checklist;
        if (existing) this.results[this.results.indexOf(existing)] = r;
        else this.results.push(r);
        if (t.progress.turn.text() === req.agent.turnId()) t.progress.dirty = false;
      }
    } finally {
      this.running = false;
    }
  }
}
