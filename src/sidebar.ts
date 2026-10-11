//! The sidebar: workspaces above, agents below. Mirrors sidebar.zig.
import * as palette from "./palette";
import { Style, colors, fg, bg, fgRgb, bgRgb, mix, underline } from "./palette";
import * as corgiAnimation from "./corgi_animation";
import * as corgiBadge from "./corgi_badge";
import * as resourceTooltip from "./resource_tooltip";
import * as dropdown from "./dropdown";
import * as worktrees from "./worktrees";
import { url as portUrl } from "./trackers/ports";
import { cpuText, memoryText } from "./trackers/resources";
import { View as ContextView } from "./usage/context_window";
import { rank, type Target as OrderTarget } from "./agent_order";
import { Rect } from "./layout";
import {
  Writer,
  displayWidth,
  writeClipped,
  writeEllipsis,
  directoryLabel,
  compactCount,
  codepointWidth,
  sat,
  clamp,
  byteLength,
  zigRound,
} from "./text";
import { max_panes, max_workspaces } from "./layout";
export { displayWidth, writeClipped, writeEllipsis, directoryLabel, compactCount, zigRound } from "./text";

/** Agents plus one header per workspace in the grouped "All" list. */
export const max_entries = max_panes + 16 + max_workspaces;
/** How far rows outside a lit worktree fade, as `writeExit` progress. */
export const spotlight_dim = 0.55;
/** The lists draw one column in: column 0 stays free for the focused list's box. */
export const lists_x = 1;
/** `bytes` drawn `dx` columns further right: every cursor position moves. */
function shiftColumns(bytes: string, dx: number): string {
  return bytes.replace(/\x1b\[(\d+);(\d+)H/g, (_, row, col) => `\x1b[${row};${Number(col) + dx}H`);
}
// Styles that code or tests concatenate.
export let panel: string,
  active_name: string,
  active_meta: string,
  active_bar: string,
  ghost_bar: string,
  rule_underline: string,
  dotted_underline: string,
  /** A seen agent's nap "z" on a plain row, dimmer than faint. */
  nap_fg: string,
  /** The agent row under the pointer, halfway from the panel to `selected`. */
  hover_rgb: palette.Rgb,
  hover_bg: string;
let selected_bg: string, button: string, ghost_underline: string, outline: string;
palette.derived(() => {
  selected_bg = bg("selected");
  panel = new Style({ fg: "muted", bg: "bg" }).sgr();
  outline = new Style({ bg: "bg" }).sgr() + fgRgb(palette.outline);
  button = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  active_name = new Style({ fg: "strong", bg: "selected", bold: true }).sgr();
  active_meta = new Style({ fg: "muted", bg: "selected" }).sgr();
  // Stacked half blocks join into one bar on hosts that draw block elements
  // themselves; one that takes the glyph from the font may leave gaps between rows.
  active_bar = new Style({ fg: "accent", bg: "selected" }).sgr() + "▌";
  ghost_bar = new Style({ fg: "strong", bg: "selected" }).sgr() + "▌";
  rule_underline = "\x1b[4m" + underline("line");
  dotted_underline = "\x1b[4:4m" + underline("line");
  ghost_underline = "\x1b[4m" + underline("strong");
  nap_fg = fgRgb(mix(colors.faint, colors.bg, 50));
  hover_rgb = mix(colors.bg, colors.selected, 50);
  hover_bg = bgRgb(hover_rgb);
});

export type Provider = "codex" | "claude";
export type State = "initializing" | "idle" | "working" | "blocked" | "done" | string;
export type Attention = "none" | "finished" | "needs_input";
/** `group` is a workspace header row in the grouped "All" list, not an agent. */
export type Target =
  | OrderTarget
  | { group: number }
  | { worktree: string; workspace: number }
  /** A conversation a browsed worktree's ghost shows, which entering it
   * brings back as a hibernated agent. */
  | { asleep: string; provider: Provider };
export const isAgent = (t: Target): t is OrderTarget => "pane" in t || "native" in t;
export const isHeading = (t: Target): boolean => "group" in t || "worktree" in t;
export function sameTarget(a: Target | null | undefined, b: Target | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if ("pane" in a) return "pane" in b && a.pane === b.pane;
  if ("native" in a) return "native" in b && a.native === b.native;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => value === (b as Record<string, unknown>)[key])
  );
}
export const isGroup = (t: Target): t is { group: number } => "group" in t;
/** Just past the rows header `index` holds: a workspace group's run to the
 * next workspace, a worktree's are its checkout's. */
export function groupEnd(entries: Entry[], index: number): number {
  const header = entries[index]?.target;
  let end = index + 1;
  if (header && isGroup(header)) while (end < entries.length && !isGroup(entries[end].target)) end += 1;
  else if (header && "worktree" in header)
    while (
      end < entries.length &&
      !isHeading(entries[end].target) &&
      entries[end].worktree?.path === header.worktree &&
      entries[end].worktree?.workspace === header.workspace
    )
      end += 1;
  return end;
}
export interface Search {
  text: string;
  /** An index into `text`, which is ASCII, so also a column. */
  cursor: number;
}
/** Viewer-local agent list filter. `workspace` follows the selected workspace. */
export type Scope = "workspace" | "all";
/** One of the sidebar's two lists. */
export type Section = "workspaces" | "agents";
/** Header totals for a group entry; `current` marks the selected workspace. */
export interface Group {
  agents: number;
  working: number;
  attention: number;
  folded: boolean;
  current: boolean;
}
export interface Subagents {
  running: number;
  blocked: number;
  waiting: boolean;
}
export interface Entry {
  worktree: { workspace: number; path: string; ghost: boolean; end?: boolean } | null;
  conversation: number;
  children: number;
  exit: { frame_ms: number; progress: number } | null;
  /** A reopened agent's row, which fades in as a closing one fades out. */
  reopened: boolean;
  /** How far a reopened row has faded in, until it has. */
  enter: number | null;
  name: string;
  target: Target;
  /** Null for workspace group headers. */
  provider: Provider | null;
  state: State;
  attention: Attention;
  focused: boolean;
  cwd: string;
  tool_active: boolean;
  compacting: boolean;
  /** Idle until its background shells or a wakeup it scheduled wake it. */
  paused: boolean;
  unread: boolean;
  activity: string;
  group: Group;
  subagents: Subagents;
  context: ContextView;
}
export function entry(fields: Partial<Entry> & { target: Target }): Entry {
  return {
    worktree: null,
    conversation: 0,
    children: 0,
    exit: null,
    reopened: false,
    enter: null,
    name: "",
    provider: null,
    state: "idle",
    attention: "none",
    focused: false,
    cwd: "",
    tool_active: false,
    compacting: false,
    paused: false,
    unread: false,
    activity: "",
    group: { agents: 0, working: 0, attention: 0, folded: false, current: false },
    subagents: { running: 0, blocked: 0, waiting: false },
    context: new ContextView(),
    ...fields,
  };
}
export function orderTarget(e: Entry): OrderTarget | null {
  if ("pane" in e.target) return { pane: e.target.pane };
  if ("native" in e.target) return { native: e.target.native };
  return null;
}
export function lessThan(order: OrderTarget[], left: Entry, right: Entry): boolean {
  return rank(order, orderTarget(left)!) < rank(order, orderTarget(right)!);
}
// The style guide's status glyphs; finished attention is the unseen-idle
// state, and its name turns bold. Corgi also retains ended native
// sessions. A `selected` row takes muted where the guide says faint.
export function indicator(e: Entry, selected: boolean): { icon: string; color: string; unread: boolean } {
  const quiet = selected ? fg("muted") : fg("faint");
  if (e.state === "done") return { icon: "○", color: quiet, unread: false };
  if (e.state === "blocked" || e.attention === "needs_input")
    return { icon: "●", color: "\x1b[1m" + fg("warm"), unread: false };
  if (e.state === "working") return { icon: "▶", color: "\x1b[1m" + fg("accent"), unread: false };
  if (e.state === "idle" && e.paused) {
    if (e.attention === "finished") return { icon: "‖", color: "\x1b[1m" + fg("accent"), unread: true };
    return { icon: "‖", color: fg("muted"), unread: false };
  }
  if (e.attention === "finished") return { icon: "●", color: "\x1b[1m" + fg("accent"), unread: true };
  if (e.state === "initializing") return { icon: "◌", color: fg("muted"), unread: false };
  if (e.state === "idle") return { icon: "○", color: fg("muted"), unread: false };
  return { icon: "·", color: quiet, unread: false };
}

export interface GitPush {
  phase: "idle" | "pushing" | "succeeded" | "failed";
  message: string;
}
export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  timestamp: number;
}
export interface Stats {
  tools: number;
  input: number;
  output: number;
  tokens_known: boolean;
  [key: string]: unknown;
}
/** A workspace's resource readings, as resources.zig's `Work`. */
export interface Work {
  id: number;
  known: boolean;
  cpu: number | null;
  memory: number | bigint | null;
  read: number | bigint | null;
  written: number | bigint | null;
  cpu_pressure: boolean;
  [key: string]: unknown;
}
export function work(fields: Partial<Work> & { id: number }): Work {
  return { known: false, cpu: null, memory: null, read: null, written: null, cpu_pressure: false, ...fields };
}
/** The workspace's readings in a resources snapshot, or none. */
export function resourcesFor(snapshot: any, id: number): Work {
  const found = (snapshot?.workspaces ?? []).find((w: any) => w.id === id);
  return work({ ...(found ?? {}), id });
}
export interface Endpoint {
  label?: string;
  label_pending?: boolean;
  [key: string]: any;
}
export interface PortsSnapshot {
  processes_available?: boolean;
  ports_available?: boolean;
  workspaces: { id: number; background?: number; endpoints: Endpoint[] }[];
}
function portEndpoints(ports: PortsSnapshot, id: number): Endpoint[] {
  return (ports?.workspaces ?? []).find(w => w.id === id)?.endpoints ?? [];
}
export interface WorkspaceEntry {
  resources: Work;
  ports: PortsSnapshot;
  remote_links: boolean;
  git_push: GitPush;
  git_ahead: number | null;
  git_commits: GitCommit[];
  worktrees: worktrees.Snapshot | null;
  id: number;
  name: string;
  cwd: string;
  active: boolean;
  agents: number;
  working: number;
  unread: number;
  attention: number;
  stats: Stats;
}
export function workspaceEntry(
  fields: Partial<WorkspaceEntry> & { id: number; name: string; cwd: string; active: boolean },
): WorkspaceEntry {
  return {
    resources: work({ id: 0 }),
    ports: { workspaces: [] },
    remote_links: false,
    git_push: { phase: "idle", message: "" },
    git_ahead: null,
    git_commits: [],
    worktrees: null,
    agents: 0,
    working: 0,
    unread: 0,
    attention: 0,
    stats: { tools: 0, input: 0, output: 0, tokens_known: false },
    ...fields,
  };
}
export type Hit =
  | { tag: "none" }
  | { tag: "toggle" }
  | { tag: "agent_scope" }
  | { tag: "agent_new" }
  | { tag: "agent_options" }
  | { tag: "entry"; entry: number }
  | { tag: "workspace_new" }
  | { tag: "workspace"; workspace: number };
