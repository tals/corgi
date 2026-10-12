//! Viewer-owned navigation, dialogs, input and rendering. Shared mutations
//! are RPC operations. Mirrors controller.zig; methods that call the daemon
//! are async and run one at a time from the viewer loop.
import { hostname } from "node:os";
import { basename, isAbsolute } from "node:path";
import * as keys from "./keys";
import * as keyboard from "./keyboard";
import * as keymap from "./keymap";
import * as bindings from "./bindings";
import * as onboarding from "./onboarding";
import * as shortcutHelp from "./shortcut_help";
import * as palette from "./palette";
import type { Colors as TerminalColors } from "./terminal_palette";
import {
  Rect,
  View as LayoutView,
  Model,
  Selection,
  max_workspaces,
  type Axis,
  type Direction,
  type Divider,
} from "./layout";
import * as render from "./render";
import { ResizeView, TabMenu, type Item as TabMenuItem } from "./commands";
import { Dialog, View as NameView, name_limit } from "./name_dialog";
import * as sidebar from "./sidebar";
import type { Entry, Target, WorkspaceEntry, Scope } from "./sidebar";
import * as agentNavigation from "./agent_navigation";
import * as sidebarFocus from "./sidebar_focus";
import { Picker as AgentPicker } from "./agent_navigation";
import { State as Navigation } from "./navigation";
import * as navigation from "./navigation";
import {
  Runtime,
  call,
  unread,
  acknowledge,
  providerName,
  statsAny,
  type Transport,
  type Pane,
  type Terminal,
  type Workspace,
  type Native,
} from "./mirror";
import { parse as parseAction, needsPane, type Action } from "./action";
import * as corgiBadge from "./corgi_badge";
import * as forkMotion from "./fork_motion";
import { State as SidebarRows } from "./sidebar_rows";
import * as agentLauncher from "./agent_launcher";
import { Menu as LauncherMenu, Row, keyAgent, type Row as LauncherRow } from "./agent_launcher";
import { Stream as LaunchPreviewStream } from "./launch_preview_stream";
import * as launcherResume from "./launcher_resume";
import { Menu as SetupMenu, Summarizer, type Apply as SetupApply } from "./corgi_setup";
import * as shellPicker from "./shell_picker";
import { installedShells } from "./launch/command";
import { State as LinkTooltip, type Target as TooltipTarget } from "./link_tooltip";
import * as resourceTooltip from "./resource_tooltip";
import * as worktreeTooltip from "./worktree_tooltip";
import * as worktreeAgents from "./worktree_agents";
import * as worktreeRemoval from "./worktree_removal";
import * as rpc from "./rpc";
import type { CommandInput } from "./protocol";
import * as worktrees from "./worktrees";
import * as launcherWorktree from "./launcher_worktree";
import * as preferences from "./preferences";
import { Preferences } from "./preferences";
import { Drag as AgentDrag } from "./agent_drag";
import { Drag as WorkspaceDrag } from "./workspace_drag";
import { milliTimestamp, microTimestamp } from "./clock";
import * as ghosttyIntegration from "./ghostty_integration";
import * as hostClipboard from "./host_clipboard";
import type { Pacer } from "./frame_pacing";
import * as pasteCard from "./paste_card";
import * as subagentTooltip from "./subagent_tooltip";
import * as viewerNative from "./viewer_native";
import { Provider } from "./providers";
import { rank } from "./agent_order";
import { sat, byteLength } from "./text";
import * as errors from "./errors";

/** A conversation a pane stopped running, and when, in seconds. */
interface Stopped {
  provider: Provider;
  session: string;
  at: number;
}
export type Effect = { write_terminal: string } | { open_url: string };
interface TabDrag {
  workspace_id: number;
  tab_id: number;
  start_x: number;
  width: number;
  tabs_x: number;
  first: number;
  ids: number[];
  count: number;
  dragging: boolean;
  cancelled: boolean;
  drop: render.TabDrop | null;
}
/** A paste goes to the text field that owned the keyboard when it began, or
 * to the focused pane when none did. */
type Paste = { pane: number } | "launcher" | "setup" | "picker" | "name" | "discard";
interface PasteCard {
  pane: number;
  notice: hostClipboard.Notice;
  /** The button went down on one of its links; its release copies it. */
  pressed: boolean;
  copied: boolean;
}
/** What an input sequence does to the paste card: Esc closes it and does
 * nothing else; a click or any other key closes it and goes on; pointer
 * motion, releases and focus changes leave it open. A click on its link
 * stays with the card, which stays open. */
type CardEffect = "keep" | "close" | "dismiss" | "capture";
export function cardEffect(seq: string): CardEffect {
  if (seq === "\x1b[27u" || seq === "\x1b[27;1u") return "dismiss";
  if (seq.startsWith("\x1b[<")) {
    if (seq[seq.length - 1] === "m") return "keep";
    const semi = seq.indexOf(";");
    if (semi < 0) return "keep";
    const button = parseU16(seq.slice(3, semi));
    if (button === null) return "keep";
    return (button & 32) !== 0 ? "keep" : "close";
  }
  if (seq === "\x1b[I" || seq === "\x1b[O") return "keep";
  return "close";
}
function parseU16(text: string): number | null {
  if (!/^\+?\d+$/.test(text)) return null;
  const value = Number(text);
  return value <= 0xffff ? value : null;
}
/** The paste keys Ghostty passes on as keys when it has no text to paste. */
export function pasteKey(k: keyboard.Key): hostClipboard.Key | null {
  if (k.codepoint !== 118 || k.mods.alt) return null;
  if (k.mods.super && !k.mods.ctrl && !k.mods.shift) return "cmd";
  if (k.mods.ctrl && k.mods.shift && !k.mods.super) return "ctrl_shift";
  return null;
}
/** Whether a wheel report scrolls the tab bar toward later tabs, with either
 * wheel and any modifier; null for other buttons. */
function tabWheel(button: number): boolean | null {
  switch (button & 0xe3) {
    case 64:
    case 66:
      return false;
    case 65:
    case 67:
      return true;
    default:
      return null;
  }
}
/** A pressed link or port row, tracked until release confirms it wasn't a drag. */
interface PortClick {
  x: number;
  y: number;
  url: string;
  menu: number | null;
  pane: number | null;
  px: number;
  py: number;
  drag_selects: boolean;
  cancelled: boolean;
}
const portClick = (fields: Partial<PortClick> & { x: number; y: number }): PortClick => ({
  url: "",
  menu: null,
  pane: null,
  px: 0,
  py: 0,
  drag_selects: false,
  cancelled: false,
  ...fields,
});
class InputState {
  viewer_id = 0;
  last_control = 0n;
  attached = false;
  watched = true;
  /** User input or a window resize since the last sync; the daemon sizes
   * shared panes for the viewer that was used most recently. */
  active = false;
  port_click: PortClick | null = null;
  /** The pane whose app took the held mouse button; its drag and release
   * follow it outside the pane. */
  pane_press: number | null = null;
  /** Where the bracketed paste in progress goes; null outside a paste. */
  paste: Paste | null = null;
  tab_drag: TabDrag | null = null;
  divider: { hit: Divider; area: Rect; cancelled: boolean } | null = null;
  keybuf: number[] = [];
  escape_at = 0;
}
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const nowSeconds = () => Math.floor(Date.now() / 1000);

export class Controller {
  connection: Transport;
  runtime = new Runtime();
  navigation = new Navigation();
  workspace_offset = 0;
  input_state = new InputState();
  effects: Effect[] = [];
  executable = "";
  width = 100;
  height = 30;
  dirty = true;
  prefix = false;
  /** Until when a repeatable prefixed key, pressed again, runs without the prefix. */
  repeat_until = 0;
  /** The sidebar's keyboard cursor, while the sidebar has focus instead of a pane. */
  sidebar_focus: sidebarFocus.State | null = null;
  /** Saved preferences as this viewer last loaded or set them. The sidebar
   * width is live while dragging and saved on release. */
  prefs = new Preferences();
  onboarding: onboarding.State | null = null;
  help = Object.assign(new shortcutHelp.State(), { command_mode: true });
  help_visible = false;
  clipboard: string | null = null;
  menu_page = 0;
  menu_highlight: string | null = null;
  sidebar_open = true;
  corgi_badge: corgiBadge.Mode = "none";
  supports_kitty_graphics = false;
  /** The host's cell in pixels, when it reports it. */
  cell_pixels: forkMotion.Cell | null = null;
  /** Whether the host draws Kitty's branch drawing characters. */
  branch_glyphs = false;
  /** The host's colors, when it reports them; both themes follow them. */
  terminal_colors: TerminalColors | null = null;
  /** The "All" list's scroll; each workspace keeps its own list's. */
  all_offset = 0;
  /** A tab this viewer launched or restored; its agent scrolls into view once listed. */
  launched = 0;
  /** A dormant pane that failed to resume while focused; focusing it again retries. */
  private wake_failed: number | null = null;
  sidebar_rows = new SidebarRows();
  remote_links = false;
  /** The host terminal's clipboard, read over SSH; the paste being read goes to `paste_target`. */
  host_clipboard: hostClipboard.State | null = null;
  /** The host terminal's frame pacing, for Terminal capabilities. */
  host_pacer: Pacer | null = null;
  paste_target: Paste | null = null;
  /** Why a paste brought no image, over the pane it was meant for. */
  paste_card: PasteCard | null = null;
  tab_menu: TabMenu | null = null;
  port_menu: sidebar.PortMenu | null = null;
  /** Workspace ids whose group is folded in the grouped "All" list. */
  folded_groups: number[] = [];
  scope_menu: sidebar.ScopeMenu | null = null;
  agent_picker: AgentPicker | null = null;
  agent_launcher: LauncherMenu | null = null;
  /** The launcher row last left selected in any workspace. */
  launcher_selection: LauncherRow | null = null;
  launch_previews = new LaunchPreviewStream();
  /** Conversations panes run, and recent ones that stopped, with when. */
  running: launcherResume.Open[] = [];
  stopped: Stopped[] = [];
  corgi_setup: SetupMenu | null = null;
  launcher_hover_blocked = false;
  pointer: render.Pointer | null = null;
  iterm2_pointer = false;
  link_tooltip = new LinkTooltip();
  git_hover: number | null = null;
  worktree_card = new worktreeTooltip.State();
  /** The worktree the overview selects once the removed one is gone. */
  private removal_next: string | null = null;
  worktree_agents = new worktreeAgents.State();
  resource_card = new resourceTooltip.State();
  resource_aim: resourceTooltip.Aim | null = null;
  ui_mouse_down = false;
  sidebar_drag: "width" | "split" | null = null;
  agent_drag: AgentDrag | null = null;
  workspace_drag: WorkspaceDrag | null = null;
  resize_mode = false;
  copy_mode = false;
  name_dialog: Dialog | null = null;
  message = "";
  native_notice: number | null = null;
  copy_feedback_until = 0;
  muted = false;
  selection: { pane: number; x: number; y: number; moved: boolean } | null = null;
  /** Panes marked unread from the agent menu, each with whether it had
   * focus when last shown. Showing one doesn't read it until focus moves
   * onto it, it takes input, or it leaves view. */
  marked_unread = new Map<number, boolean>();
  search_mode = false;
  search_text: number[] = [];
  search_skip = 0;
  last_bell_kind = "none";

