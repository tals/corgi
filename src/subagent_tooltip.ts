//! The agent card a sidebar row opens on hover, and the usage overview the
//! status bar opens. Mirrors subagent_tooltip.zig.
import { microTimestamp, milliTimestamp } from "./clock";
import { Provider } from "./providers";
import { View as UsageView, Tokens } from "./usage/live";
import { View as ContextView } from "./usage/context_window";
import * as prices from "./usage/prices";
import { Window, expired } from "./usage/account";
import * as limit_history from "./usage/limits";
import { Group as BackgroundGroup, type Group as BackgroundGroupName } from "./activity/background_tasks";
import { max_actors as max } from "./conversations";
import { stamp_bucket } from "./protocol";
import { type Option, option } from "./agent_launcher";
import * as palette from "./palette";
import { type Agent, agent as agentValue, providerName } from "./mirror";
import { type Entry, type Subagents, contextColor } from "./sidebar";
import { Writer, byteSlice, directoryLabel, displayWidth, writeEllipsis, sat } from "./text";

let base: string;
palette.derived(() => {
  base = new palette.Style({ fg: "text", bg: "bg" }).sgr();
});
/** How long an observation counts as current: 10 s, plus up to one bucket
 * by which the snapshot rounds its stamps down. */
export const fresh_window = 10_000_000 + stamp_bucket;
const u64_max = (1n << 64n) - 1n;
const satAdd = (a: bigint, b: bigint) => (a + b > u64_max ? u64_max : a + b);
const satSub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
const satMul = (a: bigint, b: bigint) => (a * b > u64_max ? u64_max : a * b);

/** Every write starts from `base`, so a tone sets only the foreground and bold. */
export type Tone =
  | "text"
  /** Titles, headings, and the figure a column ranks by. */
  | "title"
  /** The current step's label, and the token figures of single steps. */
  | "strong"
  | "muted"
  /** Column labels, footers and secondary figures. */
  | "faint"
  | "border"
  /** The stipple over a spark's time still ahead in a window. */
  | "remaining"
  /** Live: usage that is fine, the current step. */
  | "live"
  /** A working agent's arrow, an unread agent's dot. */
  | "working"
  /** Needs the user: an agent waiting for input, usage past 80%. */
  | "warm"
  /** Usage at its limit. */
  | "hot"
  /** Spark cells past 80% and at the limit: those colors without bold. */
  | "warm_cell"
  | "hot_cell";
export const Tone = {
  ansi(tone: Tone): string {
    switch (tone) {
      case "text":
        return palette.fg("text");
      case "title":
        return "\x1b[1m" + palette.fg("strong");
      case "strong":
        return palette.fg("strong");
      case "muted":
        return palette.fg("muted");
      case "faint":
        return palette.fg("faint");
      case "border":
        return palette.fg("line");
      case "remaining":
        return palette.fg("line");
      case "live":
        return palette.fg("accent");
      case "working":
        return "\x1b[1m" + palette.fg("accent");
      case "warm":
        return "\x1b[1m" + palette.fg("warm");
      case "hot":
        return "\x1b[1m" + palette.fg("hot");
      case "warm_cell":
        return palette.fg("warm");
      case "hot_cell":
        return palette.fg("hot");
    }
  },
  token(tone: Tone): palette.Token {
    switch (tone) {
      case "text":
        return "text";
      case "title":
      case "strong":
        return "strong";
      case "muted":
        return "muted";
      case "faint":
        return "faint";
      case "border":
      case "remaining":
        return "line";
      case "live":
      case "working":
        return "accent";
      case "warm":
      case "warm_cell":
        return "warm";
      case "hot":
      case "hot_cell":
        return "hot";
    }
  },
  /** The tone 45% of the way to the card's background, without bold. */
  faded(tone: Tone): string {
    return palette.fgRgb(palette.mix(palette.colors[Tone.token(tone)], palette.colors.bg, 45));
  },
};

/** protocol.zig's `Conversation.ActivityPoint`. */
export interface ActivityPoint {
  at: number;
  activity: string;
  usage: UsageView;
}
/** background_tasks.zig's `View`. */
export interface BackgroundView {
  items: { id: string; label: string; group: BackgroundGroupName }[];
  observed_at: number;
  live: boolean;
  truncated: boolean;
}
/** protocol.zig's `Conversation`, as the snapshot sends it. */
export interface Conversation {
  background_tasks: BackgroundView;
  id: number;
  timeline: { points: ActivityPoint[]; pending: UsageView };
  /** The first-party model id; Bedrock and Vertex spellings are resolved. */
  model: string;
  /** Its display name, such as "Opus 5.5"; empty for an unknown shape. */
  model_name: string;
  parent: number | null;
  workspace: number;
  observed_at: number;
  attachments: number;
  role: string;
  usage: UsageView;
  context: ContextView;
  children_observed_at: number;
  agent: Agent;
}
/** The model's name, or its id from a daemon that sends no name. */
export function modelLabel(c: Conversation): string {
  return c.model_name.length > 0 ? c.model_name : c.model;
}
const big = (value: unknown): bigint => (typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value ?? 0))));
export function usageView(value: any = {}): UsageView {
  return new UsageView({
    tokens: new Tokens({
      input: big(value?.tokens?.input),
      cached_input: big(value?.tokens?.cached_input),
      output: big(value?.tokens?.output),
    }),
    known: value?.known === true,
    partial: value?.partial === true,
    losses: Number(value?.losses ?? 0),
    since: Number(value?.since ?? 0),
    updated_at: Number(value?.updated_at ?? 0),
    recent_tokens: big(value?.recent_tokens),
  });
}
export function conversation(value: any = {}): Conversation {
  const tasks = value.background_tasks ?? {};
  const context = value.context ?? {};
  return {
    background_tasks: {
      items: (tasks.items ?? []).map((item: any) => ({
        id: item.id ?? "",
        label: item.label ?? "",
        group: item.group ?? "commands",
      })),
      observed_at: Number(tasks.observed_at ?? 0),
      live: tasks.live === true,
      truncated: tasks.truncated === true,
    },
    id: Number(value.id ?? 0),
    timeline: {
      points: (value.timeline?.points ?? []).map((point: any) => ({
        at: Number(point.at ?? 0),
        activity: point.activity ?? "",
        usage: usageView(point.usage),
      })),
      pending: usageView(value.timeline?.pending),
    },
    model: value.model ?? "",
    model_name: value.model_name ?? "",
    parent: value.parent == null ? null : Number(value.parent),
    workspace: Number(value.workspace ?? 0),
    observed_at: Number(value.observed_at ?? 0),
    attachments: Number(value.attachments ?? 0),
    role: value.role ?? "",
    usage: usageView(value.usage),
    context: new ContextView({
      used: big(context.used),
      window: big(context.window),
      compacts_at: big(context.compacts_at),
      at: Number(context.at ?? 0),
    }),
    children_observed_at: Number(value.children_observed_at ?? 0),
    agent: agentValue(value.agent),
  };
}