const hit = <T extends Hit["tag"]>(tag: T): Hit => ({ tag }) as Hit;

/** Render the prospective order without changing shared state or the stable
 * row geometry used by the captured gesture's hit testing. */
export class Preview {
  constructor(
    public source: number,
    public destination: number,
  ) {}
  apply<T>(entries: readonly T[]): T[] {
    const p = this;
    if (p.source >= entries.length || p.destination >= entries.length) return entries.slice();
    const out = entries.slice();
    const item = out[p.source];
    out.splice(p.source, 1);
    out.splice(p.destination, 0, item);
    return out;
  }
}

/** UTF-8 byte offset into `text` as a JS string index. */
function fromByte(text: string, offset: number): string {
  return Buffer.from(text).subarray(offset).toString();
}

export class View {
  search: Search | null = null;
  /** Header scope: "all" or the workspace whose agents are listed. */
  scope_label = "";
  corgi_badge: corgiBadge.Mode = "none";
  supports_kitty_graphics = false;
  cols = 0;
  rows = 0;
  width = 0;
  count = 0;
  offset = 0;
  capacity = 1;
  /** When set, rows are measured per entry: group headers take one row. */
  entries: Entry[] = [];
  dragged: number | null = null;
  /** The agent entry under the pointer. */
  hovered: number | null = null;
  dragged_workspace: number | null = null;
  workspace_count = 0;
  workspace_offset = 0;
  resources: { enabled: boolean } = { enabled: true };
  resource_hover: number | null = null;
  /** Corgi setup: idle agents nap as corgis; off marks them with a faint Z. */
  sleeping_corgis = true;
  /** The agents header row as last dragged; null splits the sidebar in half. */
  split: number | null = null;
  /** A lit worktree: its group keeps its colors while the rest of the list dims. */
  spotlight: { workspace: number; path: string } | null = null;
  /** A folded sidebar's one list, drawn over the panes from top to bottom.
   * Panes and tabs keep their folded places. */
  drawer: Section | null = null;
  /** The list with the keyboard, boxed as the focused pane is. */
  focus: Section | null = null;
  /** The lists' own view, from `lists()`. */
  inner = false;

