import type { Runtime } from "../runtime";
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { Agent, Provider, Text } from "../agents";
import { field, str, timestampMs } from "../providers/common";
import { Claude } from "../providers/claude";
import { Model } from "../providers/model";
import { parse } from "../json";
import { verifySession } from "../transcript";
import { Index, available } from "../providers/codex/files";
import { Counts, Tracker } from "./tokens";
import { Codex, View, Tokens } from "./live";
import { Reading } from "./context_window";
import { Tracker as Tools, View as Progress } from "../activity/tools";
import { Ended } from "../activity/background_tasks";
export type Request = {
  actor: number;
  workspace: number;
  since: number;
  agent: Agent;
  child: boolean;
  tracked_since: number;
};
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
  fallback(agent: Agent, now: number) {
    if (agent.provider === "claude") {
      if (this.name.len) agent.setName(this.name.text());
      if (
        agent.state === "working" &&
        !agent.activity_inferred &&
        this.update.len &&
        this.update_at > agent.activity_at
      ) {
        agent.setActivity(this.update.text());
        agent.activity_at = this.update_at;
      }
      const p = this.progress;
      if (
        !p ||
        agent.state !== "working" ||
        p.ended ||
        !p.turn.len ||
        agent.turnId() !== p.turn.text() ||
        (!p.commentary.len && !p.evidence.len)
      )
        return false;
      agent.activity_generation = Bun.hash.wyhash(agent.turnId(), 0n);
      return true;
    }
    if (agent.provider !== "codex" || !available(agent, now)) return false;
    if (this.name.len) agent.setName(this.name.text());
    const p = this.progress;
    if (!p || agent.state !== "working" || p.ended || !p.turn.len) return false;
    if (!agent.turn.len && agent.last_seq === this.seq) agent.setTurn(p.turn.text());
    if (agent.turnId() !== p.turn.text()) return false;
    agent.activity_generation = Bun.hash.wyhash(p.commentary.text(), 0n);
    return true;
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
  live = new Codex();
  context = new Reading();
  opened = false;
  catch_up = false;
  name = new Text();
  name_chosen = false;
  continued = new Text();
  update = new Text();
  update_at = 0;
  spoke_at = 0;
  ended = new Ended();
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
  claudeRecord(session: string, value: any) {
    const line = Claude.Line.decode(value);
    if (!line || line.sessionId !== session || !line.type) return;
    const chosen =
        line.type === "agent-name"
          ? str(value, "agentName")
          : line.type === "custom-title"
            ? str(value, "customTitle")
            : "",
      generated = line.type === "ai-title" ? str(value, "aiTitle") : "";
    if (chosen && !chosen.includes("\ufffd")) {
      this.name = new Text(chosen.slice(0, 160));
      this.name_chosen = true;
    } else if (generated && !this.name_chosen && !generated.includes("\ufffd"))
      this.name = new Text(generated.slice(0, 160));
    if (line.type === "assistant") this.claudeText(line);
    if (line.type === "continued-in") this.continued = new Text(str(value, "continuedInSessionId"));
    else if (line.type === "user" || line.type === "assistant") {
      this.continued = new Text();
      const stamp = timestampMs(line.timestamp);
      if (stamp !== null) this.spoke_at = Math.max(this.spoke_at, stamp);
    } else if (line.type === "queue-operation" && str(value, "operation") === "enqueue") {
      const notice = Claude.TaskNotice.decode(str(value, "content"));
      if (notice?.status) this.ended.add(notice.id);
    }
  }
  claudeText(line: any) {
    const stamp = timestampMs(line.timestamp),
      content = field(line.message, "content");
    if (stamp === null || !Array.isArray(content)) return;
    let latest = "";
    for (const part of content) {
      if (str(part, "type") !== "text") continue;
      for (const row of str(part, "text").split("\n")) {
        const text = row.replace(/^[ \t\r#*\->`_]+|[ \t\r#*\->`_]+$/g, "");
        if (!text) continue;
        latest = text;
        break;
      }
    }
    if (!latest) return;
    this.update = new Text(latest.slice(0, 160));
    this.update_at = stamp * 1000;
  }
  observeModel(message: any) {
    const id = str(message, "model");
    if (id && id !== "<synthetic>") this.model = Model.resolve(id);
  }
  record(req: Request, value: any, appended: boolean, stamp: number | null) {
    const session = req.agent.sessionId();
    if (req.agent.provider === "claude") {
      this.claudeRecord(session, value);
      if (str(value, "sessionId") === session) {
        this.progress.ingestClaude(value, appended);
        this.context.claude(value);
      }
      this.observeModel(field(value, "message"));
      const delta = this.tracker.transcript("claude", session, value),
        owned = this.catch_up && stamp !== null && stamp >= req.tracked_since;
      if ((appended || owned) && delta.tokens_known)
        this.live.meter.add(
          new Tokens({
            input: delta.input,
            cached_input: delta.cached_input,
            output: delta.output,
          }),
          stamp ?? Date.now(),
        );
      return delta;
    }
    this.progress.ingest(value, appended);
    this.observeModel(field(value, "payload"));
    const delta = this.tracker.transcript("codex", session, value);
    this.live.ingest(value, appended, Date.now());
    this.context.codex(value);
    return delta;
  }
  ingest(req: Request, bytes: Buffer | string, start_offset: number) {
    if (Provider.info(req.agent.provider!).prompt_turns) this.progress.bind(req.agent.turnId());
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
            delta = this.record(req, value, appended, stamp);
          if (appended && stamp !== null && stamp > req.since) found.add(delta);
        } catch {
          this.live.meter.lose();
        }
      this.partial = Buffer.alloc(0);
      this.discard = false;
    }
    return found;
  }
  async poll(req: Request) {
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
        await verifySession(file, req.agent.provider!, req.agent.sessionId());
        this.initial_until = stat.size;
        this.offset = Math.max(0, stat.size - 256 * 1024);
        const catch_up = req.child && !this.opened && stat.size <= 2 * 1024 * 1024;
        if (catch_up) this.offset = 0;
        const retained = this.live.meter;
        this.live = new Codex();
        this.live.meter = retained;
        if (this.opened) this.live.meter.lose();
        this.opened = true;
        this.partial = Buffer.alloc(0);
        this.tracker = new Tracker();
        this.progress = new Tools();
        this.context = new Reading();
        if (req.agent.provider === "claude") {
          if (!this.live.meter.value.known) {
            this.live.meter.value.known = true;
            this.live.meter.value.since = Date.now();
          }
          this.catch_up = catch_up;
        } else {
          const header = Buffer.alloc(65536),
            n = await file.read(header, 0, header.length, 0),
            end = header.subarray(0, n.bytesRead).indexOf(10);
          if (end >= 0)
            this.live.header(parse(header.subarray(0, end).toString()), req.child, req.tracked_since, catch_up);
          else if (req.child) this.live.meter.lose();
          this.progress.bind(req.agent.turnId());
          if (!this.offset) this.tracker.beginCodex("codex");
        }
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
      return this.ingest(req, bytes.subarray(0, bytesRead), start);
    } finally {
      await file.close();
    }
  }
}
export class Worker {
  stopping = false;
  requests: Request[] = [];
  cursor = 0;
  results: Result[] = [];
  watchers = new Map<number, Tail>();
  index = new Index();
  timer: ReturnType<typeof setInterval> | null = null;
  running = false;
  static start() {
    const w = new Worker();
    w.timer = setInterval(() => void w.run(), 250);
    return w;
  }
  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.watchers.clear();
    this.index.close();
  }
  reconcile(runtime: Runtime) {
    this.requests = [];
    for (const actor of runtime.conversations.items) {
      const agent = actor.state;
      if (!agent.session.len || (!agent.transcript.len && actor.provider() !== "codex") || !runtime.followed(actor))
        continue;
      const ws = runtime.workspaces.get(actor.workspace);
      if (!ws) continue;
      this.requests.push({
        actor: actor.id,
        workspace: ws.id,
        since: ws.away.since,
        agent: agent.snapshot(),
        child: actor.parent !== null,
        tracked_since: actor.tracked_since,
      });
    }
  }
  take() {
    const out = this.results;
    this.results = [];
    return out;
  }
  async run() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      await this.index.refreshAsync();
      const count = Math.min(64, this.requests.length);
      const batch = Array.from({ length: count }, (_, i) => this.requests[(this.cursor + i) % this.requests.length]);
      if (this.requests.length) this.cursor = (this.cursor + count) % this.requests.length;
      for (const req of batch) {
        const existing = this.results.find(r => r.actor === req.actor);
        if (!existing && this.results.length >= 64) continue;
        let t = this.watchers.get(req.actor);
        if (!t) {
          t = new Tail();
          t.actor = req.actor;
          this.watchers.set(req.actor, t);
        }
        let delta = new Counts();
        if (req.agent.transcript.len)
          try {
            delta = await t.poll(req);
          } catch {
            if (t.live.meter.value.known) t.live.meter.lose();
            t.closeFile();
            t.progress = new Tools();
          }
        if (
          !delta.any() &&
          !delta.tokens_known &&
          !t.progress.dirty &&
          req.agent.provider !== "codex" &&
          !t.model.id.len &&
          !t.name.len &&
          !t.continued.len &&
          !t.update.len &&
          !t.spoke_at &&
          !t.ended.len &&
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
        if (req.agent.provider === "codex") r.name = this.index.name(req.agent.sessionId());
        else {
          r.name = t.name;
          r.continued = t.continued;
          r.update = t.update;
          r.update_at = t.update_at;
          r.spoke_at = t.spoke_at;
          r.ended = Object.assign(new Ended(), { items: [...t.ended.items] });
        }
        if (existing) this.results[this.results.indexOf(existing)] = r;
        else this.results.push(r);
        if (t.progress.turn.text() === req.agent.turnId()) t.progress.dirty = false;
      }
    } finally {
      this.running = false;
    }
  }
}