function find(all: readonly Conversation[], id: number): Conversation | null {
  for (const item of all) if (item.id === id) return item;
  return null;
}
export function descendant(all: readonly Conversation[], item: Conversation, parent: number): boolean {
  if (parent === 0 || item.id === parent) return false;
  let current = item.parent;
  for (let i = 0; i < Math.min(max, all.length); i++) {
    if (current === null) return false;
    if (current === parent) return true;
    const next = find(all, current);
    if (!next) return false;
    current = next.parent;
  }
  return false;
}
function visibleChild(all: readonly Conversation[], item: Conversation, parent: number): boolean {
  return item.agent.state !== "idle" && descendant(all, item, parent);
}
export function childCount(all: readonly Conversation[], parent: number): number {
  let count = 0;
  for (const item of all) if (visibleChild(all, item, parent)) count += 1;
  return count;
}
export function childrenAvailable(all: readonly Conversation[], parent: number, now: number): boolean {
  const root = find(all, parent);
  if (!root) return false;
  // A list that holds until the next one does not age.
  const lasting = root.agent.provider !== null ? Provider.info(root.agent.provider).children_at_stop : false;
  const age = now - root.children_observed_at;
  if (root.children_observed_at <= 0 || (!lasting && (age < 0 || age > fresh_window))) return false;
  // Omit the whole section when child status cannot be presented reliably.
  for (const child of all) {
    if (!descendant(all, child, parent)) continue;
    const child_age = now - child.observed_at;
    if (
      child.agent.state === "unknown" ||
      child.observed_at <= 0 ||
      (!lasting && (child_age < 0 || child_age > fresh_window))
    )
      return false;
  }
  return true;
}
const noSubagents = (): Subagents => ({ running: 0, blocked: 0, waiting: false });
export function presentChildren(entry: Entry, all: readonly Conversation[], now: number): void {
  entry.children = 0;
  if (childrenAvailable(all, entry.conversation, now)) {
    entry.children = childCount(all, entry.conversation);
  } else entry.subagents = noSubagents();
}
function groupName(child: Conversation): string {
  if (child.role.length > 0) return child.role;
  if (child.agent.activity.length > 0) return child.agent.activity;
  return "Agents";
}
function add(total: UsageView, next: UsageView) {
  total.tokens.add(next.tokens);
  total.recent_tokens = satAdd(total.recent_tokens, next.recent_tokens);
  total.known = total.known || next.known;
  total.partial = total.partial || next.partial || !next.known;
}
const asciiLower = (value: string) => value.replace(/[A-Z]/g, c => c.toLowerCase());
const childName = (child: Conversation) =>
  child.agent.name.length > 0 ? child.agent.name : byteSlice(child.agent.session, 8);
function byName(lhs: Conversation, rhs: Conversation) {
  const a = asciiLower(childName(lhs)),
    b = asciiLower(childName(rhs));
  return a < b ? -1 : a > b ? 1 : lhs.id - rhs.id;
}
/** How long an agent has been working, to the minute. */
export function runningFor(agent: Agent, now: number): string {
  if (agent.working_since <= 0) return "";
  const minutes = Math.floor(Math.max(0, now - agent.working_since) / 60_000_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
export class Model {
  groups: { name: string; count: number; usage: UsageView }[] = [];
  children = 0;
  total = new UsageView();
  get group_count(): number {
    return this.groups.length;
  }
  static init(all: readonly Conversation[], parent: number): Model {
    const m = new Model();
    const root = find(all, parent);
    if (root) add(m.total, root.usage);
    for (const child of all) {
      if (!descendant(all, child, parent)) continue;
      add(m.total, child.usage);
      if (!visibleChild(all, child, parent)) continue;
      const name = groupName(child);
      let index = m.groups.findIndex(group => asciiLower(group.name) === asciiLower(name));
      if (index < 0) {
        if (m.groups.length === max) break;
        index = m.groups.length;
        m.groups.push({ name, count: 0, usage: new UsageView() });
      }
      m.groups[index].count += 1;
      add(m.groups[index].usage, child.usage);
      m.children += 1;
    }
    return m;
  }
}
export function compact(value: bigint | number): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 1000n) return v.toString();
  const suffixes = "kMBTPE";
  let scale = 1000n;
  let index = 0;
  while (true) {
    // Integer rounding avoids overflow and promotes 999.95k to 1M.
    const tenths = (v * 10n + scale / 2n) / scale;
    if (tenths >= 10_000n && index + 1 < suffixes.length) {
      scale *= 1000n;
      index += 1;
      continue;
    }
    return tenths % 10n === 0n
      ? `${tenths / 10n}${suffixes[index]}`
      : `${tenths / 10n}.${tenths % 10n}${suffixes[index]}`;
  }
}
export function tokenText(value: UsageView): string {
  if (!value.known) return "— tokens";
  return `${value.partial ? "≥" : ""}${compact(value.tokens.total())} tokens`;
}
function activity(agent: Agent): string {
  if (agent.compacting) return "Compacting";
  if (agent.state === "working" && agent.subagents.waiting) return "Waiting on subagents";
  if (agent.activity.length > 0) return agent.activity;
  if (agent.recent_activity.length > 0) return agent.recent_activity;
  if (agent.tool_active && agent.state === "working") return "Running a tool";
  switch (agent.state) {
    case "working":
      return "Working";
    case "blocked":
      return "Needs input";
    case "idle":
      return "Idle";
    case "done":
      return "Session ended";
    case "initializing":
      return "Starting session";
    default:
      return "Waiting for activity";
  }
}
/** Working with nothing reported yet: animated dots advance with the sidebar
 * spinner's redraws. */