  clone(): View {
    return Object.assign(Object.create(View.prototype), this) as View;
  }
  /** Whether this is the whole sidebar's view, whose lists sit `lists_x` in. */
  framed(): boolean {
    return !this.inner && this.width > 0;
  }
  /** The lists' view: `lists_x` columns in and as many narrower, in the
   * lists' own columns. Its border is still the sidebar's. */
  lists(): View {
    if (!this.framed()) return this;
    const v = this.clone();
    v.width -= lists_x;
    v.inner = true;
    return v;
  }
  /** The whole sidebar's width, from the lists' view too. */
  sidebarWidth(): number {
    return this.inner ? this.width + lists_x : this.width;
  }
  middle(): number {
    // A drawer's list runs from its box's top edge to the bottom one.
    if (this.drawer === "workspaces") return this.rows;
    if (this.drawer === "agents") return 1;
    return this.split === null ? Math.floor(sat(this.rows, 1) / 2) : View.splitFor(this.rows, this.split);
  }
  /** Keeps one workspace above the divider and an agent below it. */
  static splitFor(rows: number, preferred: number): number {
    return clamp(preferred, 6, Math.max(6, sat(rows, 5)));
  }
  /** The rule between workspaces and agents drags the split. */
  splitHandle(x: number, y: number): boolean {
    if (this.framed()) return this.lists().splitHandle(x - lists_x, y);
    return this.width > 0 && x < this.width - 1 && y === this.middle() - 1;
  }
  /** Name and status rows, plus the resource row unless readings are off. */
  workspaceRows(): number {
    return this.resources.enabled ? 3 : 2;
  }
  /** Whether row `y` of the right border edges the focused list's box. The
   * rule between the lists edges both, as a divider does two panes. */
  outlines(y: number): boolean {
    if (this.focus === null) return false;
    return this.focus === "workspaces" ? y >= 1 && y < this.middle() : y >= this.middle() - 1;
  }
  /** The focused list's box: its top and bottom rows. */
  box(): { top: number; bottom: number } | null {
    if (this.focus === null || this.width === 0) return null;
    return this.focus === "workspaces"
      ? { top: 1, bottom: this.middle() - 1 }
      : { top: this.middle() - 1, bottom: this.rows - 1 };
  }
  /** The rule row below the workspace list. */
  workspaceEnd(): number {
    return sat(this.middle(), 1);
  }
  /** Name and status rows end above the rule; only a trailing resource row
   * may give way to it. */
  workspaceCapacity(): number {
    return Math.max(1, Math.floor((sat(this.workspaceEnd(), 2) + (this.workspaceRows() - 2)) / this.workspaceRows()));
  }
  /** The workspace list's scrollbar thumb, like the agent list's. */
  workspaceThumb(): { start: number; len: number } | null {
    const track = sat(this.workspaceEnd(), 2);
    const last = sat(this.workspace_count, this.workspaceCapacity());
    if (last === 0 || track < 2) return null;
    const len = clamp(Math.floor((track * this.workspaceCapacity()) / this.workspace_count), 1, track - 1);
    return { start: Math.round(((track - len) * this.workspace_offset) / last), len };
  }
  withWorkspaces(count: number, offset: number): View {
    const result = this.clone();
    result.workspace_count = count;
    result.workspace_offset = Math.min(offset, sat(count, this.workspaceCapacity()));
    return result;
  }
  static widthFor(cols: number, open: boolean): number {
    return open && cols >= 64 ? 28 : 0;
  }
  static init(
    cols: number,
    rows: number,
    open: boolean,
    offset: number,
    count: number,
    split: number | null = null,
  ): View {
    const v = new View();
    v.cols = cols;
    v.rows = rows;
    v.split = split;
    v.width = rows >= 13 ? View.widthFor(cols, open) : 0;
    v.count = count;
    v.capacity = 1;
    v.offset = 0;
    v.capacity = Math.max(1, Math.floor(v.listRows() / 2));
    v.offset = Math.min(offset, sat(count, v.capacity));
    return v;
  }
  /** The list runs to the bottom, above the search hint while searching. */
  /** The bottom row stays free for a box's edge, or the search hint. */
  listEnd(): number {
    return sat(this.rows, 1);
  }
  listRows(): number {
    return sat(this.listEnd(), this.middle() + 2);
  }
  static height(e: Entry): number {
    const content = isHeading(e.target) ? 1 : 2;
    return content + (e.worktree?.ghost ? Number("worktree" in e.target) + Number(e.worktree.end === true) : 0);
  }
  /** The headers of the groups the entry at `from` belongs to, which stay
   * pinned above it: its workspace's in the grouped list, then its
   * worktree's. Ghost groups scroll with the list. */
  pinned(from: number): number[] {
    const first = this.entries[from];
    if (!first || isGroup(first.target)) return [];
    const out: number[] = [];
    for (let i = from - 1; i >= 0; i--)
      if (isGroup(this.entries[i].target)) {
        out.push(i);
        break;
      }
    const checkout = first.worktree;
    if (checkout && !checkout.ghost && !("worktree" in first.target))
      for (let i = from - 1; i >= 0 && !isGroup(this.entries[i].target); i--) {
        const target = this.entries[i].target;
        if ("worktree" in target && target.worktree === checkout.path) {
          out.push(i);
          break;
        }
      }
    return out;
  }
  /** Entries that fit in the list starting at `from`, below its pinned headers. */
  fits(from: number): number {
    let used = this.pinned(from).length;
    let n = 0;
    for (const e of this.entries.slice(Math.min(from, this.entries.length))) {
      used += View.height(e);
      if (used > this.listRows()) break;
      n += 1;
    }
    return Math.max(1, n);
  }
  maxOffset(): number {
    if (this.entries.length === 0) return sat(this.count, this.capacity);
    let used = 0;
    let start = this.entries.length;
    while (start > 0) {
      used += View.height(this.entries[start - 1]);
      if (used + this.pinned(start - 1).length > this.listRows()) break;
      start -= 1;
    }
    return start;
  }
  rowsBefore(index: number): number {
    if (this.entries.length === 0) return index * 2;
    let rows = 0;
    for (const e of this.entries.slice(0, index)) rows += View.height(e);
    return rows;
  }
  /** The scrollbar thumb's rows within the list, drawn over the border;
   * null while every entry fits. */
  thumb(): { start: number; len: number } | null {
    const track = this.listRows();
    const total = this.rowsBefore(this.count);
    if (total <= track || track < 2) return null;
    const len = clamp(Math.floor((track * track + Math.floor(total / 2)) / total), 1, track - 1);
    const last = Math.max(1, this.rowsBefore(this.maxOffset()));
    const start = Math.floor(((track - len) * this.rowsBefore(this.offset) + Math.floor(last / 2)) / last);
    return { start: Math.min(start, track - len), len };
  }
  withEntries(entries: Entry[]): View {
    const result = this.clone();
    result.entries = entries;
    result.count = entries.length;
    result.offset = Math.min(this.offset, result.maxOffset());
    result.capacity = result.fits(result.offset);
    return result;
  }
  /** The scroll that shows group `index` as it unfolds: as much of it as
   * fits, but never past its header on top. */
  revealGroup(index: number): number {
    return Math.min(this.reveal(Math.max(index, groupEnd(this.entries, index) - 1)), index);
  }
  /** The smallest scroll change that shows entry `index`. */
  reveal(index: number): number {
    if (index < this.offset) return index;
    let offset = this.offset;
    while (offset < index && index >= offset + (this.entries.length > 0 ? this.fits(offset) : this.capacity))
      offset += 1;
    return offset;
  }
  withWidth(preferred: number): View {
    const result = this.clone();
    if (result.width > 0) result.width = clamp(preferred, 20, this.cols - 20);
    return result;
  }
  withSearch(search: Search | null): View {
    const result = this.clone();
    result.search = search;
    // Search opens the same sidebar on compact terminals too, while
    // preserving at least twenty columns for the terminal pane.
    if (search !== null && this.cols >= 40 && this.rows >= 13) result.width = Math.min(28, this.cols - 20);
    return result;
  }
  searchOffset(): number {
    const search = this.search;
    if (!search) return 0;
    return sat(search.cursor, sat(this.width, 5));
  }
  searchCursor(w: Writer): void {
    const search = this.search;
    if (!search) return;
    if (this.width === 0) return;
    const x = lists_x + 4 + search.cursor - this.lists().searchOffset();
    w.write(`\x1b[0m\x1b[${this.middle() + 2};${x}H\x1b[?25h`);
  }
  area(): Rect {
    const x = this.drawer !== null ? 0 : this.width;
    return new Rect(x, 1, this.cols - x, sat(this.rows, 1));
  }
  tabX(): number {
    return this.width > 0 && this.drawer === null ? this.width : this.cols >= 64 ? 3 : 0;
  }
  hit(x: number, y: number): Hit {
    if (this.framed()) return this.lists().hit(x - lists_x, y);
    const v = this;
    if (v.width === 0) return v.cols >= 64 && x < 3 && y === 0 ? hit("toggle") : hit("none");
    if (x >= v.width - 1 || y >= v.rows) return hit("none");
    if (y === 0 && v.drawer !== "agents") {
      if (x >= v.width - 5) return hit("toggle");
      if (x >= v.width - 11 && x < v.width - 6) return hit("workspace_new");
    }
    if (y === v.middle() && v.drawer === null && x >= v.width - 10 && x < v.width - 2)
      return x >= v.width - 4 ? hit("agent_options") : hit("agent_new");
    if (y === v.middle() && x >= v.scopeStart()) {
      const qualifier = v.scopeQualifier();
      if (x < v.scopeStart() + displayWidth(qualifier) + displayWidth(v.scopeArrow())) return hit("agent_scope");
    }
    if (y < v.middle()) {
      if (y < 2 || y >= v.workspaceEnd()) return hit("none");
      const slot = Math.floor((y - 2) / v.workspaceRows());
      const index = slot + v.workspace_offset;
      return index < v.workspace_count && slot < v.workspaceCapacity()
        ? { tag: "workspace", workspace: index }
        : hit("none");
    }
    if (y < v.middle() + 2 || y >= v.listEnd()) return hit("none");
    let top = v.middle() + 2;
    for (const index of v.pinned(v.offset)) {
      top += 1;
      if (y < top) return { tag: "entry", entry: index };
    }
    for (let index = v.offset; index < Math.min(v.count, v.offset + v.capacity); index++) {
      top += v.entries.length > 0 ? View.height(v.entries[index]) : 2;
      if (y < top) return { tag: "entry", entry: index };
    }
    return hit("none");
  }
  /** Use the same row heights and viewport as hit testing. The marker sits
   * just above the destination row, including the gap after the last row. */
  agentDrop(x: number, y: number): { index: number; y: number } | null {
    if (this.framed()) return this.lists().agentDrop(x - lists_x, y);
    const v = this;
    if (v.width === 0 || x >= v.width - 1 || y < v.middle() + 2 || y >= v.listEnd() || v.entries.length === 0)
      return null;
    let top = v.middle() + 2 + v.pinned(v.offset).length;
    const end = Math.min(v.count, v.offset + v.capacity);
    for (let i = v.offset; i < end; i++) {
      const h = View.height(v.entries[i]);
      if (y < top + Math.floor(h / 2)) return { index: i, y: top - 1 };
      top += h;
    }
    return { index: end, y: top - 1 };
  }
  /** `agentDrop` over the workspace slots in the upper list. */
  workspaceDrop(x: number, y: number): { index: number; y: number } | null {
    if (this.framed()) return this.lists().workspaceDrop(x - lists_x, y);
    const v = this;
    if (v.width === 0 || x >= v.width - 1 || y < 2 || y >= v.workspaceEnd() || v.workspace_count === 0) return null;
    let top = 2;
    const end = Math.min(v.workspace_count, v.workspace_offset + v.workspaceCapacity());
    for (let i = v.workspace_offset; i < end; i++) {
      if (y < top + Math.floor((v.workspaceRows() + 1) / 2)) return { index: i, y: top - 1 };
      top += v.workspaceRows();
    }
    return { index: end, y: top - 1 };
  }
  unreadRange(ws: WorkspaceEntry): { start: number; end: number } {
    if (this.framed()) {
      const range = this.lists().unreadRange(ws);
      return { start: range.start + lists_x, end: range.end + lists_x };
    }
    const unread_width = View.unreadWidth(ws);
    const metadata_width = statusMetadataWidth(ws);
    const attention_width = ws.attention > 0 ? displayWidth(compactCount(ws.attention)) + 2 : 0;
    const working_width = ws.working > 0 ? displayWidth(compactCount(ws.working)) + 1 : 1;
    const room = sat(sat(sat(this.width, 3), metadata_width + 1), unread_width + 3);
    const working = working_width + attention_width <= room ? working_width : 0;
    const status_width = working + Math.min(attention_width, room - working);
    const start = 1 + status_width + (working > 0 || attention_width > 0 ? 3 : 0);
    return { start, end: start + unread_width };
  }
  /** The label is blank at zero, but its slot keeps the width of "1 unread →"
   * so the status row does not shift when the first unread arrives. */
  static unreadWidth(ws: WorkspaceEntry): number {
    return Math.max(10, displayWidth(compactCount(ws.unread)) + 9);
  }
  unreadHit(ws: WorkspaceEntry, x: number, y: number): boolean {
    if (this.framed()) return this.lists().unreadHit(ws, x - lists_x, y);
    if (ws.unread === 0 || y < 3 || (y - 2) % this.workspaceRows() !== 1) return false;
    const range = this.unreadRange(ws);
    return x >= range.start && x < range.end;
  }
  draw(w: Writer, entries: Entry[], workspaces: WorkspaceEntry[]): void {
    return this.drawAt(w, entries, workspaces, Date.now());
  }
  drawAt(w: Writer, entries: Entry[], workspaces: WorkspaceEntry[], now_ms: number): void {
    corgiAnimation.beginFrame();
    try {
      this.drawFrame(w, entries, workspaces, now_ms);
    } finally {
      corgiAnimation.endFrame();
    }
  }
  private drawFrame(w: Writer, entries: Entry[], workspaces: WorkspaceEntry[], now_ms: number): void {
    const v = this;
    if (v.width === 0) {
      if (v.cols >= 64) w.write("\x1b[1;1H\x1b[1m" + fg("strong") + " > \x1b[0m");
      return;
    }
    if (v.framed()) {
      for (let row = 0; row < v.rows; row++) w.write(`\x1b[${row + 1};1H${panel}` + " ".repeat(lists_x));
      const lists = new Writer();
      v.lists().drawFrame(lists, entries, workspaces, now_ms);
      w.write(shiftColumns(lists.buffered(), lists_x));
      v.drawBox(w);
      return;
    }
    for (let row = 0; row < v.rows; row++) {
      w.write(`\x1b[${row + 1};1H${panel}`);
      w.splat(" ", v.width - 1);
      w.write((v.outlines(row) ? outline : fg("line")) + "│");
    }
    v.drawScope(w);
    if (v.search) {
      const search = v.search;
      v.line(w, v.middle() + 1, "/ ", new Style({ fg: "strong", bg: "surface" }).sgr());
      w.splat(" ", v.width - 5);
      w.write(`\x1b[${v.middle() + 2};4H` + fg("text"));
      if (search.text.length === 0) writeClipped(w, "type to search", v.width - 5);
      else writeClipped(w, fromByte(search.text, v.searchOffset()), v.width - 5);
    } else if (v.drawer === null) w.write(`\x1b[${v.middle() + 1};${v.width - 9}H` + button + ` New  ▾ ${panel}`);
    if (v.drawer !== "agents") v.drawWorkspaces(w, workspaces);
    if (v.drawer === "workspaces") {
      w.write("\x1b[0m");
      return;
    }
    if (v.drawer === null) {
      // The rule meets the border, so an outline turns the corner.
      w.write(`\x1b[${v.middle()};2H` + (v.focus !== null ? outline : panel + fg("line")));
      w.write("─".repeat(Math.max(0, v.width - 2)) + "┤");
    }
    v.drawAgents(w, entries, now_ms);
  }
  /** The focused list's box: the lists' view draws its right edge and the
   * rule; this closes it on the left and, off the rule, on top and bottom. */
  private drawBox(w: Writer): void {
    const box = this.box();
    if (box === null) return;
    const v = this,
      rule = v.drawer === null ? v.middle() - 1 : -1;
    w.write(outline);
    for (let y = box.top; y <= box.bottom; y++)
      w.write(`\x1b[${y + 1};1H` + (y === box.top ? "┌" : y === box.bottom ? "└" : "│"));
    for (const y of [box.top, box.bottom]) {
      // The rule already runs to the border from the lists' first column.
      const end = y === rule ? 1 + lists_x : v.width - 1;
      w.write(`\x1b[${y + 1};2H` + "─".repeat(sat(end, 1)));
      if (y !== rule) w.write(y === v.rows - 1 ? "┘" : y > 0 ? "┤" : "┐");
    }
    w.write("\x1b[0m");
  }
  /** A list's scrollbar thumb, heavier on its stretch of the border: the
   * outline's color while the list has focus. */
  private thumbStyle(section: Section): string {
    return this.focus === section ? outline : panel + fg("faint");
  }
  /** The title row and the workspace list above the agents. */
  private drawWorkspaces(w: Writer, workspaces: WorkspaceEntry[]): void {
    const v = this;
    w.write(`\x1b[1;${v.width - 4}H${panel} < `);
    if (v.corgi_badge !== "none") {
      if (v.corgi_badge === "emoji") w.write(`\x1b[1;2H${panel}${corgiBadge.emoji}`);
      w.write("\x1b[1;6H\x1b[1m" + fg("strong"));
      writeEllipsis(w, "workspaces", sat(v.width, 17));
    } else v.line(w, 0, "workspaces", "\x1b[1m" + fg("strong"));
    w.write(`\x1b[1;${v.width - 10}H` + button + `[ + ]${panel}`);
    const shown = workspaces.slice(
      v.workspace_offset,
      Math.min(workspaces.length, v.workspace_offset + v.workspaceCapacity()),
    );
    shown.forEach((ws, index) => {
      const y = 2 + index * v.workspaceRows();
      const ghost = v.dragged_workspace === v.workspace_offset + index;
      const tinted = ws.active || ghost;
      const style = tinted ? active_name : panel;
      const meta = tinted ? active_meta : panel;
      // The dragged workspace takes the selected tint and a strong bar, like a dragged agent row.
      const bar = ghost ? ghost_bar : active_bar;
      w.write(`\x1b[${y + 1};1H${style}`);
      w.splat(" ", v.width - 1);
      const badge = gitLabel(ws, false);
      const badge_width = displayWidth(badge);
      w.write(`\x1b[${y + 1};2H${style}`);
      const link = linkRange(v, ws, workspaces);
      writeClipped(w, directoryLabel(ws.name, null, 4097), sat(link.start, 2));
      if (link.end > link.start) {
        w.write(`\x1b[${y + 1};${link.start + 1}H`);
        drawPorts(w, ws, link.end - link.start, false);
      }
      if (badge_width > 0) w.write(`\x1b[${y + 1};${v.width - 1 - badge_width}H${gitColor(ws.git_push.phase)}${badge}`);
      if (tinted) {
        w.write(`\x1b[${y + 2};1H${meta}`);
        w.splat(" ", v.width - 1);
      }
      const divider = index + 1 < Math.min(workspaces.length - v.workspace_offset, v.workspaceCapacity());
      // Without a resource row, the separator underlines the status row,
      // text included, as between agents.
      const rule = divider && v.workspaceRows() === 2 ? rule_underline : "";
      w.write(`\x1b[${y + 2};2H${meta}${rule}`);
      if (rule.length > 0) {
        w.splat(" ", v.width - 3);
        w.write(`\x1b[${y + 2};2H`);
      }
      const tools = compactCount(ws.stats.tools);
      const unread = ws.unread > 0 ? `${compactCount(ws.unread)} unread →` : "";
      const attention = ws.attention > 0 ? ` ●${compactCount(ws.attention)}` : "";
      const unread_width = View.unreadWidth(ws);
      const attention_width = displayWidth(attention);
      const metadata = `⚒${tools}`;
      const metadata_width = displayWidth(metadata);
      const left_room = sat(v.width - 3, statusMetadataWidth(ws) + 1);
      const room = { value: sat(left_room, unread_width + 3) };
      let has_status = false;
      {
        const text = ws.working === 0 ? "○" : `▶${compactCount(ws.working)}`;
        if (displayWidth(text) + attention_width <= room.value) {
          statusPart(w, text, ws.working > 0 ? "\x1b[1m" + fg("accent") : fg("muted"), room);
          has_status = true;
        }
      }
      if (attention_width > 0) {
        statusPart(w, attention, "\x1b[1m" + fg("warm"), room);
        has_status = true;
      }
      if (ws.unread > 0) {
        if (has_status) w.write(tinted ? "\x1b[22m" + fg("muted") + " · " : "\x1b[22m" + fg("faint") + " · ");
        w.write(`\x1b[${y + 2};${v.unreadRange(ws).start + 1}H`);
        const unread_room = { value: unread_width };
        statusPart(w, unread, "\x1b[1m" + fg("accent"), unread_room);
      }
      const worktree_label = worktreeLabel(ws);
      if (worktree_label)
        w.write(`\x1b[${y + 2};${v.width - 1 - displayWidth(worktree_label)}H${meta}${rule}${worktree_label}`);
      else if (ws.stats.tools > 0) w.write(`\x1b[${y + 2};${v.width - 1 - metadata_width}H${meta}${rule}${metadata}`);
      if (tinted) for (const row of [y + 1, y + 2]) w.write(`\x1b[${row};1H${bar}`);
      w.write(panel);
      if (v.workspaceRows() === 3 && y + 2 < v.workspaceEnd()) {
        if (tinted) {
          w.write(`\x1b[${y + 3};1H${meta}`);
          w.splat(" ", v.width - 1);
        }
        w.write(`\x1b[${y + 3};2H${meta}`);
        if (divider) w.write(rule_underline);
        drawResources(w, ws.resources, v, v.resource_hover === ws.id, tinted);
        w.write("\x1b[24;59m");
        w.write(panel);
        if (tinted) w.write(`\x1b[${y + 3};1H${bar}${panel}`);
      }
    });
    const ws_thumb = v.workspaceThumb();
    if (ws_thumb)
      for (let row = ws_thumb.start; row < ws_thumb.start + ws_thumb.len; row++)
        w.write(`\x1b[${3 + row};${v.width}H` + v.thumbStyle("workspaces") + "┃");
  }
  /** The agent list below its header. */
  private drawAgents(w: Writer, entries: Entry[], now_ms: number): void {
    const v = this;
    if (entries.length === 0) {
      v.line(w, v.middle() + 2, v.search !== null ? "No matching agents" : "No agents yet", panel);
      if (v.search === null) {
        v.line(w, v.middle() + 4, "Launch inside a pane:", panel);
        v.line(w, v.middle() + 5, "codex  or  claude", panel);
      }
    }
    const grouped = entries.some(e => isGroup(e.target));
    // In the grouped list a workspace's rail runs past its worktree headers
    // to the next workspace. Ghost groups sit above the first workspace.
    const first_group = entries.findIndex(e => isGroup(e.target));
    const nested = (i: number) => first_group >= 0 && i > first_group;
    const lastInGroup = (i: number) => {
      const next = entries[i + 1];
      if (!next) return true;
      if (nested(i)) return isGroup(next.target);
      return isHeading(next.target) || entries[i].worktree?.path !== next.worktree?.path;
    };
    const heading = (out: Writer, i: number, y: number, stuck: boolean) => {
      const e = entries[i];
      const lead = isGroup(e.target) ? "" : e.worktree?.ghost ? " " : !nested(i) ? "" : lastInGroup(i) ? "╰" : "├";
      v.drawHeader(out, e, y, lead, stuck);
    };
    let next_y = v.middle() + 2;
    // Outside a lit worktree, rows fade most of the way into the panel.
    const spot = v.spotlight;
    const dimmed = (e: Entry) =>
      spot !== null && !(e.worktree?.workspace === spot.workspace && e.worktree.path === spot.path);
    const pinned = v.pinned(v.offset);
    pinned.forEach((i, n) => {
      const out = dimmed(entries[i]) ? new Writer() : w;
      heading(out, i, next_y, n === pinned.length - 1);
      if (out !== w) writeExit(w, out.buffered(), spotlight_dim);
      next_y += 1;
    });
    const visible = entries.slice(v.offset, Math.min(entries.length, v.offset + v.capacity));
    const sleepers: bigint[] = [];
    for (const e of visible) {
      if (!isAgent(e.target) || e.state !== "idle" || e.exit !== null) continue;
      sleepers.push(animationKey(e));
    }
    const dream = v.sleeping_corgis ? corgiAnimation.dreamer(sleepers, now_ms) : null;
    visible.forEach((e, index) => {
      const absolute = v.offset + index;
      const exit_writer = new Writer();
      const fading = e.exit ? e.exit.progress : e.enter !== null ? 1 - e.enter : null;
      const fade = dimmed(e) ? Math.max(fading ?? 0, spotlight_dim) : fading;
      const row_writer = fade !== null ? exit_writer : w;
      const frame_ms = e.exit ? e.exit.frame_ms : now_ms;
      const top = next_y;
      const y = top + Number(e.worktree?.ghost === true && "worktree" in e.target);
      next_y += View.height(e);
      if (isHeading(e.target)) {
        heading(row_writer, absolute, y, false);
        v.drawGhost(row_writer, e, top);
        if (fade !== null) writeExit(w, exit_writer.buffered(), fade);
        return;
      }
      const in_group = grouped || e.worktree !== null;
      const last_in_group = in_group && lastInGroup(absolute);
      const divider = !in_group && index + 1 < Math.min(entries.length - v.offset, v.capacity);
      v.drawAgent(
        row_writer,
        e,
        0,
        y,
        in_group,
        last_in_group,
        divider,
        v.dragged === absolute,
        v.hovered === absolute,
        frame_ms,
        dream,
      );
      v.drawGhost(row_writer, e, top);
      if (fade !== null) writeExit(w, exit_writer.buffered(), fade);
    });
    if (v.search !== null) v.line(w, v.rows - 1, "↑↓  ↵ jump  Esc back", panel);
    const t = v.thumb();
    if (t)
      for (let row = t.start; row < t.start + t.len; row++)
        w.write(`\x1b[${v.middle() + 3 + row};${v.width}H` + v.thumbStyle("agents") + "┃");
    w.write("\x1b[0m");
  }
  /** The small glyph beside an agent's detail line: a wait clock, an active
   * tool, the working spinner, or a napping "z" once idle. */
  static activityGlyph(e: Entry, waiting: boolean, napping: boolean, spinner: string): string {
    if (waiting) return "◷";
    if (e.tool_active && (e.state === "working" || e.state === "blocked")) return "🔧";
    if (e.state === "working") return spinner;
    if (napping) return "ᶻ";
    return "";
  }
  /** The thinking swirl, or dots that pile up and squash flat while compacting. */
  static spinnerFrame(compacting: boolean, now_ms: number): string {
    const thinking = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const pile = ["⣀", "⣁", "⣂", "⣄", "⣌", "⣔", "⣤", "⣥", "⣦", "⣮", "⣶", "⣷", "⣿", "⣿", "⣿", "⣶", "⣤", "⣀", "⣀"];
    if (compacting) return pile[mod(Math.floor(now_ms / 75), pile.length)];
    return thinking[mod(Math.floor(now_ms / 80), thinking.length)];
  }
  drawAgent(
    w: Writer,
    e: Entry,
    x: number,
    y: number,
    grouped: boolean,
    last_in_group: boolean,
    divider: boolean,
    ghost: boolean,
    hovered: boolean,
    now_ms: number,
    dream: corgiAnimation.Dream | null,
  ): void {
    const v = this;
    // Focused and dragged rows take the selected tint, and a hovered one
    // goes halfway to it; in a group the rail stays unbroken.
    const selected = ghost || e.focused;
    const background = selected ? colors.selected : hovered ? hover_rgb : colors.bg;
    const row_bg = selected ? selected_bg : hovered ? hover_bg : bg("bg");
    for (let row = 0; row < 2; row++) {
      if (y + row >= v.listEnd()) break;
      w.write(`\x1b[${y + row + 1};${x + 1}H\x1b[0m${row_bg}`);
      w.splat(" ", v.width - 1);
    }
    if (grouped) {
      // The guide sits in the margin column, so agent text keeps its columns.
      // Beside the selected agent it turns heavy and accented, without a gap.
      const rail = e.focused ? new Style({ fg: "accent" }).sgr() : new Style({ fg: "line" }).sgr();
      const branch = e.focused ? (last_in_group ? "┗" : "┣") : last_in_group ? "╰" : "├";
      w.write(`\x1b[${y + 1};${x + 1}H${rail}${row_bg}${branch}`);
      if (!last_in_group && y + 1 < v.listEnd()) w.write(`\x1b[${y + 2};${x + 1}H${e.focused ? "┃" : "│"}`);
      w.write(`\x1b[0m${row_bg}`);
    }
    const dot = indicator(e, selected);
    w.write(`\x1b[${y + 1};${x + 2}H\x1b[22m${dot.color}${dot.icon}`);
    const room = v.width - 6;
    // Within a group, a dotted line under the text separates agents. Only
    // Kitty-graphics hosts get it; elsewhere the style could degrade to a
    // solid underline, so those terminals get no separator at all.
    const dotted = grouped && !last_in_group && v.supports_kitty_graphics;
    const line = ghost ? ghost_underline : dotted ? dotted_underline : divider ? rule_underline : "";
    // Dotted lines start under the name, leaving the guide and activity clear.
    const underline_x = dotted ? 5 : 2;
    const compacting = e.state === "working" && e.compacting;
    const waiting = e.state === "working" && e.subagents.waiting && !compacting;
    // Without sleeping corgis, a dim Z marks an idle agent; unseen ones are
    // brighter. Selected rows take muted, as faint is too dim on them.
    const napping = e.state === "idle" && !v.sleeping_corgis;
    const activity = View.activityGlyph(e, waiting, napping, View.spinnerFrame(compacting, now_ms));
    const activity_color = selected
      ? "\x1b[22m" + fg("muted")
      : napping && e.attention !== "finished"
        ? "\x1b[22m" + nap_fg
        : "\x1b[22m" + fg("faint");
    const provider = e.name.length > 0 ? directoryLabel(e.name, null, 160) : (e.provider ?? "");
    const figure = contextFigure(e, compacting, background);
    const figure_width = figure ? displayWidth(figure.text) : 0;
    w.write(
      `\x1b[${y + 1};${x + 5}H${dot.unread || (grouped && e.focused) ? "\x1b[1m" + fg("strong") : "\x1b[22m" + fg("text")}`,
    );
    writeEllipsis(w, provider, sat(room, figure_width + (figure_width > 0 ? 1 : 0)));
    w.write("\x1b[22m");
    if (figure) {
      w.write(`\x1b[${y + 1};${x + v.width - 1 - figure_width}H`);
      w.write(fgRgb(figure.color));
      w.write(figure.text);
    }
    // Underline the existing second row, including its padding, without
    // consuming another terminal row or changing the entry hit area.
    w.write(`\x1b[${y + 2};${x + underline_x}H${line}`);
    w.splat(" ", v.width - 1 - underline_x);
    w.write(
      `\x1b[${y + 2};${x + 2}H${dotted ? "\x1b[24m" : ""}${activity_color}${activity}\x1b[${y + 2};${x + 5}H${dotted ? line : ""}` +
        fg("text"),
    );
    const detail = compacting
      ? "Compacting…"
      : waiting
        ? "Waiting on agents"
        : e.state === "working"
          ? e.activity
          : e.state === "blocked"
            ? "Needs input"
            : e.state === "initializing"
              ? "Starting session"
              : e.state === "done"
                ? "Session ended"
                : "";
    const badge = subagentBadge(e.subagents, e.children);
    const badge_width = displayWidth(badge);
    const detail_room = sat(room, badge_width + (badge_width > 0 ? 1 : 0));
    const animation_key = animationKey(e);
    const fallback = e.state === "working" && !compacting && !waiting && e.activity.length === 0;
    // Narrow rows keep the text; the pile beside it still moves.
    const herding = compacting && detail_room >= corgiAnimation.herd_width;
    const mode: corgiAnimation.Mode = herding
      ? "herding"
      : fallback
        ? "awake"
        : e.state === "idle" && v.sleeping_corgis
          ? "asleep"
          : "content";
    const presentation = corgiAnimation.observe(animation_key, mode, now_ms);
    // Unseen and focused naps stay bright; only the list's dreamer puffs.
    const sleep = new corgiAnimation.Sleep({
      background,
      bright: e.focused || e.attention === "finished",
      selected,
      puff_ms: dream && dream.key === animation_key ? dream.puff_ms : null,
    });
    if (mode === "herding") {
      w.write(presentation!.writeHerding(detail_room, now_ms));
    } else if (mode !== "content") {
      w.write(presentation!.writeCorgi(detail_room, e.state === "working", sleep));
    } else {
      // Lifecycle signals (blocked/ended/etc.) must be immediate.
      // Interrupts already switch straight to the sleeping mode.
      if (e.state !== "working" && presentation) presentation.skipReveal();
      // No detail stays blank; directoryLabel would print "?" for it.
      const text = detail.length === 0 ? "" : directoryLabel(detail, null, 512);
      if (presentation !== null && presentation.reveal_started_ms !== null) {
        w.write(presentation.writeCorgi(detail_room, e.state === "working", sleep));
        w.write(`\x1b[${y + 2};${x + 5}H` + fg("text"));
        writeRevealedDetail(
          w,
          text,
          detail_room,
          presentation.revealedColumns(detail_room, now_ms),
          presentation.revealPosition(detail_room, now_ms),
        );
      } else writeEllipsis(w, text, detail_room);
    }
    if (badge_width > 0) {
      const color = e.subagents.blocked > 0 ? fg("warm") : fg("accent");
      w.write(`\x1b[${y + 2};${x + v.width - 1 - badge_width}H${color}${badge}`);
    }
    w.write("\x1b[24;59m");
    // Without the group rail, the focused agent takes the active workspace's bar.
    const bar = ghost ? ghost_bar : e.focused && !grouped ? active_bar : "";
    if (bar.length > 0) for (let row = 0; row < 2; row++) w.write(`\x1b[${y + row + 1};${x + 1}H${bar}\x1b[0m`);
  }
  /** A workspace or worktree group's header. A worktree's under a workspace
   * branches off the workspace's rail with `lead`; a ghost's leaves that
   * column to the outline. `stuck` marks the lowest pinned header. */
  drawHeader(w: Writer, e: Entry, y: number, lead: string, stuck: boolean): void {
    const v = this;
    const g = e.group;
    const row_bg = e.focused ? selected_bg : bg("bg");
    // Pinned, it underlines its row where the list scrolls beneath.
    w.write(`\x1b[${y + 1};1H\x1b[0m${row_bg}${stuck ? rule_underline : ""}`);
    w.splat(" ", v.width - 1);
    if (lead.length > 0) w.write(`\x1b[${y + 1};1H` + fg("line") + lead);
    const arrow_x = lead.length;
    w.write(`\x1b[${y + 1};${arrow_x + 1}H` + fg("muted") + (g.folded ? "▸" : "▾"));
    // Right side: working and attention counts, then the agent count.
    const count = compactCount(g.agents);
    const count_x = sat(sat(v.width, 2), displayWidth(count));
    const working = g.working > 0 ? `${compactCount(g.working)}▶` : "";
    const attention = g.attention > 0 ? `${compactCount(g.attention)}●` : "";
    const both = working.length > 0 && attention.length > 0;
    const status_width = displayWidth(working) + displayWidth(attention) + (both ? 1 : 0);
    const status_x = sat(count_x, status_width + (status_width > 0 ? 1 : 0));
    w.write(`\x1b[${y + 1};${count_x + 1}H${count}`);
    if (status_width > 0)
      w.write(
        `\x1b[${y + 1};${status_x + 1}H\x1b[1m` +
          fg("accent") +
          `${working}${both ? " " : ""}` +
          fg("warm") +
          `${attention}\x1b[22m`,
      );
    let name_x = arrow_x + 2;
    if ("worktree" in e.target) {
      w.write(`\x1b[${y + 1};${name_x + 1}H` + fg("faint") + "⌥");
      name_x += 2;
    }
    // Name, then a rule that leaves one space on each side.
    const text = directoryLabel(e.name, null, 160);
    const name_room = sat(status_x, name_x + 3);
    w.write(`\x1b[${y + 1};${name_x + 1}H${g.current ? "\x1b[1m" + fg("strong") : "\x1b[1m" + fg("text")}`);
    writeEllipsis(w, text, name_room);
    const name_end = name_x + Math.min(displayWidth(text), name_room);
    if (status_x > name_end + 2) {
      // A heavy, bright rule so each header stands out from its agents; a
      // worktree inside a workspace takes a thin one.
      w.write(`\x1b[${y + 1};${name_end + 2}H\x1b[22m` + (lead.length > 0 ? fg("line") : fg("muted")));
      w.write((lead.length > 0 ? "─" : "━").repeat(Math.max(0, status_x - 1 - (name_end + 1))));
    }
    w.write("\x1b[22;24;59m");
  }
  drawGhost(w: Writer, e: Entry, y: number): void {
    if (!e.worktree?.ghost) return;
    const style = new Style({ fg: "faint", bg: "bg" }).sgr(),
      height = View.height(e),
      right = this.width - 2;
    for (let row = y; row < Math.min(y + height, this.listEnd()); row++) {
      w.write(`\x1b[${row + 1};1H${style}┊\x1b[${row + 1};${right + 1}H┊`);
    }
    if ("worktree" in e.target) w.write(`\x1b[${y + 1};1H${style}╭${"┄".repeat(right - 1)}╮`);
    if (e.worktree.end && y + height <= this.listEnd())
      w.write(`\x1b[${y + height};1H${style}╰${"┄".repeat(right - 1)}╯`);
  }
  scopeStart(): number {
    if (this.framed()) return this.lists().scopeStart() + lists_x;
    // Compact headers keep one cell for the name and one for the arrow.
    return this.width >= 22 ? 9 : 8;
  }
  scopeArrow(): string {
    if (this.framed()) return this.lists().scopeArrow();
    return this.width >= 22 ? " ▾" : "▾";
  }
  scopeQualifier(): string {
    if (this.framed()) return this.lists().scopeQualifier();
    const room = sat(sat(this.width, 11), this.scopeStart() - 1 + displayWidth(this.scopeArrow()));
    const out = new Writer();
    writeEllipsis(out, directoryLabel(this.scope_label, null, 160), room);
    // The qualifier is written into a 163-byte buffer.
    return out.buffered();
  }
  drawScope(w: Writer): void {
    const v = this;
    if (v.middle() >= v.rows - 1) return;
    w.write(`\x1b[${v.middle() + 1};2H\x1b[1m` + fg("strong"));
    // Stop before the New button's leading space.
    const room = sat(v.width, 11);
    writeClipped(w, "agents", room);
    const qualifier = v.scopeQualifier();
    if (qualifier.length > 0) {
      w.write("\x1b[22m" + fg("faint") + (v.scopeStart() === 9 ? ": " : " ") + "\x1b[1m" + fg("muted"));
      w.write(qualifier);
    }
    w.write("\x1b[22m" + fg("faint") + v.scopeArrow());
  }
  line(w: Writer, y: number, text: string, style: string): void {
    if (y >= this.rows) return;
    w.write(`\x1b[${y + 1};2H${style}`);
    writeClipped(w, text, this.width - 3);
  }
}
const mod = (a: number, b: number) => ((a % b) + b) % b;

