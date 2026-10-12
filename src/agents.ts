import { BoundedText, Path, truncateUtf8, ascii } from "./bounded_text";
import path from "node:path";
import * as observation from "./observation";
import { Provider, str } from "./providers";
import * as worktrees from "./worktrees";
export { observation, Provider, str, Path };
export class Text extends BoundedText(160) {}
export type State = "unknown" | "initializing" | "idle" | "working" | "blocked" | "done";
export type Attention = "none" | "finished" | "needs_input";
export class Agent {
  subagents = { running: 0, blocked: 0, waiting: false };
  name = new Text();
  observation = new observation.State();
  transcript = new Path();
  turn = new Text();
  turn_epoch = 1;
  last_finished_turn = new Text();
  finished_since_activity = false;
  recent = new Text();
  provider: Provider | null = null;
  state: State = "unknown";
  attention: Attention = "none";
  session = new Text();
  activity = new Text();
  activity_generation = 0n;
  activity_at = 0;
  activity_inferred = false;
  metadata_protocol_at = 0;
  metadata_at = 0;
  protocol_at = 0;
  tool = new Text();
  tool_active = false;
  permission_review: number | null = null;
  compacting = false;
  /** When its current compaction began, in µs; 0 when not compacting. */
  compacting_since = 0;
  paused = false;
  cwd = new Path();
  last_seq = 0n;
  changed_at = 0;
  /** When its current stretch of work began, in µs; 0 at rest. */
  working_since = 0;
  updated_at = 0;
  constructor(fields: Partial<Agent> = {}) {
    Object.assign(this, fields);
  }
  snapshot() {
    const out = new Agent({ ...this });
    for (const key of ["name", "turn", "last_finished_turn", "recent", "session", "activity", "tool"] as const)
      out[key] = new Text(this[key].text());
    out.transcript = new Path(this.transcript.text());
    out.cwd = new Path(this.cwd.text());
    out.subagents = { ...this.subagents };
    out.observation = new observation.State({ ...this.observation });
    return out;
  }
  /** Starts or clears the work clock; blocked keeps it running. */
  trackWorking(now: number) {
    const since = this.state === "working" || this.state === "blocked" ? this.working_since || now : 0;
    if (since === this.working_since) return false;
    this.working_since = since;
    return true;
  }
  setName(v: string) {
    this.name = new Text(v);
  }
  displayName() {
    return this.name.text();
  }
  setActivity(v: string) {
    this.activity = firstLine(v);
  }
  sessionId() {
    return this.session.text();
  }
  toolLabel() {
    return this.tool.text();
  }
  directory() {
    return this.cwd.text();
  }
  turnId() {
    return this.turn.text();
  }
  transcriptPath() {
    return this.transcript.text();
  }
  recentLabel() {
    return this.recent.text();
  }
  reset() {
    worktrees.clearWrites(this);
    const receipts = this.observation,
      recent = this.recent,
      epoch = this.turn_epoch;
    Object.assign(this, new Agent());
    this.turn_epoch = (epoch + 1) >>> 0;
    this.observation.completed = receipts.completed;
    this.observation.read = receipts.read;
    this.recent = recent;
    this.attention = this.observation.unread() ? "finished" : "none";
  }
  acknowledge() {
    this.attention = "none";
    this.readThrough(this.observation.completed);
  }
  readThrough(through: bigint) {
    this.observation.acknowledge(through);
    if (this.attention !== "needs_input") this.attention = this.observation.unread() ? "finished" : "none";
  }
  /** Shows the last finished turn as unseen again. */
  markUnread() {
    const o = this.observation;
    if (o.completed === 0n || o.unread()) return false;
    o.read = o.completed - 1n;
    if (this.attention === "none") this.attention = "finished";
    return true;
  }
  setTurn(turn: string) {
    const next = Text.ascii(turn);
    if (next.text() === this.turnId()) return;
    this.turn = next;
    this.turn_epoch = (this.turn_epoch + 1) >>> 0;
  }
  finishedTurn(turn: string) {
    return turn ? turn === this.last_finished_turn.text() : this.finished_since_activity;
  }
  beginTurn(turn: string) {
    this.permission_review = null;
    if (turn) this.setTurn(turn);
    this.finished_since_activity = false;
    this.observation.pending_stop = false;
    this.state = "working";
    this.attention = this.observation.unread() ? "finished" : "none";
  }
  recordCompletion(turn: string, outcome: observation.Outcome, source: observation.Source, baseline: boolean) {
    if (this.finishedTurn(turn)) return false;
    this.last_finished_turn = Text.ascii(turn);
    if (baseline) return false;
    this.observation.finish(outcome, source);
    this.attention = "finished";
    return true;
  }
  endTurn(turn: string, outcome: observation.Outcome, source: observation.Source, now: number) {
    if (turn && this.turn.len && turn !== this.turnId()) return false;
    const recorded = this.recordCompletion(turn || this.turnId(), outcome, source, false);
    this.finished_since_activity = true;
    this.permission_review = null;
    this.observation.pending_stop = false;
    this.state = "idle";
    this.compacting = false;
    this.compacting_since = 0;
    this.activity = new Text();
    this.tool = new Text();
    this.tool_active = false;
    if (recorded) this.changed_at = now;
    return recorded && outcome === "completed";
  }
  awaitSubagents(now: number) {
    this.permission_review = null;
    this.observation.pending_stop = false;
    this.subagents.waiting = true;
    this.state = "working";
    this.clearWork(now);
  }
  clearWork(now: number) {
    this.compacting = false;
    this.compacting_since = 0;
    this.activity = new Text();
    this.tool = new Text();
    this.tool_active = false;
    this.changed_at = now;
  }
  abandonTurn(now: number) {
    this.permission_review = null;
    this.subagents.waiting = false;
    this.paused = false;
    this.state = "idle";
    this.clearWork(now);
  }
  reopened(now: number) {
    this.permission_review = null;
    this.observation.pending_stop = false;
    this.paused = false;
    this.state = "idle";
    this.compacting = false;
    this.compacting_since = 0;
    this.tool = new Text();
    this.tool_active = false;
    this.changed_at = now;
    if (this.last_seq > 0n && this.last_seq < now) this.last_seq = BigInt(now);
  }
  confirmStop(seq: bigint, outcome: observation.Outcome, now: number) {
    return this.observation.pending_stop && this.last_seq === seq
      ? this.endTurn(this.turnId(), outcome, "transcript", now)
      : false;
  }
  observeHook(provider: Provider, hook: any, seq: bigint, watched: boolean, now: number): boolean | null {
    if (seq <= this.last_seq) return null;
    const event = hook.kind,
      session = hook.session,
      start = event === "session_start",
      reported = hook.turn;
    if ((this.session.len && session && session !== this.sessionId()) || (this.provider && this.provider !== provider))
      return null;
    if (
      ["stop", "interrupt"].includes(event) &&
      (this.finishedTurn(reported) || (reported && this.turn.len && reported !== this.turnId()))
    )
      return null;
    if (path.isAbsolute(hook.transcript)) this.transcript = new Path(hook.transcript);
    this.paused = false;
    if (start && this.state !== "unknown" && this.state !== "done") return false;
    const next: State = (
      {
        session_start: "idle",
        stop: "idle",
        interrupt: "idle",
        tool_start: hook.asking ? "blocked" : "working",
        prompt: "working",
        tool_finish: "working",
        tool_failure: "working",
        compact_start: "working",
        compact_end: "working",
        permission: provider === "codex" ? "working" : "blocked",
        notification: "blocked",
        session_end: "done",
      } as Record<string, State>
    )[event];
    if (start || next === "working" || next === "blocked") this.finished_since_activity = false;
    if (hook.turn && Buffer.byteLength(hook.turn) <= 160) this.setTurn(hook.turn);
    this.last_seq = seq;
    this.permission_review = event === "permission" && provider === "codex" ? 0 : null;
    this.provider = provider;
    if (session && Buffer.byteLength(session) <= 160) this.session = new Text(session);
    const old = this.state;
    this.observation.source = "hook";
    this.observation.pending_stop = event === "stop";
    this.state = this.observation.pending_stop ? "working" : next;
    this.changed_at = now;
    this.compacting = event === "compact_start";
    if (start) {
      this.cwd = new Path();
      worktrees.clearWrites(this);
    }
    if (path.isAbsolute(hook.cwd)) this.cwd = new Path(hook.cwd);
    if (event === "tool_finish" && hook.writes) worktrees.recordWrites(this, hook.writes);
    if (event === "tool_start" || event === "permission") {
      this.tool_active = true;
      if (hook.tool) this.tool = Text.ascii(hook.tool);
    } else if (hook.permission_notification) this.tool_active = true;
    else if (event === "tool_finish" || event === "tool_failure") {
      if (!hook.tool || hook.tool === this.toolLabel()) {
        this.tool = new Text();
        this.tool_active = false;
      }
    } else if (next !== "blocked") {
      this.tool = new Text();
      this.tool_active = false;
    }
    if (event === "tool_finish" || event === "tool_failure")
      this.recent = new Text(`${event === "tool_failure" ? "failed" : "used"}: ${hook.tool}`.slice(0, 160));
    if (start || ["prompt", "interrupt", "session_end"].includes(event)) this.activity = new Text();
    if (Provider.info(provider).prompt_turns) {
      if (hook.prompt && Buffer.byteLength(hook.prompt) <= 160 && hook.prompt !== this.turnId()) {
        this.setTurn(hook.prompt);
        this.activity_inferred = false;
      }
      if (start || event === "prompt") this.activity_inferred = false;
      this.activity_at = now;
      if (event === "tool_start" && !hook.asking && !this.activity_inferred)
        this.setActivity(toolActivity(hook.tool, hook.description, hook.target));
    }
    if (start || next === "working") this.attention = this.observation.unread() ? "finished" : "none";
    if (this.observation.pending_stop) return false;
    if (event === "interrupt" && (old === "working" || old === "blocked"))
      return this.endTurn(this.turnId(), "interrupted", "hook", now);
    if (old === next) return false;
    if (next === "blocked") {
      if (!watched) this.attention = "needs_input";
      return true;
    }
    return false;
  }
  observePermissionPrompt(visible: boolean, watched: boolean, now: number) {
    if (this.permission_review === null) return false;
    if (!visible) {
      this.permission_review = 0;
      if (this.state === "blocked") {
        this.state = "working";
        this.attention = this.observation.unread() ? "finished" : "none";
        this.changed_at = now;
      }
      return false;
    }
    this.permission_review = Math.min(255, this.permission_review + 1);
    if (this.permission_review < 2 || this.state === "blocked") return false;
    this.state = "blocked";
    this.changed_at = now;
    if (!watched) this.attention = "needs_input";
    return true;
  }
  observeAnswer(next: State, now: number) {
    if (this.state !== "blocked") return;
    if (next === "working") {
      this.state = "working";
      this.changed_at = now;
    } else this.abandonTurn(now);
    this.attention = this.observation.unread() ? "finished" : "none";
  }
}
export function firstLine(v: string) {
  const line = v.split("\n", 1)[0].replace(/^[ \t\r]+|[ \t\r]+$/g, "");
  return new Text(line.replace(/[\x00-\x1f\x7f]/g, " "));
}
export function toolActivity(tool: string, description: string, target: string) {
  if (description.trim()) return description;
  if (tool === "Bash") return "";
  const verbs: Record<string, string> = {
    Read: "Reading",
    Edit: "Editing",
    MultiEdit: "Editing",
    NotebookEdit: "Editing",
    Write: "Writing",
    Grep: "Searching for",
    Glob: "Finding",
    WebFetch: "Fetching",
    WebSearch: "Searching the web for",
    Skill: "Using skill",
    TodoWrite: "Updating todos",
  };
  const verb = verbs[tool] ?? tool.split("__").at(-1) ?? tool;
  let subject = target;
  if (["Read", "Edit", "MultiEdit", "NotebookEdit", "Write"].includes(tool)) subject = path.basename(target);
  if (tool === "WebFetch") subject = target.replace(/^.*?:\/\//, "").split("/")[0];
  if (tool === "TodoWrite") subject = "";
  return (subject ? `${verb} ${subject}` : verb).slice(0, 160);
}

export function clean(input: string, capacity = Buffer.byteLength(input)) {
  return ascii(input, capacity);
}