function thinking(): string {
  const dots = Math.floor(milliTimestamp() / 400) % 3;
  return "...".slice(0, dots + 1);
}
export interface Status {
  icon: string;
  label: string;
  tone: Tone;
}
export function status(agent: Agent, stale: boolean): Status {
  if (stale) return { icon: "?", label: "Last seen", tone: "muted" };
  if (agent.state === "blocked" || agent.attention === "needs_input")
    return { icon: "●", label: "Needs input", tone: "warm" };
  const unread = agent.attention === "finished" && agent.state !== "working" && agent.state !== "done";
  // Waiting on its background shells or a wakeup, as the sidebar shows it.
  if (agent.state === "idle" && agent.paused)
    return unread ? { icon: "‖", label: "Finished", tone: "working" } : { icon: "‖", label: "Idle", tone: "muted" };
  // Finished and not yet seen, as the sidebar shows it.
  if (unread) return { icon: "●", label: "Finished", tone: "working" };
  switch (agent.state) {
    case "working":
      return { icon: "▶", label: "Working", tone: "working" };
    case "idle":
      return { icon: "○", label: "Idle", tone: "muted" };
    case "done":
      return { icon: "○", label: "Ended", tone: "faint" };
    case "initializing":
      return { icon: "◌", label: "Starting", tone: "muted" };
    default:
      return { icon: "?", label: "Unknown", tone: "muted" };
  }
}
const pad2 = (n: number) => String(n).padStart(2, "0");
export class Card {
  /** Text recedes toward the background: timeline rows older than the
   * latest five. */
  faded = false;
  constructor(
    public w: Writer,
    public x: number,
    public width: number,
  ) {}
  ink(tone: Tone): string {
    return this.faded ? Tone.faded(tone) : Tone.ansi(tone);
  }
  backgroundTasks(row: number, tasks: BackgroundView, budget: number): number {
    if (budget < 2 || tasks.items.length === 0) return 0;
    const age = microTimestamp() - tasks.observed_at;
    const live = tasks.live && age >= 0 && age <= fresh_window;
    this.line(row, "Background commands", live ? "Running" : "Last reported", "title", "muted");
    const shown = Math.min(tasks.items.length, budget - 1 - Number(tasks.items.length + 1 > budget || tasks.truncated));
    let offset = 1;
    for (const group of ["tests", "builds", "servers", "commands"] as const) {
      for (const task of tasks.items) {
        if (task.group !== group || offset > shown) continue;
        this.line(row + offset, `${BackgroundGroup.label(group)} · ${task.label}`, "", "text", "muted");
        offset += 1;
      }
    }
    if (shown < tasks.items.length || tasks.truncated) {
      this.line(
        row + offset,
        `+${tasks.items.length - shown}${tasks.truncated ? "+" : ""} more commands`,
        "",
        "faint",
        "faint",
      );
      offset += 1;
    }
    return offset;
  }
  line(row: number, left: string, right: string, left_tone: Tone, right_tone: Tone) {
    const right_width = displayWidth(right);
    const left_room = sat(this.width - 6, right_width + (right_width > 0 ? 2 : 0));
    this.w.write(`\x1b[${row + 1};${this.x + 4}H${base}${this.ink(left_tone)}`);
    writeEllipsis(this.w, left.length === 0 ? "" : directoryLabel(left, null, 512), left_room);
    this.w.write(`\x1b[${row + 1};${this.x + this.width - 2 - right_width}H${base}${this.ink(right_tone)}${right}`);
  }
  cell(row: number, offset: number, width: number, text: string, tone: Tone, right: boolean) {
    const label = directoryLabel(text, null, 512);
    const padding = right ? sat(width, displayWidth(label)) : 0;
    this.w.write(`\x1b[${row + 1};${this.x + 4 + offset + padding}H${base}${this.ink(tone)}`);
    writeEllipsis(this.w, label, width - padding);
  }
  /** The context meter takes at most half the subtitle line: narrow cards
   * shorten its bar, and the narrowest drop it. */
  meterBar(): number {
    const bar = Math.min(16, sat(Math.floor((this.width - 6) / 2), 13));
    return bar < 6 ? 0 : bar;
  }
  meterWidth(context: ContextView): number {
    const figure = `${context.percent() < 999n ? context.percent() : 999n}%`;
    const bar = this.meterBar();
    return "context ".length + bar + Number(bar > 0) + figure.length;
  }
  /** "context ━━━━━━──── 74%" at the right of a row: the share of the window,
   * in the sidebar figure's colors, with a tick at a learned compaction point.
   * A filling window's figure is bold. */
  meter(row: number, context: ContextView, compacting: boolean) {
    const band = context.band();
    if (band === null) return;
    const color = contextColor(band, compacting, palette.colors.bg);
    this.w.write(
      `\x1b[${row + 1};${this.x + this.width - 2 - this.meterWidth(context)}H${base}${Tone.ansi("faint")}context `,
    );
    const bar = this.meterBar();
    if (bar > 0) {
      const wide = BigInt(bar);
      const fill = satAdd(satMul(context.used, wide), context.window / 2n) / context.window;
      const filled = Math.max(1, Math.min(bar, Number(fill > wide ? wide : fill)));
      const tick =
        context.compacts_at > 0n && context.compacts_at < context.window
          ? Number((context.compacts_at * wide) / context.window)
          : null;
      for (let i = 0; i < bar; i++) {
        if (i < filled) {
          palette.writeFg(this.w, color);
          this.w.write("━");
        } else if (tick === i) {
          this.w.write(`${Tone.ansi("muted")}┼`);
        } else this.w.write(`${Tone.ansi("border")}─`);
      }
      this.w.write(" ");
    }
    if (band !== "calm") this.w.write("\x1b[1m");
    palette.writeFg(this.w, color);
    this.w.write(`${context.percent() < 999n ? context.percent() : 999n}%`);
  }
  static number_width = 8;
  /** Phone-narrow cards pack their columns. */
  tight(): boolean {
    return this.width < 70;
  }
  numbers(): number {
    return this.tight() ? 6 : Card.number_width;
  }
  textWidth(): number {
    return this.width - 6 - 2 * (this.numbers() + 1);
  }
  /** Tokens are uncached input plus output; cached input is its own column.
   * Null draws the column headings. Overview rows and the timeline share it. */
  tokenColumns(row: number, value: UsageView | null, live: boolean, tone: Tone) {
    const text_width = this.textWidth();
    const suffix = live ? "+" : "";
    const tokens =
      value !== null
        ? value.known
          ? `${value.partial ? "≥" : ""}${compact(satAdd(satSub(value.tokens.input, value.tokens.cached_input), value.tokens.output))}${suffix}`
          : "—"
        : "Tokens";
    const cached = value !== null ? (value.known ? `${compact(value.tokens.cached_input)}${suffix}` : "—") : "Cached";
    this.cell(row, text_width + 1, this.numbers(), tokens, tone, true);
    this.cell(row, text_width + this.numbers() + 2, this.numbers(), cached, "faint", true);
  }
  childRow(row: number, child: Conversation, now = microTimestamp()) {
    const text_width = this.textWidth();
    const prefix_width = this.tight() ? 9 : 11;
    const available = sat(text_width, prefix_width);
    const label = activity(child.agent);
    const name = childName(child);
    // Activity gets the space first; names use only the remainder, capped
    // so a long identity never displaces the description of the work.
    const fitted = Math.min(18, sat(available, displayWidth(label) + 1));
    // A narrow card drops a name it would have to cut.
    const name_width = this.tight() && fitted < displayWidth(name) ? 0 : fitted;
    const label_width = sat(available, name_width > 0 ? name_width + 1 : 0);
    let marker: Status;
    if (child.agent.attention === "needs_input" || child.agent.state === "blocked")
      marker = { icon: "●", label: "Needs input", tone: "warm" };
    else
      switch (child.agent.state) {
        case "working":
          marker = { icon: "▶", label: "Working", tone: "working" };
          break;
        case "done":
          marker = { icon: "✓", label: "Done", tone: "muted" };
          break;
        case "idle":
          marker = { icon: "○", label: "Idle", tone: "muted" };
          break;
        default:
          marker = status(child.agent, false);
      }
    this.cell(row, 0, prefix_width - 2, `${" ".repeat(prefix_width - 4)}↳`, "faint", false);
    // How long it has worked sits in the timeline's time column.
    const running = this.tight() ? "" : runningFor(child.agent, now);
    if (running) this.cell(row, 0, 5, running, "faint", true);
    this.cell(row, prefix_width - 2, 1, marker.icon, marker.tone, false);
    this.cell(row, prefix_width, label_width, label, "text", false);
    if (name_width > 0) this.cell(row, text_width - name_width, name_width, name, "faint", true);
    this.tokenColumns(row, child.usage, child.agent.state === "working", child.usage.known ? "strong" : "muted");
  }
  /** Token columns plus a trailing column in reference-model tokens, which
   * the table ranks by. Null draws the column headings. */
  overviewRow(row: number, name: string, model: string, value: UsageView | null, equivalent: string, tone: Tone) {
    const nw = this.numbers();
    const columns = new Card(this.w, this.x, this.width - (nw + 1));
    const text_width = columns.textWidth();
    // Model ids are short; the extra column comes out of their share.
    const model_width = Math.min(Math.floor(text_width / 2), 22);
    const name_width = text_width - model_width - 1;
    const heading = value === null;
    this.cell(row, 0, name_width, name, tone, false);
    this.cell(row, name_width + 1, model_width, model, heading ? "faint" : "muted", false);
    columns.tokenColumns(row, value, false, heading ? "faint" : "text");
    this.cell(row, text_width + 2 * nw + 3, nw, equivalent, heading ? "faint" : "title", true);
  }
  /** One timeline step: the live one has a sage time and a bright label,
   * and past ones recede. */
  drawPoint(row: number, stamp: string, label: string, value: UsageView, live: boolean, dot: Tone) {
    const icon = live ? "●" : "○";
    const gap = this.tight() ? " " : "  ";
    this.cell(row, 0, this.textWidth(), `${stamp}${gap}${icon}${gap}${label}`, live ? "strong" : "muted", false);
    this.tokenColumns(row, value, live, !value.known ? "muted" : live ? "title" : "strong");
    const time: Tone = live ? "live" : "faint";
    this.w.write(
      `\x1b[${row + 1};${this.x + 4}H${base}${this.ink(time)}${stamp}\x1b[${row + 1};${this.x + (this.tight() ? 10 : 11)}H${base}${this.ink(dot)}${icon}`,
    );
  }
  timeline(row: number, root: Conversation, agent: Agent, nodes: number, pending: boolean) {
    // A working agent without a summary has no current named phase. Keep
    // the previous interval in history until a fresh summary arrives.
    const unreported = agent.state === "working" && agent.activity.length === 0 && !agent.compacting;
    const history_nodes = nodes - Number(unreported);
    const show_pending = pending && history_nodes > 0;
    const divider_width = this.width - 6;
    const label = " Recent ";
    this.cell(row, 0, divider_width, "─".repeat(Math.min(88, divider_width)), "border", false);
    this.cell(row, Math.floor((divider_width - label.length) / 2), label.length, label, "muted", false);
    const completed = history_nodes - Number(show_pending);
    const history_end = root.timeline.points.length - Number(pending);
    // The latest five rows, the current one included, keep their colors.
    const older = new Card(this.w, this.x, this.width);
    older.faded = true;
    root.timeline.points.slice(history_end - completed, history_end).forEach((point, i) => {
      const local = new Date(Math.floor(point.at / 1000) * 1000);
      const time = Number.isNaN(local.getTime()) ? "--:--" : `${pad2(local.getHours())}:${pad2(local.getMinutes())}`;
      (i + 5 < nodes ? older : this).drawPoint(row + 1 + i, time, point.activity, point.usage, false, "faint");
    });
    if (show_pending) {
      const active = agent.state === "working" && !unreported;
      const blocked = agent.state === "blocked";
      const latest = root.timeline.points[root.timeline.points.length - 1];
      this.drawPoint(
        row + 1 + completed,
        active || blocked ? "  now" : " last",
        latest.activity,
        root.timeline.pending,
        active,
        active ? "working" : blocked ? "warm" : "faint",
      );
    }
    if (unreported) {
      const current = agent.compacting ? "Compacting…" : agent.subagents.waiting ? "Waiting on subagents" : thinking();
      this.drawPoint(row + nodes, "  now", current, new UsageView(), true, "working");
    }
  }
}
/** The title row: "Observed tokens", and "2.4M tokens (+38M cached)" at the
 * right in muted words with its figures drawn over them. */