/** Context colors for the row figure and the card's meter: muted, warm from
 * 70% of the way to compaction, hot from 85%, faded into the background while
 * the agent compacts. */
export function contextColor(
  band: "calm" | "near" | "high",
  compacting: boolean,
  background: palette.Rgb,
): palette.Rgb {
  const tone = band === "calm" ? colors.muted : band === "near" ? colors.warm : colors.hot;
  return compacting ? mix(tone, background, 60) : tone;
}
/** Context appears on the name line only near compaction. */
function contextFigure(
  e: Entry,
  compacting: boolean,
  background: palette.Rgb,
): { text: string; color: palette.Rgb } | null {
  if (e.state === "done") return null;
  const band = e.context.band();
  if (band === null || band === "calm") return null;
  const percent = BigInt(e.context.percent());
  const text = `${percent < 999n ? percent : 999n}%`;
  return { text, color: contextColor(band, compacting, background) };
}
export function animationKey(e: Entry): bigint {
  if ("pane" in e.target) return BigInt(e.target.pane) * 17n;
  if ("native" in e.target) return (BigInt(e.target.native) + 0x100000000n) * 17n;
  if ("asleep" in e.target) return BigInt(Bun.hash.wyhash(e.target.asleep, 0n)) + (1n << 64n);
  throw Error("unreachable");
}
function subagentBadge(status: Subagents, children: number): string {
  const running = compactCount(status.running);
  const blocked = compactCount(status.blocked);
  if (status.blocked > 0) return status.running > 0 ? `↳${running} !${blocked}` : `↳!${blocked}`;
  if (status.running > 0) return `↳${running}`;
  if (children > 0) return `↳${compactCount(children)}`;
  return "";
}

