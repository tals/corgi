import * as background_tasks from "./activity/background_tasks";
import * as breadcrumbs from "./breadcrumbs";
import * as checklist from "./activity/checklist";
import { Conversation, hash } from "./activity/summary";
import { Timeline } from "./activity/timeline";
import { View, Tokens, Counter } from "./usage/live";
import { Reading, Points } from "./usage/context_window";
import { Agent, Provider, Text, type Presence } from "./agents";
import type { Outcome } from "./observation";
import { Model } from "./providers/model";
import { PromptWatch } from "./detection";
import type { Snapshot } from "./providers/snapshot";
import { adapter } from "./providers";
import * as worktrees from "./worktrees";
export const max_actors = 1024;
export type ActorId = number & { readonly __actorId: unique symbol };
export class Actor {
  static Id = {
    none: 0 as ActorId,
    first: 1 as ActorId,
    next: (id: ActorId) => (id + 1) as ActorId,
  };
  id: ActorId;
  state: Agent;
  parent: ActorId | null = null;
  pending_headless_requests = 0;
  screen_compacting = false;
  pid = 0;
  paused_at = 0n;
  paused_for_wakeup = false;
  transcript_tool_active = false;
  prompt_watch = new PromptWatch();
  workspace = 0;
  observed_at = 0;
  /** When the last hook came, in µs; 0 before any. */
  hooked_at = 0;
  tracked_since = 0;
  child_refresh = false;
  children_observed_at = 0;
  role = new Text();
  model = new Model();
  model_from_hook = false;
  headless_usage = false;
  status_inference = new Conversation();
  activity_timeline = new Timeline();
  background_tasks = new background_tasks.Inventory();
  checklist = new checklist.List();
  /** The background shells its last Stop listed, each of which can wake it. */
  shells = new background_tasks.Shells();
  live_usage = new View();
  context = new Reading();
  headless_meter = new Counter();
  usageView(now: number) {
    return this.headless_usage ? this.headless_meter.meter.view(now) : this.live_usage;
  }
  /** Counts usage from its headless session's protocol from now on, starting from what
   * its transcript counted. `active` when a turn of it already runs. */
  beginHeadlessUsage(active: boolean) {
    if (this.headless_usage) return;
    this.headless_usage = true;
    this.headless_meter.meter.value = new View({ ...this.live_usage, tokens: new Tokens(this.live_usage.tokens) });
    this.headless_meter.meter.value.recent_tokens = 0n;
    this.headless_meter.baseline_next = this.live_usage.known || active;
    if (this.headless_meter.baseline_next) this.headless_meter.meter.value.partial = true;
  }
  compactionChanged(was: boolean, now: number) {
    if (this.state.compacting === was) return;
    // A restored compaction keeps its start.
    this.state.compacting_since = this.state.compacting ? this.state.compacting_since || now : 0;
    const ms = Math.floor(now / 1000);
    if (!this.state.compacting) this.activity_timeline.finish(this.usageView(ms));
    const text = this.state.compacting ? "Compacting context" : this.state.activity.text();
    if (text)
      this.activity_timeline.checkpoint(this.state.turnId(), new Text(text.slice(0, 80)), this.usageView(ms), ms);
  }
  checkpointActivity(amend: boolean, now: number) {
    if (this.state.compacting || !this.state.activity.len) return;
    const ms = Math.floor(now / 1000),
      timeline = this.activity_timeline;
    if (amend) timeline.amend(this.state.turnId(), this.state.activity, this.usageView(ms), ms);
    else timeline.checkpoint(this.state.turnId(), this.state.activity, this.usageView(ms), ms);
  }
  /** Keeps `list` unless the one it holds is newer. */
  observeChecklist(list: checklist.List) {
    if (list.at >= this.checklist.at) this.checklist = list;
  }
  observeTaskEnds(ended: background_tasks.Ended) {
    this.shells.drop(ended);
    if (!this.state.paused || this.paused_for_wakeup || this.shells.len) return false;
    this.state.paused = false;
    return true;
  }
  refreshTranscriptTool() {
    this.state.tool_active =
      ["working", "blocked"].includes(this.state.state) &&
      (this.transcript_tool_active || this.background_tasks.len > 0);
  }
  observeTools(progress: any) {
    if (!adapter(this.provider()).caps.transcript_tools || this.state.turnId() !== progress.turn.text()) return;
    this.transcript_tool_active = !progress.ended && progress.running > 0;
    this.refreshTranscriptTool();
  }
  observeSnapshot(snapshot: Snapshot, watched: boolean, now: number) {
    const a = this.state;
    if (!snapshot.lifecycle) {
      if (a.sessionId() !== snapshot.session) return false;
      if (snapshot.transcript.len && !a.transcript.len) a.transcript = snapshot.transcript;
      if (snapshot.cwd.len && !a.cwd.len) a.cwd = snapshot.cwd;
      if (snapshot.name.len && !a.name.len) a.name = snapshot.name;
      return false;
    }
    if (snapshot.observed_at <= a.last_seq) return false;
    this.child_refresh = false;
    const binding = a.last_seq === 0n;
    if (a.session.len && a.sessionId() !== snapshot.session) return false;
    if (binding) {
      const provider = a.provider;
      a.reset();
      a.provider = provider;
      a.session = new Text(snapshot.session);
    }
    if (snapshot.transcript.len) a.transcript = snapshot.transcript;
    if (snapshot.cwd?.len) a.cwd = snapshot.cwd;
    a.account = snapshot.account;
    if (snapshot.model) {
      a.model = new Text(snapshot.model);
      this.model = snapshot.model_info ?? Model.resolve(snapshot.model);
    }
    if (snapshot.usage) {
      this.beginHeadlessUsage(binding && ["working", "blocked"].includes(snapshot.state));
      this.headless_meter.sample(
        snapshot.usage.total,
        snapshot.usage.last,
        snapshot.state === "working",
        Math.floor(now / 1000),
      );
    }
    if (snapshot.context) this.context = snapshot.context;
    if (snapshot.location) worktrees.recordLocation(a, snapshot.location);
    this.observed_at = Math.max(this.observed_at, snapshot.observed_at);
    this.background_tasks = snapshot.background_tasks;
    a.updated_at = snapshot.updated_at;
    a.metadata_protocol_at = snapshot.observed_at;
    a.metadata_at = now;
    if (snapshot.name.len) a.name = snapshot.name;
    const old = a.state,
      was = a.compacting,
      same = a.turnId() === snapshot.turn.text();
    a.state = snapshot.state;
    a.permission_review = null;
    a.subagents = snapshot.subagents;
    a.last_seq = BigInt(snapshot.observed_at);
    a.protocol_at = now;
    a.observation.source = "protocol";
    a.observation.pending_stop = false;
    if (!same || !["working", "blocked"].includes(snapshot.state)) this.transcript_tool_active = false;
    if (snapshot.tool_active !== null) this.transcript_tool_active = snapshot.tool_active;
    this.refreshTranscriptTool();
    a.tool = new Text(snapshot.tool);
    if (!same || old !== snapshot.state || snapshot.state !== "working") {
      a.activity = new Text();
      a.compacting = false;
      this.screen_compacting = false;
    }
    if (snapshot.compacting !== null) {
      a.compacting = snapshot.state === "working" && snapshot.compacting;
      this.screen_compacting = false;
    }
    a.activity_generation = hash(snapshot.evidence);
    let ding = false;
    if (snapshot.turn.len) {
      a.setTurn(snapshot.turn.text());
      if (snapshot.outcome)
        ding =
          a.recordCompletion(a.turnId(), snapshot.outcome, "protocol", binding) &&
          snapshot.outcome === "completed" &&
          !watched &&
          this.parent === null;
    }
    a.attention =
      snapshot.state === "blocked" && !watched ? "needs_input" : a.observation.unread() ? "finished" : "none";
    this.compactionChanged(was, snapshot.observed_at);
    return ding || (!binding && snapshot.state === "blocked" && old !== "blocked" && !watched);
  }
  constructor(fields: { id: number; state?: Agent }) {
    this.id = fields.id as ActorId;
    this.state = fields.state ?? new Agent();
  }
  provider() {
    return this.state.provider!;
  }
  observeHook(event: any, seq: bigint, watched: boolean, now: number, presence: Presence = "detached") {
    const was = this.state.compacting;
    const ding = this.state.observeHook(this.provider(), event, seq, watched, now, presence);
    if (ding === null) return false;
    if (event.checklist) this.observeChecklist(event.checklist.stamped(now));
    if (event.kind === "checklist") return false;
    if (this.state.last_seq === seq && event.kind !== "activity") this.screen_compacting = false;
    if (event.model) {
      this.model = Model.resolve(event.model);
      this.model_from_hook = true;
    }
    this.compactionChanged(was, now);
    adapter(this.provider()).conversation?.hooked?.(this, event, now);
    this.observed_at = Math.max(this.observed_at, now);
    this.hooked_at = now;
    return ding;
  }
  checkPause() {
    if (!this.state.paused || (adapter(this.provider()).conversation?.holds?.(this.pid) ?? false)) return false;
    this.state.paused = false;
    return true;
  }
  observeTranscriptTurn(spoke_at: number) {
    if (!this.state.paused || spoke_at * 1000 <= this.paused_at) return false;
    this.state.paused = false;
    return true;
  }
  restoreCompaction(screen_owned: boolean | null, now: number) {
    if (!this.state.compacting) return;
    this.screen_compacting = screen_owned ?? (this.state.changed_at === 0 && this.state.observation.source !== "hook");
    this.compactionChanged(false, now);
  }
  observeCompactionScreen(compacting: boolean | null, now: number) {
    const was = this.state.compacting;
    if (this.state.state !== "working" || compacting === null) return;
    if (compacting && !this.state.compacting) {
      this.state.compacting = true;
      this.screen_compacting = true;
    } else if (!compacting && this.screen_compacting) {
      this.state.compacting = false;
      this.screen_compacting = false;
    }
    this.compactionChanged(was, now);
  }
  authoritative(now: number) {
    if (!this.state.last_seq) return false;
    return (
      this.state.observation.source === "hook" ||
      this.state.observation.source === "transcript" ||
      (this.state.observation.source === "protocol" && now - this.state.protocol_at <= 5000000)
    );
  }
  screen(status: Agent, needs_input: boolean, now: number) {
    if (this.authoritative(now) || status.observation.source !== "screen") return;
    this.state.state = status.state;
    this.state.tool_active = status.tool_active;
    this.state.observation.source = "screen";
    if (needs_input) {
      this.state.changed_at = now;
      this.state.attention = "needs_input";
    }
  }
  confirmStop(seq: bigint, outcome: Outcome, now: number) {
    return this.state.confirmStop(seq, outcome, now);
  }
  acknowledge(through: bigint, attention_at: bigint | null) {
    if (attention_at !== null && attention_at === BigInt(this.state.changed_at)) this.state.attention = "none";
    this.state.readThrough(through);
  }
}
export class Attachment {
  actor: Actor | null = null;
  provisional = new Agent();
  generation = 1n;
  selection_hash = 0n;
  /** The title shows a side conversation of `actor`, such as Codex's `/btw`. */
  side = false;
  hook_seq = 0n;
  known: ActorId[] = [];
  /** The pane or native session it belongs to, for breadcrumbs. */
  owner: breadcrumbs.Owner | null = null;
  get known_len() {
    return this.known.length;
  }
  agent() {
    return this.actor?.state ?? this.provisional;
  }
  select(actor: Actor) {
    if (this.actor !== actor && this.provisional.observation.source === "screen") {
      if (
        this.actor === null &&
        this.known_len === 0 &&
        this.provisional.provider === actor.provider() &&
        actor.state.last_seq === 0n &&
        actor.state.state === "unknown" &&
        actor.state.observation.completed === 0n
      ) {
        const session = actor.state.session;
        actor.state = this.provisional.snapshot();
        actor.state.session = session;
      }
      this.provisional = new Agent({ provider: actor.provider() });
    }
    if (!this.knows(actor.id)) {
      if (this.known.length === 256) this.known.shift();
      this.known.push(actor.id);
    }
    this.side = false;
    if (this.actor === actor) return;
    breadcrumbs.record("bound", { owner: this.owner, actors: [actor.id] });
    this.actor = actor;
    this.generation = BigInt.asUintN(64, this.generation + 1n);
  }
  knows(id: number) {
    return this.known.includes(id as ActorId);
  }
  deselect() {
    if (this.actor) breadcrumbs.record("unbound", { owner: this.owner, actors: [this.actor.id] });
    this.clear();
  }
  private clear() {
    this.actor = null;
    this.side = false;
    this.provisional = new Agent();
    this.generation = BigInt.asUintN(64, this.generation + 1n);
  }
  detach() {
    if (this.actor || this.known.length) breadcrumbs.record("released", { owner: this.owner, actors: [...this.known] });
    this.clear();
    this.known = [];
    this.selection_hash = 0n;
    this.hook_seq = 0n;
  }
  matches(generation: bigint, actor: number) {
    return this.generation === generation && this.actor?.id === actor;
  }
}
export class Registry {
  items: Actor[] = [];
  compaction_points = new Points();
  next_id: ActorId = Actor.Id.first;
  find(provider: Provider, session: string) {
    return this.items.find(a => a.state.provider === provider && a.state.sessionId() === session) ?? null;
  }
  byId(id: number) {
    return this.items.find(a => a.id === id) ?? null;
  }
  get(provider: Provider, session: string) {
    if (!session || Buffer.byteLength(session) > 160 || /[\x00-\x1f\x7f]/.test(session) || session.includes("\ufffd"))
      throw Error("InvalidSession");
    const found = this.find(provider, session);
    if (found) return found;
    if (this.items.length === max_actors || this.next_id === 0xffffffff) throw Error("TooManyConversations");
    const actor = new Actor({
      id: this.next_id,
      state: new Agent({ provider, session: new Text(session) }),
    });
    actor.tracked_since = Date.now();
    this.items.push(actor);
    this.next_id = Actor.Id.next(this.next_id);
    return actor;
  }
  /** Forgets every conversation but those in `keep`, their parents and
   * their children. Returns whether it forgot any. */
  prune(keep: ReadonlySet<ActorId>) {
    const kept = new Set<ActorId>();
    for (const actor of this.items) {
      if (!keep.has(actor.id)) continue;
      let ancestor: Actor | null = actor;
      for (let i = 0; i < max_actors && ancestor && !kept.has(ancestor.id); i++) {
        kept.add(ancestor.id);
        ancestor = ancestor.parent === null ? null : this.byId(ancestor.parent);
      }
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const actor of this.items)
        if (!kept.has(actor.id) && actor.parent !== null && kept.has(actor.parent)) {
          kept.add(actor.id);
          grew = true;
        }
    }
    if (kept.size === this.items.length) return false;
    breadcrumbs.record("forgot", { actors: this.items.flatMap(actor => (kept.has(actor.id) ? [] : [actor.id])) });
    this.items = this.items.filter(actor => kept.has(actor.id));
    return true;
  }
  linkChild(parent: Actor, child: Actor) {
    if (parent.state.provider !== child.state.provider || (child.parent !== null && child.parent !== parent.id))
      return false;
    let ancestor: Actor | null = parent;
    for (let i = 0; i < max_actors; i++) {
      if (!ancestor) {
        child.parent = parent.id;
        child.workspace = parent.workspace;
        child.tracked_since = parent.tracked_since;
        return true;
      }
      if (ancestor.id === child.id) return false;
      ancestor = ancestor.parent === null ? null : this.byId(ancestor.parent);
    }
    return false;
  }
  observeHook(actor: Actor, event: any, seq: bigint, watched: boolean, now: number, presence: Presence = "detached") {
    if (event.kind === "subagent_start" || event.kind === "subagent_stop") {
      // Child hooks share a transport, not their parent's or siblings' event order.
      const child = this.find(actor.provider(), event.subagent);
      if (
        child &&
        (seq < child.state.last_seq ||
          (seq === child.state.last_seq && child.state.state === "idle" && event.kind === "subagent_start"))
      )
        return false;
      adapter(actor.provider()).conversation?.child?.(this, actor, event, now);
      const updated = this.find(actor.provider(), event.subagent);
      if (updated?.parent === actor.id) updated.state.last_seq = seq;
      return false;
    }
    const accepted = actor.state.last_seq;
    const ding = actor.observeHook(event, seq, watched, now, presence);
    if (actor.state.last_seq !== accepted)
      adapter(actor.provider()).conversation?.applied?.(this, actor, event, seq, now);
    return ding;
  }
  observeChildren(parent: Actor, snapshot: Snapshot, now: number) {
    if (snapshot.observed_at <= parent.children_observed_at) return;
    if (!snapshot.children_complete) {
      parent.children_observed_at = 0;
      return;
    }
    parent.children_observed_at = snapshot.observed_at;
    for (const meta of snapshot.children) {
      let child: Actor;
      try {
        child = this.get(parent.provider(), meta.session);
      } catch {
        continue;
      }
      if (!this.linkChild(parent, child)) continue;
      if (meta.role.len) child.role = meta.role;
      const state = child.state;
      if (snapshot.observed_at <= state.metadata_protocol_at) continue;
      if (state.state !== meta.state || state.updated_at !== meta.updated_at || !state.last_seq)
        child.child_refresh = true;
      if (meta.name.len) state.setName(meta.name.text());
      if (meta.transcript.len) state.transcript = meta.transcript;
      state.state = meta.state;
      state.updated_at = meta.updated_at;
      state.metadata_protocol_at = snapshot.observed_at;
      state.metadata_at = now;
      child.observed_at = Math.max(child.observed_at, snapshot.observed_at);
    }
  }
  /** The conversation a hook is about, in the pane `binding` its watcher
   * routed it to. A hook that doesn't `bind` goes only where its session
   * already shows. */
  routeHook(binding: Attachment, provider: Provider, event: any, binds: boolean) {
    if (!event.session) return null;
    if (event.kind === "subagent_start" || event.kind === "subagent_stop") {
      const actor = this.find(provider, event.session);
      let ancestor = actor;
      for (let i = 0; ancestor && i < max_actors; i++) {
        if (binding.knows(ancestor.id)) return actor;
        ancestor = ancestor.parent === null ? null : this.byId(ancestor.parent);
      }
      return null;
    }
    if (!binds) {
      const actor = this.find(provider, event.session);
      return actor && binding.knows(actor.id) ? actor : null;
    }
    if (
      event.kind === "session_start" ||
      (binding.actor === null &&
        binding.known_len === 0 &&
        (binding.provisional.provider === provider || binding.generation === 1n))
    ) {
      const actor = this.get(provider, event.session);
      binding.select(actor);
      return actor;
    }
    const actor = this.find(provider, event.session);
    return actor && binding.knows(actor.id) ? actor : null;
  }
}