function overviewTotal(card: Card, row: number, value: UsageView) {
  if (!value.known) return card.line(row, "Observed tokens", "— tokens", "title", "muted");
  const tokens = `${value.partial ? "≥" : ""}${compact(satAdd(satSub(value.tokens.input, value.tokens.cached_input), value.tokens.output))}`;
  const cached = compact(value.tokens.cached_input);
  const total = `${tokens} tokens (+${cached} cached)`;
  card.line(row, "Observed tokens", total, "title", "muted");
  const start = card.x + card.width - 2 - displayWidth(total);
  card.w.write(`\x1b[${row + 1};${start}H${base}${Tone.ansi("title")}${tokens}`);
  card.w.write(
    `\x1b[${row + 1};${start + displayWidth(tokens) + " tokens (+".length}H${base}${Tone.ansi("text")}${cached}`,
  );
}
function runningSomewhere(all: readonly Conversation[], item: Conversation, now: number): boolean {
  if (item.agent.state === "done") return false;
  if (item.attachments > 0) return true;
  if (item.agent.state !== "working" && item.agent.state !== "blocked" && item.agent.state !== "initializing")
    return false;
  const age = now - item.observed_at;
  if (item.observed_at <= 0 || age < 0 || age > fresh_window) return false;
  let parent = item.parent;
  for (let i = 0; i < Math.min(max, all.length); i++) {
    if (parent === null) return false;
    const ancestor = find(all, parent);
    if (!ancestor) return false;
    if (ancestor.attachments > 0 && ancestor.agent.state !== "done") return true;
    parent = ancestor.parent;
  }
  return false;
}
/** The runtime's release and any newer one downloaded for the next launch. */
export interface Release {
  running?: string;
  commit?: string;
  staged?: string;
}
/** Account limits for the pane beside Top agents, from the launcher preview. */
export class Accounts {
  options: { codex: Option; claude: Option } = { codex: option(), claude: option() };
  /** The provider the activity summarizer runs on. */
  system: Provider | null = null;
  /** Unix seconds; zero reads the clock. */
  now = 0;
  /** The card only grows to hold the pane in terminals this wide. */
  static min_cols = 124;
  constructor(fields: Partial<Accounts> = {}) {
    Object.assign(this, fields);
  }
  any(): boolean {
    for (const provider of Provider.all) {
      const limits = this.options[provider].limits;
      if (limits === "metered" || typeof limits === "object") return true;
    }
    return false;
  }
}
interface Ranked {
  conversation: Conversation | null;
  value: UsageView;
  /** The id prices are found by, and the name the column shows. */
  model: string;
  model_name: string;
  // Uncached input plus output in reference-model tokens; raw for unknown models.
  equivalent: bigint;
}
/** The first `shown` rows, keeping Corgi's own row in place of the last
 * visible agent if needed. */