/** Resource hover stays on the third workspace row. Clicks and drags on that
 * row select the workspace, just like its title and status rows. */
export function resourceAt(v: View, workspaces: WorkspaceEntry[], x: number, y: number): WorkspaceEntry | null {
  if (v.framed()) return resourceAt(v.lists(), workspaces, x - lists_x, y);
  if (
    v.workspaceRows() < 3 ||
    v.width === 0 ||
    x < 1 ||
    x >= v.width - 2 ||
    y < 4 ||
    y >= v.workspaceEnd() ||
    (y - 2) % 3 !== 2
  )
    return null;
  const i = Math.floor((y - 2) / 3);
  if (i >= v.workspaceCapacity() || i + v.workspace_offset >= workspaces.length) return null;
  const ws = workspaces[i + v.workspace_offset];
  if (!resourceCardFits(v)) return null;
  for (let reading = 0; reading < 2; reading++) if (shownReading(v.resources, ws.resources, reading)) return ws;
  return null;
}
function resourceCardFits(v: View): boolean {
  return resourceTooltip.geometry(v.cols, v.rows, v.sidebarWidth(), 0) !== null;
}
/** Whether the row shows CPU (0) or memory (1). Disk I/O is only in the hover card. */
function shownReading(prefs: { enabled: boolean }, work: Work, reading: number): boolean {
  const available = reading === 0 ? work.cpu !== null : work.memory !== null;
  return prefs.enabled && available;
}
/** `tinted` rows sit on the selected background, which takes muted or brighter. */
export function drawResources(w: Writer, work: Work, v: View, hovered: boolean, tinted: boolean): void {
  const width = sat(v.width, 3);
  const prefs = v.resources;
  const details = resourceCardFits(v) && width >= 2 && (shownReading(prefs, work, 0) || shownReading(prefs, work, 1));
  const hover = details && hovered;
  const normal = hover ? "\x1b[22m" + fg("text") : tinted ? "\x1b[22m" + fg("muted") : "\x1b[22m" + fg("faint");
  if (hover) w.write(selected_bg);
  const readings_width = width - (details ? 2 : 0);
  const values = [cpuText(work.cpu), memoryText(work.memory as any)];
  const names = [
    ["CPU", "C"],
    ["Memory", "Mem", "M"],
  ];
  values.forEach((value, i) => {
    const choices = names[i];
    const room = i === 1 ? readings_width - Math.floor(readings_width / 2) : Math.floor(readings_width / 2);
    // The longest label that leaves room for a five-character value
    // (1234%, 12.3G) and, after CPU, a one-column gap.
    const label = choices.find(name => room >= name.length + 1 + 5 + (i === 0 ? 1 : 0)) ?? choices[choices.length - 1];
    if (value.length === 0 || !shownReading(prefs, work, i)) {
      w.splat(" ", room);
      return;
    }
    // Only CPU alerts.
    w.write(i === 0 && work.cpu_pressure ? "\x1b[22m" + fg("warm") : normal);
    w.write(label);
    if (room >= 7) w.write(" ");
    const used = label.length + (room >= 7 ? 1 : 0);
    writeClipped(w, value, sat(room, used) - (i === 0 ? 1 : 0));
    const printed = used + Math.min(displayWidth(value), sat(room, used) - (i === 0 ? 1 : 0));
    w.splat(" ", sat(room, printed));
  });
  if (details) {
    w.write(normal);
    w.write(" ›");
  }
  w.write("\x1b[22m");
}