  constructor(connection: Transport) {
    this.connection = connection;
  }
  private model(): Model {
    return this.current().model;
  }
  private nav(): Selection {
    return this.navigation.tabs(this.runtime.workspaces);
  }
  current(): Workspace {
    return this.navigation.current(this.runtime.workspaces);
  }
  private workspaceIndex(): number {
    return this.navigation.index(this.runtime.workspaces);
  }
  private selectedTab() {
    return this.model().tabs[this.nav().active];
  }
  layoutView(): LayoutView {
    return new LayoutView(this.model(), this.nav());
  }
  private async execute(command: CommandInput): Promise<{ pane: number; workspace: number }> {
    const response = await call(this.connection, "session.command", { command });
    const result = { pane: Number(response.result?.pane ?? 0), workspace: Number(response.result?.workspace ?? 0) };
    await this.refresh();
    if (this.runtime.panes.length === 0 && this.runtime.workspaces.items.length === 1)
      this.input_state.attached = false;
    this.dirty = true;
    return result;
  }
  private async edit(command: CommandInput): Promise<void> {
    await this.execute(command);
  }
  private async moveTab(id: number, gap: number): Promise<void> {
    const operation = navigation.moveTab(this.model(), id, gap);
    if (operation) await this.edit(operation);
  }
  switchWorkspace(id: number): void {
    if (this.runtime.workspaces.index(id) === null) throw Error("NoWorkspace");
    this.rememberAgent();
    if (this.input_state.tab_drag) this.input_state.tab_drag.cancelled = true;
    this.dismissName();
    this.closeMenu();
    this.navigation.workspace_id = id;
    this.visitWorkspace(id);
    this.revealWorkspace();
    this.copy_mode = false;
    this.search_mode = false;
    this.selection = null;
    this.cancelDividers();
    this.message = "";
    this.native_notice = null;
    this.rememberAgent();
    this.dirty = true;
  }
  private async closeWorkspace(id: number, close_contents: boolean): Promise<void> {
    if (this.runtime.workspaces.index(id) === null) throw Error("NoWorkspace");
    if (this.runtime.workspaces.items.length === 1) throw Error("LastWorkspace");
    await this.edit({ "workspace.close": { target: id, close_contents } });
    this.switchWorkspace(this.current().id);
  }
  private revealWorkspace(index = this.workspaceIndex()): void {
    const capacity = this.sidebarView([]).workspaceCapacity();
    if (index < this.workspace_offset) this.workspace_offset = index;
    else if (index >= this.workspace_offset + capacity) this.workspace_offset = index + 1 - capacity;
  }
  /** Moves focus between panes, and from the leftmost one into the sidebar. */
  private async moveFocus(to: Direction): Promise<void> {
    if (this.sidebar_focus) return this.steerSidebar(to, true);
    const intent =
      this.model().count > 0
        ? this.navigation.command(this.runtime.workspaces, { name: "focus", value: to }, this.area())
        : { edit: null, focus: null };
    if (intent.focus !== null) {
      this.focusPane(intent.focus);
      this.copy_mode = false;
    } else if (to === "left") this.enterSidebar();
  }
  /** Gives the sidebar focus, its cursor in `list`, else on the agent list or the
   * current workspace. A folded sidebar opens only for a list, as its drawer. */
  private enterSidebar(list: sidebar.Section | null = null): void {
    this.closeMenu();
    const folded = !this.sidebar_open;
    if (folded && list === null) return;
    this.sidebar_open = true;
    if (this.sidebarView([]).width === 0) {
      this.sidebar_open = !folded;
      return;
    }
    this.copy_mode = false;
    this.search_mode = false;
    this.selection = null;
    this.cancelDividers();
    const entries = this.sidebarEntries(),
      current = this.current().id;
    const cursor = list === "workspaces" ? { workspace: current } : sidebarFocus.initial(current, entries);
    this.sidebar_focus = new sidebarFocus.State(cursor, folded ? list : null);
    this.revealCursor(entries);
    this.dirty = true;
  }
  /** Gives the keyboard back to the focused pane, putting a drawer away. */
  private leaveSidebar(): void {
    const focus = this.sidebar_focus;
    if (!focus) return;
    this.sidebar_focus = null;
    if (focus.drawer) this.sidebar_open = false;
    this.dirty = true;
  }
  /** Focuses `list` in the sidebar; its key again puts its drawer away. */
  private chooseIn(list: sidebar.Section): void {
    if (this.sidebar_focus?.drawer === list) this.leaveSidebar();
    else this.enterSidebar(list);
  }
  /** A plain arrow moves within the focused list; a prefixed one, `across`, between the lists. */
  private async steerSidebar(to: Direction, across: boolean): Promise<void> {
    if (to === "right") return this.openSidebarRow(true);
    if (to === "left") return;
    const entries = this.sidebarEntries();
    if (across) this.sidebar_focus!.cross(this.current().id, entries, to === "up");
    else this.sidebar_focus!.move(this.workspaceIds(), entries, to === "down");
    this.revealCursor(entries);
    this.dirty = true;
  }
  private revealCursor(entries: Entry[]): void {
    const cursor = this.sidebar_focus!.cursor;
    if ("workspace" in cursor) {
      const index = this.runtime.workspaces.index(cursor.workspace);
      if (index !== null) this.revealWorkspace(index);
      return;
    }
    const index = agentNavigation.indexOf(entries, cursor.entry);
    if (index !== null) this.agentOffset().set(this.sidebarView(entries).reveal(index));
  }
  /** Opens the cursor's row as a click would. → opens only a row that leads
   * to a pane; on a header it goes back to the focused pane. */
  private async openSidebarRow(arrow: boolean): Promise<void> {
    const cursor = this.sidebar_focus!.cursor;
    if ("workspace" in cursor) return this.switchWorkspace(cursor.workspace);
    const target = cursor.entry;
    const index = agentNavigation.indexOf(this.sidebarEntries(), target);
    if (index === null) return;
    if (sidebar.isAgent(target)) {
      this.leaveSidebar();
      return this.selectAgent(target);
    }
    if (arrow) return this.leaveSidebar();
    if ("group" in target) return this.selectAgent(target);
    await this.perform({ name: "worktree-agent", value: index });
  }
  /** The agent under the sidebar's cursor, where entering it would put it,
   * while no pane shows it. */
  sidebarGhost(): render.Ghost | null {
    const focus = this.sidebar_focus;
    const cursor = focus?.cursor;
    if (!focus || !cursor || !("entry" in cursor) || !("pane" in cursor.entry)) return null;
    const id = cursor.entry.pane;
    const p = this.pane(id),
      owner = this.runtime.workspaces.owner(id);
    if (!p || !owner) return null;
    if (
      owner.id === this.current().id &&
      this.layoutView()
        .placements(this.area())
        .some(place => place.id === id)
    )
      return null;
    const area = this.area();
    const selection = this.navigation.entering(this.runtime.workspaces, owner, id);
    const place = new LayoutView(owner.model, selection).placements(area).find(place => place.id === id);
    return place ? { pane: p, rect: place.rect, area } : null;
  }
  /** Typing in the focused sidebar searches its agents. */
  private searchSidebar(byte: number): void {
    this.openAgentPicker();
    if (!this.agent_picker) return;
    this.agent_picker.query.key(byte);
    this.pickerEntries();
  }
  /** The list while the sidebar has focus, its cursor the one focused row. */
  private focusEntries(): Entry[] {
    const entries = this.sidebarEntries();
    this.sidebar_focus!.reconcile(this.workspaceIds(), entries);
    return this.sidebar_focus!.mark(entries);
  }
  /** Runs a prefixed binding. Any but a focus move or a drawer's own key
   * takes the keyboard back from the sidebar; a repeatable one opens its
   * repeat window. */
  private async runPrefixed(act: Action, repeats: boolean): Promise<void> {
    this.prefix = false;
    this.repeat_until = repeats ? Date.now() + bindings.repeat_ms : 0;
    if (act.name !== "focus" && act.name !== "choose-workspace" && act.name !== "choose-agent") this.leaveSidebar();
    await this.perform(act);
  }
  /** Whether a repeatable key came again inside its window, which it
   * extends, or else closes. The focused sidebar takes plain arrows itself,
   * but they keep the window open, so focus can leave it the same way. */
  private repeats(act: Action | null): act is Action {
    if (act === null) return false;
    const again = !this.prefix && Date.now() < this.repeat_until;
    this.repeat_until = again ? Date.now() + bindings.repeat_ms : 0;
    return again && !this.sidebar_focus;
  }
  focusPane(id: number): void {
    const owner = this.runtime.workspaces.owner(id);
    if (!owner) throw Error("NoPane");
    this.rememberAgent();
    if (owner.id !== this.current().id) this.switchWorkspace(owner.id);
    this.nav().focus(this.model(), id);
    this.native_notice = null;
    this.rememberAgent();
  }
  area(): Rect {
    return this.sidebarView([]).area();
  }
  sidebarView(entries: Entry[]): sidebar.View {
    const offset = this.agent_picker ? this.agent_picker.offset : this.agentOffset().get();
    let view = sidebar.View.init(
      this.width,
      this.height,
      this.sidebar_open,
      offset,
      entries.length,
      this.prefs.sidebar_split,
    )
      .withSearch(this.agentSearch())
      .withWidth(this.prefs.sidebar_width);
    // Workspace rows, and so paging, depend on whether readings are shown.
    view.resources = this.prefs.resources;
    view.drawer = this.sidebar_focus?.drawer ?? null;
    view = view.withWorkspaces(this.runtime.workspaces.items.length, this.workspace_offset).withEntries(entries);
    view.scope_label = this.scopeLabel();
    return view;
  }
  private agentOffset(): { get(): number; set(value: number): void } {
    if (this.prefs.agents === "workspace") return this.navigation.agentOffset(this.runtime.workspaces);
    return {
      get: () => this.all_offset,
      set: (value: number) => {
        this.all_offset = value;
      },
    };
  }
  /** The list the agent scroll belongs to: the current workspace's, or the "All" list (null). */
  private agentList(): number | null {
    return this.prefs.agents === "workspace" ? this.current().id : null;
  }
  /** Scrolls the agent list where the last viewer left it, when this one shows the same list. */
  restoreAgentScroll(): void {
    const saved = this.prefs.agent_scroll;
    if (saved && saved.workspace === this.agentList()) this.agentOffset().set(saved.offset);
  }
  /** Saves the agent list's scroll for the next viewer, when it moved. */
  saveAgentScroll(): void {
    if (this.runtime.workspaces.items.length === 0) return;
    const scroll = { workspace: this.agentList(), offset: this.agentOffset().get() };
    const saved = this.prefs.agent_scroll;
    if (saved && saved.workspace === scroll.workspace && saved.offset === scroll.offset) return;
    this.prefs.agent_scroll = scroll;
    // Best effort: without it the next viewer starts at the top.
    try {
      preferences.update({ agent_scroll: scroll });
    } catch {}
  }
  private scopeLabel(): string {
    return this.prefs.agents === "workspace" ? this.current().name : "all";
  }
  private inScope(id: number): boolean {
    return this.prefs.agents === "workspace" ? id === this.current().id : true;
  }
  private setAgentScope(scope: Scope): void {
    this.closeMenu();
    this.prefs.agents = scope;
    this.dirty = true;
    try {
      preferences.update({ agents: scope });
    } catch (error) {
      this.notice((error as Error).message);
    }
  }
  loadPreferences(): void {
    this.prefs = preferences.load();
    if (!this.prefs.onboarding_complete)
      this.onboarding = Object.assign(new onboarding.State(), { preset: this.prefs.preset, prefix: this.prefs.prefix });
  }
  private groupFolded(id: number): boolean {
    return this.folded_groups.includes(id);
  }
  private toggleGroup(id: number): void {
    const index = this.folded_groups.indexOf(id);
    if (index >= 0) {
      this.folded_groups[index] = this.folded_groups[this.folded_groups.length - 1];
      this.folded_groups.pop();
    } else if (this.folded_groups.length < max_workspaces) this.folded_groups.push(id);
    this.sidebar_rows.discard();
    if (index >= 0) this.revealGroup({ group: id });
    this.dirty = true;
  }
  private toggleWorktree(selection: worktreeAgents.Selection): void {
    const key = worktreeAgents.key(selection);
    const unfolded = this.worktree_agents.folded.delete(key);
    if (!unfolded) this.worktree_agents.folded.add(key);
    this.sidebar_rows.discard();
    // Folding from a pinned header leaves the header in its own row.
    const entries = this.sidebarEntries();
    const index = worktreeAgents.index(entries, selection);
    if (index >= 0) {
      const view = this.sidebarView(entries);
      this.agentOffset().set(unfolded ? view.revealGroup(index) : view.reveal(index));
    }
    this.dirty = true;
  }
  /** Scrolls a group that just unfolded into view. */
  private revealGroup(header: Target): void {
    const entries = this.sidebarEntries();
    const index = agentNavigation.indexOf(entries, header);
    if (index !== null) this.agentOffset().set(this.sidebarView(entries).revealGroup(index));
  }
  private openScopeMenu(pinned: boolean): void {
    this.closeMenu();
    this.scope_menu = new sidebar.ScopeMenu({ pinned });
    this.cancelDividers();
    this.selection = null;
    this.dirty = true;
  }
  private pollScopeMenu(): void {
    const side = this.sidebarView([]);
    const on_label = this.pointer !== null && side.hit(this.pointer.x, this.pointer.y).tag === "agent_scope";
    if (this.scope_menu) {
      const inside =
        this.pointer !== null &&
        sidebar.ScopeMenu.bounds(side, this.width, this.height).contains(this.pointer.x, this.pointer.y);
      if (side.width === 0 || (!this.scope_menu.pinned && !on_label && !inside)) this.closeMenu();
    } else if (
      on_label &&
      !this.launcher_hover_blocked &&
      !this.hasMenu() &&
      this.name_dialog === null &&
      !this.ui_mouse_down &&
      !this.copy_mode
    ) {
      this.openScopeMenu(false);
    }
  }
  private agentSearch(): sidebar.Search | null {
    if (this.agent_picker) return { text: this.agent_picker.query.raw(), cursor: this.agent_picker.query.cursor };
    return null;
  }
  inheritedCwd(ws: Workspace, target: number | null): string {
    let id = target;
    if (id === null) {
      if (ws.model.count > 0) id = ws.model.firstPane(ws.model.tabs[0].root);
      else return ws.cwd;
    }
    const p = this.pane(id);
    return p ? p.cwd : ws.cwd;
  }
  private currentCwd(): string {
    const p = this.focused();
    return this.inheritedCwd(this.current(), p ? p.id : null);
  }
  private workspaceIds(): number[] {
    return this.runtime.workspaces.items.map(ws => ws.id);
  }
  workspaceEntries(): WorkspaceEntry[] {
    return this.runtime.workspaces.items.map((ws, i) => {
      const entry = sidebar.workspaceEntry({
        id: ws.id,
        name: ws.name,
        cwd: ws.cwd,
        active: i === this.workspaceIndex(),
        git_ahead: ws.git_ahead,
        git_push: ws.git_push,
        git_commits: ws.git_commits,
        worktrees: ws.worktrees,
        stats: ws.stats,
      });
      entry.ports = this.runtime.ports;
      entry.resources = sidebar.resourcesFor(this.runtime.resources, ws.id);
      entry.remote_links = this.remote_links;
      for (const p of this.runtime.panes) {
        if (p.agent.provider === null || ws.model.tabForPane(p.id) === null) continue;
        entry.agents += 1;
        if (p.agent.state === "working") entry.working += 1;
        if (p.agent.state === "blocked" || p.agent.attention === "needs_input") entry.attention += 1;
        if (unread(p.agent.observation)) entry.unread += 1;
      }
      for (const session of this.runtime.sessions) {
        if (session.workspace !== ws.id) continue;
        entry.agents += 1;
        if (session.state === "working") entry.working += 1;
        if (session.state === "blocked" || session.attention === "needs_input") entry.attention += 1;
        if (unread(session.observation)) entry.unread += 1;
      }
      return entry;
    });
  }
  agentEntries(workspace?: number): Entry[] {
    const entries: Entry[] = [];
    const focus = this.model().count > 0 ? this.nav().tab().focus : 0;
    // "All" groups agents under a header per workspace that has any.
    const grouped = workspace === undefined && this.prefs.agents === "all";
    const totals = grouped ? this.workspaceEntries() : [];
    this.runtime.workspaces.items.forEach((ws, ws_index) => {
      if (workspace !== undefined ? ws.id !== workspace : !this.inScope(ws.id)) return;
      if (grouped) {
        const total = totals[ws_index];
        if (total.agents === 0 || entries.length === sidebar.max_entries) return;
        const folded = this.groupFolded(ws.id);
        const here = ws.id === this.current().id;
        // A folded header stands in for the focused agent it hides.
        entries.push(
          sidebar.entry({
            target: { group: ws.id },
            name: ws.name,
            provider: null,
            state: "idle",
            attention: "none",
            focused: folded && here && this.focusedAgent() !== null,
            group: { agents: total.agents, working: total.working, attention: total.attention, folded, current: here },
          }),
        );
        if (folded) return;
      }
      const first_agent = entries.length;
      for (let tab_index = 0; tab_index < ws.model.count; tab_index++) {
        for (const p of this.runtime.panes) {
          if (
            p.agent.provider === null ||
            ws.model.tabForPane(p.id) !== tab_index ||
            entries.length === sidebar.max_entries
          )
            continue;
          entries.push(
            sidebar.entry({
              conversation: p.agent.conversation,
              target: { pane: p.id },
              name: p.label.length > 0 ? p.label : p.agent.name,
              provider: p.agent.provider,
              state: p.agent.state,
              attention: p.agent.attention,
              focused: this.native_notice === null && focus === p.id,
              cwd: p.agent.cwd.length > 0 ? p.agent.cwd : p.cwd,
              tool_active: p.agent.tool_active,
              compacting: p.agent.compacting,
              paused: p.agent.paused,
              subagents: { ...p.agent.subagents },
              unread: unread(p.agent.observation),
              activity: p.agent.activity,
              reopened: p.restoring.length > 0 && !p.dormant,
            }),
          );
        }
      }
      for (const session of this.runtime.sessions) {
        if (session.workspace !== ws.id || entries.length === sidebar.max_entries) continue;
        const e = sidebar.entry({
          target: { native: session.id },
          provider: session.provider,
          state: session.state,
          attention: session.attention,
          focused: this.native_notice === session.id,
          cwd: session.cwd,
          tool_active: session.tool_active,
          unread: unread(session.observation),
        });
        if (session.agent) {
          e.conversation = session.agent.conversation;
          e.subagents = { ...session.agent.subagents };
          e.name = session.agent.name;
          e.activity = session.agent.activity;
        }
        entries.push(e);
      }
      // std.sort.insertion is stable.
      const sorted = entries
        .slice(first_agent)
        .sort((l, r) => (sidebar.lessThan(ws.agent_order, l, r) ? -1 : sidebar.lessThan(ws.agent_order, r, l) ? 1 : 0));
      const decorated =
        workspace === undefined ? worktreeAgents.grouped(ws.worktrees, ws.id, sorted, this.worktree_agents) : sorted;
      entries.splice(first_agent, sorted.length, ...decorated);
    });
    const now = microTimestamp();
    for (const entry of entries) {
      if (!sidebar.isAgent(entry.target)) continue;
      subagentTooltip.presentChildren(entry, this.runtime.conversations, now);
      const conversation = this.runtime.conversations.find(c => c.id === entry.conversation);
      if (conversation) entry.context = contextView(conversation.context);
    }
    return entries;
  }
  private sidebarEntries(): Entry[] {
    const list = this.prefs.agents === "workspace" ? this.current().id : 0xffffffff;
    let entries = this.sidebar_rows.update(list, this.agentEntries(), [], milliTimestamp());
    const selected = this.browsingWorktree();
    if (!selected) {
      this.worktree_agents.previewed = null;
      this.worktree_agents.appearing = null;
      return entries;
    }
    let index = worktreeAgents.index(entries, selected);
    // A browsed worktree missing from the list, or folded, shows as a ghost:
    // at the top, or in its folded header's place.
    const folded = index >= 0 && entries[index].group.folded;
    if (index >= 0 && !folded) this.worktree_agents.appearing = null;
    else {
      const snapshot = this.runtime.workspaces.items.find(ws => ws.id === selected.workspace)?.worktrees;
      if (snapshot) {
        const asleep = worktreeAgents.conversations(snapshot, selected.path, this.mergedHistory(), this.openSessions());
        // The overview's footer says what Enter would do with them.
        this.worktree_card.asleep = { path: selected.path, count: asleep.length };
        const ghost = worktreeAgents.group(
          snapshot,
          selected,
          this.agentEntries(selected.workspace),
          asleep,
          this.worktree_agents,
          true,
        );
        // A worktree with nothing to list has no ghost; one fades in once it has.
        if (!ghost.length) this.worktree_agents.appearing = null;
        const shown = ghost.length ? this.worktree_agents.animate(ghost, selected, milliTimestamp()) : [];
        entries = folded ? [...entries.slice(0, index), ...shown, ...entries.slice(index + 1)] : [...shown, ...entries];
      }
      index = worktreeAgents.index(entries, selected);
    }
    const key = worktreeAgents.key(selected);
    if (index >= 0 && this.worktree_agents.previewed !== key) {
      this.agentOffset().set(this.sidebarView(entries).reveal(index));
      this.worktree_agents.previewed = key;
    }
    return entries;
  }
  private firstUnreadAgent(workspace_index: number): Target | null {
    const ws = this.runtime.workspaces.items[workspace_index];
    for (let tab_index = 0; tab_index < ws.model.count; tab_index++)
      for (const p of this.runtime.panes)
        if (p.agent.provider !== null && ws.model.tabForPane(p.id) === tab_index && unread(p.agent.observation))
          return { pane: p.id };
    for (const session of this.runtime.sessions)
      if (session.workspace === ws.id && unread(session.observation)) return { native: session.id };
    return null;
  }
  private selectAgent(target: Target): void {
    if ("worktree" in target) return this.revealWorktree({ workspace: target.workspace, path: target.worktree }, true);
    if (!sidebar.isAgent(target) && !("group" in target)) return;
    this.rememberAgent();
    this.copy_mode = false;
    this.search_mode = false;
    this.selection = null;
    this.cancelDividers();
    this.message = "";
    if ("pane" in target) {
      this.focusPane(target.pane);
      this.dirty = true;
    } else if ("native" in target) {
      const session = this.runtime.sessions.find(s => s.id === target.native);
      if (session) {
        if (session.workspace !== this.current().id) this.switchWorkspace(session.workspace);
        this.noticeNativeSession(session);
      }
    } else if ("group" in target) this.toggleGroup(target.group);
    this.rememberAgent();
    const entries = this.sidebarEntries();
    const index = agentNavigation.indexOf(entries, target);
    if (index !== null) this.agentOffset().set(this.sidebarView(entries).reveal(index));
    this.dirty = true;
  }
  /** A launched agent shows up in the list only once it starts, so reveal it
   * then, unless focus has moved on. */
  private revealLaunched(entries: Entry[]): void {
    if (this.launched === 0) return;
    if (this.model().count === 0 || this.nav().tab().focus !== this.launched) {
      this.launched = 0;
      return;
    }
    const index = agentNavigation.indexOf(entries, { pane: this.launched });
    if (index === null) return;
    this.agentOffset().set(this.sidebarView(entries).reveal(index));
    this.launched = 0;
  }
  private focusedAgent(): Target | null {
    if (this.native_notice !== null) {
      const id = this.native_notice;
      for (const session of this.runtime.sessions)
        if (session.id === id && session.workspace === this.current().id) return { native: id };
    }
    const p = this.focused();
    if (p && p.agent.provider !== null) return { pane: p.id };
    return null;
  }
  private rememberAgent(): void {
    if (this.runtime.workspaces.items.length === 0) return;
    const target = this.focusedAgent();
    this.navigation.agentHistory(this.runtime.workspaces).observe(target);
  }
  private navigateAgent(next: boolean | null): void {
    this.rememberAgent();
    const entries = this.agentEntries();
    const target =
      next !== null
        ? agentNavigation.relative(entries, this.focusedAgent(), next)
        : this.navigation.agentHistory(this.runtime.workspaces).destination(entries, this.focusedAgent());
    if (target) this.selectAgent(target);
    else this.notice(entries.length === 0 ? " No agents in this workspace" : " No previous agent in this workspace");
  }
  private openAgentPicker(): void {
    this.closeMenu();
    if (this.width < 40 || this.height < 13) {
      this.notice(" Agent search needs at least 40 columns and 13 rows");
      return;
    }
    this.sidebar_open = true;
    this.copy_mode = false;
    this.search_mode = false;
    this.selection = null;
    this.cancelDividers();
    const picker = new AgentPicker(this.current().id);
    picker.selected = this.focusedAgent();
    picker.offset = this.agentOffset().get();
    this.agent_picker = picker;
    this.dirty = true;
  }
  private pickerEntries(): Entry[] {
    const entries = this.agentEntries();
    const picker = this.agent_picker!;
    const filtered = picker.list(entries);
    picker.reconcile(filtered, this.sidebarView(filtered).capacity);
    return filtered.map(entry => ({ ...entry, focused: sidebar.sameTarget(picker.selected, entry.target) }));
  }
  private moveAgentPicker(next: boolean): void {
    const entries = this.pickerEntries();
    this.agent_picker!.move(entries, next, this.sidebarView(entries).capacity);
    this.dirty = true;
  }
  private acceptAgentPicker(): void {
    this.pickerEntries();
    const target = this.agent_picker!.selected;
    if (!target) return;
    this.closeMenu();
    this.selectAgent(target);
  }
  private pane(id: number): Pane | null {
    return this.runtime.pane(id);
  }
  focused(): Pane | null {
    return this.model().count === 0 ? null : this.pane(this.nav().tab().focus);
  }
  notice(msg: string): void {
    this.message = Array.from(Buffer.from(msg).subarray(0, 512), ch =>
      ch >= 32 && ch < 127 ? String.fromCharCode(ch) : " ",
    ).join("");
    this.native_notice = null;
    this.dirty = true;
  }
  private noticeNativeSession(session: Native): void {
    this.notice(
      ` ${session.provider} native session ${session.id}: ${session.state}. Inspect: corgi native events ${session.id}`,
    );
    this.native_notice = session.id;
  }
  menu(): ResizeView | null {
    if (!this.resize_mode) return null;
    const view = ResizeView.init(this.width, this.height, this.menu_page, this.model().count > 0);
    view.highlighted = this.menu_highlight;
    return view;
  }
  private hasMenu(): boolean {
    return (
      this.worktree_card.pinned ||
      this.onboarding !== null ||
      this.prefix ||
      this.resize_mode ||
      this.tab_menu !== null ||
      this.port_menu !== null ||
      this.agent_picker !== null ||
      this.sidebar_focus !== null ||
      this.agent_launcher !== null ||
      this.corgi_setup !== null ||
      this.scope_menu !== null
    );
  }
  /** Open UI that can change with no input, such as the launcher's preview
   * arriving; the viewer keeps drawing at full rate while it shows. */
  overlayOpen(): boolean {
    return this.hasMenu() || this.name_dialog !== null || this.paste_card !== null || this.copy_feedback_until !== 0;
  }
  private tabIndex(id: number): number | null {
    const i = this.model()
      .tabs.slice(0, this.model().count)
      .findIndex(tab => tab.id === id);
    return i < 0 ? null : i;
  }
  /** Whether a tab menu's target (pane, workspace, or tab) has disappeared. */
  private tabMenuStale(context: TabMenu): boolean {
    if (context.worktree !== null) {
      const ws = this.runtime.workspaces.items.find(ws => ws.id === context.tab);
      return !worktrees.linked(ws?.worktrees ?? null).some(e => e.path === context.worktree);
    }
    if (context.pane || context.agent) return this.pane(context.tab) === null;
    if (context.workspace) return this.runtime.workspaces.index(context.tab) === null;
    return this.tabIndex(context.tab) === null;
  }
  private openTabMenu(index: number, x: number): void {
    this.closeMenu();
    this.search_mode = false;
    this.cancelDividers();
    this.selection = null;
    this.tab_menu = new TabMenu({ tab: this.model().tabs[index].id, anchor_x: x });
  }
  /** Opens agent pane `id`'s menu. The daemon says whether its agent can
   * be renamed now, and whether it has a conversation to fork. */
  private async openAgentMenu(id: number, x: number, y: number): Promise<void> {
    this.closeMenu();
    this.search_mode = false;
    this.cancelDividers();
    this.selection = null;
    const p = this.pane(id);
    if (!p) return;
    const opened = new TabMenu({ tab: id, agent: true, anchor_x: x, anchor_y: y });
    if (p.agent.session.length === 0) opened.off.add("copy-id");
    if (p.agent.observation.completed === 0n || unread(p.agent.observation)) opened.off.add("mark-unread");
    try {
      await call(this.connection, "session.command", { command: { "agent.rename": { target: id } } });
    } catch {
      opened.off.add("rename");
    }
    try {
      await call(this.connection, "session.command", { command: { "agent.fork": { target: id, check: true } } });
    } catch {
      opened.off.add("fork");
    }
    opened.highlightFirst();
    this.tab_menu = opened;
    this.dirty = true;
  }
  /** Opens a worktree heading's menu. Close all runs only while the group
   * lists an agent in a pane. */
  private openWorktreeMenu(entry: Entry, x: number, y: number): void {
    if (!("worktree" in entry.target)) return;
    this.closeMenu();
    this.search_mode = false;
    this.cancelDividers();
    this.selection = null;
    const selection = { workspace: entry.target.workspace, path: entry.target.worktree };
    const opened = new TabMenu({
      tab: selection.workspace,
      worktree: selection.path,
      title: entry.name,
      folded: entry.group.folded,
      anchor_x: x,
      anchor_y: y,
    });
    if (this.worktreePanes(selection).length === 0) opened.off.add("close-all");
    opened.highlightFirst();
    this.tab_menu = opened;
    this.dirty = true;
  }
  /** Follows the daemon's report on a removal under way: its progress, then
   * how it ended. Reports of an earlier removal are not this one's. */
  private followRemoval(): void {
    const card = this.worktree_card,
      hold = card.removal,
      t = hold.target;
    if (hold.phase !== "removing" || !t || !hold.job) return;
    const report = this.runtime.workspaces.items.find(w => w.id === t.workspace)?.worktree_removal ?? null;
    if (report?.id !== hold.job) return;
    hold.report = report;
    const now = milliTimestamp();
    switch (report.phase) {
      case "done":
        hold.settle(now, null);
        if (card.selected === t.path) card.select(this.removal_next);
        break;
      case "stopped":
        hold.stopped(now);
        break;
      case "failed": {
        const reason = removalReason(report.error);
        hold.settle(now, reason);
        if (card.workspace !== t.workspace) this.notice(` Couldn't remove ${t.name}: ${reason}`);
        break;
      }
      default:
        break;
    }
  }
  /** The panes of the agents listed under a worktree, folded or not. */
  private worktreePanes(selection: worktreeAgents.Selection): number[] {
    const snapshot = this.runtime.workspaces.items.find(ws => ws.id === selection.workspace)?.worktrees;
    if (!snapshot) return [];
    return this.agentEntries(selection.workspace).flatMap(e =>
      "pane" in e.target && worktreeAgents.belongs(snapshot, selection.path, e) ? [e.target.pane] : [],
    );
  }
  /** Runs a row of the open tab menu; `item` comes from its `entries()`. */
  private async tabMenuAction(item: TabMenuItem): Promise<void> {
    const context = this.tab_menu;
    if (!context) return;
    this.closeMenu();
    if (context.worktree !== null) {
      const selection = { workspace: context.tab, path: context.worktree };
      switch (item) {
        case "fold":
          this.toggleWorktree(selection);
          break;
        case "close-all":
          for (const id of this.worktreePanes(selection)) await this.close(id);
          break;
        default:
          break;
      }
      return;
    }
    if (context.agent) {
      const pane_id = context.tab;
      const p = this.pane(pane_id);
      if (!p) return;
      switch (item) {
        case "rename":
          this.name_dialog = Dialog.init({ agent: pane_id }, p.label.length > 0 ? p.label : p.agent.name);
          this.prepareName();
          break;
        case "fork": {
          const title = p.label.length > 0 ? p.label : p.agent.name.length > 0 ? p.agent.name : providerName(p.agent);
          this.name_dialog = Dialog.init({ fork: pane_id }, forkName(title));
          this.startHero();
          this.prepareName();
          break;
        }
        case "copy-id":
          this.copyText(breadcrumbs(p));
          break;
        case "mark-unread":
          try {
            await call(this.connection, "pane.mark_unread", {
              pane: p.id,
              binding: p.binding,
              conversation: p.agent.conversation,
              session: p.agent.session,
            });
            this.marked_unread.set(p.id, this.focused()?.id === p.id);
          } catch {
            this.notice(" Couldn't mark as unread");
          }
          break;
        case "close":
          await this.close(pane_id);
          break;
        default:
          break;
      }
      return;
    }
    if (context.pane) {
      const pane_id = context.tab;
      if (!this.pane(pane_id)) return;
      switch (item) {
        case "rename":
          this.name_dialog = Dialog.init({ pane: pane_id }, this.pane(pane_id)!.label);
          this.dirty = true;
          break;
        case "clear-name":
          await this.renamePane(pane_id, "");
          break;
        case "close":
          await this.close(pane_id);
          break;
        case "swap":
          if (context.source !== null) {
            const source = context.source;
            if (this.model().tabForPane(source) !== this.model().tabForPane(pane_id)) return;
            this.focusPane(source);
            await this.edit({ "pane.swap": { target: source, other: pane_id } });
            this.dirty = true;
          }
          break;
        case "split-right":
        case "split-down":
        case "zoom":
          this.focusPane(pane_id);
          await this.perform(
            item === "split-right"
              ? { name: "split", value: "right" }
              : item === "split-down"
                ? { name: "split", value: "down" }
                : { name: "zoom" },
          );
          break;
        default:
          break;
      }
      return;
    }
    if (context.workspace) {
      if (this.runtime.workspaces.index(context.tab) === null) return;
      switch (item) {
        case "rename":
          this.beginWorkspace(context.tab);
          break;
        case "close":
          try {
            await this.closeWorkspace(context.tab, true);
          } catch (error) {
            this.notice(
              errors.is(error, "LastWorkspace") ? " Cannot close the last workspace" : " Could not close workspace",
            );
          }
          break;
        default:
          break;
      }
      return;
    }
    this.rememberAgent();
    const index = this.tabIndex(context.tab);
    if (index === null) return;
    this.nav().active = index;
    this.native_notice = null;
    this.rememberAgent();
    this.copy_mode = false;
    this.dirty = true;
    switch (item) {
      case "new":
        await this.perform({ name: "new" });
        break;
      case "rename":
        this.beginRename();
        break;
      case "close":
        await this.perform({ name: "close-tab" });
        break;
      default:
        break;
    }
  }
  private moveTabMenu(next: boolean): void {
    if (this.tab_menu) this.tab_menu.move(next);
    this.dirty = true;
  }
  private beginPrefix(): void {
    // A prefixed arrow moves within the sidebar, so the prefix keeps its focus.
    const focus = this.sidebar_focus;
    this.sidebar_focus = null;
    this.closeMenu();
    this.sidebar_focus = focus;
    this.cancelDividers();
    this.selection = null;
    this.prefix = true;
    this.help = Object.assign(new shortcutHelp.State(), { command_mode: true });
  }
  /** Whether a full-screen view hides every pane, so nothing on them was seen. */
  coversPanes(): boolean {
    return this.onboarding !== null || (this.prefix && this.help_visible);
  }
  private openHelp(): void {
    this.beginPrefix();
    this.help_visible = true;
  }
  closeMenu(): void {
    this.leaveSidebar();
    this.worktree_card.clear();
    this.help_visible = false;
    this.link_tooltip.cancel();
    this.agent_picker = null;
    this.closeLauncher();
    this.scope_menu = null;
    this.corgi_setup?.close();
    this.corgi_setup = null;
    this.launcher_hover_blocked = true;
    this.port_menu = null;
    this.tab_menu = null;
    this.menu_highlight = null;
    this.prefix = false;
    this.resize_mode = false;
    this.dirty = true;
  }
  private pageMenu(next: boolean): void {
    const view = this.menu();
    if (!view) return;
    this.menu_highlight = null;
    this.menu_page = next ? (view.page + 1) % view.pages : (view.page + view.pages - 1) % view.pages;
    this.dirty = true;
  }
  private beginWorkspace(id: number | null): void {
    this.dismissName();
    let initial = "";
    if (id !== null) {
      const index = this.runtime.workspaces.index(id);
      if (index === null) return;
      initial = this.runtime.workspaces.items[index].custom_name;
    }
    this.name_dialog = Dialog.init({ workspace_name: id }, initial);
    this.prepareName();
  }
  private async newWorkspace(name: string, cwd: string): Promise<number> {
    const id = (await this.execute({ "workspace.create": { name, cwd } })).workspace;
    this.switchWorkspace(id);
    return id;
  }
  /** Shows the workspace for a folder, adding one when none has it. */
  private async openFolder(cwd: string): Promise<void> {
    if (!isAbsolute(cwd)) throw Error("InvalidDirectory");
    const current = this.current(),
      found = current.cwd === cwd ? current : this.runtime.workspaces.items.find(w => w.cwd === cwd);
    if (found) this.switchWorkspace(found.id);
    else await this.newWorkspace("", cwd);
  }
  private beginRename(): void {
    if (this.model().count === 0) return;
    const tab = this.selectedTab();
    this.dismissName();
    this.name_dialog = Dialog.init({ rename: tab.id }, tab.title);
    this.prepareName();
  }
  private prepareName(): void {
    this.search_mode = false;
    this.copy_mode = false;
    this.closeMenu();
    this.cancelDividers();
    this.selection = null;
    this.dirty = true;
  }
  dismissName(): void {
    // The hero's images go with it.
    if (this.name_dialog && this.name_dialog.hero.motion) this.queueEffect({ write_terminal: forkMotion.remove });
    this.name_dialog = null;
  }
  /** Sets the fork card's hero moving, where the host shows Kitty images
   * and reports its cell size; elsewhere it shows at rest. */
  private startHero(): void {
    const d = this.name_dialog;
    if (!d) return;
    d.hero.glyphs = this.branch_glyphs;
    const cell = this.cell_pixels;
    if (!cell) return;
    if (!this.supports_kitty_graphics) return;
    this.queueEffect({ write_terminal: forkMotion.upload(cell) });
    d.hero.motion = { start: milliTimestamp() + forkMotion.lead_ms, cell };
  }
  /** How long the viewer waits between frames: a display frame while the
   * fork card's hero moves. */
  frameDelay(): number {
    const d = this.name_dialog;
    if (!d) return 30;
    return forkMotion.moving(d.hero, milliTimestamp()) ? 16 : 30;
  }
  private async renamePane(id: number, name: string): Promise<void> {
    await this.edit({ "pane.rename": { target: id, name } });
  }
  private async finishName(save: boolean): Promise<void> {
    this.dirty = true;
    const dialog = this.name_dialog;
    if (save && dialog) {
      const target = dialog.target;
      if ("agent_command" in target) {
        // The launcher edits saved commands in its own dialog.
      } else if ("pane" in target) {
        try {
          await this.renamePane(target.pane, dialog.name());
        } catch {
          dialog.failed = true;
          return;
        }
      } else if ("workspace_name" in target) {
        const name = dialog.name();
        if (target.workspace_name === null) {
          try {
            await this.newWorkspace(name, this.currentCwd());
          } catch {
            this.notice(" Could not create workspace");
          }
          return;
        }
        try {
          await this.edit({ "workspace.edit": { target: target.workspace_name, name } });
        } catch {
          dialog.failed = true;
          return;
        }
      } else if ("rename" in target) {
        try {
          await this.edit({ "tab.rename": { target: target.rename, name: dialog.name() } });
        } catch {
          dialog.failed = true;
          return;
        }
      } else if ("agent" in target) {
        if (dialog.name().length > 0) {
          try {
            await this.edit({ "agent.rename": { target: target.agent, name: dialog.name() } });
          } catch (error) {
            this.dismissName();
            this.notice(agentMessage((error as Error).message, " Could not rename this agent"));
            return;
          }
        }
      } else if ("shell" in target) {
        if (!(await this.configureShell(dialog.name()))) {
          dialog.failed = true;
          return;
        }
      } else if ("fork" in target) {
        // An emptied name keeps the one the copy takes over.
        const name = dialog.name().length > 0 ? dialog.name() : null;
        let created: { pane: number };
        try {
          created = await this.execute({ "agent.fork": { target: target.fork, name } });
        } catch (error) {
          this.dismissName();
          this.notice(agentMessage((error as Error).message, " Could not fork this agent"));
          return;
        }
        try {
          this.focusPane(created.pane);
        } catch {}
      }
    }
    this.dismissName();
    this.message = "";
  }
  private async create(split: Axis | null, cwd: string, command: string | null, title: string): Promise<number> {
    const operation: CommandInput = split
      ? {
          "pane.split": {
            target: this.model().count > 0 ? this.nav().tab().focus : 0,
            direction: split === "horizontal" ? "right" : "down",
            cwd,
            command,
            title,
          },
        }
      : { "pane.create": { workspace: this.current().id, cwd, command, title } };
    const id = (await this.execute(operation)).pane;
    this.focusPane(id);
    this.nav().tab().zoom = false;
    this.dirty = true;
    return id;
  }
  async close(id: number): Promise<void> {
    await this.edit({ "pane.close": { target: id } });
    this.dirty = true;
  }
  private async undoClose(): Promise<void> {
    if (this.current().closed_agents === 0) {
      this.notice(" No closed agents to reopen in this workspace");
      return;
    }
    const id = (await this.execute({ "pane.restore": { workspace: this.current().id } })).pane;
    this.focusPane(id);
    this.launched = id;
    this.copy_mode = false;
  }
  /** A dormant agent resumes once its pane has focus. */
  private async wakeFocused(): Promise<void> {
    const p = this.focused();
    if (p?.id !== this.wake_failed) this.wake_failed = null;
    if (!p?.dormant || this.wake_failed !== null) return;
    try {
      await this.edit({ "pane.wake": { target: p.id } });
    } catch {
      this.wake_failed = p.id;
      this.notice(" Could not resume this agent");
    }
  }
  private attention(): void {
    for (const priority of ["needs_input", "finished"]) {
      let best: Pane | null = null;
      for (const p of this.runtime.panes)
        if (p.agent.attention === priority && (best === null || p.agent.changed_at < best.agent.changed_at)) best = p;
      if (best) {
        this.focusPane(best.id);
        this.dirty = true;
        return;
      }
    }
    for (const priority of ["needs_input", "finished"])
      for (const session of this.runtime.sessions)
        if (session.attention === priority) {
          if (session.workspace !== this.current().id) this.switchWorkspace(session.workspace);
          this.noticeNativeSession(session);
          return;
        }
    this.notice(" Nothing needs your attention");
  }
  async perform(act: Action): Promise<void> {
    this.message = "";
    switch (act.name) {
      case "worktrees": {
        const id = Number(act.value) || this.current().id;
        if (this.runtime.workspaces.index(id) === null) break;
        this.closeMenu();
        this.sidebar_open = true;
        this.worktree_card.workspace = id;
        this.worktree_card.pinned = true;
        this.worktree_card.anchor = sidebar.worktreeBadge(this.sidebarView([]), this.workspaceEntries(), id)?.y ?? 3;
        this.dirty = true;
        break;
      }
      case "worktree-close":
        this.worktree_card.clear();
        this.worktree_agents.previewed = null;
        this.link_tooltip.cancel();
        this.dirty = true;
        break;
      case "worktree-next":
      case "worktree-prev": {
        if (this.worktreeDetail() === null) break;
        this.worktree_card.pinned = true;
        const ws = this.runtime.workspaces.items.find(w => w.id === this.worktree_card.workspace);
        this.worktree_card.move(ws?.worktrees ?? null, act.name === "worktree-next" ? 1 : -1);
        this.dirty = true;
        break;
      }
      case "worktree-select": {
        const ws = this.runtime.workspaces.items.find(w => w.id === this.worktree_card.workspace);
        if (worktrees.linked(ws?.worktrees ?? null).some(entry => entry.path === act.value))
          this.worktree_card.select(String(act.value));
        this.dirty = true;
        break;
      }
      case "worktree-enter": {
        const selection = this.browsingWorktree();
        if (selection) await this.enterWorktree(selection);
        break;
      }
      case "worktree-remove": {
        // Each press or key repeat comes here; the hold decides when it's done.
        if (this.worktreeDetail() === null) break;
        const card = this.worktree_card,
          ws = this.runtime.workspaces.items.find(w => w.id === card.workspace),
          entries = worktrees.linked(ws?.worktrees ?? null),
          index = card.index(entries),
          checkout = entries[index];
        if (!ws || !checkout) break;
        const selection = { workspace: ws.id, path: checkout.path },
          panes = this.worktreePanes(selection);
        card.select(checkout.path);
        this.dirty = true;
        const target = worktreeRemoval.target(ws.id, checkout, index, panes.length);
        if (!card.removal.press(milliTimestamp(), target, card.removalEffect())) break;
        try {
          for (const id of panes) await this.close(id);
        } catch {
          card.removal.settle(milliTimestamp(), "its agents didn't close");
          break;
        }
        // The daemon deletes the files in the background and reports on them.
        try {
          const reply = await call(this.connection, "worktree.remove", selection);
          card.removal.job = Number(reply.removal) || 0;
          this.removal_next = (entries[index + 1] ?? entries[index - 1])?.path ?? null;
          // A daemon that removes before it answers sends no removal to follow.
          if (!card.removal.job) {
            card.removal.settle(milliTimestamp(), null);
            if (card.selected === selection.path) card.select(this.removal_next);
          }
        } catch (error) {
          card.removal.settle(milliTimestamp(), removalReason(errors.name(error)));
        }
        break;
      }
      case "worktree-stop": {
        const t = this.worktree_card.removal.target;
        if (this.worktree_card.removal.phase !== "removing" || !t) break;
        try {
          await call(this.connection, "worktree.stop", { workspace: t.workspace });
        } catch {}
        this.dirty = true;
        break;
      }
      case "worktree-agent": {
        const row = this.sidebarEntries()[Number(act.value)];
        if (!row) break;
        const target = row.target;
        if ("asleep" in target && row.worktree) {
          // Entering brings the ghost's agents back asleep; the clicked one wakes.
          await this.enterWorktree({ workspace: row.worktree.workspace, path: row.worktree.path });
          const p = this.runtime.panes.find(
            p => p.agent.provider === target.provider && p.agent.session === target.asleep,
          );
          if (p) this.selectAgent({ pane: p.id });
        } else if ("worktree" in target) {
          // A ghost's header keeps its group; one in the list folds it.
          const selection = { workspace: target.workspace, path: target.worktree };
          if (row.worktree?.ghost) await this.enterWorktree(selection);
          else this.toggleWorktree(selection);
        } else if (sidebar.isAgent(target)) {
          this.closeMenu();
          this.selectAgent(target);
        }
        break;
      }
      case "onboard":
        return this.openOnboarding("welcome");
      case "workspace-next":
      case "workspace-prev": {
        const count = this.runtime.workspaces.items.length;
        const index =
          act.name === "workspace-next"
            ? (this.workspaceIndex() + 1) % count
            : (this.workspaceIndex() + count - 1) % count;
        return this.switchWorkspace(this.runtime.workspaces.items[index].id);
      }
      case "new":
        this.openLauncher(true);
        this.copy_mode = false;
        break;
      case "sidebar":
        this.sidebar_open = !this.sidebar_open;
        this.selection = null;
        this.cancelDividers();
        this.dirty = true;
        break;
      case "mute":
        this.muted = !this.muted;
        this.notice(this.muted ? " Dings muted; attention markers remain on" : " Dings enabled");
        break;
      case "undo-close":
        return this.undoClose();
      case "attention":
        return this.attention();
      case "rename-tab":
        this.beginRename();
        break;
      case "new-workspace":
        this.beginWorkspace(null);
        break;
      case "edit-workspace":
        this.beginWorkspace(this.current().id);
        break;
      case "close-workspace":
        await this.closeWorkspace(this.current().id, true);
        break;
      case "choose-workspace":
        this.chooseIn("workspaces");
        break;
      case "goto-workspace": {
        const number = Number(act.value);
        if (number >= 1 && number <= this.runtime.workspaces.items.length)
          this.switchWorkspace(this.runtime.workspaces.items[number - 1].id);
        break;
      }
      case "open":
        return this.openFolder(String(act.value ?? ""));
      case "new-agent":
        this.openLauncher(true);
        break;
      case "find-agent":
        this.openAgentPicker();
        break;
      case "choose-agent":
        this.chooseIn("agents");
        break;
      case "next-agent":
        this.navigateAgent(true);
        break;
      case "prev-agent":
        this.navigateAgent(false);
        break;
      case "last-agent":
        this.navigateAgent(null);
        break;
      case "resize-mode":
        this.resize_mode = true;
        this.menu_page = 0;
        this.menu_highlight = null;
        break;
      case "next-pane":
        this.cyclePane(true);
        break;
      case "prev-pane":
        this.cyclePane(false);
        break;
      case "copy-mode":
        this.copy_mode = true;
        break;
      case "copy":
        this.copyText(String(act.value ?? ""));
        break;
      case "paste":
        if (this.clipboard !== null) {
          const p = this.focused();
          if (p) {
            const bracketed = p.terminal.bracketedPaste();
            if (bracketed) this.sendInput(p.terminal, "\x1b[200~");
            this.sendInput(p.terminal, this.clipboard);
            if (bracketed) this.sendInput(p.terminal, "\x1b[201~");
          }
        }
        break;
      case "setup":
        this.openSetup();
        break;
      case "help":
        this.openHelp();
        break;
      case "detach":
        this.input_state.attached = false;
        break;
      case "split":
      case "zoom":
      case "close":
      case "close-tab":
        if (this.model().count === 0) throw Error("NoPane");
        if (act.name === "split")
          await this.create(act.value === "down" ? "vertical" : "horizontal", this.currentCwd(), null, "");
        else if (act.name === "zoom") this.nav().tab().zoom = !this.nav().tab().zoom;
        else if (act.name === "close") await this.close(this.nav().tab().focus);
        else await this.edit({ "tab.close": { target: this.selectedTab().id } });
        break;
      case "focus":
        await this.moveFocus(act.value as Direction);
        break;
      case "rename":
      case "resize":
      case "swap":
      case "move-tab":
      case "break":
      case "next":
      case "prev":
      case "tab":
      case "join": {
        if (this.model().count === 0) throw Error("NoPane");
        const intent = this.navigation.command(this.runtime.workspaces, act, this.area());
        if (intent.edit) await this.edit(intent.edit);
        if (intent.focus !== null) {
          this.focusPane(intent.focus);
          this.copy_mode = false;
        }
        break;
      }
      default:
        // viewer.sync execs the new binary before anything reaches here.
        break;
    }
    this.dirty = true;
  }
  private scroll(delta: number): void {
    const p = this.focused();
    if (p) {
      p.terminal.scrollViewport({ delta });
      this.dirty = true;
    }
  }
  private sendInput(term: Terminal, bytes: string | Uint8Array | number[]): void {
    // Nothing reads a dormant pane's input.
    if (this.pane(term.id)?.dormant) return;
    this.marked_unread.delete(term.id);
    if (!this.copy_mode && bytes.length > 0 && !term.atBottom()) {
      term.scrollViewport("bottom");
      term.clearSelection();
      this.selection = null;
      this.dirty = true;
    }
    term.send(bytes);
  }
  private queueEffect(effect: Effect): void {
    this.effects.push(effect);
  }
  clearEffects(): void {
    this.effects = [];
  }
  private copyPane(p: Pane): void {
    this.copyText(p.terminal.selectedText());
  }
  /** Puts `text` on the host clipboard and keeps it for `paste`. */
  private copyText(text: string): void {
    this.copyQuietly(text);
    this.copy_feedback_until = milliTimestamp() + 2000;
  }
  /** `copyText` without the toast, for a caller that confirms it itself. */
  private copyQuietly(text: string): void {
    this.clipboard = text;
    this.queueEffect({ write_terminal: `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07` });
    this.dirty = true;
  }
  /** The agent `New` repeats in the current workspace. */
  private lastAgent(): Provider {
    return this.current().last_agent ?? this.runtime.last_agent;
  }
  private async launchAgent(provider: Provider | null): Promise<void> {
    const dir = await this.launcherDir();
    if (dir === null) return;
    if (byteLength(dir) > 4096) throw Error("NameTooLong");
    this.closeMenu();
    this.rememberLauncherRow(this.current().id, Row.of(provider ?? this.lastAgent()));
    let created: { pane: number };
    try {
      created = await this.execute({ "agent.create": { workspace: this.current().id, cwd: dir, provider } });
    } catch (error) {
      this.notice((error as Error).message);
      return;
    }
    this.focusPane(created.pane);
    this.launched = created.pane;
    this.dirty = true;
  }
  private async launchRow(row: LauncherRow): Promise<void> {
    const launch = this.agent_launcher;
    if (launch) {
      if (!launch.managing && row !== "manage") launch.selected = row;
      if (launch.managing && row === "add") return this.saveInlineCommand();
      if (launch.managing && Row.custom(row) !== null) {
        launch.edit(row);
        this.dirty = true;
        return;
      }
      if (!launch.managing) {
        const index = Row.custom(row);
        if (index !== null) {
          const dir = await this.launcherDir();
          if (dir === null) return;
          const created = await this.execute({
            "agent.command.create": { workspace: launch.workspace, cwd: dir, index },
          });
          this.closeMenu();
          this.focusPane(created.pane);
          this.launched = created.pane;
          this.dirty = true;
          return;
        }
      }
      if (row === "manage") {
        this.rememberLauncherSelection();
        launch.managing = !launch.managing;
        launch.selected = launch.managing ? "add" : this.launcherSelection(launch.workspace);
        launch.normalize();
        launch.pinned = true;
        this.dirty = true;
        return;
      }
      if (launch.managing) {
        const provider = Row.agent(row);
        if (provider) {
          const hidden = { ...this.runtime.agent_hidden };
          hidden[provider] = !hidden[provider];
          await this.execute({ "agent.visibility": { hidden } });
          if (this.agent_launcher) {
            this.agent_launcher.hidden = hidden;
            this.agent_launcher.pinned = true;
          }
          this.dirty = true;
        }
        return;
      }
    }
    const provider = Row.agent(row);
    if (provider) return this.launchAgent(provider);
    const dir = await this.launcherDir();
    if (dir === null) return;
    if (byteLength(dir) > 4096) throw Error("NameTooLong");
    this.closeMenu();
    await this.create(null, dir, null, "");
    this.copy_mode = false;
  }
  /** Where the launcher starts what it launches. A new worktree named there
   * is added first, over a connection of its own since a big checkout takes
   * seconds; null when Git refused it, with the reason in its form. */
  private async launcherDir(): Promise<string | null> {
    const launch = this.agent_launcher;
    if (!launch) return this.currentCwd();
    const c = launch.worktree,
      planned = c.planned;
    if (!planned) return launch.cwd;
    if (c.adding) return null;
    const fields = { workspace: launch.workspace, path: planned.path, branch: planned.branch, base: planned.base },
      socket = this.connection.socket;
    c.adding = true;
    this.dirty = true;
    try {
      if (socket) await rpc.request(socket, "worktree.add", fields);
      else await call(this.connection, "worktree.add", fields);
    } catch (error) {
      const reason = launcherWorktree.reason(errors.name(error), planned);
      c.adding = false;
      if (this.agent_launcher === launch) {
        // The box opens in the form, on the name Git refused.
        this.openWorktrees();
        c.error = reason;
      } else this.notice(` Couldn't add ${planned.branch}: ${reason}`);
      this.dirty = true;
      return null;
    }
    c.adding = false;
    c.planned = null;
    launch.cwd = planned.path;
    return planned.path;
  }
  /** Opens the box of checkouts and the new-worktree form from the title's
   * button, and has the daemon list the branches From offers the first time. */
  private openWorktrees(): void {
    const launch = this.agent_launcher;
    if (!launch || launch.managing || !launch.place().worktree) return;
    launch.pinned = true;
    launch.resume_view.focused = false;
    launch.worktree.open(launch.worktrees, launch.cwd);
    if (launch.worktree.branches === null) void this.listBranches(launch);
    this.dirty = true;
  }
  /** The repository's branches for From, over a connection of its own like
   * `worktree.add`. A daemon that can't list them leaves From the default bases. */
  private async listBranches(launch: LauncherMenu): Promise<void> {
    const fields = { workspace: launch.workspace },
      socket = this.connection.socket;
    let branches: launcherWorktree.Branch[];
    try {
      const reply = socket
        ? await rpc.request(socket, "git.branches", fields)
        : await call(this.connection, "git.branches", fields);
      branches = launcherWorktree.branchList(reply.branches);
    } catch {
      branches = launcherWorktree.bases(launch.worktrees, launch.cwd).map(b => ({ ...b, at: 0 }));
    }
    launch.worktree.branches = branches;
    this.dirty = true;
  }
  /** Moves the launcher to a checkout. */
  private chooseWorktree(index: number): void {
    const launch = this.agent_launcher;
    if (!launch) return;
    const c = launch.worktree,
      all = launcherWorktree.checkouts(launch.worktrees);
    this.dirty = true;
    if (index >= all.length) return;
    c.mode = "closed";
    c.planned = null;
    if (launcherWorktree.containing(launch.worktrees, launch.cwd) === all[index]) return;
    launch.cwd = all[index].path;
    launch.preview = this.launch_previews.current(launch.cwd);
    launch.resume_view.focused = false;
  }
  /** Keys while the launcher's box of checkouts and new-worktree form is
   * open. Escape closes the box from anywhere in it but From's branch list,
   * which it only dismisses. */
  private worktreeKey(byte: number): void {
    const launch = this.agent_launcher!;
    const c = launch.worktree;
    this.dirty = true;
    if (c.focus === "from") {
      switch (byte) {
        case 27:
          c.focus = "branch";
          return;
        case 13:
        case 9:
          c.takeFrom();
          return;
        case 14:
          c.movePick(1);
          return;
        case 16:
          c.movePick(-1);
          return;
        default:
          c.search(from => from.key(byte));
          return;
      }
    }
    if (c.focus === "branch") {
      switch (byte) {
        case 27:
          c.mode = "closed";
          return;
        case 13:
          c.accept(launch.worktrees, launch.cwd, launch.worktree_folder);
          return;
        case 9:
          c.focusFrom();
          return;
        default:
          c.error = "";
          // Branch names have no spaces; a typed one joins the words.
          c.field.key(byte === 32 ? 45 : byte);
          return;
      }
    }
    switch (byte) {
      case 27:
      case 119:
        c.mode = "closed";
        break;
      case 13:
        this.chooseWorktree(c.hovered);
        break;
      case 110:
        c.focus = "branch";
        break;
      case 9:
      case 14:
      case 106:
        c.move(launch.worktrees, 1);
        break;
      case 16:
      case 107:
        c.move(launch.worktrees, -1);
        break;
      default:
        break;
    }
  }
  private async previewInlineCommand(immediate: boolean): Promise<void> {
    const launch = this.agent_launcher;
    if (!launch || !launch.managing) return;
    const now = milliTimestamp();
    if (launch.draft.text() !== launch.editor.name()) {
      try {
        launch.draft.set(launch.editor.name());
      } catch {
        return;
      }
      launch.draft_changed = now;
      launch.request_id = (Math.floor(Math.random() * 0xffffffff) | 1) >>> 0;
      launch.resolution_checked = 0;
      launch.resolution = agentLauncher.resolution();
      launch.save_requested = false;
      this.dirty = true;
    }
    if (launch.draft.command.length === 0 || launch.editor.overflow || !launch.resolution.pending) return;
    if (!immediate && now - launch.draft_changed < 350) return;
    if (now - launch.resolution_checked < 100) return;
    launch.resolution_checked = now;
    let response: any;
    try {
      response = await call(this.connection, "agent.command.preview", {
        workspace: launch.workspace,
        cwd: launch.cwd,
        request: launch.request_id,
        command: launch.draft.text(),
      });
    } catch {
      return;
    }
    launch.resolution = agentLauncher.resolution(response.resolution);
    if (!launch.resolution.pending && !launch.name_customized && launch.resolution.error_message.length === 0)
      launch.name_editor = Dialog.init({ rename: 0 }, launch.resolution.semantics.suggested_name);
    this.dirty = true;
  }
  private async deleteLauncherCommand(index: number): Promise<void> {
    await this.execute({ "agent.command": { index, command: "", resolve: false } });
    const launch = this.agent_launcher;
    if (launch) {
      launch.commands = this.runtime.agent_commands;
      if (launch.edit_index === index) launch.edit("add");
      launch.normalize();
    }
    this.dirty = true;
  }
  private async saveInlineCommand(): Promise<void> {
    const launch = this.agent_launcher;
    if (!launch) return;
    const index = launch.edit_index ?? launch.emptyCommand();
    if (index === null) {
      launch.editor.failed = true;
      this.dirty = true;
      return;
    }
    if (launch.editor.overflow || (launch.editor.name().length === 0 && launch.edit_index === null)) {
      launch.editor.failed = true;
      this.dirty = true;
      return;
    }
    await this.previewInlineCommand(true);
    if (launch.editor.name().length > 0 && launch.resolution.pending) {
      launch.save_requested = true;
      return;
    }
    launch.save_requested = false;
    if (launch.editor.name().length > 0 && launch.resolution.error_message.length > 0) {
      launch.save_error = launch.resolution.error_message;
      launch.editor.failed = true;
      this.dirty = true;
      return;
    }
    launch.save_error = "";
    const hidden = launch.edit_index !== null ? launch.commands[launch.edit_index].hidden : false;
    try {
      await this.execute({
        "agent.command": {
          index,
          command: launch.editor.name().length === 0 ? "" : launch.resolution.command.text(),
          hidden,
          resolve: false,
          original: launch.editor.name(),
          name:
            launch.name_editor.name().length > 0
              ? launch.name_editor.name()
              : launch.resolution.semantics.suggested_name,
          semantics: launch.resolution.semantics,
        },
      });
    } catch {
      launch.save_error = "Could not resolve shorthand. Paste its underlying command.";
      launch.editor.failed = true;
      this.dirty = true;
      return;
    }
    if (launch.edit_provider) {
      const visibility = { ...this.runtime.agent_hidden };
      visibility[launch.edit_provider] = true;
      await this.execute({ "agent.visibility": { hidden: visibility } });
      launch.hidden = visibility;
    }
    launch.commands = this.runtime.agent_commands;
    launch.edit("add");
    this.dirty = true;
  }
  private async toggleCommandVisibility(index: number): Promise<void> {
    const entry = this.runtime.agent_commands[index];
    await this.execute({ "agent.command": { index, command: entry.text(), hidden: !entry.hidden, resolve: false } });
    if (this.agent_launcher) {
      this.agent_launcher.commands[index].hidden = !entry.hidden;
      this.agent_launcher.pinned = true;
    }
    this.dirty = true;
  }
  private async toggleLauncherYolo(provider: Provider): Promise<void> {
    const enabled = !this.runtime.agent_yolo[provider];
    await this.execute({ "agent.yolo": { provider, enabled } });
    if (this.agent_launcher) {
      this.agent_launcher.yolo[provider] = enabled;
      this.agent_launcher.selected = Row.of(provider);
      this.agent_launcher.pinned = true;
    }
    this.dirty = true;
  }
  private rememberLauncherSelection(): void {
    const launch = this.agent_launcher;
    if (!launch) return;
    if (launch.managing || launch.selected === "manage" || launch.selected === "add") return;
    this.rememberLauncherRow(launch.workspace, launch.selected);
  }
  private rememberLauncherRow(id: number, row: LauncherRow): void {
    this.launcher_selection = row;
    this.navigation.rememberLauncherRow(this.runtime.workspaces, id, row);
  }
  /** The row the launcher opens on in workspace `id`: the one last left
   * selected there, else its agent, else the last row or agent used anywhere. */
  private launcherSelection(id: number): LauncherRow {
    const row = this.navigation.launcherRow(this.runtime.workspaces, id);
    if (row !== null) return row;
    const i = this.runtime.workspaces.index(id);
    if (i === null) return Row.of(this.runtime.last_agent);
    const last = this.runtime.workspaces.items[i].last_agent;
    if (last) return Row.of(last);
    return this.launcher_selection ?? Row.of(this.runtime.last_agent);
  }
  private closeLauncher(): void {
    this.rememberLauncherSelection();
    this.agent_launcher = null;
  }
  private openLauncher(pinned: boolean, cwd = this.currentCwd()): void {
    this.closeMenu();
    if (byteLength(cwd) > 10 * 1024) return;
    const launch = new LauncherMenu({
      workspace: this.current().id,
      cwd,
      selected: this.launcherSelection(this.current().id),
      last: this.lastAgent(),
      yolo: { ...this.runtime.agent_yolo },
      hidden: { ...this.runtime.agent_hidden },
      commands: this.runtime.agent_commands,
      pinned,
    });
    launch.preview = this.launch_previews.current(cwd);
    launch.workspace_cwd = byteLength(this.current().cwd) <= 10 * 1024 ? this.current().cwd : "";
    launch.worktrees = this.current().worktrees ?? null;
    launch.worktree_folder = this.prefs.worktree_folder;
    this.showHistory(launch);
    launch.normalize();
    this.agent_launcher = launch;
    this.cancelDividers();
    this.selection = null;
    this.dirty = true;
  }
  private async newAgentShortcut(): Promise<void> {
    const launch = this.agent_launcher;
    if (launch) {
      if (launch.pinned) {
        await this.launchRow(launch.selected);
        return;
      }
      launch.pinned = true;
      this.dirty = true;
      return;
    }
    this.sidebar_open = true;
    this.openLauncher(true);
  }
  private moveLauncher(next: boolean, wrap: boolean): void {
    const launch = this.agent_launcher;
    if (launch) {
      // Down from the last agent row goes into the conversations.
      if (next && !wrap && !launch.managing && launch.hasResume() && launch.selected === launch.lastRow()) {
        launch.resume_view.focused = true;
        launch.resume_view.home();
      } else launch.move(next, wrap);
      launch.pinned = true;
    }
    this.dirty = true;
  }
  private selectLauncher(row: LauncherRow): void {
    const launch = this.agent_launcher;
    if (launch) {
      launch.selected = row;
      launch.normalize();
      launch.pinned = true;
    }
    this.dirty = true;
  }
  private async trackLauncherUsage(provider: Provider): Promise<void> {
    const launch = this.agent_launcher;
    if (!launch) return;
    // Tracking asks for access to Claude's stored credentials.
    if (provider === "codex") return;
    if (!launch.trackable(Row.of(provider))) return;
    launch.pinned = true;
    try {
      await call(this.connection, "agent.track_usage", { workspace: launch.workspace, cwd: launch.cwd });
    } catch {
      return;
    }
    launch.preview.pending = true;
    this.launch_previews.pending(launch.cwd);
    this.dirty = true;
  }
  private async pollLauncher(): Promise<void> {
    this.updateLaunchPreview();
    await this.previewInlineCommand(false);
    if (
      this.agent_launcher &&
      this.agent_launcher.managing &&
      this.agent_launcher.save_requested &&
      !this.agent_launcher.resolution.pending
    )
      await this.saveInlineCommand();
    const side = this.sidebarView([]);
    const hit = this.pointer ? side.hit(this.pointer.x, this.pointer.y).tag : "none";
    const on_button = hit === "agent_new" || hit === "agent_options";
    const launch = this.agent_launcher;
    if (launch) {
      launch.yolo = { ...this.runtime.agent_yolo };
      launch.hidden = { ...this.runtime.agent_hidden };
      launch.commands = this.runtime.agent_commands;
      launch.normalize();
      if (launch.workspace !== this.current().id || (side.width === 0 && !launch.pinned)) {
        this.closeLauncher();
        return;
      }
      const inside =
        this.pointer !== null && launch.bounds(this.width, this.height, side).contains(this.pointer.x, this.pointer.y);
      if (!launch.pinned && !on_button && !inside) {
        this.closeMenu();
        return;
      }
      launch.last = this.lastAgent();
    } else if (
      on_button &&
      !this.launcher_hover_blocked &&
      !this.hasMenu() &&
      this.name_dialog === null &&
      !this.ui_mouse_down &&
      !this.copy_mode
    ) {
      this.openLauncher(false);
    }
  }
  updateLaunchPreview(): void {
    const cwd = this.agent_launcher ? this.agent_launcher.cwd : this.currentCwd();
    if (!this.launch_previews.poll(this.current().id, cwd)) return;
    const launch = this.agent_launcher;
    if (launch) {
      launch.preview = this.launch_previews.current(launch.cwd);
      // An open launcher keeps its list, unless it had none yet.
      if (launch.history.entries.length === 0 && this.launch_previews.history.entries.length > 0)
        this.showHistory(launch);
      launch.normalize();
      this.revealResume();
    }
    this.dirty = true;
  }
  /** Give the launcher the conversations as they are now, with this
   * Corgi's names and times for the ones it ran. */
  private showHistory(launch: LauncherMenu): void {
    launch.history = { pending: this.launch_previews.history.pending, entries: this.mergedHistory() };
    launch.open = this.running.slice();
  }
  private mergedHistory(): launcherResume.Entry[] {
    const known: launcherResume.Known[] = [];
    for (const c of this.runtime.conversations) {
      const provider = c.agent.provider;
      if (!provider) continue;
      if ((c.parent !== null && c.parent !== undefined) || c.agent.session.length === 0) continue;
      const at = Math.trunc(Math.max(Number(c.observed_at ?? 0), c.agent.changed_at) / 1_000_000);
      known.push({ provider, session: c.agent.session, name: c.agent.name, at });
    }
    for (const stop of this.stopped)
      known.push({ provider: stop.provider, session: stop.session, name: "", at: stop.at });
    return launcherResume.merge(this.launch_previews.history.entries.map(launcherResume.historyEntry), known);
  }
  /** Note the conversations panes stop running, and when, so a closed one
   * sorts by when it closed. */
  private trackRunning(): void {
    const running: launcherResume.Open[] = [];
    for (const p of this.runtime.panes) {
      const provider = p.agent.provider;
      if (!provider) continue;
      if (p.agent.session.length === 0 || running.length === launcherResume.max_open) continue;
      running.push({ provider, session: p.agent.session, pane: p.id });
    }
    const now = nowSeconds();
    for (const was of this.running) {
      if (running.some(is => is.provider === was.provider && is.session === was.session)) continue;
      if (this.stopped.length === 32) this.stopped.shift();
      this.stopped.push({ provider: was.provider, session: was.session, at: now });
    }
    this.running = running;
  }
  /** Expand the conversations under the agents, searching when asked. */
  private expandResume(searching: boolean): void {
    const launch = this.agent_launcher;
    if (!launch || !launch.hasResume()) return;
    launch.pinned = true;
    if (searching) launch.resume_view.startSearch();
    else launch.resume_view.expand();
    this.revealResume();
    this.dirty = true;
  }
  private revealResume(): void {
    const launch = this.agent_launcher;
    if (!launch || !launch.resume_view.expanded) return;
    launch.resume_view.reveal(launch.resumeContext(), launch.resumeArea(this.width, this.height, this.sidebarView([])));
  }
  private async openManager(): Promise<void> {
    if (this.agent_launcher) {
      this.agent_launcher.resume_view.focused = false;
      this.agent_launcher.resume_view.collapse();
    }
    await this.launchRow("manage");
  }
  /** Move within the conversations; up from the first returns to the agents. */
  private moveResume(rows: launcherResume.Line[], delta: number): void {
    const launch = this.agent_launcher!;
    if (launch.resume_view.move(launch.resumeContext(), rows, delta)) return;
    launch.resume_view.focused = false;
    launch.selected = launch.lastRow();
  }
  private async resumeKey(byte: number): Promise<void> {
    const launch = this.agent_launcher!;
    const view = launch.resume_view;
    const c = launch.resumeContext();
    const rows = view.lines(c);
    if (view.searching) {
      switch (byte) {
        case 27:
          if (view.query.len > 0) {
            view.query.clear();
            view.home();
          } else return this.closeMenu();
          break;
        case 13:
          return this.resumeSelected();
        case 9:
          view.nextScope(true);
          break;
        case 14:
          this.moveResume(rows, 1);
          break;
        case 16:
          this.moveResume(rows, -1);
          break;
        default:
          view.query.key(byte);
          view.home();
      }
    } else {
      switch (byte) {
        case 27:
          if (view.expanded) view.collapse();
          else return this.closeMenu();
          break;
        case 13:
        case 97:
        case 65:
        case 1:
          return this.resumeSelected();
        case 47:
          view.startSearch();
          break;
        case 9:
          if (view.expanded) view.nextScope(true);
          else this.moveResume(rows, 1);
          break;
        case 106:
        case 14:
          this.moveResume(rows, 1);
          break;
        case 107:
        case 16:
          this.moveResume(rows, -1);
          break;
        case 109:
          return this.openManager();
        case 116:
          return this.launchRow("terminal");
        default:
          if (byte >= 48 && byte <= 57) {
            const row = launch.shortcutRow(byte);
            if (row !== null) return this.launchRow(row);
          } else {
            const provider = keyAgent(byte);
            if (provider && launch.shown(Row.of(provider))) return this.launchAgent(provider);
          }
      }
    }
    this.revealResume();
    this.dirty = true;
  }
  private resumeSequence(seq: string, parsed: keys.Key | null): void {
    const launch = this.agent_launcher!;
    const view = launch.resume_view;
    const c = launch.resumeContext();
    const rows = view.lines(c);
    const page = view.expanded
      ? Math.max(1, launch.resumeArea(this.width, this.height, this.sidebarView([])).height - 3)
      : launcherResume.collapsed_rows;
    if (parsed === null) {
      if (view.searching) view.query.sequence(seq);
      this.dirty = true;
      return;
    }
    switch (parsed) {
      case "up":
        this.moveResume(rows, -1);
        break;
      case "down":
        this.moveResume(rows, 1);
        break;
      case "page_up":
        this.moveResume(rows, -page);
        break;
      case "page_down":
        this.moveResume(rows, page);
        break;
      case "home":
      case "end":
      case "left":
      case "right":
      case "delete":
        if (view.searching) view.query.sequence(seq);
        else if (parsed === "home") view.home();
        else if (parsed === "end") view.move(c, rows, Number.MAX_SAFE_INTEGER);
        break;
      case "shift_tab":
        if (view.expanded) view.nextScope(false);
        else this.moveResume(rows, -1);
        break;
      default:
        break;
    }
    this.revealResume();
    this.dirty = true;
  }
  /** Resume the selected conversation in a new tab, or go to the pane that already runs it. */
  private async resumeSelected(): Promise<void> {
    const launch = this.agent_launcher!;
    const c = launch.resumeContext();
    // The row past the newest few shows them all.
    const e = launch.resume_view.entry(c, launch.resume_view.lines(c));
    if (!e) return this.expandResume(false);
    return this.resumeEntry(e, this.current().id);
  }
  private async resumeEntry(e: launcherResume.Entry, workspace: number): Promise<void> {
    for (const open of this.running)
      if (open.provider === e.provider && open.session === e.session) {
        this.closeMenu();
        return this.selectAgent({ pane: open.pane });
      }
    if (byteLength(e.cwd) > 4096 || byteLength(e.session) > 256) throw Error("NameTooLong");
    const command = {
      "agent.resume": { workspace, cwd: e.cwd, provider: e.provider, session: e.session },
    };
    this.closeMenu();
    let created: { pane: number };
    try {
      created = await this.execute(command);
    } catch (error) {
      this.notice((error as Error).message);
      return;
    }
    this.focusPane(created.pane);
    this.launched = created.pane;
    this.dirty = true;
  }
  private portWorkspaceEntry(id: number): WorkspaceEntry {
    return sidebar.workspaceEntry({
      id,
      name: "",
      cwd: "",
      active: false,
      ports: this.runtime.ports,
      remote_links: this.remote_links,
    });
  }
  private openSetup(): void {
    this.closeMenu();
    const setup = SetupMenu.open();
    setup.integration = this.remote_links ? "unavailable" : ghosttyIntegration.state();
    setup.image_paste = this.host_clipboard;
    setup.pacing = this.host_pacer;
    setup.terminal = {
      name: this.host_clipboard?.terminal.text() || (process.env.TERM_PROGRAM ?? ""),
      ssh: this.remote_links,
      graphics: this.supports_kitty_graphics,
      colors: this.terminal_colors !== null,
    };
    setup.shell = this.runtime.shell;
    setup.shells = installedShells();
    // Source control previews the worktree folder in a real project, this workspace's first.
    for (const ws of [this.current(), ...this.runtime.workspaces.items]) {
      const root = ws.worktrees?.entries.find(e => e.primary)?.path;
      if (!root) continue;
      setup.project = { name: basename(root), root };
      break;
    }
    setup.smart_links = this.runtime.smart_links;
    this.corgi_setup = setup;
    this.dirty = true;
  }
  openOnboarding(mode: onboarding.Mode): void {
    // Repeated commands must preserve an open wizard and any active import.
    if (this.onboarding !== null) return;
    this.dismissName();
    this.closeMenu();
    this.copy_mode = false;
    this.search_mode = false;
    this.selection = null;
    this.cancelDividers();
    this.onboarding = onboarding.State.start(mode, this.prefs.preset, this.prefs.prefix);
    this.dirty = true;
  }
  /** Carries out what Enter or a click in Corgi setup asked for. */
  private async applySetup(apply: SetupApply | null): Promise<void> {
    this.dirty = true;
    if (apply === null) return;
    switch (apply.kind) {
      case "shell":
        return this.chooseShell(apply.entry);
      case "import": {
        const picker = this.corgi_setup?.import_picker;
        if (!picker) return;
        try {
          await picker.begin(this.rpc());
        } catch (error) {
          picker.message = (error as Error).message;
        }
        return;
      }
      case "detach":
        this.closeMenu();
        return this.perform({ name: "detach" });
      case "imported":
        this.closeMenu();
        if (apply.workspace === null) return;
        await this.refresh();
        this.switchWorkspace(apply.workspace);
        if (this.model().count === 0) this.openLauncher(true);
        return;
      case "keymap":
        return this.openHelp();
      case "preset":
        // Command keys need Ghostty set up first; onboarding walks through it.
        if (apply.preset === "cmux") {
          this.openOnboarding("keyboard");
          if (this.onboarding) {
            this.onboarding.preset = "cmux";
            this.onboarding.step = "connect";
          }
          return;
        }
        return this.saveKeys(apply.preset, this.prefs.prefix);
      case "prefix":
        return this.saveKeys(this.prefs.preset, this.prefs.prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b");
      case "readings":
        this.prefs.resources.enabled = apply.on;
        try {
          preferences.update({ resources: this.prefs.resources });
        } catch (error) {
          this.notice((error as Error).message);
        }
        return;
      case "sleeping_corgis":
        this.prefs.sleeping_corgis = apply.on;
        try {
          preferences.update({ sleeping_corgis: this.prefs.sleeping_corgis });
        } catch (error) {
          this.notice((error as Error).message);
        }
        return;
      case "theme":
        this.prefs.theme = apply.theme;
        try {
          preferences.update({ theme: this.prefs.theme });
        } catch (error) {
          this.notice((error as Error).message);
        }
        return;
      case "worktree_folder":
        this.prefs.worktree_folder = apply.template;
        try {
          preferences.update({ worktree_folder: apply.template });
        } catch (error) {
          this.notice((error as Error).message);
        }
        return;
      case "ghostty":
        return this.toggleGhostty();
      case "smart_links":
        return this.configureSmartLinks(apply.on);
      case "summaries":
        return this.configureSummaries(apply.choice);
    }
  }
  private async toggleGhostty(): Promise<void> {
    const integration_state = this.remote_links ? "unavailable" : ghosttyIntegration.state();
    if (integration_state === "unavailable") {
      this.notice(" Ghostty integration requires a local macOS viewer");
      return;
    }
    if (integration_state === "failed") {
      this.notice(" Could not read Ghostty config; no changes made");
      return;
    }
    try {
      await ghosttyIntegration.sync(
        integration_state === "enabled" ? null : { preset: this.prefs.preset, prefix: this.prefs.prefix },
      );
    } catch (error) {
      this.notice(` Ghostty integration: ${(error as Error).message}`);
      return;
    }
    if (this.corgi_setup) {
      this.corgi_setup.integration = ghosttyIntegration.state();
      this.corgi_setup.reload_ghostty = true;
    }
    this.notice(
      integration_state === "enabled"
        ? " Ghostty integration disabled. Reload Ghostty: Cmd+Shift+,"
        : " Ghostty integration enabled. Reload Ghostty: Cmd+Shift+,",
    );
  }
  /** The setup screen stays open; the daemon republishes status, which moves the in-use mark. */
  private async configureSummaries(choice: Summarizer): Promise<void> {
    let response: any;
    try {
      response = await call(this.connection, "inference.configure", { choice });
    } catch {
      this.notice(" Corgi setup: the runtime did not accept the change");
      return;
    }
    const saved = response.saved === true;
    const label =
      choice === "auto"
        ? "Auto (follows your agents)"
        : choice === "off"
          ? "Off"
          : Provider.info(Summarizer.provider(choice)!).label;
    this.notice(` Summaries and link names: ${label}${saved ? "" : " (not saved for next start)"}`);
  }
  private async configureSmartLinks(enabled: boolean): Promise<void> {
    try {
      await call(this.connection, "smart_links.configure", { enabled });
    } catch {
      this.notice(" Corgi setup: the runtime did not accept the change");
      return;
    }
    this.runtime.smart_links = enabled;
    if (this.corgi_setup) this.corgi_setup.smart_links = enabled;
    this.notice(enabled ? " Smart Links on" : " Smart Links off: Corgi won't connect to pane ports");
  }
  /** A shell option: Other… asks for a path; the rest go to the daemon. */
  private async chooseShell(entry: shellPicker.Entry): Promise<void> {
    if (entry === "other") {
      const setting = this.runtime.shell.setting;
      // Setup draws over dialogs, so it closes first.
      this.closeMenu();
      this.name_dialog = Dialog.init({ shell: null }, setting);
      return;
    }
    await this.configureShell(entry === "default" ? "" : entry.path);
  }
  /** False when the daemon finds no executable shell for the setting. */
  private async configureShell(shell: string): Promise<boolean> {
    let response: any;
    try {
      response = await call(this.connection, "shell.configure", { shell });
    } catch (error) {
      if (errors.is(error, "ShellNotFound")) return false;
      this.notice(" Corgi setup: the runtime did not accept the change");
      return true;
    }
    const status = shellPicker.status(response.shell);
    this.runtime.shell = status;
    if (this.corgi_setup) this.corgi_setup.shell = status;
    this.notice(` New panes start in ${basename(status.path)}${status.source === "setting" ? "" : " (the default)"}`);
    return true;
  }
  private movePortMenu(next: boolean): void {
    const links = this.port_menu;
    if (links) {
      const count = sidebar.urlCount(this.portWorkspaceEntry(links.workspace));
      links.selected = next ? Math.min(links.selected + 1, sat(count, 1)) : sat(links.selected, 1);
      this.dirty = true;
    }
  }
  private async finishOnboarding(): Promise<void> {
    const wizard = this.onboarding;
    if (!wizard) return;
    if (wizard.cancelled) {
      wizard.close();
      this.onboarding = null;
      this.dirty = true;
      return;
    }
    let reload: boolean;
    try {
      reload = await this.storeKeys(wizard.preset, wizard.prefix);
    } catch (error) {
      wizard.fail(error as Error);
      this.dirty = true;
      return;
    }
    const target = wizard.picker.progress?.workspace ?? null;
    const mode = wizard.mode;
    wizard.close();
    this.onboarding = null;
    if (mode === "keyboard") this.keysNotice(reload);
    else if (target !== null && target !== undefined) {
      await this.refresh();
      this.switchWorkspace(target);
      if (this.model().count === 0) this.openLauncher(true);
    } else if (mode === "welcome") this.openLauncher(true);
    this.dirty = true;
  }
  /** Saves the shortcut preset and prefix; true when Ghostty needs a reload. */
  private async storeKeys(preset: keymap.Preset, prefix: keymap.Prefix): Promise<boolean> {
    preferences.update({ preset, prefix, onboarding_complete: true });
    this.prefs.preset = preset;
    this.prefs.prefix = prefix;
    this.prefs.onboarding_complete = true;
    // An enabled Ghostty block types the old prefix and keys until re-rendered.
    if (this.remote_links) return false;
    try {
      return await ghosttyIntegration.refresh({ preset, prefix });
    } catch {
      return false;
    }
  }
  private keysNotice(reload: boolean): void {
    this.notice(
      this.prefs.preset === "cmux"
        ? " Shortcuts: cmux. Reload Ghostty: Cmd+Shift+,"
        : ` Shortcuts: ${keymap.name(this.prefs.preset)} · prefix ${keymap.prefixName(this.prefs.prefix)}${reload ? ". Reload Ghostty: Cmd+Shift+," : ""}`,
    );
  }
  private async saveKeys(preset: keymap.Preset, prefix: keymap.Prefix): Promise<void> {
    let reload: boolean;
    try {
      reload = await this.storeKeys(preset, prefix);
    } catch (error) {
      this.notice(` ${(error as Error).message}`);
      return;
    }
    this.keysNotice(reload);
  }
  private cyclePane(next: boolean): void {
    if (this.model().count === 0) return;
    const selection = new Selection();
    selection.tabs = this.nav().tabs.map(tab => ({ ...tab }));
    selection.count = this.nav().count;
    selection.active = this.nav().active;
    selection.tab().zoom = false;
    const list = new LayoutView(this.model(), selection).placements(this.area());
    if (list.length === 0) return;
    let index = list.findIndex(p => p.id === this.nav().tab().focus);
    if (index < 0) index = 0;
    this.focusPane(list[next ? (index + 1) % list.length : (index + list.length - 1) % list.length].id);
  }
  private async key(byte: number): Promise<void> {
    const cl = this.input_state;
    this.repeat_until = 0;
    if (this.worktreeDetail() !== null) {
      // Esc stops a removal under way; otherwise it closes the overview.
      if (byte === 27)
        return this.perform({
          name: this.worktree_card.removal.phase === "removing" ? "worktree-stop" : "worktree-close",
        });
      if (this.worktree_card.pinned) {
        if (byte === 13) await this.perform({ name: "worktree-enter" });
        else if (byte === 106 || byte === 14 || byte === 9) await this.perform({ name: "worktree-next" });
        else if (byte === 107 || byte === 16) await this.perform({ name: "worktree-prev" });
        else if (byte === 127 || byte === 8) await this.perform({ name: "worktree-remove" });
        return;
      }
    }
    if (byte === 27 && this.paste_card !== null) return this.closePasteCard();
    if (this.onboarding) {
      const wizard = this.onboarding;
      if (byte === 3) {
        cl.attached = false;
        return;
      }
      let done = false;
      try {
        done = await wizard.key(byte, this.rpc());
      } catch (error) {
        wizard.fail(error as Error);
        this.dirty = true;
        return;
      }
      if (done) await this.finishOnboarding();
      this.dirty = true;
      return;
    }
    if (this.scope_menu !== null) {
      this.closeMenu();
      if (byte === 27) return;
    }
    if (this.corgi_setup) {
      const setup = this.corgi_setup,
        s = this.runtime.inference,
        shortcuts = setup.item === "keyboard" && setup.focus === "options",
        chord = setup.prefixKey(byte, this.prefs);
      if (chord !== null) {
        if (chord === "detach") await this.applySetup({ kind: "detach" });
        this.dirty = true;
        return;
      }
      if (setup.key(byte)) {
        this.dirty = true;
        return;
      }
      switch (byte) {
        case 27:
        case 113:
          if (!setup.back()) this.closeMenu();
          break;
        case 13:
        case 32:
          await this.applySetup(setup.enter(s, this.prefs));
          break;
        case 106:
        case 14:
        case 9:
          setup.move(true, s, this.prefs);
          break;
        case 107:
        case 16:
          setup.move(false, s, this.prefs);
          break;
        case 108:
          setup.openOptions(s, this.prefs);
          break;
        case 104:
          setup.back();
          break;
        // The preset detail's own keys: [ P change ] and [ ? Full keymap ].
        case 112:
        case 80:
          if (shortcuts) await this.applySetup({ kind: "prefix" });
          break;
        case 63:
          if (shortcuts) await this.applySetup({ kind: "keymap" });
          break;
        default:
          break;
      }
      this.dirty = true;
      return;
    }
    if (this.agent_launcher) {
      const launch = this.agent_launcher;
      if (launch.managing && launch.selected === "add") {
        switch (byte) {
          case 9:
            launch.name_focused = !launch.name_focused;
            break;
          case 14:
            this.moveLauncher(true, false);
            break;
          case 16:
            this.moveLauncher(false, false);
            break;
          case 27:
            await this.launchRow("manage");
            break;
          case 13:
            await this.saveInlineCommand();
            break;
          default:
            if (launch.name_focused) launch.name_customized = true;
            launch.input().key(byte);
        }
        this.dirty = true;
        return;
      }
      if (launch.pinned && byte === keymap.prefixByte(this.prefs.prefix)) {
        launch.prefix = true;
        return;
      }
      const after_prefix = launch.prefix;
      launch.prefix = false;
      if (after_prefix && (byte === 99 || byte === 97 || byte === 65)) return;
      if (launch.pinned && byte === 20 && this.prefs.preset === "corgi") return;
      if (launch.worktree.mode !== "closed" && !launch.managing) {
        launch.pinned = true;
        return this.worktreeKey(byte);
      }
      if (launch.resume_view.focused && !launch.managing) {
        launch.pinned = true;
        return this.resumeKey(byte);
      }
      const recognized =
        [27, 13, 9, 14, 16, 97, 65, 1, 121, 116, 109, 47, 119].includes(byte) ||
        (byte === 117
          ? launch.trackable(launch.selected) || launch.shortcutRow(byte) !== null
          : launch.shortcutRow(byte) !== null);
      if (!launch.pinned && !recognized) {
        this.closeMenu();
      } else {
        launch.pinned = true;
        switch (byte) {
          case 27:
            this.closeMenu();
            break;
          case 13:
          case 97:
          case 65:
          case 1:
            await this.launchRow(launch.selected);
            break;
          case 9:
            this.moveLauncher(true, true);
            break;
          case 106:
          case 14:
            this.moveLauncher(true, false);
            break;
          case 107:
          case 16:
            this.moveLauncher(false, false);
            break;
          case 116:
            await this.launchRow("terminal");
            break;
          case 109:
            if (!launch.managing) await this.openManager();
            break;
          case 119:
            this.openWorktrees();
            break;
          case 47:
            this.expandResume(true);
            break;
          case 121:
            if (!launch.managing) {
              const provider = Row.agent(launch.selected);
              if (provider) await this.toggleLauncherYolo(provider);
            }
            break;
          case 117:
            if (launch.trackable(launch.selected)) await this.trackLauncherUsage(Row.agent(launch.selected)!);
            break;
          default:
            if (byte >= 48 && byte <= 57) {
              const row = launch.shortcutRow(byte);
              if (row !== null) await this.launchRow(row);
            } else {
              const provider = keyAgent(byte);
              if (provider && !launch.managing && launch.shown(Row.of(provider))) await this.launchAgent(provider);
            }
        }
        return;
      }
    }
    if (this.agent_picker) {
      switch (byte) {
        case 27:
          this.closeMenu();
          break;
        case 13:
          this.acceptAgentPicker();
          break;
        case 9:
        case 14:
          this.moveAgentPicker(true);
          break;
        case 16:
          this.moveAgentPicker(false);
          break;
        default:
          this.agent_picker.query.key(byte);
          this.pickerEntries();
      }
      this.dirty = true;
      return;
    }
    if (this.sidebar_focus && !this.prefix) {
      switch (byte) {
        case 27:
          this.leaveSidebar();
          break;
        case 13:
          await this.openSidebarRow(false);
          break;
        default:
          if (byte === keymap.prefixByte(this.prefs.prefix)) this.beginPrefix();
          // A drawer stays one list; searching would open the whole sidebar.
          else if (byte > 32 && byte < 127 && !this.sidebar_focus.drawer) this.searchSidebar(byte);
      }
      this.dirty = true;
      return;
    }
    if (this.port_menu) {
      const links = this.port_menu;
      switch (byte) {
        case 27:
          this.closeMenu();
          break;
        case 106:
        case 9:
          this.movePortMenu(true);
          break;
        case 107:
          this.movePortMenu(false);
          break;
        case 13:
          if (!this.remote_links) {
            const url = sidebar.workspaceUrl(this.portWorkspaceEntry(links.workspace), links.selected);
            if (url !== null) {
              this.queueEffect({ open_url: url });
              this.closeMenu();
            }
          }
          break;
        default:
          break;
      }
      return;
    }
    this.sidebar_drag = null;
    if (this.workspace_drag) {
      this.workspace_drag.cancelled = true;
      this.workspace_drag.drop = null;
      this.workspace_drag.preview = null;
      this.dirty = true;
    }
    if (this.agent_drag) {
      this.agent_drag.cancelled = true;
      this.agent_drag.drop = null;
      this.agent_drag.preview = null;
      this.dirty = true;
    }
    this.cancelDividers();
    if (cl.tab_drag) {
      cl.tab_drag.cancelled = true;
      this.dirty = true;
    }
    if (this.tab_menu) {
      const context = this.tab_menu;
      switch (byte) {
        case 27:
          this.closeMenu();
          break;
        case 13: {
          const item = context.highlightedItem();
          if (item) await this.tabMenuAction(item);
          break;
        }
        case 106:
        case 9:
          this.moveTabMenu(true);
          break;
        case 107:
          this.moveTabMenu(false);
          break;
        default: {
          const item = context.itemFor(byte);
          if (item) await this.tabMenuAction(item);
          else if (byte === keymap.prefixByte(this.prefs.prefix)) this.beginPrefix();
        }
      }
      return;
    }
    if (this.search_mode) {
      if (byte === 27) {
        this.search_mode = false;
        this.message = "";
      } else if (byte === 13) {
        this.search_mode = false;
        this.search_skip = 0;
        this.message = "";
        const p = this.focused();
        if (p && !(await p.terminal.search(Buffer.from(this.search_text).toString(), 0))) this.notice(" No matches");
      } else if (byte === 127) {
        this.search_text.pop();
      } else if (byte >= 32 && byte < 127 && this.search_text.length < 128) {
        this.search_text.push(byte);
      }
      if (this.search_mode) this.message = ("/" + Buffer.from(this.search_text).toString()).slice(0, 512);
      this.dirty = true;
      return;
    }
    if (this.name_dialog) {
      switch (this.name_dialog.key(byte)) {
        case "save":
          await this.finishName(true);
          break;
        case "cancel":
          await this.finishName(false);
          break;
        default:
          break;
      }
      this.dirty = true;
      return;
    }
    if (this.resize_mode) {
      const dir = direction(byte);
      if (dir) await this.perform({ name: "resize", value: dir });
      else this.closeMenu();
      return;
    }
    if (this.prefix) {
      if (this.help_visible && (byte === 14 || byte === 16)) {
        this.help.move(byte === 14, 1);
        this.dirty = true;
        return;
      }
      if (this.help_visible && byte === 116) {
        this.help.play(Date.now());
        return;
      }
      this.prefix = false;
      this.dirty = true;
      if (byte === keymap.prefixByte(this.prefs.prefix)) {
        const p = this.focused();
        if (p) this.sendInput(p.terminal, [byte]);
        return;
      }
      const act = bindings.lookup(this.prefs.preset, true, byte, {});
      if (act) await this.runPrefixed(act, false);
      return;
    }
    if (byte === keymap.prefixByte(this.prefs.prefix)) {
      this.beginPrefix();
      return;
    }
    if (!this.copy_mode) {
      const act = bindings.lookup(this.prefs.preset, false, byte, {});
      if (act) return this.perform(act);
    }
    if (this.copy_mode) {
      const p = this.focused();
      switch (byte) {
        case 107:
          this.scroll(-1);
          break;
        case 106:
          this.scroll(1);
          break;
        case 21:
          this.scroll(-10);
          break;
        case 4:
          this.scroll(10);
          break;
        case 103:
          if (p) {
            p.terminal.scrollViewport("top");
            this.dirty = true;
          }
          break;
        case 71:
          if (p) {
            p.terminal.scrollViewport("bottom");
            this.dirty = true;
          }
          break;
        case 121:
        case 13:
          if (p) this.copyPane(p);
          break;
        case 47:
          this.search_mode = true;
          this.search_text = [];
          this.notice("/");
          break;
        case 110:
        case 78:
          if (p) {
            const needle = Buffer.from(this.search_text).toString();
            if (byte === 110) this.search_skip += 1;
            else this.search_skip = sat(this.search_skip, 1);
            if (!(await p.terminal.search(needle, this.search_skip))) {
              this.search_skip = 0;
              await p.terminal.search(needle, 0);
            }
            this.dirty = true;
          }
          break;
        case 113:
        case 27:
          this.copy_mode = false;
          if (p) {
            p.terminal.scrollViewport("bottom");
            p.terminal.clearSelection();
          }
          this.dirty = true;
          break;
        default:
          break;
      }
      return;
    }
    const p = this.focused();
    if (p) {
      this.sendInput(p.terminal, [byte]);
      acknowledge(p.agent.observation, p.agent.observation.completed);
      p.agent.attention = "none";
      // Ctrl+V asks an agent to paste an image from its own machine.
      if (byte === 22 && p.agent.provider !== null) this.imageHint("ctrl");
    }
  }
  /** The keyboard's owner when a paste begins, in `key`'s order. */
  private pasteTarget(): Paste {
    if (this.worktreeDetail() !== null) return "discard";
    if (this.agent_launcher)
      return (this.agent_launcher.managing && this.agent_launcher.selected === "add") ||
        (this.agent_launcher.worktree.mode === "open" && this.agent_launcher.worktree.focus !== "list")
        ? "launcher"
        : "discard";
    if (this.corgi_setup?.editing) return "setup";
    if (this.agent_picker) return "picker";
    if (this.name_dialog) return "name";
    if (this.hasMenu()) return "discard";
    const p = this.focused();
    return p ? { pane: p.id } : "discard";
  }
  private pastePane(): Pane | null {
    const target = this.input_state.paste;
    return target !== null && typeof target === "object" ? this.pane(target.pane) : null;
  }
  /** A paste from the host's clipboard listed `listing`: read what it
   * brings for the keyboard's owner. */
  async pasteEvent(listing: string): Promise<void> {
    const clipboard = this.host_clipboard;
    if (!clipboard) return;
    this.closePasteCard();
    const target = this.pasteTarget();
    if (target === "discard") return;
    // A program that takes paste events gets the clipboard itself.
    const types = hostClipboard.relayTypes(listing);
    if (typeof target === "object" && types.length > 0) {
      const p = this.pane(target.pane);
      if (p && p.terminal.pasteEvents()) {
        if (clipboard.relay(types, Date.now())) this.paste_target = target;
        else this.notice(hostClipboard.Failure.message("busy"));
        return;
      }
    }
    const choice = hostClipboard.choose(listing, typeof target === "object");
    if (choice === "nothing") return;
    if ("read" in choice) {
      if (clipboard.request(choice.read, Date.now())) this.paste_target = target;
      else this.notice(hostClipboard.Failure.message("busy"));
    } else this.notice(hostClipboard.Failure.message(choice.refuse));
  }
  async pasteResult(result: hostClipboard.Result): Promise<void> {
    const target = this.paste_target;
    if (target === null) return;
    this.paste_target = null;
    if ("text" in result) this.pasteClipboardText(target, result.text);
    else if ("path" in result) this.pasteText(target, result.path);
    else if ("relay" in result) await this.relayPaste(target, result.relay);
    else this.notice(hostClipboard.Failure.message(result.failed));
  }
  private pasteClipboardText(target: Paste, text: string): void {
    // The check Ghostty makes before a paste reaches Corgi.
    if (!viewerNative.isSafePaste(text)) return this.notice("Paste refused: it contains an end-of-paste marker");
    this.pasteText(target, text);
  }
  /** Has the daemon offer the clipboard in the program's own paste event,
   * or pastes it as text or an image's path when the daemon can't. */
  private async relayPaste(target: Paste, relayed: hostClipboard.Relay): Promise<void> {
    const encoded = relayed.text !== null ? Buffer.from(relayed.text).toString("base64") : null;
    try {
      const reply = await call(this.connection, "pane.paste", {
        pane: typeof target === "object" ? target.pane : 0,
        text: encoded,
        image: relayed.image ? { mime: relayed.image.mime, path: relayed.image.path } : null,
      });
      if (reply.pasted) return;
    } catch {}
    if (relayed.text !== null) return this.pasteClipboardText(target, relayed.text);
    if (relayed.image) return this.pasteText(target, relayed.image.path);
  }
  /** Pastes `text` as the host terminal would have: control characters
   * become spaces, and a pane gets it bracketed if it asked to be. */
  private pasteText(target: Paste, text: string): void {
    this.input_state.active = true;
    this.dirty = true;
    if (typeof target === "object") {
      const p = this.pane(target.pane);
      if (!p) return this.notice("The pane closed before the paste arrived");
      this.sendInput(p.terminal, viewerNative.encodePaste(text, p.terminal.bracketedPaste()));
    } else {
      for (const byte of viewerNative.encodePaste(text, true, 1)) void this.pasteByteSync(target, byte);
    }
  }
  /** Explains, over SSH, why a key that usually pastes an image didn't.
   * Opens the card over the focused pane when `pressed` was likely an
   * attempt to paste an image that can't work over SSH. A local agent
   * reads this machine's clipboard on its own Ctrl+V. */
  private imageHint(pressed: hostClipboard.Key): boolean {
    if (!this.remote_links) return false;
    const clipboard = this.host_clipboard;
    if (!clipboard) return false;
    const p = this.focused();
    if (!p) return false;
    const agent = p.agent.provider ? Provider.info(p.agent.provider).name : "The program";
    let host = "this machine";
    try {
      const full = hostname();
      host = full.slice(0, full.includes(".") ? full.indexOf(".") : full.length);
    } catch {}
    const found = clipboard.notice(pressed, agent, host);
    if (!found) return false;
    this.paste_card = { pane: p.id, notice: found, pressed: false, copied: false };
    this.dirty = true;
    return true;
  }
  /** `cardEffect`, except on the card's links. Over SSH the terminal opens
   * a link on Cmd-click and swallows that release; a plain click's release
   * reaches Corgi, which copies the link instead. */
  private cardInput(seq: string): CardEffect {
    const card = this.paste_card;
    if (!card) return "keep";
    if (!seq.startsWith("\x1b[<")) return cardEffect(seq);
    const fields = seq.slice(3, seq.length - 1).split(";");
    const button = parseU16(fields[0] ?? "");
    const xs = parseU16(fields[1] ?? "");
    const ys = parseU16(fields[2] ?? "");
    if (button === null || xs === null || ys === null) return "keep";
    const x = sat(xs, 1);
    const y = sat(ys, 1);
    const at = this.cardPlacement();
    const on_link = at !== null && pasteCard.linkAt(card.notice, at, x, y);
    if ((button & 32) !== 0) return "keep";
    if (seq[seq.length - 1] === "m") {
      if (!card.pressed) return "keep";
      card.pressed = false;
      if (on_link) {
        this.copyQuietly(hostClipboard.nightly_url);
        card.copied = true;
        this.dirty = true;
      }
      return "capture";
    }
    if ((button & 3) === 0 && button < 64 && on_link) {
      card.pressed = true;
      return "capture";
    }
    return "close";
  }
  private cardPlacement(): pasteCard.Placement | null {
    const card = this.paste_card;
    if (!card) return null;
    const p = this.focused();
    if (!p || p.id !== card.pane) return null;
    return pasteCard.locate(this.layoutView(), this.runtime.panes, this.area(), card.notice);
  }
  private closePasteCard(): void {
    if (this.paste_card === null) return;
    this.paste_card = null;
    this.dirty = true;
  }
  private async pasteByte(target: Paste, byte: number): Promise<void> {
    if (typeof target === "object") {
      const p = this.pane(target.pane);
      if (p) this.sendInput(p.terminal, [byte]);
      return;
    }
    switch (target) {
      // Its owner can close mid-paste, when a snapshot removes the target.
      case "launcher":
        if (this.agent_launcher) {
          const c = this.agent_launcher.worktree;
          if (this.agent_launcher.name_focused) this.agent_launcher.name_customized = true;
          if (c.mode === "open" && c.focus === "from") c.search(from => from.pasteByte(byte));
          else this.agent_launcher.input().pasteByte(byte);
        }
        break;
      case "setup":
        this.corgi_setup?.paste(byte);
        break;
      case "picker":
        if (this.agent_picker && byte >= 32 && byte < 127) await this.key(byte);
        break;
      case "name":
        if (this.name_dialog) this.name_dialog.pasteByte(byte);
        break;
      case "discard":
        break;
    }
  }
  /** `pasteByte` for targets that never need the daemon. */
  private pasteByteSync(target: Paste, byte: number): Promise<void> {
    return this.pasteByte(target, byte);
  }
  async input(data: Uint8Array): Promise<void> {
    const cl = this.input_state;
    if (data.length > 0) cl.active = true;
    for (const byte of data) cl.keybuf.push(byte);
    let used = 0;
    while (used < cl.keybuf.length) {
      if (!cl.attached) {
        cl.keybuf = [];
        return;
      }
      const rest = cl.keybuf.slice(used);
      if (rest[0] !== 27) {
        this.closePasteCard();
        this.pinWorktreeInput(String.fromCharCode(rest[0]));
        this.link_tooltip.cancel();
        this.dirty = true;
        if (cl.paste !== null) await this.pasteByte(cl.paste, rest[0]);
        else await this.key(rest[0]);
        used += 1;
        continue;
      }
      if (rest.length < 2) {
        this.pinWorktreeInput("\x1b");
        this.link_tooltip.cancel();
        this.dirty = true;
        break;
      }
      if (cl.paste === null && rest[1] !== 0x5b && rest[1] !== 0x4f && (this.hasMenu() || this.name_dialog !== null)) {
        await this.key(27);
        used += 1;
        continue;
      }
      let len = 2;
      if (rest[1] === 0x5b || rest[1] === 0x4f) {
        while (len < rest.length && !(rest[len] >= 0x40 && rest[len] <= 0x7e)) len += 1;
        if (len === rest.length) break;
        len += 1;
      }
      let seq: number[] = rest.slice(0, len);
      if (this.paste_card !== null) {
        const effect = this.cardInput(latin1(seq));
        if (effect === "close") this.closePasteCard();
        else if (effect === "dismiss") {
          this.closePasteCard();
          used += len;
          continue;
        } else if (effect === "capture") {
          used += len;
          continue;
        }
      }
      if (!latin1(seq).startsWith("\x1b[<")) {
        this.pinWorktreeInput(latin1(seq));
        this.link_tooltip.cancel();
        this.dirty = true;
      }
      if (cl.paste === null) {
        const key_event = keyboard.decode(latin1(seq));
        if (key_event) {
          // Ghostty passes its paste key on only when it had no text
          // to paste. Over SSH it can't be pasted here: say why.
          const pressed = pasteKey(key_event);
          if (pressed !== null && this.imageHint(pressed)) {
            used += len;
            continue;
          }
          const repeated = bindings.repeat(this.prefs.preset, key_event);
          if (this.repeats(repeated)) {
            await this.perform(repeated);
            used += len;
            continue;
          }
          if (repeated === null) this.repeat_until = 0;
          if (this.onboarding === null && this.name_dialog === null && (this.prefix || !this.hasMenu())) {
            const act = bindings.chord(this.prefs.preset, this.prefix, key_event);
            if (act) {
              if (this.prefix) await this.runPrefixed(act, repeated !== null);
              else await this.perform(act);
              used += len;
              continue;
            }
          }
          // Resolve Corgi shortcuts before encoding for the child. A
          // Kitty Ctrl-B/Ctrl-T are otherwise invisible to the byte handlers.
          const legacy = Array.from(Buffer.from(viewerNative.encodeKey(null, key_event.codepoint, key_event.mods)));
          const owned = this.hasMenu() || this.name_dialog !== null || this.copy_mode || this.search_mode;
          if (
            owned ||
            (legacy.length === 1 &&
              (legacy[0] === keymap.prefixByte(this.prefs.prefix) ||
                bindings.lookup(this.prefs.preset, false, legacy[0], {}) !== null))
          ) {
            seq = legacy;
          } else {
            const p = this.focused();
            if (p)
              seq = Array.from(
                Buffer.from(viewerNative.encodeKey(p.terminal.handle, key_event.codepoint, key_event.mods)),
              );
          }
          if (seq.length === 0) {
            used += len;
            continue;
          }
          if (seq.length === 1) {
            await this.key(seq[0]);
            used += len;
            continue;
          }
        }
      }
      const text = latin1(seq);
      const parsed_key = keys.parse(text);
      const again = cl.paste === null ? bindings.repeatSequence(this.prefs.preset, text) : null;
      if (parsed_key === "paste_start" || parsed_key === "paste_end") {
        if (parsed_key === "paste_start") cl.paste = this.pasteTarget();
        // The markers reach only an application that asked for them.
        const p = this.pastePane();
        if (p && p.terminal.bracketedPaste()) this.sendInput(p.terminal, seq);
        if (parsed_key === "paste_end") cl.paste = null;
      } else if (cl.paste !== null) {
        const p = this.pastePane();
        if (p) this.sendInput(p.terminal, seq);
      } else if (parsed_key === "focus_in") {
        cl.watched = true;
      } else if (parsed_key === "focus_out") {
        cl.watched = false;
        this.pointer = null;
        this.dirty = true;
      } else if (text.startsWith("\x1b[<")) await this.mouse(text);
      else if (this.repeats(again)) await this.perform(again);
      else if (this.worktree_card.pinned) {
        if (parsed_key === "up") await this.perform({ name: "worktree-prev" });
        else if (parsed_key === "down") await this.perform({ name: "worktree-next" });
        else if (parsed_key === "delete") await this.perform({ name: "worktree-remove" });
      } else if (this.onboarding) {
        const wizard = this.onboarding;
        let done = false;
        try {
          done = await wizard.sequence(text, this.rpc());
        } catch (error) {
          wizard.fail(error as Error);
        }
        if (done) await this.finishOnboarding();
        this.dirty = true;
      } else if (this.prefix) {
        const act = bindings.prefixedSequence(this.prefs.preset, text);
        if (act) await this.runPrefixed(act, again !== null);
        else if (this.help_visible) this.help.sequence(text);
        this.dirty = true;
      } else if (this.sidebar_focus) {
        if (parsed_key === "up" || parsed_key === "down" || parsed_key === "left" || parsed_key === "right")
          await this.steerSidebar(parsed_key, false);
      } else if (this.agent_picker) {
        if (parsed_key === "up" || parsed_key === "shift_tab") this.moveAgentPicker(false);
        else if (parsed_key === "down") this.moveAgentPicker(true);
        else this.agent_picker.query.sequence(text);
      } else if (this.corgi_setup) {
        const setup = this.corgi_setup,
          s = this.runtime.inference;
        if (setup.sequence(text)) {
          // The worktree folder field took it.
        } else if (parsed_key === "up" || parsed_key === "shift_tab") setup.move(false, s, this.prefs);
        else if (parsed_key === "down") setup.move(true, s, this.prefs);
        else if (parsed_key === "right") setup.openOptions(s, this.prefs);
        else if (parsed_key === "left") setup.back();
        this.dirty = true;
      } else if (this.agent_launcher) {
        const launch = this.agent_launcher;
        // CSI-only on purpose: SS3 arrows reach the name field as input.
        if (launch.worktree.mode === "open" && launch.worktree.focus !== "list" && !launch.managing) {
          const c = launch.worktree;
          // ↑ from Branch walks back to the checkouts; ↓ goes on to From.
          if (c.focus === "from" && parsed_key === "shift_tab") c.focus = "branch";
          else if (c.focus === "from" && (parsed_key === "up" || parsed_key === "down"))
            c.movePick(parsed_key === "up" ? -1 : 1);
          else if (c.focus === "from") c.search(from => from.sequence(text));
          else if (parsed_key === "up" || parsed_key === "shift_tab") c.toList(launch.worktrees);
          else if (parsed_key === "down") c.focusFrom();
          else c.field.sequence(text);
          this.dirty = true;
        } else if (launch.worktree.mode === "open" && !launch.managing) {
          if (parsed_key === "up" || parsed_key === "down")
            launch.worktree.move(launch.worktrees, parsed_key === "up" ? -1 : 1);
          this.dirty = true;
        } else if (launch.resume_view.focused && !launch.managing) {
          launch.pinned = true;
          this.resumeSequence(text, parsed_key);
        } else if (
          launch.managing &&
          launch.selected === "add" &&
          text !== "\x1b[A" &&
          text !== "\x1b[B" &&
          text !== "\x1b[Z"
        ) {
          launch.input().sequence(text);
          this.dirty = true;
        } else if (parsed_key === "up") {
          this.moveLauncher(false, false);
        } else if (parsed_key === "down") {
          this.moveLauncher(true, false);
        } else if (text === "\x1b[H" || text === "\x1b[1~") {
          this.selectLauncher(launch.first());
        } else if (text === "\x1b[F" || text === "\x1b[4~") {
          this.selectLauncher(launch.managing ? "manage" : "terminal");
        } else if (parsed_key === "shift_tab") {
          this.moveLauncher(false, true);
        } else if (!launch.pinned) {
          this.closeMenu();
          const p = this.focused();
          if (p) this.sendInput(p.terminal, seq);
        }
      } else if (this.port_menu) {
        if (parsed_key === "up") this.movePortMenu(false);
        else if (parsed_key === "down") this.movePortMenu(true);
      } else if (this.tab_menu) {
        if (parsed_key === "up") this.moveTabMenu(false);
        else if (parsed_key === "down") this.moveTabMenu(true);
      } else if (this.menu() !== null) {
        if (parsed_key === "page_up") this.pageMenu(false);
        else if (parsed_key === "page_down") this.pageMenu(true);
      } else if (this.name_dialog) {
        this.name_dialog.sequence(text);
        this.dirty = true;
      } else if (this.copy_mode && parsed_key === "page_up") this.scroll(-20);
      else if (this.copy_mode && parsed_key === "page_down") this.scroll(20);
      else {
        const p = this.focused();
        if (p) this.sendInput(p.terminal, seq);
      }
      used += len;
    }
    cl.keybuf = cl.keybuf.slice(used);
    cl.escape_at = Date.now();
    if (cl.keybuf.length > 256) {
      cl.keybuf = [];
      throw Error("InvalidInput");
    }
  }
  /** The daemon connection as onboarding calls it. */
  private rpc(): Pick<rpc.Connection, "call"> {
    return { call: (op, ...args) => call(this.connection, op, ...args) };
  }
  /** Columns the tab bar's tabs may take, left of its "+" button. */
  private tabSpace(): number {
    return sat(this.width - this.sidebarView([]).tabX(), 3);
  }
  private scrollTabs(forward: boolean): void {
    const view = this.layoutView();
    const start = render.tabStart(view, this.tabSpace());
    this.nav().offset = forward ? Math.min(start + 1, render.maxTabStart(view, this.tabSpace())) : sat(start, 1);
    this.dirty = true;
  }
  /** Scrolls the tab bar to show the active tab whenever another one becomes active. */
  private revealTab(): void {
    const selection = this.nav();
    if (this.model().count === 0 || selection.revealed === selection.active) return;
    selection.offset = render.revealTab(this.layoutView(), this.tabSpace(), selection.active);
    selection.revealed = selection.active;
  }
  private validTabDrag(drag: TabDrag): boolean {
    const tabs_x = this.sidebarView([]).tabX();
    const m = this.model();
    if (
      drag.workspace_id !== this.current().id ||
      drag.width !== this.width ||
      drag.tabs_x !== tabs_x ||
      drag.count !== m.count ||
      drag.first !== render.tabStart(this.layoutView(), this.tabSpace()) ||
      this.hasMenu() ||
      this.name_dialog !== null
    )
      drag.cancelled = true;
    m.tabs.slice(0, m.count).forEach((tab, i) => {
      if (i >= drag.count || drag.ids[i] !== tab.id) drag.cancelled = true;
    });
    return !drag.cancelled;
  }
  tabDropX(): number | null {
    const drag = this.input_state.tab_drag;
    if (drag && this.validTabDrag(drag) && drag.dragging && drag.drop) return drag.drop.x;
    return null;
  }
  private cancelDividers(): void {
    if (this.input_state.divider) this.input_state.divider.cancelled = true;
  }
  private async mouse(seq: string): Promise<void> {
    const cl = this.input_state;
    const fields = seq.slice(3, seq.length - 1).split(";");
    const button = parseU16(fields[0] ?? "");
    if (button === null) return;
    const xs = parseU16(fields[1] ?? "");
    if (xs === null) return;
    const ys = parseU16(fields[2] ?? "");
    if (ys === null) return;
    const x = sat(xs, 1);
    const y = sat(ys, 1);
    const release = seq[seq.length - 1] === "m";
    if (this.onboarding) {
      const wizard = this.onboarding;
      if (!release && button === 0) {
        let done = false;
        try {
          done = await wizard.click(this.width, this.height, x, y, this.rpc());
        } catch (error) {
          wizard.fail(error as Error);
        }
        if (done) await this.finishOnboarding();
      } else if (!release && (button & 64) !== 0) {
        if (wizard.step === "keymap") wizard.help.move((button & 1) !== 0, 3);
        else if ((button & 1) !== 0) wizard.picker.scroll += 3;
        else wizard.picker.scroll = sat(wizard.picker.scroll, 3);
      }
      this.dirty = true;
      return;
    }
    if (this.prefix && this.help_visible) {
      this.pointer = { x, y };
      if (!release && button === 0) {
        this.ui_mouse_down = true;
        const hit = this.help.hit(this.width, this.height, x, y, this.prefs.preset);
        if (hit.name === "close") this.closeMenu();
        else if (hit.name === "play") this.help.play(Date.now());
        else if (hit.name === "action") {
          const act = hit.action;
          if (this.model().count > 0 || !needsPane(act)) {
            this.prefix = false;
            await this.perform(act);
          }
        }
      } else if (!release && (button === 64 || button === 65)) this.help.move(button === 65, 3);
      if (release) this.ui_mouse_down = false;
      this.dirty = true;
      return;
    }
    // A drawer covers the panes: a press opens its row as Enter would, or puts the drawer away.
    if (this.sidebar_focus?.drawer && !release && (button & 0xe0) === 0) {
      this.ui_mouse_down = true;
      const focus = this.sidebar_focus,
        entries = this.sidebarEntries(),
        found = this.sidebarView(entries).hit(x, y);
      this.dirty = true;
      if (found.tag === "workspace") focus.cursor = { workspace: this.runtime.workspaces.items[found.workspace].id };
      else if (found.tag === "entry" && sidebarFocus.stops(entries[found.entry]))
        focus.cursor = { entry: entries[found.entry].target };
      else {
        this.leaveSidebar();
        if (found.tag === "workspace_new") this.beginWorkspace(null);
        return;
      }
      return this.openSidebarRow(false);
    }
    // A click gives the keyboard back.
    if (this.sidebar_focus && !release && (button & 0xe0) === 0) this.leaveSidebar();
    // The prefix bar has no mouse targets. A click resumes normal UI input.
    if (this.prefix && !release && (button & 0xe0) === 0) this.closeMenu();
    const moved = this.pointer === null || this.pointer.x !== x || this.pointer.y !== y;
    const worktree_rect = this.worktreeRect();
    if (worktree_rect?.contains(x, y)) {
      this.pointer = { x, y };
      const ws = this.runtime.workspaces.items.find(w => w.id === this.worktree_card.workspace);
      const path = this.worktree_card.hit(ws?.worktrees ?? null, worktree_rect, x, y);
      if (path && (button === 35 || button === 0)) await this.perform({ name: "worktree-select", value: path });
      if (!release && button === 0) {
        if (path) await this.perform({ name: "worktree-enter" });
        else this.worktree_card.pinned = true;
        this.ui_mouse_down = true;
      }
      if (!release && (button === 64 || button === 65))
        await this.perform({ name: button === 65 ? "worktree-next" : "worktree-prev" });
      if (release) this.ui_mouse_down = false;
      this.dirty = true;
      return;
    }
    // Moving off the card, its badge and the triangle between closes it, pinned or not.
    if (moved && (button & 32) !== 0 && this.worktreeDetail() !== null && !this.worktreeHoverContains(x, y))
      await this.perform({ name: "worktree-close" });
    const agent_entries = this.sidebarEntries(),
      agent_side = this.sidebarView(agent_entries);
    if (this.worktreeDetail() !== null && this.worktreeAgentContains(x, y)) {
      this.pointer = { x, y };
      if (!release && button === 0) {
        this.worktree_card.pinned = true;
        const hit = agent_side.hit(x, y);
        if (hit.tag === "entry")
          await this.perform({
            name: "worktree-agent",
            value: hit.entry,
          });
        this.ui_mouse_down = true;
      } else if (!release && (button === 64 || button === 65)) {
        this.worktree_card.pinned = true;
        this.agentOffset().set(
          button === 64 ? sat(agent_side.offset, 1) : Math.min(agent_side.offset + 1, agent_side.maxOffset()),
        );
      }
      if (release) this.ui_mouse_down = false;
      this.dirty = true;
      return;
    }
    if (this.worktree_card.pinned && !release && (button === 0 || button === 2)) {
      await this.perform({ name: "worktree-close" });
      this.ui_mouse_down = true;
      return;
    }
    if (moved) this.aimResource(x, y);
    let resource_workspace_press = false;
    const resource_rect = this.resourceRect();
    if (resource_rect && resource_rect.contains(x, y)) {
      // The card can cover workspace rows on narrower screens. A
      // workspace press dismisses it and reaches normal navigation.
      resource_workspace_press =
        !release && (button === 0 || button === 2) && this.sidebarView([]).hit(x, y).tag === "workspace";
      if (!resource_workspace_press) {
        this.pointer = { x, y };
        if (!release && button === 0) this.resource_card.click(resource_rect, x, y);
        else if (release) this.ui_mouse_down = false;
        else if ((button & 64) !== 0) this.link_tooltip.cancel();
        this.dirty = true;
        return;
      }
    }
    if (!release && (button & 32) !== 0 && (button & 3) === 3 && (button & 64) === 0) {
      if (moved && !this.resourceHoverContains(x, y) && !this.worktreeHoverContains(x, y)) {
        const resource_hit = sidebar.resourceAt(this.sidebarView([]), this.workspaceEntries(), x, y);
        if (resource_hit === null || this.resourceDetail() !== resource_hit.id) this.link_tooltip.move();
        this.launcher_hover_blocked = false;
      }
    } else {
      this.link_tooltip.cancel();
      this.dirty = true;
    }
    if (moved) {
      this.pointer = { x, y };
      this.dirty = true;
    }
    if (cl.port_click) {
      const click = cl.port_click;
      if ((x !== click.x || y !== click.y) && click.pane !== null) {
        const p = this.pane(click.pane);
        if (p) {
          // A consumed link press must not leak an unmatched drag
          // or release into a mouse-aware child.
          if (!click.drag_selects && p.terminal.mouseEvents()) {
            click.cancelled = true;
            if (release) cl.port_click = null;
            return;
          }
          p.terminal.clearSelection();
          p.terminal.holding_selection = true;
          this.selection = { pane: click.pane, x: click.px, y: click.py, moved: false };
        }
        cl.port_click = null;
      } else {
        if (x !== click.x || y !== click.y) click.cancelled = true;
        if (release) {
          if (!click.cancelled && (button === 0 || button === 16)) {
            if (click.menu !== null) {
              this.port_menu = new sidebar.PortMenu(click.menu);
              this.dirty = true;
            } else {
              this.queueEffect({ open_url: click.url });
              this.closeMenu();
            }
          }
          cl.port_click = null;
        }
        return;
      }
    }
    if (this.port_menu) {
      const links = this.port_menu;
      const ws = this.portWorkspaceEntry(links.workspace);
      if (!release && (button === 64 || button === 65)) this.movePortMenu(button === 65);
      if (!release && button === 0) {
        const index = links.hit(ws, this.width, this.height, x, y);
        if (index !== null) {
          if (!this.remote_links) {
            const url = sidebar.workspaceUrl(ws, index);
            if (url !== null) cl.port_click = portClick({ x, y, url: byteLength(url) <= 4096 ? url : "" });
          }
        } else this.closeMenu();
      }
      return;
    }
    if (cl.divider) {
      const drag = cl.divider;
      if (!sameRect(drag.area, this.area())) drag.cancelled = true;
      if (!drag.cancelled && (release || (button & 0xe3) === 32)) {
        const node = this.model().nodes[drag.hit.node];
        if (node && "split" in node) {
          const split = node.split;
          await this.edit({
            "split.ratio": {
              target: this.model().firstPane(split.first),
              other: this.model().firstPane(split.second),
              ratio: LayoutView.dividerRatio(drag.hit, x, y),
              expected: this.model().revision,
            },
          });
          // A successful local resize changes revision, but keeps this gesture valid.
          drag.cancelled = false;
          this.dirty = true;
        }
      }
      if (release) cl.divider = null;
      return;
    }
    if (this.sidebar_drag) {
      const drag = this.sidebar_drag;
      if (release) {
        this.sidebar_drag = null;
        try {
          if (drag === "width") preferences.update({ sidebar_width: this.prefs.sidebar_width });
          else preferences.update({ sidebar_split: this.prefs.sidebar_split });
        } catch (error) {
          this.notice((error as Error).message);
        }
      } else if (button === 32) {
        if (drag === "width")
          this.prefs.sidebar_width = Math.min(Math.max(x + 1, 20), Math.max(20, sat(this.width, 20)));
        else this.prefs.sidebar_split = sidebar.View.splitFor(this.height, y + 1);
        this.dirty = true;
      }
      this.dirty = true;
      return;
    }
    if (this.agent_drag) {
      const drag = this.agent_drag;
      // Input can arrive before the next snapshot poll. Validate a drop
      // against current shared state, including rows removed mid-drag.
      if (release && (button & 3) === 0) await this.refresh();
      const live = this.sidebarEntries();
      let side = this.sidebarView(live);
      if (!release && (button === 64 || button === 65) && drag.valid(side, this.current().id)) {
        this.agentOffset().set(button === 64 ? sat(side.offset, 1) : Math.min(side.offset + 1, side.maxOffset()));
        side = this.sidebarView(live);
        drag.dragging = true;
      }
      if (!release && button === 32 && (x !== drag.start_x || y !== drag.start_y)) drag.dragging = true;
      drag.update(side, this.current().id, x, y);
      if (release && (button & 3) === 0) {
        this.agent_drag = null;
        this.ui_mouse_down = false;
        if (drag.drop && sidebar.isAgent(drag.target)) {
          const before = drag.drop.index === drag.end ? null : sidebar.orderTarget(live[drag.drop.index]);
          try {
            await this.edit({ "agent.move": { workspace: drag.workspace, target: drag.target, before } });
          } catch (error) {
            this.notice((error as Error).message);
          }
        }
      }
      this.dirty = true;
      return;
    }
    if (this.workspace_drag) {
      const drag = this.workspace_drag;
      // Mirrors the agent drag: validate against current shared state.
      if (release && (button & 3) === 0) await this.refresh();
      const ids = this.workspaceIds();
      let side = this.sidebarView([]);
      if (!release && (button === 64 || button === 65) && drag.valid(side, ids)) {
        this.workspace_offset =
          button === 64
            ? sat(side.workspace_offset, 1)
            : Math.min(side.workspace_offset + 1, sat(ids.length, side.workspaceCapacity()));
        side = this.sidebarView([]);
        drag.dragging = true;
      }
      if (!release && button === 32 && (x !== drag.start_x || y !== drag.start_y)) drag.dragging = true;
      drag.update(side, ids, x, y);
      if (release && (button & 3) === 0) {
        this.workspace_drag = null;
        this.ui_mouse_down = false;
        const before = drag.before();
        if (before !== null) {
          try {
            await this.edit({ "workspace.move": { target: drag.ids[drag.source], before } });
          } catch (error) {
            this.notice((error as Error).message);
          }
        }
      }
      this.dirty = true;
      return;
    }
    // Finish the captured selection before hit testing the release location.
    if (release && (button & 3) === 0 && this.selection) {
      const sel = this.selection;
      this.selection = null;
      this.dirty = true;
      const p = this.pane(sel.pane);
      if (p) {
        try {
          if (sel.moved) this.copyPane(p);
        } finally {
          try {
            p.terminal.clearSelection();
          } catch {}
        }
      }
      return;
    }
    if (cl.tab_drag) {
      const drag = cl.tab_drag;
      const valid = this.validTabDrag(drag);
      const wheel = release ? null : tabWheel(button);
      if (valid && wheel !== null) {
        this.scrollTabs(wheel);
        drag.first = render.tabStart(this.layoutView(), this.tabSpace());
        drag.dragging = true;
      }
      const drop =
        valid && y === 0 && x >= drag.tabs_x
          ? render.tabDrop(this.layoutView(), this.width - drag.tabs_x, x - drag.tabs_x)
          : null;
      if ((button === 32 && !release) || wheel !== null) {
        if (drop !== null && x !== drag.start_x) drag.dragging = true;
        drag.drop = drop;
      }
      if (release && (button & 3) === 0) {
        if (valid && drag.dragging && drop) await this.moveTab(drag.tab_id, drop.index);
        cl.tab_drag = null;
      }
      // The tab owns this gesture, including motion/release over a pane.
      this.dirty = true;
      return;
    }
    if (cl.pane_press !== null && (release || ((button & 96) === 32 && (button & 3) !== 3))) {
      const id = cl.pane_press;
      if (release) cl.pane_press = null;
      for (const p of this.layoutView().placements(this.area())) {
        if (p.id !== id) continue;
        const held = this.pane(id);
        if (!held) break;
        sendMouse(held.terminal, p.rect, button, x, y, release);
      }
      return;
    }
    if (!release && (x >= this.width || y >= this.height)) return;
    const tabs_x = this.sidebarView([]).tabX();
    const tabs_width = this.width - tabs_x;
    if (this.ui_mouse_down) {
      if (release) this.ui_mouse_down = false;
      return;
    }
    if (this.corgi_setup) {
      const setup = this.corgi_setup,
        s = this.runtime.inference,
        hit = setup.hit(this.width, this.height, x, y, s, this.prefs);
      if (!release && button === 0) {
        this.ui_mouse_down = true;
        if (hit !== null) await this.applySetup(setup.click(hit, s, this.prefs));
        else if (!setup.contains(this.width, this.height, x, y)) this.closeMenu();
      } else if (!release && (button === 35 || button === 32)) {
        if (hit !== null) setup.hover(hit, s, this.prefs);
      } else if (!release && (button === 64 || button === 65)) setup.move(button === 65, s, this.prefs, false);
      this.dirty = true;
      return;
    }
    if (this.scope_menu) {
      const scope_menu = this.scope_menu;
      const side = this.sidebarView([]);
      const scope = sidebar.ScopeMenu.hit(side, this.width, this.height, x, y);
      if (!release && button === 0) {
        this.ui_mouse_down = true;
        if (scope !== null) this.setAgentScope(scope);
        else if (side.hit(x, y).tag === "agent_scope" && !scope_menu.pinned) scope_menu.pinned = true;
        else this.closeMenu();
      } else if (!release && (button === 35 || button === 32)) {
        scope_menu.hovered = scope;
      }
      this.dirty = true;
      return;
    }
    if (this.agent_launcher) {
      const side = this.sidebarView([]);
      if (!release && button === 0) {
        this.ui_mouse_down = true;
        if (this.agent_launcher.managing) {
          const launch = this.agent_launcher;
          const b = launch.bounds(this.width, this.height, side);
          const row = launch.hit(this.width, this.height, side, x, y);
          if (row !== null) {
            if (row === "add") {
              launch.selected = "add";
              const top = b.y + launch.countRows() + 5;
              const actions = top + 12 + (launch.show_command ? 2 : 0);
              if (y === actions && x >= sat(b.x + b.w, 10)) {
                await this.saveInlineCommand();
              } else if (y === actions && x >= sat(b.x + b.w, 20)) {
                launch.edit("add");
              } else if (y === top + 10 && x >= sat(b.x + b.w, 18)) {
                launch.show_command = !launch.show_command;
              } else if (y === top + 2 || y === top + 6) {
                launch.name_focused = y === top + 6;
                const width = sat(b.w, 10);
                const editor = launch.input();
                let offset = sat(editor.cursor, sat(width, 1));
                while (offset < editor.cursor && (editor.text[offset] & 0xc0) === 0x80) offset += 1;
                editor.position(editor.byteAtColumn(offset, sat(x, b.x + 5)));
              }
            } else if (row === "manage") {
              await this.launchRow(row);
            } else if (Row.custom(row) !== null && x >= sat(b.x + b.w, 11)) {
              await this.deleteLauncherCommand(Row.custom(row)!);
            } else if (x >= sat(b.x + b.w, 18)) {
              launch.edit(row);
            } else if (Row.custom(row) !== null) {
              await this.toggleCommandVisibility(Row.custom(row)!);
            } else await this.launchRow(row);
          } else if (!b.contains(x, y)) this.closeMenu();
          this.dirty = true;
          return;
        }
        {
          const launch = this.agent_launcher,
            button = launch.worktreeButton(this.width, this.height, side);
          if (launch.worktree.mode !== "closed") {
            // In the box a click takes a checkout, a field or a branch; elsewhere it closes the box first.
            const c = launch.worktree,
              spot = launch.worktreeHit(this.width, this.height, side, x, y);
            this.dirty = true;
            if (spot === "branch") c.focus = "branch";
            else if (spot === "from") {
              if (c.focus !== "from") c.focusFrom();
            } else if (spot !== null && "pick" in spot) {
              c.picked = spot.pick;
              c.takeFrom();
            } else if (spot !== null) return this.chooseWorktree(spot.checkout);
            const bx = launch.worktreeBox(this.width, this.height, side);
            if (spot !== null || bx?.rect.contains(x, y)) return;
            // Elsewhere, the button included, closes the box.
            c.mode = "closed";
            if (launch.bounds(this.width, this.height, side).contains(x, y)) return;
          } else if (button?.contains(x, y)) return this.openWorktrees();
        }
        if (this.agent_launcher.manageHit(this.width, this.height, side, x, y)) return this.openManager();
        const resume = this.agent_launcher.resumeHit(this.width, this.height, side, x, y);
        if (resume !== null) {
          const launch = this.agent_launcher;
          launch.pinned = true;
          if (resume === "scope") launch.resume_view.nextScope(true);
          else if (launch.resume_view.select(launch.resumeContext(), resume.row)) return this.resumeSelected();
          this.revealResume();
          this.dirty = true;
          return;
        }
        const hit = side.hit(x, y).tag;
        const yolo = this.agent_launcher.yoloHit(this.width, this.height, side, x, y);
        const usage = yolo === null ? this.agent_launcher.usageHit(this.width, this.height, side, x, y) : null;
        if (yolo !== null) await this.toggleLauncherYolo(yolo);
        else if (usage !== null) await this.trackLauncherUsage(usage);
        else if (hit === "agent_new") await this.launchAgent(null);
        else if (hit === "agent_options") this.agent_launcher.pinned = true;
        else {
          const row = this.agent_launcher.hit(this.width, this.height, side, x, y);
          if (row !== null) await this.launchRow(row);
          else if (!this.agent_launcher.bounds(this.width, this.height, side).contains(x, y)) this.closeMenu();
        }
      } else if (!release && (button === 35 || button === 32)) {
        const launch = this.agent_launcher;
        const spot = launch.worktree.mode === "open" ? launch.worktreeHit(this.width, this.height, side, x, y) : null;
        if (spot !== null && typeof spot === "object" && "checkout" in spot) launch.worktree.hovered = spot.checkout;
        else if (spot !== null && typeof spot === "object") launch.worktree.picked = spot.pick;
        else if (launch.worktree.mode !== "closed") {
          // The list or form covers the rows under it.
        } else if (!launch.managing) {
          const row = launch.hit(this.width, this.height, side, x, y);
          if (row !== null) {
            launch.selected = row;
            launch.resume_view.focused = false;
          } else {
            const target = launch.resumeHit(this.width, this.height, side, x, y);
            if (target !== null && target !== "scope") launch.resume_view.select(launch.resumeContext(), target.row);
          }
        }
        this.dirty = true;
      } else if (!release && (button === 64 || button === 65) && this.agent_launcher.resume_view.expanded) {
        const launch = this.agent_launcher;
        const c = launch.resumeContext();
        launch.resume_view.focused = true;
        launch.resume_view.move(c, launch.resume_view.lines(c), button === 65 ? 3 : -3);
        this.revealResume();
        this.dirty = true;
      }
      return;
    }
    if (this.agent_picker) {
      const entries = this.pickerEntries();
      const view = this.sidebarView(entries);
      if (!release && (button === 64 || button === 65)) {
        if (x < view.width && y >= view.middle()) this.moveAgentPicker(button === 65);
        return;
      }
      if (!release && button === 0) {
        const hit = view.hit(x, y);
        if (hit.tag === "entry") {
          this.ui_mouse_down = true;
          this.agent_picker.selected = entries[hit.entry].target;
          this.acceptAgentPicker();
          return;
        } else if (x < view.width && y === view.middle() + 1) {
          this.ui_mouse_down = true;
          this.agent_picker.query.position(view.searchOffset() + sat(x, 3));
          return;
        } else if (x < view.width && y >= view.middle()) {
          return;
        }
        // A click elsewhere leaves search and retains its usual action.
        this.closeMenu();
      } else return;
    }
    if (!release && button === 2 && y === 0 && this.name_dialog === null && x >= tabs_x) {
      const index = render.tabAt(this.layoutView(), tabs_width, x - tabs_x);
      if (index !== null) {
        this.ui_mouse_down = true;
        this.openTabMenu(index, x);
        return;
      }
    }
    if (this.tab_menu) {
      const context = this.tab_menu;
      if (!release && (button === 64 || button === 65)) this.moveTabMenu(button === 65);
      if (!release && button === 0) {
        this.ui_mouse_down = true;
        const index = context.hit(this.width, this.height, x, y);
        if (index !== null) {
          const item = context.entries()[index].item;
          if (!context.off.has(item)) await this.tabMenuAction(item);
        } else this.closeMenu();
      } else if (!release && (button === 35 || button === 32)) {
        const index = context.hit(this.width, this.height, x, y);
        if (index !== null && !context.off.has(context.entries()[index].item)) {
          context.highlighted = index;
          this.dirty = true;
        }
      }
      return;
    }
    const view = this.menu();
    if (view) {
      if (!release && (button === 35 || button === 32)) {
        const found = view.hit(x, y);
        const highlighted = found.tag === "command" ? found.command.key : null;
        if (this.menu_highlight !== highlighted) {
          this.menu_highlight = highlighted;
          this.dirty = true;
        }
      }
      if (!release && (button === 64 || button === 65)) this.pageMenu(button === 65);
      if (!release && button === 0) {
        this.ui_mouse_down = true;
        const found = view.hit(x, y);
        if (found.tag === "close") this.closeMenu();
        else if (found.tag === "previous") this.pageMenu(false);
        else if (found.tag === "next") this.pageMenu(true);
        else if (found.tag === "command") await this.perform({ name: "resize", value: found.command.direction });
      }
      return;
    }
    if (this.name_dialog) {
      const dialog = this.name_dialog;
      if (!release && button === 0) {
        this.ui_mouse_down = true;
        const dialog_view = NameView.init(this.width, this.height, dialog);
        const found = dialog_view.hit(x, y);
        if (found.tag === "save") await this.finishName(true);
        else if (found.tag === "cancel") await this.finishName(false);
        else if (found.tag === "clear") dialog.clear();
        else if (found.tag === "field")
          dialog.position(dialog.byteAtColumn(dialog_view.offset, found.field - dialog_view.offset));
        this.dirty = true;
      }
      return;
    }
    let entries = this.sidebarEntries();
    const side = this.sidebarView(entries);
    const worktree_hit = sidebar.worktreeAt(side, this.workspaceEntries(), x, y);
    if (!release && button === 0 && worktree_hit && !resource_workspace_press && !this.copy_mode) {
      this.ui_mouse_down = true;
      await this.perform({ name: "worktrees", value: worktree_hit.id });
      return;
    }
    if (!release && button === 0 && side.width > 0 && x === side.width - 1) {
      this.sidebar_drag = "width";
      return;
    }
    if (!release && button === 0 && side.splitHandle(x, y)) {
      this.sidebar_drag = "split";
      return;
    }
    // Do not activate Git or URL controls hidden behind the resource card.
    const git_hit = resource_workspace_press
      ? null
      : sidebar.gitActionWorkspace(side, this.workspaceEntries(), this.git_hover, x, y);
    this.git_hover = git_hit ? git_hit.id : null;
    if (!release && button === 0 && git_hit !== null && !this.copy_mode) {
      this.ui_mouse_down = true;
      const ws = git_hit;
      if (ws.git_push.phase === "pushing" || ws.git_push.phase === "succeeded") return;
      const index = this.runtime.workspaces.index(ws.id);
      if (index === null) return;
      try {
        await call(this.connection, "git.push", {
          workspace: ws.id,
          ref: this.runtime.workspaces.items[index].git_ref,
        });
      } catch (error) {
        this.notice(gitPushMessage((error as Error).message));
      }
      await this.refresh();
      this.dirty = true;
      return;
    }
    if (!release && button === 0 && !resource_workspace_press) {
      const ws = sidebar.portWorkspace(side, this.workspaceEntries(), x, y);
      if (ws) {
        const click = portClick({ x, y });
        if (sidebar.urlCount(ws) > 1) click.menu = ws.id;
        else if (!this.remote_links) {
          const url = sidebar.workspaceUrl(ws, 0);
          if (url === null) return;
          click.url = url;
        } else return;
        cl.port_click = click;
        return;
      }
    }
    if ((side.width > 0 && x < side.width) || (y === 0 && x < tabs_x)) {
      if (!release && (button === 64 || button === 65)) {
        if (y < side.middle())
          this.workspace_offset =
            button === 64
              ? sat(side.workspace_offset, 1)
              : Math.min(
                  side.workspace_offset + 1,
                  sat(this.runtime.workspaces.items.length, side.workspaceCapacity()),
                );
        else this.agentOffset().set(button === 64 ? sat(side.offset, 1) : Math.min(side.offset + 1, side.maxOffset()));
        this.dirty = true;
      } else if (!release && (button === 0 || button === 2)) {
        this.ui_mouse_down = true;
        if (corgiBadge.hit(this.corgi_badge, side.width, x, y)) return this.openSetup();
        const found = side.hit(x, y);
        switch (found.tag) {
          case "toggle":
            await this.perform({ name: "sidebar" });
            break;
          case "entry": {
            const index = found.entry;
            if (entries[index].exit !== null) break;
            const target = entries[index].target;
            if (!sidebar.isAgent(target) && !("group" in target)) {
              if (button === 2 && "worktree" in target && !entries[index].worktree?.ghost)
                this.openWorktreeMenu(entries[index], x, y);
              else await this.perform({ name: "worktree-agent", value: index });
              break;
            }
            this.selectAgent(target);
            if (button === 2 && "pane" in target) await this.openAgentMenu(target.pane, x, y);
            if (button === 0 && sidebar.isAgent(target) && !entries[index].worktree) {
              // Selecting another workspace can scroll the list.
              // Capture the post-selection viewport and identity.
              const updated = this.sidebarEntries();
              const view = this.sidebarView(updated);
              const at = agentNavigation.indexOf(updated, target);
              if (at !== null && view.offset === side.offset) {
                const owner =
                  "pane" in target
                    ? this.runtime.workspaces.owner(target.pane)!.id
                    : this.runtime.sessions.find(s => s.id === (target as { native: number }).native)!.workspace;
                this.agent_drag = AgentDrag.init(view, at, x, y, owner, this.current().id);
              }
            }
            break;
          }
          case "workspace_new":
            this.beginWorkspace(null);
            break;
          case "agent_new":
            if (button === 0) await this.launchAgent(null);
            else this.openLauncher(true);
            break;
          case "agent_options":
            this.openLauncher(true);
            break;
          case "agent_scope":
            this.openScopeMenu(true);
            break;
          case "workspace": {
            const index = found.workspace;
            if (button === 2) {
              this.closeMenu();
              this.search_mode = false;
              this.cancelDividers();
              this.selection = null;
              this.tab_menu = new TabMenu({
                tab: this.runtime.workspaces.items[index].id,
                workspace: true,
                anchor_x: x,
                anchor_y: y,
              });
            } else {
              const id = this.runtime.workspaces.items[index].id;
              const ws_entries = this.workspaceEntries();
              const jump = !resource_workspace_press && side.unreadHit(ws_entries[index], x, y);
              const target = jump ? this.firstUnreadAgent(index) : null;
              this.switchWorkspace(id);
              if (jump) {
                if (target) {
                  this.selectAgent(target);
                  const updated = this.sidebarEntries();
                  const i = updated.findIndex(entry => sidebar.sameTarget(entry.target, target));
                  if (i >= 0) this.agentOffset().set(Math.min(i, this.sidebarView(updated).maxOffset()));
                }
              } else {
                const ids = this.workspaceIds();
                // Switching can scroll the list; capture the post-switch viewport.
                const after = this.sidebarView([]);
                const at = ids.indexOf(id);
                if (after.workspace_offset === side.workspace_offset && at >= 0)
                  this.workspace_drag = WorkspaceDrag.init(after, ids, at, x, y);
              }
            }
            break;
          }
          default:
            break;
        }
        this.dirty = true;
      }
      return;
    }
    if (y === 0 && x >= tabs_x && !release) {
      const forward = tabWheel(button);
      if (forward !== null) return this.scrollTabs(forward);
    }
    if (y === 0 && button === 0 && !release) {
      const add_x = tabs_x + render.addTabX(this.layoutView(), tabs_width);
      if (x >= add_x && x < add_x + 3) {
        this.ui_mouse_down = true;
        this.dismissName();
        await this.perform({ name: "new" });
        return;
      }
      if (x >= tabs_x) {
        const index = render.tabAt(this.layoutView(), tabs_width, x - tabs_x);
        if (index !== null) {
          this.rememberAgent();
          this.nav().active = index;
          this.native_notice = null;
          this.rememberAgent();
          cl.tab_drag = {
            workspace_id: this.current().id,
            tab_id: this.model().tabs[index].id,
            start_x: x,
            width: this.width,
            tabs_x,
            first: render.tabStart(this.layoutView(), this.tabSpace()),
            count: this.model().count,
            ids: this.model()
              .tabs.slice(0, this.model().count)
              .map(tab => tab.id),
            dragging: false,
            cancelled: false,
            drop: null,
          };
          this.dirty = true;
        }
      }
      return;
    }
    const hover = (button & 32) !== 0 && (button & 3) === 3;
    for (const p of this.layoutView().placements(this.area())) {
      if (!p.rect.contains(x, y)) continue;
      const term = this.pane(p.id)!.terminal;
      // Once the app asks for mouse input it gets every event except
      // Shift, copy mode and the rest of a selection drag.
      const app_mouse = term.mouseEvents() && !this.copy_mode && (button & 4) === 0 && this.selection === null;
      // Hover never moves focus. The encoder drops it unless the app
      // tracks all motion.
      if (hover) {
        if (app_mouse) sendMouse(term, p.rect, button, x, y, release);
        return;
      }
      if (!release && (button & 0xe3) === 2 && (!term.mouseEvents() || (button & 4) !== 0)) {
        const source = this.nav().tab().focus;
        this.closeMenu();
        this.selection = null;
        this.cancelDividers();
        this.tab_menu = new TabMenu({
          pane: true,
          tab: p.id,
          source: source !== p.id ? source : null,
          anchor_x: x,
          anchor_y: y,
        });
        this.ui_mouse_down = true;
        this.dirty = true;
        return;
      }
      this.focusPane(p.id);
      this.dirty = true;
      // Links open on release in the pressed cell, so a drag that ends
      // on a link never opens it. Plain clicks only claim links when
      // they would otherwise start a selection; mouse-aware apps keep
      // them. Cmd-click stays with the host's OSC 8 handler. SGR mouse
      // events expose Ctrl, but do not encode the Command modifier.
      const plain_link = button === 0 && !term.mouseEvents();
      if (!release && (button === 16 || plain_link) && !this.copy_mode) {
        for (const link of term.hyperlinks()) {
          if (link.row !== y - p.rect.y || x - p.rect.x < link.start || x - p.rect.x >= link.end) continue;
          if (!link.uri.startsWith("http://") && !link.uri.startsWith("https://")) continue;
          if (byteLength(link.uri) > 4096) continue;
          cl.port_click = portClick({
            x,
            y,
            url: link.uri,
            pane: p.id,
            px: x - p.rect.x,
            py: y - p.rect.y,
            drag_selects: plain_link,
          });
          return;
        }
      }
      if (app_mouse) {
        if (!release && (button & 96) === 0) cl.pane_press = p.id;
        sendMouse(term, p.rect, button, x, y, release);
        return;
      }
      if (release) {
        this.selection = null;
        return;
      }
      // Wheel events are a separate button class, including horizontal
      // scrolling and modifiers. They must never fall through to clicks.
      if ((button & 64) !== 0) {
        switch (button & 0xc3) {
          case 64:
            this.scroll(-3);
            break;
          case 65:
            this.scroll(3);
            break;
          default:
            break; // No horizontal viewport scrolling.
        }
        return;
      }
      if ((button & 0xe3) === 2) {
        this.ui_mouse_down = true;
        return;
      }
      const px = x - p.rect.x;
      const py = y - p.rect.y;
      if ((button & 32) !== 0) {
        const sel = this.selection;
        if (sel && sel.pane === p.id) {
          sel.moved = true;
          term.select(sel.x, sel.y, px, py);
        }
      } else if ((button & 3) === 0) {
        this.selection = { pane: p.id, x: px, y: py, moved: false };
        term.clearSelection();
        term.holding_selection = true;
      }
      return;
    }
    if (release) {
      this.selection = null;
      return;
    }
    if (button === 0) {
      const hit = this.layoutView().dividerAt(this.area(), x, y);
      if (hit) {
        cl.divider = { hit, area: this.area(), cancelled: false };
        this.selection = null;
      }
    }
  }
  visitWorkspace(id: number): void {
    const index = this.runtime.workspaces.index(id);
    if (index === null) return;
    const ws = this.runtime.workspaces.items[index];
    if (statsAny(ws.stats)) {
      ws.stats = { tools: 0, input: 0, output: 0, tokens_known: false };
      this.dirty = true;
    }
  }
  async refresh(): Promise<void> {
    const reply = await call(this.connection, "session.snapshot", {});
    this.receiveSnapshot(reply);
  }
  receiveSnapshot(snapshot: any): void {
    const had = this.runtime.workspaces.items.length > 0;
    const previous_focus = had ? (this.focused()?.id ?? 0) : 0;
    const previous_workspace = had ? this.current().id : 0;
    const previous_token = had ? this.model().revision : 0n;
    this.runtime.receive(this.connection, snapshot);
    this.trackRunning();
    if (previous_workspace !== this.current().id || previous_token !== this.model().revision) this.cancelDividers();
    if (previous_focus !== 0 && previous_focus !== (this.focused()?.id ?? 0)) {
      this.copy_mode = false;
      this.search_mode = false;
      this.selection = null;
      this.message = "";
      this.native_notice = null;
    }
    this.reconcile();
  }
  reconcile(): void {
    if (this.agent_picker && this.agent_picker.workspace !== this.current().id) this.agent_picker = null;
    if (this.agent_launcher) this.agent_launcher.worktrees = this.current().worktrees ?? null;
    if (this.sidebar_focus && this.sidebarView([]).width === 0) this.leaveSidebar();
    if (this.port_menu) {
      const links = this.port_menu;
      const count = sidebar.urlCount(this.portWorkspaceEntry(links.workspace));
      if (this.runtime.workspaces.index(links.workspace) === null || count === 0) this.port_menu = null;
      else links.selected = Math.min(links.selected, count - 1);
    }
    if (this.tab_menu && this.tabMenuStale(this.tab_menu)) this.tab_menu = null;
    if (this.selection && this.pane(this.selection.pane) === null) this.selection = null;
    const dialog = this.name_dialog;
    if (dialog) {
      const target = dialog.target;
      const stale =
        "rename" in target
          ? this.tabIndex(target.rename) === null
          : "pane" in target
            ? this.pane(target.pane) === null
            : "agent" in target
              ? this.pane(target.agent) === null
              : "fork" in target
                ? this.pane(target.fork) === null
                : false;
      if (stale) this.dismissName();
    }
    this.dirty = true;
  }
  async expireInput(): Promise<void> {
    await this.wakeFocused();
    if (this.onboarding && (await this.onboarding.poll(this.rpc()))) this.dirty = true;
    if (this.corgi_setup && (await this.corgi_setup.poll(this.rpc()))) this.dirty = true;
    await this.pollLauncher();
    this.pollScopeMenu();
    if (this.link_tooltip.due(milliTimestamp())) this.dirty = true;
    if (this.resource_aim && milliTimestamp() - this.resource_aim.at >= resourceTooltip.aim_ms) {
      // The pointer stopped short of the card: what it rests on takes over.
      this.resource_aim = null;
      if (this.resourceDetail() !== null) this.link_tooltip.move();
      this.dirty = true;
    }
    if (this.copy_feedback_until !== 0 && milliTimestamp() >= this.copy_feedback_until) {
      this.copy_feedback_until = 0;
      this.dirty = true;
    }
    const removal = this.worktree_card.removal;
    if (removal.phase !== "idle") {
      this.followRemoval();
      removal.advance(milliTimestamp());
      this.dirty = true;
    }
    const cl = this.input_state;
    if (
      cl.attached &&
      cl.keybuf.length > 0 &&
      Date.now() - cl.escape_at > (cl.paste !== null || cl.keybuf.length === 1 ? 40 : 1000)
    ) {
      if (cl.paste !== null) {
        const p = this.pastePane();
        if (p) this.sendInput(p.terminal, cl.keybuf);
      } else if (cl.keybuf.length === 1 && cl.keybuf[0] === 27) await this.key(27);
      else if (!this.hasMenu() && this.name_dialog === null) {
        const p = this.focused();
        if (p) this.sendInput(p.terminal, cl.keybuf);
      }
      cl.keybuf = [];
    }
  }
  /** The workspace whose worktrees' uncommitted files to scan: the overview's, or
   * the current one while the launcher lists its checkouts. */
  worktreeDetailWanted(): number | null {
    return this.worktreeDetail() ?? (this.agent_launcher?.worktree.mode === "open" ? this.current().id : null);
  }
  worktreeDetail(): number | null {
    const id = this.worktree_card.workspace;
    if (id === null || (!this.worktree_card.pinned && !this.hoverIdle()) || this.runtime.workspaces.index(id) === null)
      return null;
    return this.worktree_card.pinned || (this.link_tooltip.shown && this.link_tooltip.target?.worktree === id)
      ? id
      : null;
  }
  /** The open overview, with its worktrees' agents counted for this frame. */
  private worktreeCard(): worktreeTooltip.State | null {
    const id = this.worktreeDetail();
    if (id === null) return null;
    const snapshot = this.runtime.workspaces.items.find(ws => ws.id === id)?.worktrees;
    this.worktree_card.agents = snapshot ? worktreeAgents.counts(snapshot, this.agentEntries(id)) : null;
    return this.worktree_card;
  }
  private pinWorktreeInput(input: string): void {
    if (this.worktreeDetail() === null) return;
    const key = keys.parse(input),
      event = keyboard.decode(input);
    if (
      ["j", "k", "\r", "\t", "\x0e", "\x10", "\x1b", "\x7f", "\x08"].includes(input) ||
      key === "up" ||
      key === "down" ||
      key === "delete" ||
      key === "paste_start" ||
      (event &&
        [
          9,
          13,
          14,
          16,
          27,
          106,
          107,
          127,
          keyboard.arrow_up,
          keyboard.arrow_down,
          keys.logicalKey("delete").codepoint,
        ].includes(event.codepoint))
    )
      this.worktree_card.pinned = true;
  }
  private openSessions(): Set<string> {
    const open = new Set<string>();
    for (const pane of this.runtime.panes)
      if (pane.agent.provider && pane.agent.state !== "done" && pane.agent.session)
        open.add(`${pane.agent.provider}:${pane.agent.session}`);
    for (const session of this.runtime.sessions)
      if (!session.exited && session.state !== "done" && session.agent?.session)
        open.add(`${session.provider}:${session.agent.session}`);
    return open;
  }
  private browsingWorktree(): worktreeAgents.Selection | null {
    const id = this.worktreeDetail();
    if (id === null || !this.worktreeRect()) return null;
    const snapshot = this.runtime.workspaces.items.find(ws => ws.id === id)?.worktrees,
      entries = worktrees.linked(snapshot ?? null),
      checkout = entries[this.worktree_card.index(entries)];
    if (!checkout) return null;
    this.worktree_card.select(checkout.path);
    return { workspace: id, path: checkout.path };
  }
  private worktreeAgentContains(x: number, y: number): boolean {
    const side = this.sidebarView([]);
    return side.width > 0 && x >= 0 && x < side.width - 1 && y >= side.middle() + 2 && y < side.rows;
  }
  /** Keeps a browsed worktree in the agent list. One with no agents gets its
   * newest conversations back as hibernated agents, or, with none, the agent
   * picker there; otherwise its first agent takes focus. */
  private async enterWorktree(selection: worktreeAgents.Selection): Promise<void> {
    const snapshot = this.runtime.workspaces.items.find(ws => ws.id === selection.workspace)?.worktrees;
    if (!snapshot || !worktrees.linked(snapshot).some(e => e.path === selection.path)) return;
    const live = this.agentEntries(selection.workspace).some(e => worktreeAgents.belongs(snapshot, selection.path, e)),
      asleep = live
        ? []
        : worktreeAgents.conversations(snapshot, selection.path, this.mergedHistory(), this.openSessions());
    if (!live && asleep.length === 0) {
      if (this.current().id !== selection.workspace) this.switchWorkspace(selection.workspace);
      this.sidebar_open = true;
      this.openLauncher(true, selection.path);
      return;
    }
    for (const e of asleep) {
      const resume = { workspace: selection.workspace, cwd: e.cwd, provider: e.provider, session: e.session };
      try {
        await this.execute({ "agent.resume": { ...resume, asleep: true, name: worktreeAgents.name(e) } });
      } catch (error) {
        this.notice((error as Error).message);
        break;
      }
    }
    this.revealWorktree(selection, live);
  }
  /** Unfolds a worktree's group and scrolls to it, focusing its first agent if `focus`. */
  private revealWorktree(selection: worktreeAgents.Selection, focus: boolean): void {
    this.worktree_agents.folded.delete(worktreeAgents.key(selection));
    this.folded_groups = this.folded_groups.filter(id => id !== selection.workspace);
    if (this.current().id !== selection.workspace) this.switchWorkspace(selection.workspace);
    this.closeMenu();
    this.sidebar_rows.discard();
    const entries = this.sidebarEntries(),
      index = worktreeAgents.index(entries, selection);
    const first = entries.find(
      e =>
        sidebar.isAgent(e.target) &&
        e.worktree?.workspace === selection.workspace &&
        e.worktree.path === selection.path,
    );
    if (focus && first) this.selectAgent(first.target);
    if (index >= 0) this.agentOffset().set(this.sidebarView(entries).reveal(index));
    this.dirty = true;
  }
  private worktreeRect(): Rect | null {
    const id = this.worktreeDetail();
    if (id === null) return null;
    const ws = this.runtime.workspaces.items.find(w => w.id === id);
    const badge = sidebar.worktreeBadge(this.sidebarView([]), this.workspaceEntries(), id),
      shown = worktreeTooltip.listing(ws?.worktrees ?? null, this.worktree_card);
    return worktreeTooltip.geometry(
      this.width,
      this.height,
      this.sidebarView([]).width,
      badge?.y ?? this.worktree_card.anchor,
      shown.entries.length,
      shown.closed,
    );
  }
  private worktreeHoverContains(x: number, y: number): boolean {
    const rect = this.worktreeRect();
    if (!rect) return false;
    if (rect.contains(x, y)) return true;
    const badge = sidebar.worktreeBadge(this.sidebarView([]), this.workspaceEntries(), this.worktree_card.workspace!);
    return badge !== null && worktreeTooltip.between(rect, badge, x, y);
  }
  resourceDetail(): number | null {
    if (!this.prefs.resources.enabled || !this.link_tooltip.shown || this.link_tooltip.target === null) return null;
    const id = this.link_tooltip.target.resource ?? null;
    if (id === null) return null;
    if (this.runtime.workspaces.index(id) === null) return null;
    const work = sidebar.resourcesFor(this.runtime.resources, id);
    if (work.cpu === null && work.memory === null && work.read === null && work.written === null) return null;
    return id;
  }
  private resourceRect(): Rect | null {
    if (this.resourceDetail() === null) return null;
    return resourceTooltip.geometry(this.width, this.height, this.sidebarView([]).width, this.resource_card.anchor);
  }
  private resourceBridgeContains(rect: Rect, x: number, y: number): boolean {
    const side = this.sidebarView([]).width;
    // Bridge the resource row's right padding and sidebar divider so the
    // pointer can reach the card one cell at a time, including diagonally.
    return rect.contains(x, y) || (x >= sat(side, 2) && x < rect.x && y >= rect.y && y < rect.y + rect.h);
  }
  private resourceHoverContains(x: number, y: number): boolean {
    const rect = this.resourceRect();
    if (!rect) return false;
    if (this.resourceBridgeContains(rect, x, y)) return true;
    const aim = this.resource_aim;
    if (!aim) return false;
    return resourceTooltip.aimed(rect, aim, x, y);
  }
  /** Starts aiming when the pointer steps off the card's row toward the
   * card and keeps the card while each move stays inside the triangle. */
  private aimResource(x: number, y: number): void {
    const id = this.resourceDetail();
    if (id === null) {
      this.resource_aim = null;
      return;
    }
    const rect = this.resourceRect()!;
    const entries = this.workspaceEntries();
    const view = this.sidebarView([]);
    const on_row = sidebar.resourceAt(view, entries, x, y)?.id === id;
    if (on_row || this.resourceBridgeContains(rect, x, y)) {
      this.resource_aim = null;
      return;
    }
    if (this.pointer) {
      const from = this.pointer;
      if (sidebar.resourceAt(view, entries, from.x, from.y)?.id === id)
        this.resource_aim = { x: from.x, y: from.y, at: 0 };
    }
    if (this.resource_aim) {
      if (resourceTooltip.aimed(rect, this.resource_aim, x, y)) this.resource_aim.at = milliTimestamp();
      else this.resource_aim = null;
    }
  }
  /** No modal, drag, or selection is claiming the pointer right now. */
  private hoverIdle(): boolean {
    return (
      !this.hasMenu() &&
      this.menu() === null &&
      this.name_dialog === null &&
      !this.copy_mode &&
      this.selection === null &&
      this.workspace_drag === null
    );
  }
  private linkTooltipReady(): boolean {
    let target: TooltipTarget | null = null;
    const pointer = this.pointer;
    if (
      pointer &&
      !this.hasMenu() &&
      this.menu() === null &&
      this.name_dialog === null &&
      !this.copy_mode &&
      this.selection === null &&
      !this.ui_mouse_down
    ) {
      if (this.worktreeHoverContains(pointer.x, pointer.y)) return true;
      if (this.resourceHoverContains(pointer.x, pointer.y)) return true;
      const ws = sidebar.resourceAt(this.sidebarView([]), this.workspaceEntries(), pointer.x, pointer.y);
      if (ws && resourceTooltip.geometry(this.width, this.height, this.sidebarView([]).width, pointer.y) !== null) {
        target = { resource: ws.id };
        this.resource_card.anchor = pointer.y;
      }
      if (corgiBadge.hit(this.corgi_badge, this.sidebarView([]).width, pointer.x, pointer.y)) target = { usage: true };
      const git = sidebar.gitActionWorkspace(
        this.sidebarView([]),
        this.workspaceEntries(),
        this.git_hover,
        pointer.x,
        pointer.y,
      );
      if (git) {
        target = { git: git.id };
        if (git.git_push.phase === "failed") return true;
      }
      const worktree = sidebar.worktreeAt(this.sidebarView([]), this.workspaceEntries(), pointer.x, pointer.y);
      if (
        worktree &&
        worktreeTooltip.geometry(
          this.width,
          this.height,
          this.sidebarView([]).width,
          pointer.y,
          worktrees.linked(worktree.worktrees).length,
        )
      ) {
        target = { worktree: worktree.id };
        this.worktree_card.workspace = worktree.id;
        this.worktree_card.anchor = pointer.y;
      }
      const entries = this.sidebarEntries();
      // The host may leave its last mouse report at the window edge.
      if (pointer.x > 0) {
        const entry = sidebar.agentAt(this.sidebarView(entries), entries, pointer.x, pointer.y);
        if (entry) target = { conversation: entry.conversation, agent: entry.target };
      }
    }
    return this.link_tooltip.ready(target, milliTimestamp());
  }
  frame(): string {
    palette.use(this.corgi_setup?.previewTheme(this.prefs) ?? this.prefs.theme, this.terminal_colors);
    if (this.onboarding) return this.onboarding.frame(this.width, this.height);
    if (this.prefix && this.help_visible) {
      const hand =
        this.pointer !== null &&
        this.help.pointsAt(this.width, this.height, this.pointer.x, this.pointer.y, this.prefs.preset);
      return this.help.frame(
        this.width,
        this.height,
        this.prefs.preset,
        this.prefs.prefix,
        Date.now(),
        hand ? render.handShape(this.iterm2_pointer) : "default",
      );
    }
    this.rememberAgent();
    const entries = this.agent_picker
      ? this.pickerEntries()
      : this.sidebar_focus
        ? this.focusEntries()
        : this.sidebarEntries();
    if (!this.agent_picker) this.revealLaunched(entries);
    this.revealTab();
    if (this.pointer) {
      const hit = sidebar.gitActionWorkspace(
        this.sidebarView(entries),
        this.workspaceEntries(),
        this.git_hover,
        this.pointer.x,
        this.pointer.y,
      );
      this.git_hover = hit ? hit.id : null;
    } else this.git_hover = null;
    if (this.agent_drag) this.agent_drag.valid(this.sidebarView(entries), this.current().id);
    if (this.workspace_drag) this.workspace_drag.valid(this.sidebarView(entries), this.workspaceIds());
    const tooltip_ready = this.linkTooltipReady();
    const detail = this.resourceDetail();
    if (detail !== null) {
      const rect = this.resourceRect();
      const freeze = this.pointer !== null && rect !== null && rect.contains(this.pointer.x, this.pointer.y);
      this.resource_card.update(sidebar.resourcesFor(this.runtime.resources, detail) as any, freeze);
    }
    const card = this.paste_card;
    const focused = this.focused();
    return render.frame(
      this.layoutView(),
      this.runtime.panes,
      this.width,
      this.height,
      render.ui({
        prefs: this.prefs,
        pointer: this.pointer,
        iterm2_pointer: this.iterm2_pointer,
        link_tooltip: tooltip_ready,
        resources: this.runtime.resources,
        resource_hover: this.link_tooltip.target?.resource ?? null,
        resource_card: tooltip_ready && detail !== null ? this.resource_card : null,
        git_hover: this.hoverIdle() ? this.git_hover : null,
        worktree_card: this.worktreeCard(),
        worktree_spotlight: this.browsingWorktree(),
        message:
          this.agent_picker && (this.width < 40 || this.height < 13)
            ? " Agent search: enlarge terminal or Esc"
            : this.message,
        copy_feedback: this.copy_feedback_until > milliTimestamp(),
        copy_mode: this.copy_mode,
        prefix: this.prefix,
        sidebar_focus: this.sidebar_focus?.section() ?? null,
        ghost: this.sidebarGhost(),
        menu: this.menu(),
        tab_menu: this.tab_menu,
        port_menu: this.port_menu,
        agent_search: this.agentSearch(),
        agent_launcher: this.agent_launcher,
        scope_menu: this.scope_menu,
        scope_label: this.scopeLabel(),
        corgi_setup: this.corgi_setup,
        paste_card: card && focused && focused.id === card.pane ? card.notice : null,
        paste_copied: card ? card.copied : false,
        inference: this.runtime.inference,
        tab_drop_x: this.tabDropX(),
        dialog: this.name_dialog,
        sidebar_open: this.sidebar_open,
        sidebar_drawer: this.sidebar_focus?.drawer ?? null,
        corgi_badge: this.corgi_badge,
        supports_kitty_graphics: this.supports_kitty_graphics,
        dragged_workspace:
          this.workspace_drag && this.workspace_drag.preview !== null
            ? new sidebar.Preview(this.workspace_drag.source, this.workspace_drag.preview)
            : null,
        dragged_agent:
          this.agent_drag && this.agent_drag.preview !== null
            ? new sidebar.Preview(this.agent_drag.source, this.agent_drag.preview)
            : null,
        resizing: this.sidebar_drag
          ? this.sidebar_drag === "width"
            ? "horizontal"
            : "vertical"
          : this.input_state.divider && !this.input_state.divider.cancelled
            ? this.input_state.divider.hit.axis
            : null,
        sidebar_offset: this.agent_picker ? this.agent_picker.offset : this.agentOffset().get(),
        agents: entries,
        conversations: this.runtime.conversations,
        system_model: this.runtime.system_model,
        system_model_name: this.runtime.system_model_name,
        release: {
          running: this.runtime.release_version,
          commit: this.runtime.release_commit,
          staged: this.runtime.staged_version,
        },
        system_usage: this.runtime.system_usage,
        system_working: this.runtime.system_working,
        accounts: new subagentTooltip.Accounts({
          options: this.launch_previews.preview.options,
          system: this.runtime.inference.provider,
        }),
        workspaces: this.sidebar_focus
          ? this.sidebar_focus.markWorkspaces(this.workspaceEntries())
          : this.workspaceEntries(),
        workspace_offset: this.workspace_offset,
      }),
    );
  }
}
function direction(key: number): Direction | null {
  switch (key) {
    case 104:
      return "left";
    case 106:
      return "down";
    case 107:
      return "up";
    case 108:
      return "right";
    default:
      return null;
  }
}
/** `title (fork)`, shortening the title so the name fits a dialog. */
export function forkName(title: string): string {
  const suffix = " (fork)";
  const bytes = Buffer.from(title);
  let end = Math.min(bytes.length, name_limit - suffix.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString() + suffix;
}
/** What Copy ID puts on the clipboard: enough for another agent to find
 * this conversation. Unknown fields are left out. */
export function breadcrumbs(p: Pane): string {
  const name = p.label.length > 0 ? p.label : p.agent.name;
  return [
    ["harness", p.agent.provider ? Provider.info(p.agent.provider).label : ""],
    ["session", name],
    ["id", p.agent.session],
    ["cwd", p.agent.cwd.length > 0 ? p.agent.cwd : p.cwd],
    ["transcript", p.agent.transcript],
  ]
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}
/** What a viewer says when an agent rename or fork fails with `err`. */
function agentMessage(err: string, fallback: string): string {
  switch (err) {
    case "AgentBusy":
      return " Codex is busy: rename it once its input box is empty";
    case "RenameUnavailable":
      return " This agent can't be renamed from outside";
    case "NoConversation":
      return " This agent has no conversation yet";
    case "InvalidName":
      return " Names are one line of up to 80 characters";
    default:
      return fallback;
  }
}
function removalReason(err: string | null): string {
  switch (err) {
    case "NoWorktree":
      return "it's already gone";
    case "WorktreeLocked":
      return "it's locked";
    case "WorktreeInUse":
      return "a workspace is open in it";
    case "WorktreeRemoveFailed":
      return "git couldn't remove it";
    case "WorktreeRemoving":
      return "another one is being removed";
    case "UnknownOperation":
      return "reload Corgi's daemon first";
    default:
      return err ?? "unknown error";
  }
}
const preview_changed = "The commits to push changed. Review them and push again.";
function gitPushMessage(err: string): string {
  switch (err) {
    case "GitPreviewChanged":
      return preview_changed;
    case "GitPushInProgress":
      return "A push is already running for this repository.";
    default:
      return err;
  }
}
/** Re-encodes a host SGR report for the app in `rect`, in the protocol it
 * chose. Points outside `rect` reach the app only while a button is held. */
function sendMouse(term: Terminal, rect: Rect, button: number, x: number, y: number, release: boolean): void {
  term.send(viewerNative.encodeMouse(term.handle, button, x - rect.x, y - rect.y, release));
}
function latin1(bytes: number[]): string {
  return String.fromCharCode(...bytes);
}
function contextView(value: any): sidebar.Entry["context"] {
  const view = sidebar.entry({ target: { pane: 0 } }).context;
  if (!value) return view;
  view.used = BigInt(value.used ?? 0);
  view.window = BigInt(value.window ?? 0);
  view.compacts_at = BigInt(value.compacts_at ?? 0);
  view.at = Number(value.at ?? 0);
  return view;
}