function visible(ranked: readonly Ranked[], shown: number): Ranked[] {
  const out = ranked.slice(0, shown);
  const system_index = ranked.findIndex(item => item.conversation === null);
  if (system_index >= shown) out[shown - 1] = ranked[system_index];
  return out;
}
function overviewBox(w: Writer, x: number, y: number, width: number, height: number) {
  for (let row = 0; row < height; row++) {
    w.write(`\x1b[${y + row + 1};${x + 1}H${base}${Tone.ansi("border")}`);
    w.write(row === 0 ? "╭" : row === height - 1 ? "╰" : "│");
    w.write((row === 0 || row === height - 1 ? "─" : " ").repeat(width - 2));
    w.write(row === 0 ? "╮" : row === height - 1 ? "╯" : "│");
  }
}
function overviewAgent(
  card: Card,
  row: number,
  ranked_row: Ranked,
  reference: prices.Price | null,
  system_working: boolean,
) {
  const model =
    ranked_row.model_name.length > 0 ? ranked_row.model_name : ranked_row.model.length === 0 ? "—" : ranked_row.model;
  const equivalent =
    reference === null
      ? ""
      : !ranked_row.value.known
        ? "—"
        : prices.lookup(ranked_row.model) === null
          ? "?"
          : `${ranked_row.value.partial ? "≥" : ""}${compact(ranked_row.equivalent)}`;
  // Corgi's own row keeps a muted name; only a working arrow is lit.
  const item = ranked_row.conversation;
  if (item === null) {
    card.overviewRow(
      row,
      system_working ? "▶ Corgi (Activity summarizer)" : "○ Corgi (Activity summarizer)",
      model,
      ranked_row.value,
      equivalent,
      "muted",
    );
    if (system_working) card.w.write(`\x1b[${row + 1};${card.x + 4}H${base}${Tone.ansi("working")}▶`);
    return;
  }
  const agent_status = status(item.agent, false);
  const name =
    item.agent.name.length > 0 ? item.agent.name : `${providerName(item.agent)} · ${byteSlice(item.agent.session, 8)}`;
  // Idle agents recede with their dot; finished ones wait to be seen.
  const idle = item.agent.state === "idle" && item.agent.attention === "none";
  card.overviewRow(row, `${agent_status.icon} ${name}`, model, item.usage, equivalent, idle ? "muted" : "text");
  card.w.write(`\x1b[${row + 1};${card.x + 4}H${base}${Tone.ansi(agent_status.tone)}${agent_status.icon}`);
}
function overviewFooter(card: Card, row: number, hidden: number, release: Release) {
  const more = hidden > 0 ? `... ${hidden} more agents` : "";
  const running = versionLabel(release.running ?? "", release.commit ?? "");
  const staged = versionLabel(release.staged ?? "", "");
  // Prefer the most complete version text that still leaves room for the agent count.
  const room = sat(card.width - 6, more.length > 0 ? displayWidth(more) + 2 : 0);
  const candidates =
    staged.length > 0
      ? [`↑ Update ${staged} ready · relaunch Corgi`, "↑ Update ready · relaunch Corgi", "↑ Update ready"]
      : [running.length > 0 ? `Corgi ${running}` : "", running, ""];
  const version_line = candidates.find(candidate => displayWidth(candidate) <= room) ?? "";
  card.line(row, more, version_line, "faint", staged.length > 0 ? "title" : "faint");
}
/** "20260925T183012Z-be82c7b9090a" reads as "2026-09-25 · be82c7b". A known
 * commit replaces the version's hash, so development builds show theirs too. */