export function agentAt(v: View, entries: Entry[], x: number, y: number): Entry | null {
  const index = agentIndexAt(v, entries, x, y);
  return index === null ? null : entries[index];
}
/** `agentAt` as an index into `entries`. */
export function agentIndexAt(v: View, entries: Entry[], x: number, y: number): number | null {
  const found = v.hit(x, y);
  if (found.tag !== "entry" || found.entry >= entries.length) return null;
  const e = entries[found.entry];
  return e.exit === null && isAgent(e.target) ? found.entry : null;
}

// Fade both the card background and its foreground/underline colors into the
// sidebar panel. All cursor positions and glyphs stay fixed until removal.
export function writeExit(w: Writer, frame: string, progress: number): void {
  const t = clamp(progress, 0, 1);
  const opacity = 1 - t * t * (3 - 2 * t);
  let i = 0;
  let out = "";
  while (i < frame.length) {
    if (frame.startsWith("\x1b[", i)) {
      let end = i + 2;
      while (end < frame.length && (frame.charCodeAt(end) < 0x40 || frame.charCodeAt(end) > 0x7e)) end++;
      if (end < frame.length && frame[end] === "m") {
        out += "\x1b[";
        let p = i + 2;
        while (p < end) {
          const params = frame.slice(p, end);
          const prefix = ["38;2;", "48;2;", "58:2::"].find(candidate => params.startsWith(candidate)) ?? null;
          if (prefix !== null) {
            const separator = prefix[2] === ":" ? ":" : ";";
            let cursor = p + prefix.length;
            const color = [0, 0, 0];
            let valid = true;
            for (let n = 0; n < 3; n++) {
              const start = cursor;
              while (cursor < end && frame.charCodeAt(cursor) >= 48 && frame.charCodeAt(cursor) <= 57) cursor++;
              const digits = frame.slice(start, cursor);
              const value = digits.length > 0 ? Number(digits) : NaN;
              if (!(value >= 0 && value <= 255)) {
                valid = false;
                break;
              }
              const background = colors.bg[n];
              color[n] = Math.round(background + (value - background) * opacity);
              if (n < 2) {
                if (cursor >= end || frame[cursor] !== separator) {
                  valid = false;
                  break;
                }
                cursor++;
              }
            }
            if (valid) {
              out += `${prefix}${color[0]}${separator}${color[1]}${separator}${color[2]}`;
              p = cursor;
              continue;
            }
          }
          out += frame[p];
          p++;
        }
        out += "m";
        i = end + 1;
        continue;
      }
    }
    out += frame[i];
    i++;
  }
  w.write(out);
}
function statusPart(w: Writer, text: string, style: string, room: { value: number }): void {
  w.write("\x1b[22m");
  w.write(style);
  writeClipped(w, text, room.value);
  room.value = sat(room.value, displayWidth(text));
}
// Clip the final (already ellipsized) text, so the ellipsis does not move with
// the wipe. Opaque padding covers the old dog even for a short/empty label.
export function writeRevealedDetail(
  w: Writer,
  text: string,
  room: number,
  revealed: number,
  edge: number | null,
): void {
  const final = new Writer();
  writeEllipsis(final, text, room);
  let used = 0;
  const limit = Math.min(room, revealed);
  for (const ch of final.buffered()) {
    const width = codepointWidth(ch.codePointAt(0)!);
    if (used + width > limit) break;
    if (edge !== null) {
      // The three cells behind the edge brighten continuously between
      // column steps; smoothstep avoids a sudden brightness jump.
      const t = clamp((edge - (used + width)) / corgiAnimation.Presentation.reveal_feather, 0, 1);
      const amount = t * t * (3 - 2 * t);
      const dim = colors.faint;
      const bright = colors.text;
      const color = dim.map((from, i) => zigRound(from + (bright[i] - from) * amount)) as palette.Rgb;
      w.write(fgRgb(color));
    }
    w.write(ch);
    used += width;
  }
  w.splat(" ", limit - used);
  if (edge !== null) w.write(fg("text"));
}

