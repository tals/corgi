import { hydrate } from "../persist/checkpoint";
import * as links from "../trackers/link_labels";
import { Actor, max_actors } from "../conversations";
import { Agent, Provider, Text } from "../agents";
import * as summary from "./summary";
import type { View as ToolView } from "./tools";
import { Backend, outcome } from "../summary_backend";
import * as setup from "../inference/setup";
import { Meter } from "../usage/live";
import * as clock from "../clock";
export const cooldown_ms = 8000,
  tool_quiet_ms = 5000,
  tool_wait_ms = 30000,
  retry_ms = 60000,
  away_after_ms = 300000,
  away_interval_ms = 60000;
export class Request {
  actor = 0;
  provider: Provider = "codex";
  session = new Text();
  turn = new Text();
  evidence = new summary.Text();
  panes: number[] = [];
  name = new Text();
  conversation = new summary.Conversation();
  generation = 0n;
  completed_tools = 0n;
  turn_epoch = 0;
  toJSON() {
    return {
      ...this,
      panes: [...this.panes, ...Array(64 - this.panes.length).fill(0)],
      panes_len: this.panes.length,
    };
  }
  sameTurn(other: Request) {
    return this.actor === other.actor && this.turn_epoch === other.turn_epoch;
  }
}
export class Result {
  number = 0n;
  constructor(
    public request: Request,
    public label: Text | null,
  ) {}
  stale(agent: Agent) {
    if (agent.state !== "working") return "not_working";
    if (agent.turn_epoch !== this.request.turn_epoch) return "turn_changed";
    if (agent.activity_generation !== this.request.generation) return "evidence_changed";
    return null;
  }
  apply(actor: Actor) {
    if (actor.id !== this.request.actor) return false;
    const agent = actor.state,
      reason = this.stale(agent);
    if (reason) {
      outcome(this.number, reason);
      return false;
    }
    outcome(this.number, null);
    if (this.label === null) {
      agent.activity = new Text();
      agent.activity_inferred = false;
      return true;
    }
    agent.activity = new Text(this.label.text());
    agent.activity_inferred = true;
    actor.status_inference.remember(agent.turnId(), this.request.evidence.text(), this.label);
    const now = clock.milliTimestamp();
    if (!agent.compacting) actor.activity_timeline.checkpoint(agent.turnId(), this.label, actor.usageView(now), now);
    return true;
  }
}
export class Slot {
  commentary = new summary.Text();
  tool_evidence = new summary.Text();
  next = 0;
  attempted_tools = 0n;
  attempted_evidence: bigint | null = null;
  attempted_commentary: bigint | null = null;
  attempted_at = 0;
  tools_changed_at = 0;
  tools_pending_since = 0;
  retry = false;
  active = true;
  result: Result | null = null;
  constructor(public request: Request) {}
  ready(now: number, away: boolean) {
    if (!this.active || now < this.next || !this.request.evidence.len) return false;
    if (this.retry) return true;
    if (this.attempted_evidence === null) return true;
    if (this.attempted_evidence === summary.hash(this.request.evidence)) return false;
    if (away && now - this.attempted_at < away_interval_ms) return false;
    if (this.attempted_commentary !== summary.hash(this.commentary)) return true;
    return now - this.tools_changed_at >= tool_quiet_ms || now - this.tools_pending_since >= tool_wait_ms;
  }
  combine() {
    this.request.evidence = new summary.Text((this.tool_evidence.text() + this.commentary.text()).slice(0, 2048));
  }
  updateTools(evidence: Text, now: number) {
    if (this.tool_evidence.text() !== evidence.text()) {
      this.tools_changed_at = now;
      if (!this.tools_pending_since) this.tools_pending_since = now;
    }
    this.tool_evidence = evidence;
    this.combine();
  }
  observeTools(progress: ToolView, now: number) {
    if (progress.completed < this.request.completed_tools) {
      this.attempted_tools = 0n;
      this.retry = false;
    }
    this.request.completed_tools = progress.completed;
    this.updateTools(progress.evidence, now);
  }
  attempt(now: number) {
    this.attempted_tools = this.request.completed_tools;
    this.attempted_evidence = summary.hash(this.request.evidence);
    this.attempted_commentary = summary.hash(this.commentary);
    this.attempted_at = now;
    this.tools_pending_since = 0;
    this.retry = false;
    this.next = now + cooldown_ms;
  }
}
export class Worker {
  link_requests: Array<links.Request | null> = Array(links.capacity).fill(null);
  link_results: Array<links.Result | null> = Array(links.capacity).fill(null);
  link_cursor = 0;
  prefer_links = true;
  submitLink(request: links.Request) {
    if (request.slot >= 0 && request.slot < links.capacity) this.link_requests[request.slot] = { ...request };
  }
  cancelLink(slot: number, generation: bigint) {
    if (this.link_requests[slot]?.generation === generation) this.link_requests[slot] = null;
    if (this.link_results[slot]?.generation === generation) this.link_results[slot] = null;
  }
  takeLinks() {
    const out = this.link_results;
    this.link_results = Array(links.capacity).fill(null);
    return out;
  }
  slots: Array<Slot | null> = Array(max_actors).fill(null);
  implementation = new Backend();
  system_meter = new Meter();
  choice: setup.Choice = "auto";
  launches = new setup.Launches();
  remembered: Provider = "codex";
  active: Provider | null = null;
  applied = false;
  locked = false;
  observed_at = clock.milliTimestamp();
  cursor = 0;
  next_global = 0;
  passes = 0n;
  stopping = false;
  pausing = false;
  paused = false;
  running = false;
  timer: ReturnType<typeof setInterval> | null = null;
  constructor(choice: setup.Choice = "auto") {
    this.choice = choice;
    this.system_meter.value.known = true;
  }
  static start(choice: setup.Choice = "auto") {
    const w = new Worker(choice);
    w.activate();
    return w;
  }
  activate() {
    if (this.timer) throw Error("InferenceBusy");
    this.timer = setInterval(() => void this.run(), 250);
  }
  observe(now: number) {
    this.observed_at = now;
  }
  off() {
    return this.choice === "off";
  }
  status() {
    const provider = this.applied ? this.active : setup.resolve(this.choice, this.launches, this.remembered),
      s = new setup.Status();
    s.choice = this.choice;
    s.provider = provider;
    s.model = setup.model(provider);
    s.locked = this.locked;
    for (const p of Provider.all) {
      s.launches.set(p, this.launches.count.get(p));
      s.models.set(p, setup.model(p));
    }
    return s;
  }
  configure(choice: setup.Choice) {
    this.choice = choice;
    this.applied = false;
    this.locked = false;
    for (const s of this.slots) if (s?.retry) s.next = 0;
  }
  async poke() {
    const before = this.passes;
    void this.run();
    const deadline = Date.now() + 47000;
    while (this.passes === before && Date.now() < deadline) await Bun.sleep(10);
  }
  observeLaunch(provider: Provider) {
    this.launches.record(provider);
    this.remembered = provider;
  }
  remember(provider: Provider) {
    this.remembered = provider;
  }
  systemUsage(now: number) {
    return this.system_meter.view(now);
  }
  applyChoice() {
    const provider =
      this.locked && this.choice === "auto" ? this.active : setup.resolve(this.choice, this.launches, this.remembered);
    if (this.applied && provider === this.active) return;
    this.implementation.use(provider);
    this.active = provider;
    this.applied = true;
  }
  async pause() {
    this.pausing = true;
    const deadline = Date.now() + 47000;
    while (this.running) {
      if (Date.now() >= deadline) {
        this.pausing = false;
        throw Error("ReloadInferenceBusy");
      }
      await Bun.sleep(10);
    }
    this.paused = true;
  }
  unpause() {
    this.pausing = false;
    this.paused = false;
  }
  capture() {
    if (!this.paused || this.running) throw Error("InferenceBusy");
    return {
      slots: this.slots.flatMap((slot, index) => (slot ? [{ index, slot }] : [])),
      link_requests: this.link_requests.filter(Boolean),
      link_results: this.link_results,
      pool: this.implementation.pool.capture(),
      next_request: this.implementation.next_request,
      choice: this.choice,
      launches: this.launches,
      remembered: this.remembered,
      active: this.active,
      applied: this.applied,
      locked: this.locked,
      cursor: this.cursor,
      link_cursor: this.link_cursor,
      prefer_links: this.prefer_links,
      next_global: this.next_global,
    };
  }
  static restore(saved: any) {
    if (
      saved.slots.length > max_actors ||
      saved.link_requests.length > links.capacity ||
      saved.cursor >= max_actors ||
      saved.link_cursor >= links.capacity
    )
      throw Error("InvalidCheckpoint");
    const worker = new Worker(saved.choice);
    worker.launches = setup.Launches.restore(saved.launches);
    for (const key of [
      "remembered",
      "active",
      "applied",
      "locked",
      "cursor",
      "link_cursor",
      "prefer_links",
      "next_global",
    ] as const)
      (worker as any)[key] = saved[key];
    worker.implementation.next_request = BigInt(saved.next_request);
    for (const entry of saved.slots) {
      if (entry.index >= max_actors || worker.slots[entry.index]) throw Error("InvalidCheckpoint");
      const request = hydrate(new Request(), entry.slot.request);
      request.panes = request.panes.slice(0, entry.slot.request.panes_len ?? request.panes.length);
      const slot = hydrate(new Slot(request), entry.slot);
      slot.request = request;
      if (request.panes.length > 64 || request.conversation.recent.length > 4) throw Error("InvalidCheckpoint");
      for (const key of ["attempted_evidence", "attempted_commentary"] as const)
        if (entry.slot[key] !== null) slot[key] = BigInt(entry.slot[key]);
      if (entry.slot.result) {
        slot.result = hydrate(
          new Result(hydrate(new Request(), entry.slot.result.request), entry.slot.result.label ? new Text() : null),
          entry.slot.result,
        );
      }
      if (slot.result)
        slot.result.request.panes = slot.result.request.panes.slice(
          0,
          entry.slot.result.request.panes_len ?? slot.result.request.panes.length,
        );
      worker.slots[entry.index] = slot;
    }
    for (const request of saved.link_requests) {
      if (request.slot >= links.capacity || worker.link_requests[request.slot]) throw Error("InvalidCheckpoint");
      worker.link_requests[request.slot] = {
        ...request,
        generation: BigInt(request.generation),
        key: { ...request.key, address: BigInt(request.key.address) },
      };
    }
    worker.link_results = saved.link_results.map((result: any, index: number) => {
      if (!result) return null;
      if (result.slot !== index) throw Error("InvalidCheckpoint");
      return {
        ...result,
        generation: BigInt(result.generation),
        key: { ...result.key, address: BigInt(result.key.address) },
        name: result.name ? hydrate(new Text(), result.name) : null,
      };
    });
    worker.implementation.pool.restore(saved.pool);
    worker.system_meter = worker.implementation.pool.system_usage.meter;
    return worker;
  }
  inherit() {
    this.implementation.pool.inherit();
  }
  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.implementation.deinit();
    this.slots.fill(null);
  }
  submit(owner: Actor, evidence: Text, progress: ToolView | null, panes: any[]) {
    const agent = owner.state;
    if (!["working", "blocked"].includes(agent.state) || !agent.turn.len || this.off()) return;
    const req = Object.assign(new Request(), {
      actor: owner.id,
      provider: owner.provider(),
      session: agent.session,
      turn: agent.turn,
      turn_epoch: agent.turn_epoch,
      evidence,
      generation: agent.activity_generation,
      conversation: owner.status_inference,
      name: agent.name,
      panes: panes
        .filter(p => p.attachment.actor === owner)
        .slice(0, 64)
        .map(p => p.id),
    });
    let index = this.slots.findIndex(s => s?.request.actor === owner.id);
    if (index < 0) index = this.slots.findIndex(s => !s);
    if (index < 0) return;
    let slot = this.slots[index];
    if (!slot || !slot.request.sameTurn(req)) slot = this.slots[index] = new Slot(req);
    slot.request.panes = req.panes;
    slot.request.name = req.name;
    slot.request.conversation = req.conversation;
    slot.active = agent.state === "working";
    slot.commentary = evidence;
    slot.request.generation = agent.activity_generation;
    slot.combine();
    if (progress && agent.turnId() === progress.turn.text()) slot.observeTools(progress, clock.milliTimestamp());
  }
  tools(actor: number, agent: Agent, progress: ToolView) {
    if (agent.turnId() !== progress.turn.text()) return;
    const slot = this.slots.find(s => s?.request.actor === actor && s.request.turn_epoch === agent.turn_epoch);
    slot?.observeTools(progress, clock.milliTimestamp());
  }
  reconcile(actors: Actor[]) {
    this.slots = this.slots.map(slot => {
      if (!slot) return null;
      const actor = actors.find(
        a =>
          a.id === slot.request.actor &&
          ["working", "blocked"].includes(a.state.state) &&
          a.state.turn_epoch === slot.request.turn_epoch,
      );
      if (actor) {
        slot.active = actor.state.state === "working";
        slot.request.conversation = actor.status_inference;
        return slot;
      }
      if (slot.result) outcome(slot.result.number, "not_working");
      return null;
    });
  }
  take() {
    const out: Result[] = [];
    for (const slot of this.slots)
      if (slot?.result && out.length < 64) {
        out.push(slot.result);
        slot.result = null;
      }
    return out;
  }
  async run() {
    if (this.running || this.stopping || this.pausing) return;
    this.running = true;
    try {
      this.applyChoice();
      this.implementation.pool.refreshUsage();
      this.locked ||= this.implementation.pool.started;
      this.system_meter = this.implementation.pool.system_usage.meter;
      this.passes++;
      if (this.off()) {
        for (let i = 0; i < links.capacity; i++) {
          const request = this.link_requests[i];
          if (request) {
            this.link_results[i] = {
              slot: request.slot,
              generation: request.generation,
              key: request.key,
              name: null,
            };
            this.link_requests[i] = null;
          }
        }
        return;
      }
      const now = clock.milliTimestamp();
      if (now < this.next_global) return;
      let index = -1;
      for (let n = 0; n < max_actors; n++) {
        const i = (this.cursor + n) % max_actors;
        if (this.slots[i]?.ready(now, now - this.observed_at >= away_after_ms)) {
          index = i;
          break;
        }
      }
      let selected_link = -1;
      for (let n = 0; n < links.capacity; n++) {
        const i = (this.link_cursor + n) % links.capacity;
        if (this.link_requests[i]) {
          selected_link = i;
          break;
        }
      }
      if (selected_link >= 0 && (this.prefer_links || index < 0)) {
        const request = this.link_requests[selected_link]!;
        this.link_requests[selected_link] = null;
        this.link_cursor = (selected_link + 1) % links.capacity;
        this.prefer_links = false;
        this.next_global = now + 1000;
        const result = await links.infer(this.implementation.pool, request, {
          load: () => this.stopping,
        });
        this.system_meter = this.implementation.pool.system_usage.meter;
        this.link_results[selected_link] = result;
        return;
      }
      if (index < 0) return;
      this.prefer_links = true;
      const slot = this.slots[index]!,
        request = Object.assign(new Request(), slot.request),
        tools = request.completed_tools > slot.attempted_tools ? request.completed_tools - slot.attempted_tools : 0n;
      slot.attempt(now);
      this.cursor = (index + 1) % max_actors;
      this.next_global = now + 1000;
      const turn = request.turn.text(),
        attempt = await this.implementation.infer(
          {
            provider: request.provider,
            turn: summary.turnTag(turn),
            evidence: request.evidence.text(),
            history: request.conversation.recent.slice(0, request.conversation.len).map(e => e.text()),
          },
          turn,
          request.conversation.key(request.actor),
          {
            actor: request.actor,
            panes: request.panes,
            agent_name: request.name.text(),
            session: request.session.text(),
            tools_since_last: tools,
          },
          { load: () => this.stopping },
        );
      this.system_meter = this.implementation.pool.system_usage.meter;
      const current = this.slots[index];
      let discard: "not_working" | "turn_changed" | "evidence_changed" | null = "not_working";
      if (current) {
        if (!current.request.sameTurn(request)) discard = "turn_changed";
        else if (attempt.decision) {
          if (current.request.generation !== request.generation) discard = "evidence_changed";
          else {
            if (current.result) outcome(current.result.number, "superseded");
            current.result = new Result(request, attempt.decision.label);
            current.result.number = attempt.request;
            discard = null;
          }
        } else {
          current.retry = true;
          current.next = clock.milliTimestamp() + retry_ms;
        }
      }
      if (attempt.decision && discard) outcome(attempt.request, discard);
    } finally {
      this.running = false;
    }
  }
}