export function versionLabel(ver: string, commit: string): string {
  const release = ver.length >= 24 && ver[8] === "T" && ver[16] === "-";
  const dirty = commit.endsWith("-dirty");
  const hex = commit.length >= 7 && /^[0-9a-fA-F]{7}/.test(commit);
  const short = hex ? commit.slice(0, 7) : release ? ver.slice(17, 24) : "";
  const suffix = hex && dirty ? "-dirty" : "";
  if (release) return `${ver.slice(0, 4)}-${ver.slice(4, 6)}-${ver.slice(6, 8)} · ${short}${suffix}`;
  if (short.length > 0) return `${ver} · ${short}${suffix}`;
  return ver;
}
export function drawOverview(
  w: Writer,
  all: readonly Conversation[],
  system_usage: UsageView,
  system_working: boolean,
  system_model: string,
  system_model_name: string,
  release: Release,
  accounts: Accounts,
  cols: number,
  rows: number,
): void {
  if (cols < 40 || rows < 13) return;
  const total = cloneUsage(system_usage);
  let ranked: Ranked[] = [
    { conversation: null, value: system_usage, model: system_model, model_name: system_model_name, equivalent: 0n },
  ];
  const now = microTimestamp();
  // Rows use exclusive own usage. Parents never include their children here.
  for (const item of all) {
    add(total, item.usage);
    if (!runningSomewhere(all, item, now)) continue;
    if (ranked.length < max + 1)
      ranked.push({
        conversation: item,
        value: item.usage,
        model: item.model,
        model_name: item.model_name,
        equivalent: 0n,
      });
  }
  // Rank by spend: express every row in tokens of the priciest listed model.
  let reference: prices.Price | null = null;
  for (const row of ranked) {
    const price = prices.lookup(row.model);
    if (price === null) continue;
    if (
      reference === null ||
      price.input > reference.input ||
      (price.input === reference.input && price.output > reference.output)
    )
      reference = price;
  }
  for (const row of ranked) {
    const uncached = satSub(row.value.tokens.input, row.value.tokens.cached_input);
    const price = prices.lookup(row.model);
    row.equivalent =
      reference !== null && price !== null
        ? prices.equivalent(price, reference, uncached, row.value.tokens.output)
        : satAdd(uncached, row.value.tokens.output);
  }
  const id = (row: Ranked) => (row.conversation !== null ? row.conversation.id : 0);
  ranked = ranked.sort((lhs, rhs) =>
    lhs.equivalent === rhs.equivalent ? id(lhs) - id(rhs) : lhs.equivalent > rhs.equivalent ? -1 : 1,
  );
  // This total is observed runtime usage, rather than full session history.
  total.partial = false;
  const shown = Math.min(Math.min(10, ranked.length), rows - 9);
  const reference_label = reference !== null ? `≈${reference.label}` : "";
  if (cols >= Accounts.min_cols && accounts.any()) {
    const overview: Overview = { total, reference, reference_label, system_working, release };
    if (drawAccounts(w, ranked, shown, overview, accounts, cols, rows)) return;
  }
  const width = Math.min(88, cols);
  const x = Math.min(1, cols - width);
  const y = 2;
  const height = 6 + shown;
  const rows_shown = visible(ranked, shown);
  w.write("\x1b7\x1b]8;;\x1b\\");
  overviewBox(w, x, y, width, height);
  const card = new Card(w, x, width);
  overviewTotal(card, y + 1, total);
  const heading = y + 3;
  card.overviewRow(heading, "Top agents", "Model", null, reference_label, "title");
  rows_shown.forEach((ranked_row, i) => overviewAgent(card, heading + 1 + i, ranked_row, reference, system_working));
  overviewFooter(card, y + height - 2, ranked.length - shown, release);
  w.write("\x1b[0m\x1b8");
}
function cloneUsage(value: UsageView): UsageView {
  return new UsageView({ ...value, tokens: new Tokens({ ...value.tokens }) });
}

/** What both overview layouts draw besides the agent rows. */
interface Overview {
  total: UsageView;
  reference: prices.Price | null;
  reference_label: string;
  system_working: boolean;
  release: Release;
}
type WindowPair = [Window | null, Window | null];
/** One account's rule and the rows under it: its agents on the left and its
 * limits in the pane on the right. */
class Section {
  rows: number[] = [];
  constructor(public provider: Provider | null) {}
  get count(): number {
    return this.rows.length;
  }
  option(accounts: Accounts): Option | null {
    return this.provider === null ? null : accounts.options[this.provider];
  }
  /** Limit windows by length, shortest first. */
  windowOrder(accounts: Accounts): [number | null, number | null] {
    const value = this.option(accounts);
    if (value === null || typeof value.limits !== "object") return [null, null];
    const limits: WindowPair = value.limits.windows;
    let order: [number | null, number | null] = [null, null];
    let n = 0;
    limits.forEach((window, i) => {
      if (window !== null) {
        order[n] = i;
        n += 1;
      }
    });
    if (n === 2 && (limits[1]!.minutes ?? 0) < (limits[0]!.minutes ?? 0)) order = [1, 0];
    return order;
  }
  paneRows(accounts: Accounts): number {
    if (this.provider === null) return 0;
    const order = this.windowOrder(accounts);
    return Math.max(1, Number(order[0] !== null) + Number(order[1] !== null));
  }
  height(accounts: Accounts): number {
    return 1 + Math.max(1, this.count, this.paneRows(accounts));
  }
  /** Limited and nearly full accounts first; metered and unread ones last. */
  urgency(accounts: Accounts, now: number): number {
    const option_value = this.option(accounts);
    if (option_value === null) return -1;
    if (expired(option_value.usage_fetched_at, now)) return 0;
    if (typeof option_value.limits !== "object") return 0;
    let most = 0;
    for (const window of option_value.limits.windows) if (window !== null) most = Math.max(most, window.used + 1);
    return most;
  }
}
/** Groups the visible rows by account. Accounts with limits keep a section
 * even with no agents running, since other clients use them too. */
function byAccount(rows_shown: readonly Ranked[], accounts: Accounts, now: number): Section[] {
  const out = [...Provider.all.map(provider => new Section(provider)), new Section(null)];
  rows_shown.forEach((row, i) => {
    const provider = row.conversation !== null ? row.conversation.agent.provider : accounts.system;
    out[provider !== null ? Provider.all.indexOf(provider) : Provider.all.length].rows.push(i);
  });
  const kept = out.filter(section => {
    const value = section.option(accounts);
    const shows = value !== null ? value.limits === "metered" || typeof value.limits === "object" : false;
    return section.count > 0 || shows;
  });
  // Array.prototype.sort is stable, as std.sort.insertion is.
  return kept.sort((lhs, rhs) => rhs.urgency(accounts, now) - lhs.urgency(accounts, now));
}
/** The overview with a limits pane: the Top agents table is unchanged on the
 * left, and each account's rule crosses both panes so its limits sit level
 * with its agents. Returns false when the rows do not fit the terminal. */