// OSC 8 belongs to the outer terminal: its usual link gesture opens the URL.
export function drawPorts(w: Writer, ws: WorkspaceEntry, width: number, divider: boolean): void {
  portLine(w, ws, width, null, divider);
}
function gitColumn(workspaces: WorkspaceEntry[]): number {
  let width = 4;
  for (const ws of workspaces)
    if (ws.git_ahead !== null && ws.git_ahead !== undefined)
      width = Math.max(width, 1 + displayWidth(compactCount(ws.git_ahead)));
  return width;
}
export function linkRange(v: View, ws: WorkspaceEntry, workspaces: WorkspaceEntry[]): { start: number; end: number } {
  if (v.framed()) {
    const range = linkRange(v.lists(), ws, workspaces);
    return { start: range.start + lists_x, end: range.end + lists_x };
  }
  const count = urlCount(ws);
  const label = portLabel(ws);
  const end = sat(sat(v.width, 2), gitColumn(workspaces));
  const width = count > 0 ? Math.min(displayWidth(label), sat(end, 4)) : 0;
  return { start: end - width, end };
}
/** Resolve names through the same deduplicated URL selection used by clicks. */
export function workspaceUrlName(ws: WorkspaceEntry, index: number): string {
  const target = workspaceUrl(ws, index);
  if (target === null) return "";
  for (const endpoint of portEndpoints(ws.ports, ws.id)) {
    const candidate = portUrl(endpoint as any, ws.remote_links);
    if (candidate === null) continue;
    if (target === candidate && (endpoint.label ?? "").length > 0) return endpoint.label!;
  }
  return "";
}
function workspaceUrlPending(ws: WorkspaceEntry, index: number): boolean {
  if (workspaceUrlName(ws, index).length > 0) return false;
  const target = workspaceUrl(ws, index);
  if (target === null) return false;
  for (const endpoint of portEndpoints(ws.ports, ws.id)) {
    const candidate = portUrl(endpoint as any, ws.remote_links);
    if (candidate === null) continue;
    if (target === candidate && endpoint.label_pending) return true;
  }
  return false;
}
function portPending(ws: WorkspaceEntry): boolean {
  for (let i = 0; i < urlCount(ws); i++) if (workspaceUrlPending(ws, i)) return true;
  return false;
}
/** The link button's name, empty when it has none, or null while inference is
 * still naming it. */
export function portName(ws: WorkspaceEntry): string | null {
  let name = workspaceUrlName(ws, 0);
  // A common name is useful for duplicate app endpoints; distinct apps keep
  // the generic chooser label and their individual names inside the menu.
  for (let i = 1; i < Math.max(1, urlCount(ws)); i++)
    if (name !== workspaceUrlName(ws, i)) {
      name = "";
      break;
    }
  return name.length === 0 && portPending(ws) ? null : name;
}
export function portLabel(ws: WorkspaceEntry): string {
  const count = urlCount(ws);
  // A name stands alone; without one the button says what it does.
  const name = portName(ws) ?? "Open ...";
  const text = name.length > 0 ? name : "Open Link";
  return count === 1 ? `${text} ↗` : `${text} ↗ ${count}`;
}
/** A label still `naming` its link starts "Open ...". Keep all three dots in
 * place; only their brightness travels gently. Quantized to 80ms so idle
 * viewers do not emit a different frame every poll. */
