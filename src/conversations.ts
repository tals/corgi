import path from "node:path";
import * as background_tasks from "./activity/background_tasks";
import { Conversation, hash } from "./activity/summary";
import { Timeline } from "./activity/timeline";
import { View, Codex as NativeMeter } from "./usage/live";
import { Reading, Points } from "./usage/context_window";
import { Claude } from "./providers/claude";
import { Agent, Provider, Text, type State } from "./agents";
import type { Outcome } from "./observation";
import { Model } from "./providers/model";
import { PromptWatch, claudeRunning } from "./detection";
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
  pending_native_requests = 0;
  screen_compacting = false;
  pid = 0;
  paused_at = 0n;
  paused_for_wakeup = false;
  transcript_tool_active = false;
  prompt_watch = new PromptWatch();
  workspace = 0;
  observed_at = 0;
  tracked_since = 0;
  child_refresh = false;
  children_observed_at = 0;
  role = new Text();
  model = new Model();
  model_from_hook = false;
  native_usage = false;
  status_inference = new Conversation();
  activity_timeline = new Timeline();
  background_tasks = new background_tasks.Inventory();
  /** Claude: the background shells its last Stop listed, each of which can wake it. */
  shells = new background_tasks.Shells();
  live_usage = new View();
  context = new Reading();
  native_meter = new NativeMeter();
  usageView(now: number) {
    return this.native_usage ? this.native_meter.meter.view(now) : this.live_usage;
  }
  compactionChanged(was: boolean, now: number) {
    if (this.state.compacting === was) return;
    const ms = Math.floor(now / 1000);
    if (!this.state.compacting) this.activity_timeline.finish(this.usageView(ms));
    const text = this.state.compacting ? "Compacting context" : this.state.activity.text();
    if (text)
      this.activity_timeline.checkpoint(this.state.turnId(), new Text(text.slice(0, 80)), this.usageView(ms), ms);
  }
  observeTaskEnds(ended: background_tasks.Ended) {
    this.shells.drop(ended);
    if (!this.state.paused || this.paused_for_wakeup || this.shells.len) return false;
    this.state.paused = false;
    return true;
  }
  pauseAtStop(crons: any, seq: bigint) {
    const wakeup = background_tasks.claudeWakeup(crons);
    if (this.pid <= 0 || (!this.shells.len && !wakeup)) return;
    this.state.paused = true;
    this.paused_at = seq;
    this.paused_for_wakeup = wakeup;
  }
  refreshTranscriptTool() {
    this.state.tool_active =
      ["working", "blocked"].includes(this.state.state) &&
      (this.transcript_tool_active || this.background_tasks.len > 0);
  }
  observeTools(progress: any) {
    if (this.provider() !== "codex" || this.state.turnId() !== progress.turn.text()) return;
    this.transcript_tool_active = !progress.ended && progress.running > 0;
    this.refreshTranscriptTool();
  }
  observeSnapshot(snapshot: any, watched: boolean, now: number) {
    const a = this.state;
    if (snapshot.observed_at <= a.last_seq) return false;
    this.child_refresh = false;
    const binding = a.last_seq === 0n;
    if (a.session.len && a.sessionId() !== snapshot.session) return false;
    if (binding) {
      a.reset();
      a.provider = "codex";
      a.session = new Text(snapshot.session);
    }
    if (snapshot.transcript.len) a.transcript = snapshot.transcript;
    if (snapshot.cwd?.len) a.cwd = snapshot.cwd;
    if (typeof snapshot.worktree_cwd === "string")
      worktrees.recordLocation(a, snapshot.worktree_cwd, snapshot.writes ?? []);
    else if (snapshot.writes) worktrees.recordWrites(a, snapshot.writes);
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
    this.refreshTranscriptTool();
    a.tool = new Text();
    if (!same || old !== snapshot.state || snapshot.state !== "working") {
      a.activity = new Text();
      a.compacting = false;
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
  observeHook(event: any, seq: bigint, watched: boolean, now: number) {
    const was = this.state.compacting;
    const ding = this.state.observeHook(this.provider(), event, seq, watched, now);
    if (ding === null) return false;
    if (this.state.last_seq === seq) this.screen_compacting = false;
    if (event.model) {
      this.model = Model.resolve(event.model);
      this.model_from_hook = true;
    }
    this.compactionChanged(was, now);
    if (this.provider() === "claude") {
      this.state.subagents.waiting = false;
      const tasks = background_tasks.Inventory.claude(event.background_tasks, now);
      if (tasks) this.background_tasks = tasks;
      if (event.kind === "session_end") this.background_tasks = new background_tasks.Inventory();
      // A Stop lists only the tasks of the process that runs the session
      // now, so a shell of an earlier one drops out.
      if (event.kind === "stop") this.shells = background_tasks.Shells.claude(event.background_tasks);
      if (event.kind === "session_end") this.shells = new background_tasks.Shells();
    }
    this.observed_at = Math.max(this.observed_at, now);
    return ding;
  }
  checkPause(buffer?: Uint8Array) {
    if (!this.state.paused || claudeRunning(this.pid, buffer)) return false;
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
    if (
      !Provider.info(this.provider()).screen.compaction_status ||
      this.state.state !== "working" ||
      compacting === null
    )
      return;
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
  hook_seq = 0n;
  known: ActorId[] = [];
  get known_len() {
    return this.known.length;
  }
  agent() {
    return this.actor?.state ?? this.provisional;
  }
  select(actor: Actor) {
    if (!this.knows(actor.id)) {
      if (this.known.length === 256) this.known.shift();
      this.known.push(actor.id);
    }
    if (this.actor === actor) return;
    this.actor = actor;
    this.generation = BigInt.asUintN(64, this.generation + 1n);
  }
  knows(id: number) {
    return this.known.includes(id as ActorId);
  }
  deselect() {
    this.actor = null;
    this.provisional = new Agent();
    this.generation = BigInt.asUintN(64, this.generation + 1n);
  }
  detach() {
    this.deselect();
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
  observeHook(actor: Actor, event: any, seq: bigint, watched: boolean, now: number) {
    const accepted = actor.state.last_seq;
    const ding = actor.observeHook(event, seq, watched, now);
    if (actor.state.last_seq === accepted || actor.provider() !== "claude") return ding;
    if (event.subagent) this.observeLaunch(actor, event, now);
    const listed = background_tasks.Children.claude(event.background_tasks);
    if (listed === null && event.kind !== "session_end") return ding;
    const children = listed ?? new background_tasks.Children();
    this.observeSubagents(actor, children, now);
    if (event.kind === "stop") {
      if (children.running > 0) actor.state.awaitSubagents(now);
      else actor.pauseAtStop(event.session_crons, seq);
    }
    return ding;
  }
  adoptSubagent(parent: Actor, meta: any, now: number) {
    let child: Actor;
    try {
      child = this.get("claude", meta.id.text());
    } catch {
      return false;
    }
    if (!this.linkChild(parent, child)) return false;
    if (!child.state.transcript.len && path.isAbsolute(parent.state.transcriptPath()))
      child.state.transcript = new Text(
        Claude.subagentTranscript(parent.state.transcriptPath(), parent.state.sessionId(), meta.id.text()),
      );
    child.role = meta.agent_type;
    child.state.setName(meta.agent_type.text());
    child.state.setActivity(meta.description.text());
    child.state.state = "working";
    child.observed_at = now;
    return true;
  }
  observeLaunch(parent: Actor, event: any, now: number) {
    if (Buffer.byteLength(event.subagent) > 96 || this.find("claude", event.subagent)?.state.state === "working")
      return;
    if (
      !this.adoptSubagent(
        parent,
        {
          id: new Text(event.subagent),
          description: new Text(event.description),
          agent_type: new Text(event.subagent_type),
        },
        now,
      )
    )
      return;
    parent.state.subagents.running = Math.min(0xffffffff, parent.state.subagents.running + 1);
    parent.children_observed_at = now;
  }
  observeSubagents(parent: Actor, children: background_tasks.Children, now: number) {
    parent.state.subagents.running = children.running;
    parent.children_observed_at = now;
    for (const meta of children.slice()) this.adoptSubagent(parent, meta, now);
    if (!children.complete()) return;
    for (const child of this.items)
      if (child.parent === parent.id && child.state.state !== "idle" && !children.listed(child.state.sessionId())) {
        child.state.state = "idle";
        child.observed_at = now;
      }
  }
  observeChildren(parent: Actor, snapshot: any, now: number) {
    if (snapshot.observed_at <= parent.children_observed_at) return;
    if (!snapshot.children_complete) {
      parent.children_observed_at = 0;
      return;
    }
    parent.children_observed_at = snapshot.observed_at;
    for (const meta of snapshot.children) {
      let child: Actor;
      try {
        child = this.get("codex", meta.session);
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
  routeHook(binding: Attachment, provider: Provider, event: any) {
    if (!event.session) return null;
    if (provider === "codex") {
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
    if (!actor || !binding.knows(actor.id)) return null;
    if (
      event.kind !== "session_end" &&
      binding.actor &&
      binding.actor !== actor &&
      binding.actor.state.state === "done"
    )
      binding.select(actor);
    return actor;
  }
}