function drawAccounts(
  w: Writer,
  ranked: readonly Ranked[],
  most: number,
  overview: Overview,
  accounts: Accounts,
  cols: number,
  rows: number,
): boolean {
  const now = accounts.now !== 0 ? accounts.now : Math.floor(Date.now() / 1000);
  let shown = most;
  let rows_shown: Ranked[];
  let sections: Section[];
  let height: number;
  while (true) {
    rows_shown = visible(ranked, shown);
    sections = byAccount(rows_shown, accounts, now);
    height = 6;
    for (const section of sections) height += section.height(accounts);
    if (height + 3 <= rows) break;
    if (shown === 1) return false;
    shown -= 1;
  }
  const width = 122;
  const x = Math.min(1, cols - width);
  const y = 2;
  // The pane divider's column, and the pane's offset within the card.
  const divider = x + 87;
  const pane = 87;
  w.write("\x1b7\x1b]8;;\x1b\\");
  overviewBox(w, x, y, width, height);
  w.write(`\x1b[${y + height};${divider + 1}H${base}${Tone.ansi("border")}┴`);
  const full = new Card(w, x, width);
  const table = new Card(w, x, 88);
  overviewTotal(full, y + 1, overview.total);
  const heading = y + 3;
  table.overviewRow(heading, "Top agents", "Model", null, overview.reference_label, "title");
  full.cell(heading, pane, 6, "Limits", "title", false);
  full.cell(heading, pane + 9, 20, "↻ resets in", "faint", true);
  let row = heading + 1;
  sections.forEach((section, i) => {
    accountRule(full, row, section, accounts, divider, i === 0);
    const order = section.windowOrder(accounts);
    const body = section.height(accounts) - 1;
    for (let line = 0; line < body; line++) {
      const at = row + 1 + line;
      w.write(`\x1b[${at + 1};${divider + 1}H${base}${Tone.ansi("border")}│`);
      if (line < section.count)
        overviewAgent(table, at, rows_shown[section.rows[line]], overview.reference, overview.system_working);
      const value = section.option(accounts);
      if (value === null) continue;
      if (line < 2) {
        const index = order[line];
        if (index !== null && typeof value.limits === "object") {
          limitLine(
            full,
            at,
            pane,
            value.limits.windows[index]!,
            spark(value.history, index),
            !expired(value.usage_fetched_at, now),
            now,
          );
          continue;
        }
      }
      if (line === 0) full.cell(at, pane, 29, limitsMessage(value), "muted", false);
    }
    row += 1 + body;
  });
  w.write(`\x1b[${row + 1};${divider + 1}H${base}${Tone.ansi("border")}│`);
  overviewFooter(table, row, ranked.length - shown, overview.release);
  w.write("\x1b[0m\x1b8");
  return true;
}
/** One window's readings from a preview's `history`. */
function spark(history: unknown, index: number): limit_history.Spark {
  const cells = Array.isArray(history) && Array.isArray(history[index]) ? (history[index] as unknown[]) : [];
  return Array.from({ length: limit_history.cells }, (_, i) =>
    typeof cells[i] === "number" ? (cells[i] as number) : null,
  );
}
/** A rule across the whole card naming the account, crossing the divider. */
function accountRule(card: Card, row: number, section: Section, accounts: Accounts, divider: number, first: boolean) {
  const w = card.w;
  w.write(`\x1b[${row + 1};${card.x + 1}H${base}${Tone.ansi("border")}├`);
  w.write("─".repeat(card.width - 2));
  w.write("┤");
  w.write(`\x1b[${row + 1};${divider + 1}H${first ? "┬" : "┼"}`);
  const value = section.option(accounts);
  const name =
    section.provider !== null
      ? value !== null && value.account.length > 0
        ? `${Provider.info(section.provider).name} ${value.account}`
        : Provider.info(section.provider).name
      : "Other agents";
  w.write(`\x1b[${row + 1};${card.x + 3}H${base}${Tone.ansi("border")} `);
  w.write(`${base}${Tone.ansi("title")}`);
  writeEllipsis(w, name, 60);
  if (value !== null && value.plan.length > 0) {
    w.write(`${base}${Tone.ansi("muted")} · `);
    writeEllipsis(w, value.plan, 16);
  }
  w.write(`${base} `);
}
function limitsMessage(value: Option): string {
  if (value.limits === "metered") return "metered · no limit";
  if (value.limits === "rate_limited") return "Unavailable · server returned 429";
  if (value.usage_error.length > 0) return "Unavailable";
  if (value.signed_in === false) return "Not signed in";
  return "Reading…";
}
const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
function eighths(used: number): number {
  return Math.min(8, Math.max(1, Math.floor((used * 8 + 50) / 100)));
}
function block(used: number): string {
  return blocks[eighths(used) - 1];
}
/** One window across the pane: its label, a spark from the window's start to
 * its reset, the percent used, and the time until the reset. The spark sits on
 * a panel that shows each bar's full height, so low usage doesn't read as a
 * progress bar. Time left is stippled, and a slot with no reading is a
 * gray bar at the last reading's level (usage only rises within a window), or
 * the floor before the first reading. */
export function limitLine(
  card: Card,
  row: number,
  pane: number,
  window: Window,
  readings: limit_history.Spark,
  fresh: boolean,
  now: number,
) {
  card.cell(row, pane, 2, window.label(), "muted", false);
  const elapsed = elapsedCells(window, now);
  let last: number | null = null;
  for (let i = 0; i < limit_history.cells; i++) {
    const at = pane + 3 + i;
    if (i >= elapsed) {
      sparkCell(card, row, at, "⢕", Tone.ansi("remaining"));
      continue;
    }
    // The current slot shows the latest reading even before it is recorded.
    const reading = readings[i] ?? (fresh && i + 1 === elapsed ? window.used : null);
    if (reading === null) {
      sparkCell(card, row, at, last !== null ? block(last) : "▁", Tone.ansi("faint"));
      continue;
    }
    last = reading;
    sparkCell(card, row, at, block(reading), fresh ? barInk(reading) : Tone.ansi("faint"));
  }
  const figure: Tone = !fresh ? "muted" : window.used >= 100 ? "hot" : window.used >= 80 ? "warm" : "title";
  card.cell(row, pane + 15, 4, `${window.used}%`, figure, true);
  const status_text = !fresh ? "stale" : `↻ ${window.countdown(now) ?? "unknown"}`;
  card.cell(row, pane + 20, 9, status_text, "faint", false);
}
function sparkCell(card: Card, row: number, offset: number, glyph: string, ink: string) {
  card.w.write(`\x1b[${row + 1};${card.x + 4 + offset}H${base}${palette.bg("surface")}${ink}${glyph}`);
}
/** Warm past 80% and hot at the limit. Below that, accent fades toward gray
 * the shorter the bar, so a low, flat run doesn't read as a progress bar. */
export function barInk(used: number): string {
  if (used >= 100) return Tone.ansi("hot_cell");
  if (used >= 80) return Tone.ansi("warm_cell");
  return shallow_inks[eighths(used) - 1];
}
export let shallow_inks: string[];
palette.derived(() => {
  shallow_inks = [75, 45, 15, 0, 0, 0, 0, 0].map(percent =>
    palette.fgRgb(palette.mix(palette.colors.accent, palette.colors.faint, percent)),
  );
});
/** Spark cells that cover time already passed in the window. */
export function elapsedCells(window: Window, now: number): number {
  const minutes = window.minutes;
  const reset = window.reset_at;
  if (minutes === null || reset === null || minutes <= 0) return 0;
  const span = minutes * 60;
  const into = Math.min(span, Math.max(0, now - (reset - span)));
  return Math.ceil((into * limit_history.cells) / span);
}