export function writePortLabel(w: Writer, label: string, width: number, naming: boolean, now_ms: number): void {
  if (!naming) return writeClipped(w, label, width);
  writeClipped(w, "Open ", width);
  for (let i = 0; i < Math.min(3, sat(width, 5)); i++) {
    const phase = mod(Math.floor(now_ms / 80) * 80 - i * 160, 1800);
    const glow = phase < 640 ? 320 - Math.abs(phase - 320) : 0;
    const color = mix(colors.muted, colors.strong, Math.floor((glow * 100) / 320));
    w.write(fgRgb(color));
    w.write(".");
  }
  w.write(fg("text"));
  if (width > 8) writeClipped(w, Buffer.from(label).subarray(8).toString(), width - 8);
}
function statusMetadataWidth(ws: WorkspaceEntry): number {
  return displayWidth(worktreeLabel(ws)) || displayWidth(compactCount(ws.stats.tools)) + 1;
}
export function worktreeLabel(ws: WorkspaceEntry): string {
  const count = worktrees.linked(ws.worktrees).length;
  return count ? `${count} worktree${count === 1 ? "" : "s"}` : "";
}
export function worktreeBadge(v: View, workspaces: WorkspaceEntry[], id: number): Rect | null {
  const index = workspaces.findIndex(ws => ws.id === id),
    slot = index - v.workspace_offset;
  if (v.width === 0 || index < 0 || slot < 0 || slot >= v.workspaceCapacity()) return null;
  const width = displayWidth(worktreeLabel(workspaces[index]));
  return width ? new Rect(v.width - 2 - width, 3 + slot * v.workspaceRows(), width, 1) : null;
}
export function worktreeAt(v: View, workspaces: WorkspaceEntry[], x: number, y: number): WorkspaceEntry | null {
  if (v.framed()) return worktreeAt(v.lists(), workspaces, x - lists_x, y);
  if (v.width === 0 || y < 3 || (y - 3) % v.workspaceRows() !== 0) return null;
  const hit = v.hit(x, y);
  if (hit.tag !== "workspace") return null;
  const ws = workspaces[hit.workspace];
  const width = ws ? displayWidth(worktreeLabel(ws)) : 0;
  return width && x >= v.width - 2 - width && x < v.width - 2 ? ws : null;
}
export function portLink(v: View, workspaces: WorkspaceEntry[], x: number, y: number): string | null {
  const ws = portWorkspace(v, workspaces, x, y);
  if (ws === null) return null;
  return urlCount(ws) === 1 ? workspaceUrl(ws, 0) : null;
}
// Only confirmed browser URLs participate; duplicate binds collapse to one link.
export function workspaceUrl(ws: WorkspaceEntry, wanted: number): string | null {
  const endpoints = portEndpoints(ws.ports, ws.id);
  let count = 0;
  for (let i = 0; i < endpoints.length; i++) {
    const target = portUrl(endpoints[i] as any, ws.remote_links);
    if (target === null) continue;
    let duplicate = false;
    for (const previous of endpoints.slice(0, i)) {
      const other = portUrl(previous as any, ws.remote_links);
      if (other !== null && target === other) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    if (count === wanted) return target;
    count += 1;
  }
  return null;
}
export function urlCount(ws: WorkspaceEntry): number {
  let count = 0;
  while (workspaceUrl(ws, count) !== null) count += 1;
  return count;
}
export function portWorkspace(v: View, workspaces: WorkspaceEntry[], x: number, y: number): WorkspaceEntry | null {
  if (v.framed()) return portWorkspace(v.lists(), workspaces, x - lists_x, y);
  if (v.width === 0 || x < 1 || y < 2 || y >= v.workspaceEnd() || (y - 2) % v.workspaceRows() !== 0) return null;
  const offset = Math.floor((y - 2) / v.workspaceRows());
  const index = v.workspace_offset + offset;
  if (offset >= v.workspaceCapacity() || index >= workspaces.length) return null;
  const ws = workspaces[index];
  const link = linkRange(v, ws, workspaces);
  if (x < link.start || x >= link.end) return null;
  return ws;
}
function portLine(
  w: Writer | null,
  ws: WorkspaceEntry,
  width: number,
  hitColumn: number | null,
  divider: boolean,
): string | null {
  const count = urlCount(ws);
  if (count === 0) return null;
  const label = portLabel(ws);
  if (count === 1) {
    const target = workspaceUrl(ws, 0)!;
    if (hitColumn !== null && hitColumn < Math.min(displayWidth(label), width)) return target;
    if (w) w.write(`\x1b]8;id=corgi-port-${ws.id};${target}\x1b\\`);
  }
  if (w) {
    w.write("\x1b[4m" + fg("text"));
    writePortLabel(w, label, width, portName(ws) === null, Date.now());
    if (count === 1) w.write("\x1b]8;;\x1b\\");
    w.write("\x1b[24m" + fg("muted"));
    if (divider) w.write(rule_underline);
  }
  return null;
}

/** Hover popover under the agents header for choosing which agents are listed. */
export class ScopeMenu {
  pinned = false;
  hovered: Scope | null = null;
  constructor(fields: Partial<ScopeMenu> = {}) {
    Object.assign(this, fields);
  }
  static bounds(side: View, cols: number, rows: number): Rect {
    const y = side.middle() + 1;
    const width = Math.min(sat(cols, 1 + lists_x), Math.max(sat(side.width, 2 + lists_x), 26));
    const height = Math.min(4, sat(sat(rows, 1), y));
    return new Rect(1 + lists_x, y, width, height);
  }
  static hit(side: View, cols: number, rows: number, x: number, y: number): Scope | null {
    const b = ScopeMenu.bounds(side, cols, rows);
    if (b.h < 4) return null;
    const index = dropdown.hit(b, scopes.length, x, y);
    return index === null ? null : scopes[index];
  }
  draw(w: Writer, side: View, cols: number, rows: number, workspaces: WorkspaceEntry[], scope: Scope): void {
    const b = ScopeMenu.bounds(side, cols, rows);
    if (b.h < 4 || b.w < 16) return;
    let total = 0;
    let current = 0;
    for (const ws of workspaces) {
      total += ws.agents;
      if (ws.active) current = ws.agents;
    }
    dropdown.draw(
      w,
      b,
      scopes.map(option => ({
        text: option === "workspace" ? "This workspace" : "All",
        note: compactCount(option === "workspace" ? current : total),
        current: option === scope,
        hovered: this.hovered === option,
      })),
    );
  }
}
/** The scope menu's rows, top to bottom. */
const scopes: Scope[] = ["workspace", "all"];

export class PortMenu {
  selected = 0;
  constructor(
    public workspace: number,
    selected = 0,
  ) {
    this.selected = selected;
  }
  static bounds(cols: number, rows: number): Rect {
    const width = Math.min(cols, 64);
    const height = Math.min(rows, 14);
    return new Rect(Math.floor((cols - width) / 2), Math.floor((rows - height) / 2), width, height);
  }
  static capacity(rows: number): number {
    return Math.max(1, sat(Math.min(rows, 14), 3));
  }
  hit(ws: WorkspaceEntry, cols: number, rows: number, x: number, y: number): number | null {
    const rect = PortMenu.bounds(cols, rows);
    if (x <= rect.x || x >= sat(rect.x + rect.w, 1) || y < rect.y + 2 || y >= sat(rect.y + rect.h, 1)) return null;
    const selected = Math.min(this.selected, sat(urlCount(ws), 1));
    const index = Math.floor(selected / PortMenu.capacity(rows)) * PortMenu.capacity(rows) + y - rect.y - 2;
    return index < urlCount(ws) ? index : null;
  }
  draw(w: Writer, ws: WorkspaceEntry, cols: number, rows: number): void {
    const rect = PortMenu.bounds(cols, rows);
    if (rect.w < 8 || rect.h < 4) return;
    for (let row = 0; row < rect.h; row++) {
      w.write(`\x1b[${rect.y + row + 1};${rect.x + 1}H` + new Style({ fg: "muted", bg: "surface" }).sgr());
      w.splat(" ", rect.w);
    }
    w.write(`\x1b[${rect.y + 1};${rect.x + 2}H`);
    writeClipped(w, "Links · Esc to close", rect.w - 2);
    const count = urlCount(ws);
    const selected = Math.min(this.selected, sat(count, 1));
    const offset = Math.floor(selected / PortMenu.capacity(rows)) * PortMenu.capacity(rows);
    for (let index = offset; index < Math.min(count, offset + PortMenu.capacity(rows)); index++) {
      const url = workspaceUrl(ws, index);
      if (url === null) continue;
      w.write(
        `\x1b[${rect.y + 3 + index - offset};${rect.x + 1}H${index === selected ? fg("text") + selected_bg : fg("text") + bg("surface")} ${index === selected ? "›" : " "} \x1b]8;id=corgi-popup-${ws.id}-${index};${url}\x1b\\`,
      );
      const name = workspaceUrlName(ws, index);
      const naming = name.length === 0 && workspaceUrlPending(ws, index);
      const label = name.length > 0 ? `${name} · ${url}` : naming ? `Open ... · ${url}` : url;
      writePortLabel(w, label, rect.w - 4, naming, Date.now());
      w.write("\x1b]8;;\x1b\\");
    }
  }
}

/** Warm while commits wait to be pushed, accent while pushing or just pushed, hot when it failed. */
function gitColor(phase: GitPush["phase"]): string {
  switch (phase) {
    case "idle":
      return fg("warm");
    case "pushing":
    case "succeeded":
      return fg("accent");
    case "failed":
      return fg("hot");
  }
}
/** Keep the right edge fixed: expansion covers the name, never moves the badge. */
export function gitLabel(ws: WorkspaceEntry, expanded: boolean): string {
  switch (ws.git_push.phase) {
    case "pushing": {
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      const i = mod(Math.floor(Date.now() / 80), frames.length);
      return ` Pushing ${frames[i]}`;
    }
    case "succeeded":
      return " Pushed ✓";
    case "failed":
      return " Retry !";
    case "idle":
      break;
  }
  const count = ws.git_ahead;
  if (count === null || count === undefined || count === 0) return "";
  return `${expanded ? " Push " : ""}↑${compactCount(count)}`;
}
export function gitWorkspace(v: View, workspaces: WorkspaceEntry[], x: number, y: number): WorkspaceEntry | null {
  return gitActionWorkspace(v, workspaces, null, x, y);
}
export function gitActionWorkspace(
  v: View,
  workspaces: WorkspaceEntry[],
  expanded: number | null,
  x: number,
  y: number,
): WorkspaceEntry | null {
  if (v.framed()) return gitActionWorkspace(v.lists(), workspaces, expanded, x - lists_x, y);
  if (v.width === 0 || y < 2 || (y - 2) % v.workspaceRows() !== 0) return null;
  const found = v.hit(x, y);
  if (found.tag !== "workspace" || found.workspace >= workspaces.length) return null;
  const ws = workspaces[found.workspace];
  const size = displayWidth(gitLabel(ws, expanded === ws.id));
  const end = v.width - 2;
  return size > 0 && x >= sat(end, size) && x < end ? ws : null;
}
export function drawGitAction(w: Writer, v: View, workspaces: WorkspaceEntry[], id: number): void {
  if (v.width === 0) return;
  const shown = workspaces.slice(
    v.workspace_offset,
    Math.min(workspaces.length, v.workspace_offset + v.workspaceCapacity()),
  );
  for (let i = 0; i < shown.length; i++) {
    const ws = shown[i];
    if (ws.id !== id) continue;
    const label = gitLabel(ws, true);
    if (label.length === 0) return;
    const style =
      ws.git_push.phase === "idle"
        ? new Style({ fg: "warm", bg: "selected", bold: true }).sgr()
        : ws.git_push.phase === "failed"
          ? new Style({ fg: "hot", bg: "selected", bold: true }).sgr()
          : new Style({ fg: "accent", bg: "selected", bold: true }).sgr();
    w.write(
      `\x1b]8;;\x1b\\\x1b[${3 + i * v.workspaceRows()};${v.width - 1 - displayWidth(label)}H${style}${label}\x1b[0m`,
    );
    return;
  }
}
function drawGitError(w: Writer, message: string, cols: number, rows: number, px: number, py: number): void {
  const width = Math.min(76, cols);
  const room = width - 4;
  const lines: string[] = [];
  let rest = message;
  while (rest.length > 0 && lines.length < Math.min(20, rows - 5)) {
    // Byte-wise in Zig; whole codepoints here.
    const chars = [...rest];
    let end = 0;
    let used = 0;
    while (end < chars.length) {
      const next = used + codepointWidth(chars[end].codePointAt(0)!);
      if (next > room) break;
      used = next;
      end++;
    }
    if (end < chars.length) {
      const space = chars.slice(0, end).lastIndexOf(" ");
      if (space > 0) end = space;
    }
    if (end === 0) break;
    lines.push(chars.slice(0, end).join(""));
    rest = chars.slice(end).join("").replace(/^ +/, "");
  }
  const height = lines.length + 3;
  const x = Math.min(px + 2, cols - width);
  const y = Math.min(py + 1, rows - 1 - height);
  w.write("\x1b7\x1b]8;;\x1b\\");
  for (let row = 0; row < height; row++) {
    w.write(`\x1b[${y + row + 1};${x + 1}H` + new Style({ fg: "hot", bg: "bg" }).sgr());
    w.write(row === 0 ? "╭" : row === height - 1 ? "╰" : "│");
    w.write((row === 0 || row === height - 1 ? "─" : " ").repeat(width - 2));
    w.write(row === 0 ? "╮" : row === height - 1 ? "╯" : "│");
  }
  w.write(`\x1b[${y + 2};${x + 3}H\x1b[1mPush failed\x1b[22m`);
  lines.forEach((line, i) => w.write(`\x1b[${y + 3 + i};${x + 3}H${line}`));
  w.write("\x1b[0m\x1b8");
}
export function drawGitTooltip(
  w: Writer,
  ws: WorkspaceEntry,
  cols: number,
  rows: number,
  px: number,
  py: number,
): void {
  if (cols < 24 || rows < 8) return;
  if (ws.git_push.phase === "failed") return drawGitError(w, ws.git_push.message, cols, rows, px, py);
  const width = Math.min(76, cols);
  const count = Math.min(ws.git_commits.length, Math.floor((rows - 6) / 2));
  const remaining = sat(ws.git_ahead ?? 0, count);
  const has_footer = remaining > 0 || ws.git_commits.length === 0;
  const height = 3 + count * 2 + (has_footer ? 1 : 0);
  const x = Math.min(px + 2, cols - width);
  const y = Math.min(py + 1, rows - 1 - height);
  const base = new Style({ fg: "text", bg: "bg" }).sgr();
  w.write("\x1b7\x1b]8;;\x1b\\");
  for (let row = 0; row < height; row++) {
    w.write(`\x1b[${y + row + 1};${x + 1}H` + new Style({ fg: "line", bg: "bg" }).sgr());
    w.write(row === 0 ? "╭" : row === height - 1 ? "╰" : "│");
    w.write((row === 0 || row === height - 1 ? "─" : " ").repeat(width - 2));
    w.write(row === 0 ? "╮" : row === height - 1 ? "╯" : "│");
  }
  w.write(`\x1b[${y + 2};${x + 3}H\x1b[1m` + fg("strong"));
  writeEllipsis(w, `↑ ${ws.git_ahead ?? 0} unpushed commit${ws.git_ahead === 1 ? "" : "s"}`, width - 4);
  ws.git_commits.slice(0, count).forEach((item, i) => {
    w.write(`\x1b[${y + 3 + i * 2};${x + 3}H${base}` + fg("muted") + `${item.hash}  ` + fg("text"));
    writeEllipsis(w, item.subject, sat(width - 6, byteLength(item.hash)));
    w.write(`\x1b[${y + 4 + i * 2};${x + 5}H` + fg("faint"));
    const age = relativeTime(item.timestamp, Math.floor(Date.now() / 1000));
    const timing = `${item.date} · ${age}`;
    const author_room = Math.min(24, sat(width - 9, displayWidth(timing)));
    if (author_room > 0) {
      writeEllipsis(w, item.author, author_room);
      w.write(" · ");
    }
    writeEllipsis(
      w,
      timing,
      sat(width - 6, author_room > 0 ? Math.min(displayWidth(item.author), author_room) + 3 : 0),
    );
  });
  if (has_footer) {
    w.write(`\x1b[${y + height - 1};${x + 3}H${base}` + fg("faint"));
    const footer = ws.git_commits.length === 0 ? "Commit details unavailable" : `+${remaining} more`;
    writeEllipsis(w, footer, width - 4);
  }
  w.write("\x1b[0m\x1b8");
}
export function relativeTime(timestamp: number, now: number): string {
  if (timestamp === 0) return "";
  const seconds = Math.abs(now - timestamp);
  if (seconds < 60) return "just now";
  const unit =
    seconds < 3600
      ? { seconds: 60, name: "minute" }
      : seconds < 86400
        ? { seconds: 3600, name: "hour" }
        : seconds < 30 * 86400
          ? { seconds: 86400, name: "day" }
          : seconds < 365 * 86400
            ? { seconds: 30 * 86400, name: "month" }
            : { seconds: 365 * 86400, name: "year" };
  const n = Math.floor(seconds / unit.seconds);
  return `${timestamp > now ? "in " : ""}${n} ${unit.name}${n === 1 ? "" : "s"}${timestamp > now ? "" : " ago"}`;
}