export function draw(
  w: Writer,
  all: readonly Conversation[],
  entry: Entry,
  cols: number,
  rows: number,
  px: number,
  py: number,
): void {
  if (cols < 40 || rows < 13) return;
  const parent = entry.conversation;
  // A detected agent can have a visible row before it has a session binding.
  // Keep that row inspectable, with unknown usage until telemetry arrives.
  const provisional = conversation({ id: parent });
  Object.assign(provisional.agent, {
    provider: entry.provider,
    state: entry.state,
    attention: entry.attention,
    name: entry.name,
    session: "",
    activity: entry.activity,
    cwd: entry.cwd,
    tool_active: entry.tool_active,
    compacting: entry.compacting,
    subagents: { ...entry.subagents },
  });
  const root = find(all, parent) ?? provisional;
  const root_agent: Agent = { ...root.agent, subagents: { ...root.agent.subagents } };
  root_agent.state = entry.state;
  const children_available = childrenAvailable(all, parent, microTimestamp());
  if (!children_available) root_agent.subagents = noSubagents();
  const name =
    entry.name.length > 0 ? entry.name : root_agent.name.length > 0 ? root_agent.name : providerName(root_agent);
  const model = children_available ? Model.init(all, parent) : Object.assign(new Model(), { total: root.usage });
  const width = Math.min(88, cols);
  const pending = root.timeline.points.length > 0;
  const timeline_nodes = Math.min(
    16,
    root.timeline.points.length +
      Number(root_agent.state === "working" && root_agent.activity.length === 0 && !root_agent.compacting),
  );
  const timeline_height = timeline_nodes > 0 ? timeline_nodes + 1 : 0;
  const child_footer = children_available && model.children === 0;
  const tasks = root.background_tasks;
  const task_height = tasks.items.length > 0 ? Math.min(8, tasks.items.length + 1 + Number(tasks.truncated)) : 0;
  // Until there is a timeline, the activity takes its own line under the subtitle.
  const activity_row = timeline_nodes === 0;
  const wanted =
    7 +
    Number(activity_row) +
    timeline_height +
    task_height +
    (model.children > 0 ? model.children + 3 : Number(child_footer));
  const height = Math.min(wanted, rows - 2);
  const x = Math.min(px + 2, cols - width);
  const y = Math.min(py + 1, rows - 1 - height);
  w.write("\x1b7\x1b]8;;\x1b\\");
  for (let row = 0; row < height; row++) {
    w.write(`\x1b[${y + row + 1};${x + 1}H${base}${Tone.ansi("border")}`);
    w.write(row === 0 ? "╭" : row === height - 1 ? "╰" : "│");
    w.write((row === 0 || row === height - 1 ? "─" : " ").repeat(width - 2));
    w.write(row === 0 ? "╮" : row === height - 1 ? "╯" : "│");
  }
  const card = new Card(w, x, width);
  const top = y + 1;
  const root_status = status(root_agent, false);
  const status_text = `${root_status.icon} ${root_status.label}`;
  card.line(top, name, status_text, "title", "text");
  // Only the status dot takes the state's color.
  w.write(
    `\x1b[${top + 1};${x + width - 2 - displayWidth(status_text)}H${base}${Tone.ansi(root_status.tone)}${root_status.icon}`,
  );
  const root_activity =
    root_agent.activity.length === 0 &&
    root_agent.recent_activity.length === 0 &&
    !root_agent.tool_active &&
    !root_agent.compacting &&
    !root_agent.subagents.waiting &&
    root_agent.state === "working"
      ? thinking()
      : activity(root_agent);
  // The subtitle names the provider and model, with the context meter beside it.
  const provider = providerName(root_agent);
  const model_label = modelLabel(root);
  const subtitle =
    asciiLower(name) === asciiLower(provider)
      ? model_label
      : model_label.length > 0
        ? `${provider} · ${model_label}`
        : provider;
  const metered = root_agent.state !== "done" && root.context.band() !== null;
  card.line(top + 1, subtitle, metered ? " ".repeat(card.meterWidth(root.context)) : "", "muted", "muted");
  if (metered) card.meter(top + 1, root.context, root_agent.state === "working" && root_agent.compacting);
  const header = top + 2 + Number(activity_row);
  if (activity_row) card.line(top + 2, root_activity, "", "muted", "muted");
  card.tokenColumns(header, null, false, "faint");
  card.cell(header + 1, 0, card.textWidth(), "Total", "text", false);
  card.tokenColumns(header + 1, root.usage, false, root.usage.known ? "title" : "muted");
  let row = header + 2;
  const footer_row = y + height - 2;
  const end = model.children > 0 || child_footer ? footer_row : y + height - 1;
  // Give requested background work priority on short terminals. The section
  // stays bounded and reports omitted commands explicitly.
  row += card.backgroundTasks(row, tasks, Math.min(task_height, sat(end, row)));
  // Reserve child rows and the combined total; use the rest for recent phases.
  const room = sat(end, row);
  const total_rows = model.children > 0 ? 2 : 0;
  const reserved_children = Math.min(model.children, sat(room, total_rows + (timeline_nodes > 0 ? 2 : 0)));
  const visible_nodes = Math.min(timeline_nodes, sat(sat(room, reserved_children + total_rows), 1));
  if (visible_nodes > 0) {
    card.timeline(row, root, root_agent, visible_nodes, pending);
    row += visible_nodes + 1;
  }
  let shown = 0;
  if (children_available)
    for (const child of all.filter(item => visibleChild(all, item, parent)).sort(byName)) {
      if (row + total_rows >= end) break;
      const display_child = childrenAvailable(all, child.id, microTimestamp())
        ? child
        : { ...child, agent: { ...child.agent, subagents: noSubagents() } };
      card.childRow(row, display_child);
      row += 1;
      shown += 1;
    }
  if (model.children > 0 && row + 1 < end) {
    row += 1;
    card.cell(row, 0, card.textWidth(), "Including subagents", "text", false);
    card.tokenColumns(row, model.total, false, model.total.known ? "title" : "muted");
  }
  const footer = !children_available
    ? ""
    : model.children === 0 && (entry.subagents.running > 0 || entry.subagents.blocked > 0)
      ? "Updating child details…"
      : shown < model.children
        ? `+${model.children - shown} more`
        : model.children === 0
          ? "No subagents"
          : "Live usage";
  if (model.children > 0 || child_footer) card.line(footer_row, footer, "", "faint", "faint");
  w.write("\x1b[0m\x1b8");
}
