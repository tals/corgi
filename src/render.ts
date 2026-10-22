//! One complete frame of the viewer: tabs, panes, sidebar and overlays.
//! Mirrors render.zig.
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import { Rect, View as LayoutView, cleanLabel, type Axis, type Border } from "./layout";
import * as sidebar from "./sidebar";
import {
  View as SidebarView,
  Preview,
  ScopeMenu,
  PortMenu,
  type Entry,
  type WorkspaceEntry,
  type Search,
  type Scope,
  type Section,
} from "./sidebar";
import { ResizeView, TabMenu } from "./commands";
import { Dialog, View as NameView } from "./name_dialog";
import type { Menu as LauncherMenu } from "./agent_launcher";
import { Menu as SetupMenu, status as setupStatus, type Status as SetupStatus } from "./corgi_setup";
import * as corgiBadge from "./corgi_badge";
import * as rowGlide from "./row_glide";
import type { Cell } from "./fork_motion";
import * as pasteCard from "./paste_card";
import * as resourceTooltip from "./resource_tooltip";
import * as linkTooltip from "./link_tooltip";
import * as linkThumbnail from "./link_thumbnail";
import type { Images } from "./pane_images";
import * as worktreeTooltip from "./worktree_tooltip";
import { milliTimestamp } from "./clock";
import * as subagentTooltip from "./subagent_tooltip";
import { View as UsageView } from "./usage/live";
import * as corgiAnimation from "./corgi_animation";
import * as signinExit from "./signin_exit";
import * as keymap from "./keymap";
import * as bindings from "./bindings";
import { Preferences } from "./preferences";
import { providerName, type Pane } from "./mirror";
import type { Notice } from "./host_clipboard";
import {
  Writer,
  codepointWidth,
  displayWidth,
  writeEllipsis,
  ellipsis,
  directoryLabel,
  sat,
  byteLength,
  byteSlice,
} from "./text";

export type Pointer = { x: number; y: number };
/** The focused pane's outline. The divider tests parse it back. */
export let divider_focused: string;
/** How much ink a cut tab label's last two letters keep, in percent. */
const tab_fade_ink = [65, 35];
let tab_active: string,
  tab_inactive: string,
  tab_badge: string,
  tab_badge_active: string,
  tab_open: string,
  tab_open_active: string,
  tab_badge_end: string,
  tab_badge_end_active: string,
  tab_fade: [string, string],
  tab_fade_active: [string, string],
  button: string,
  button_edge: string,
  chip: string,
  hint_key: string,
  hint_label: string,
  bar: string,
  divider_plain: string,
  ghost_band: string,
  ghost_edge: string;
palette.derived(() => {
  tab_active = new Style({ fg: "strong", bg: "selected", bold: true }).sgr();
  tab_inactive = new Style({ fg: "faint", bg: "surface" }).sgr();
  // Each tab's number, on the keycap's gray; the active tab's is lit with the focus color.
  tab_badge = new Style({ fg: "text", bg: "line" }).sgr();
  tab_badge_active = new Style({ fg: "bg", bg: "accent", bold: true }).sgr();
  // Half blocks: the bar's half cell before the badge, and the badge's after its number.
  tab_open = new Style({ fg: "line", bg: "bg" }).sgr();
  tab_open_active = new Style({ fg: "accent", bg: "bg" }).sgr();
  tab_badge_end = new Style({ fg: "line", bg: "surface" }).sgr();
  tab_badge_end_active = new Style({ fg: "accent", bg: "selected" }).sgr();
  // A cut label's last two letters fade into the tab, so the name trails off.
  const fade = (style: string, ground: palette.Token, ink: palette.Token) =>
    tab_fade_ink.map(
      share => style + palette.fgRgb(palette.mix(palette.colors[ground], palette.colors[ink], share)),
    ) as [string, string];
  tab_fade = fade(tab_inactive, "surface", "faint");
  tab_fade_active = fade(tab_active, "selected", "strong");
  button = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  button_edge = new Style({ fg: "surface", bg: "bg" }).sgr();
  chip = new Style({ fg: "text", bg: "selected" }).sgr();
  hint_key = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  hint_label = new Style({ fg: "faint", bg: "surface" }).sgr();
  bar = new Style({ bg: "surface" }).sgr();
  divider_focused = `\x1b[0;38;2;${palette.outline.join(";")}m`;
  divider_plain = new Style({ fg: "line" }).sgr();
  ghost_band = new Style({ bg: "bg" }).sgr();
  ghost_edge = new Style({ fg: "faint", bg: "bg" }).sgr();
});
/** The agent under the sidebar's cursor, as entering it would show it. */
export interface Ghost {
  pane: Pane;
  /** Its pane's place once entered. */
  rect: Rect;
  /** The pane area once entered. */
  area: Rect;
}

export interface Ui {
  prefs: Preferences;
  pointer: Pointer | null;
  iterm2_pointer: boolean;
  link_tooltip: boolean;
  link_card: linkTooltip.Card | null;
  resources: any;
  resource_hover: number | null;
  resource_card: resourceTooltip.State | null;
  git_hover: number | null;
  worktree_card: worktreeTooltip.State | null;
  /** The worktree browsed in the overview, or the checkout the launcher
   * starts agents in, whose rows stay lit while the rest of the agent list dims. */
  worktree_spotlight: sidebar.Spotlight | null;
  agent_launcher: LauncherMenu | null;
  corgi_setup: SetupMenu | null;
  /** Why a paste brought no image, for the focused pane, and whether a
   * click copied its link. */
  paste_card: Notice | null;
  paste_copied: boolean;
  inference: SetupStatus;
  message: string;
  copy_mode: boolean;
  copy_feedback: boolean;
  /** The agent just added, shown briefly above the launcher or its new pane. */
  added_feedback: string;
  signin_exit: signinExit.State | null;
  /** The prefix key was pressed and waits for the next one. */
  prefix: boolean;
  /** The sidebar list with the keyboard instead of the focused pane. */
  sidebar_focus: Section | null;
  ghost: Ghost | null;
  menu: ResizeView | null;
  tab_menu: TabMenu | null;
  port_menu: PortMenu | null;
  scope_menu: ScopeMenu | null;
  scope_label: string;
  agent_search: Search | null;
  tab_drop_x: number | null;
  dialog: Dialog | null;
  sidebar_open: boolean;
  /** The folded sidebar's list that shows as a drawer over the panes. */
  sidebar_drawer: Section | null;
  corgi_badge: corgiBadge.Mode;
  supports_kitty_graphics: boolean;
  images: Images | null;
  /** The host's cell in pixels, when it reports it. */
  cell_pixels: Cell | null;
  dragged_workspace: Preview | null;
  dragged_agent: Preview | null;
  /** The axis of a divider or sidebar edge being dragged. */
  resizing: Axis | null;
  sidebar_offset: number;
  agents: Entry[];
  conversations: subagentTooltip.Conversation[];
  system_model: string;
  system_model_name: string;
  release: subagentTooltip.Release;
  system_working: boolean;
  system_usage: UsageView;
  accounts: subagentTooltip.Accounts;
  workspaces: WorkspaceEntry[];
  workspace_offset: number;
  /** Columns the review panel takes at the right edge; 0 while it is closed. */
  review_width: number;
  /** The row of the rule under the review panel's file list, which drags its height. */
  review_split: number | null;
  /** The review panel has the keyboard, so no pane shows its cursor. */
  review_focused: boolean;
  /** The review panel's keys are up, dimming the panes. */
  review_keys: boolean;
  /** Draws the review panel over its columns. */
  review_draw: ((w: Writer) => void) | null;
  /** Draws an account's sign-in over the whole screen, its cursor included. */
  signin_draw: ((w: Writer, pointer: Pointer | null) => linkTooltip.Link | null) | null;
}
export function ui(fields: Partial<Ui> & { message: string; copy_mode: boolean }): Ui {
  return {
    prefs: new Preferences(),
    pointer: null,
    iterm2_pointer: false,
    link_tooltip: false,
    link_card: null,
    resources: { workspaces: [] },
    resource_hover: null,
    resource_card: null,
    git_hover: null,
    worktree_card: null,
    worktree_spotlight: null,
    agent_launcher: null,
    corgi_setup: null,
    paste_card: null,
    paste_copied: false,
    inference: setupStatus(),
    copy_feedback: false,
    added_feedback: "",
    signin_exit: null,
    prefix: false,
    sidebar_focus: null,
    ghost: null,
    menu: null,
    tab_menu: null,
    port_menu: null,
    scope_menu: null,
    scope_label: "",
    agent_search: null,
    tab_drop_x: null,
    dialog: null,
    sidebar_open: true,
    sidebar_drawer: null,
    corgi_badge: "none",
    supports_kitty_graphics: false,
    images: null,
    cell_pixels: null,
    dragged_workspace: null,
    dragged_agent: null,
    resizing: null,
    sidebar_offset: 0,
    agents: [],
    conversations: [],
    system_model: "",
    system_model_name: "",
    release: {},
    system_working: false,
    system_usage: new UsageView(),
    accounts: new subagentTooltip.Accounts(),
    workspaces: [],
    workspace_offset: 0,
    review_width: 0,
    review_split: null,
    review_focused: false,
    review_keys: false,
    review_draw: null,
    signin_draw: null,
    ...fields,
  };
}
/** What an untitled tab shows for its focused pane: the pane's name, its
 * agent's, or the last part of its folder. */
export function untitledTab(p: Pane): string {
  if (p.label.length > 0) return p.label;
  if (p.agent.provider !== null) return cleanLabel(p.agent.name || providerName(p.agent));
  const folder = directoryLabel(p.cwd, process.env.HOME ?? null);
  return cleanLabel(folder === "/" ? folder : folder.slice(folder.lastIndexOf("/") + 1));
}
/** A tab is a half cell of bar, its number, the badge's half cell, then its
 * label and a space. Untitled tabs keep one width, so they don't move when an
 * agent renames itself; a renamed tab fits its whole title. */
export function tabWidth(view: LayoutView, index: number): number {
  const digits = `${index + 1}`.length;
  return Math.max(12, digits + 3 + byteLength(view.model.tabs[index].title));
}
function tabExtent(view: LayoutView, index: number, first: number, remaining: number): number {
  const width = tabWidth(view, index);
  // Clip only when even the first tab cannot fit; avoid tiny trailing tabs.
  return index === first ? Math.min(width, remaining) : width <= remaining ? width : 0;
}
/** The first tab shown: the scroll offset, kept where tabs still fill `width`. */
export function tabStart(view: LayoutView, width: number): number {
  return Math.min(view.selection.offset, maxTabStart(view, width));
}
/** The first tab once scrolled to the end, from which every later tab fits. */
export function maxTabStart(view: LayoutView, width: number): number {
  const model = view.model;
  let start = model.count;
  let used = 0;
  while (start > 0) {
    used += tabWidth(view, start - 1);
    if (used > width) break;
    start -= 1;
  }
  return Math.min(start, sat(model.count, 1));
}
/** The smallest scroll change that shows tab `index`. */
export function revealTab(view: LayoutView, width: number, index: number): number {
  let start = tabStart(view, width);
  if (index < start) return index;
  let used = 0;
  for (let i = start; i <= index; i++) used += tabWidth(view, i);
  while (start < index && used > width) {
    used -= tabWidth(view, start);
    start += 1;
  }
  return start;
}
function tabsBefore(view: LayoutView, index: number): number {
  let used = 0;
  for (let i = 0; i < index; i++) used += tabWidth(view, i);
  return used;
}
export interface TabThumb {
  start: number;
  len: number;
}
/** The scrollbar knob's columns within the shown tabs, drawn along their
 * bottom edge; null while every tab fits. The knob keeps one short length,
 * so only its position tells how far the tabs are scrolled. */
export function tabThumb(view: LayoutView, width: number): TabThumb | null {
  const available = sat(width, 3);
  const last = tabsBefore(view, maxTabStart(view, available));
  const track = addTabX(view, width);
  if (last === 0 || track < 2) return null;
  const len = Math.min(6, track - 1);
  const start = Math.floor(((track - len) * tabsBefore(view, tabStart(view, available)) + Math.floor(last / 2)) / last);
  return { start: Math.min(start, track - len), len };
}
export let track_rule: string, thumb_rule: string;
palette.derived(() => {
  track_rule = "\x1b[4:4m" + palette.underline("line");
  thumb_rule = "\x1b[4m" + palette.underline("text");
});
/** Writes a tab's cells, one column each, from column `left`, each in its
 * style, underlined as the scrollbar's track or thumb while the tabs overflow. */
function writeTabCells(w: Writer, cells: string[], styles: string[], left: number, thumb: TabThumb | null): void {
  let style: string | null = null;
  let lit: boolean | null = null;
  for (let i = 0; i < cells.length; i++) {
    const column = left + i;
    const on = thumb !== null && column >= thumb.start && column < thumb.start + thumb.len;
    // A style resets the underline, so the rule follows it.
    if (style !== styles[i] || lit !== on) w.write(styles[i] + (thumb === null ? "" : on ? thumb_rule : track_rule));
    w.write(cells[i]);
    style = styles[i];
    lit = on;
  }
}
/** `text` as one entry per column, a wide character's second column empty. */
function columns(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    out.push(ch);
    if (codepointWidth(ch.codePointAt(0)!) === 2) out.push("");
  }
  return out;
}
export function addTabX(view: LayoutView, width: number): number {
  const model = view.model;
  const available = sat(width, 3);
  let x = 0;
  const first = tabStart(view, available);
  for (let i = first; i < model.count; i++) {
    const len = tabExtent(view, i, first, available - x);
    if (len === 0) break;
    x += len;
  }
  return x;
}
export function tabAt(view: LayoutView, width: number, x: number): number | null {
  const model = view.model;
  const available = sat(width, 3);
  let start = 0;
  const first = tabStart(view, available);
  for (let i = first; i < model.count; i++) {
    const len = tabExtent(view, i, first, available - start);
    if (len === 0) break;
    if (x >= start && x < start + len) return i;
    start += len;
  }
  return null;
}
export interface TabDrop {
  index: number;
  x: number;
}
/** Use the same clipped tab geometry for hit testing and the drop marker. */
export function tabDrop(view: LayoutView, width: number, x: number): TabDrop | null {
  const model = view.model;
  if (x >= width || model.count === 0) return null;
  const available = sat(width, 3);
  const first = tabStart(view, available);
  let left = 0;
  let last: TabDrop | null = null;
  for (let i = first; i < model.count; i++) {
    const len = tabExtent(view, i, first, available - left);
    if (len === 0) break;
    if (x < left + Math.floor(len / 2)) return { index: i, x: sat(left, 1) };
    left += len;
    last = { index: i + 1, x: sat(left, 1) };
    if (x < left) return last;
  }
  return last;
}
/** Where the paste card goes. Menus and dialogs take precedence; then the card waits. */
function placeCard(view: LayoutView, panes: Pane[], area: Rect, notice: Notice, u: Ui): pasteCard.Placement | null {
  if (!noOverlay(u) || u.copy_mode) return null;
  return pasteCard.locate(view, panes, area, notice);
}
/** No modal overlay, menu, or dialog is covering the panes. */
function noOverlay(u: Ui): boolean {
  return (
    u.scope_menu === null &&
    u.agent_launcher === null &&
    u.corgi_setup === null &&
    u.agent_search === null &&
    u.menu === null &&
    u.tab_menu === null &&
    u.port_menu === null &&
    u.worktree_card === null &&
    u.dialog === null &&
    u.signin_draw === null &&
    u.signin_exit === null &&
    !u.sidebar_focus
  );
}
/** An open overlay reaches the badge. The launcher and scope menu open clear of it. */
function badgeCovered(u: Ui, side: SidebarView, width: number, height: number): boolean {
  // The agents drawer has no title row for the badge.
  if (u.sidebar_drawer === "agents") return true;
  const boxes = menuBoxes(u, width, height);
  if (u.agent_search) boxes.push(new Rect(0, side.middle() + 1, side.width, 1));
  if (u.dialog) {
    const d = NameView.init(width, height, u.dialog);
    boxes.push(new Rect(d.x, d.y, d.width, d.height));
  }
  return boxes.some(corgiBadge.overlaps);
}
/** The open menus that can reach past the sidebar. */
function menuBoxes(u: Ui, width: number, height: number): Rect[] {
  const boxes: Rect[] = [];
  if (u.menu) boxes.push(new Rect(u.menu.x, u.menu.y, u.menu.width, u.menu.rows + 3));
  if (u.tab_menu) {
    const b = u.tab_menu.bounds(width, height);
    boxes.push(new Rect(b.x, b.y, b.width, u.tab_menu.lines() + 2 * b.padding));
  }
  if (u.port_menu) boxes.push(sidebar.PortMenu.bounds(width, height));
  return boxes;
}
/** The host's name for the pointing hand. iTerm2 takes X11 cursor names. */
export function handShape(iterm2: boolean): string {
  return iterm2 ? "hand2" : "pointer";
}
/** Draw one row of text over the window's bottom-left corner, from column
 * `left`, like a browser's link preview. Panes keep the row otherwise. It
 * moves to the bottom-right corner when the pointer is where it would go. */
function writeChip(
  w: Writer,
  raw: string,
  width: number,
  height: number,
  pointer: Pointer | null,
  left = 0,
): Rect | null {
  const text = raw.replace(/^ +/, "");
  if (width - left < 4 || height === 0 || text.length === 0) return null;
  const clipped = new Writer();
  writeEllipsis(clipped, text, width - left - 2);
  const body = clipped.buffered();
  const chip_width = displayWidth(body) + 2;
  const covered = pointer !== null && pointer.y === height - 1 && pointer.x >= left && pointer.x < left + chip_width;
  const x = covered ? width - chip_width : left;
  w.write(`\x1b[${height};${x + 1}H\x1b]8;;\x1b\\${chip} ${body} \x1b[0m`);
  return new Rect(x, height - 1, chip_width, 1);
}
/** A bar over the pane area's bottom row while the prefix waits for its key.
 * A narrow bar drops "send prefix", then "cancel". */
export function drawPrefixBar(w: Writer, area: Rect, preset: keymap.Preset, prefix: keymap.Prefix): void {
  if (area.w === 0 || area.h === 0) return;
  const hints = [
    { key: "Esc", label: "cancel" },
    { key: keymap.prefixName(prefix), label: "send prefix" },
    { key: bindings.format(bindings.first(preset, { name: "help" }, true)!), label: "shortcuts" },
  ];
  const hintWidth = (h: { key: string; label: string }) => displayWidth(h.key) + h.label.length + 3;
  const label = " PREFIX ";
  let shown = [true, true, true];
  let used = label.length;
  for (const hint of hints) used += hintWidth(hint);
  for (const i of [1, 0]) {
    if (used <= area.w) break;
    shown[i] = false;
    used -= hintWidth(hints[i]);
  }
  if (used > area.w) {
    shown = [false, false, false];
    used = label.length;
  }
  w.write(
    `\x1b[${area.y + area.h};${area.x + 1}H\x1b]8;;\x1b\\${keycap}${label.slice(0, Math.min(label.length, area.w))}`,
  );
  hints.forEach((hint, i) => {
    if (shown[i]) w.write(`${hint_key} ${hint.key}${hint_label} ${hint.label} `);
  });
  w.write(bar);
  w.splat(" ", sat(area.w, used));
  w.write("\x1b[0m");
}
export function frame(view: LayoutView, panes: Pane[], width: number, height: number, u: Ui): string {
  const model = view.model;
  const w = new Writer();
  const entries = u.dragged_agent ? u.dragged_agent.apply(u.agents) : u.agents;
  const workspaces = u.dragged_workspace ? u.dragged_workspace.apply(u.workspaces) : u.workspaces;
  const dragging = u.dragged_agent !== null || u.dragged_workspace !== null;
  let side = SidebarView.init(width, height, u.sidebar_open, u.sidebar_offset, entries.length, u.prefs.sidebar_split)
    .withSearch(u.agent_search)
    .withWidth(u.prefs.sidebar_width)
    .withPanel(u.review_width);
  side.resources = u.prefs.resources;
  side.gpus = resourceTooltip.gpuCount(u.resources) > 0;
  side.drawer = u.sidebar_drawer;
  side.focus = u.sidebar_focus;
  side = side.withWorkspaces(u.workspaces.length, u.workspace_offset).withEntries(entries);
  side.corgi_badge = u.corgi_badge;
  side.supports_kitty_graphics = u.supports_kitty_graphics;
  side.cell = u.cell_pixels;
  side.scope_label = u.scope_label;
  side.resource_hover = u.resource_hover;
  side.corgi_intensity = u.corgi_setup?.previewIntensity(u.prefs) ?? u.prefs.corgi_intensity;
  side.dragged = u.dragged_agent ? u.dragged_agent.destination : null;
  side.dragged_workspace = u.dragged_workspace ? u.dragged_workspace.destination : null;
  // Mouse tracking modes replace one another. Disabling first makes the host
  // briefly switch to a text pointer on every redraw.
  w.write("\x1b[?1003h");
  // Erase from home to the end, preserving Kitty image storage. ED 2
  // deletes cached images in Ghostty, even those without a placement.
  w.write("\x1b[?2026h\x1b[?25l\x1b[0m\x1b[H\x1b[J");
  w.write(`\x1b[1;${side.tabX() + 1}H`);
  let x = 0;
  const tab_space = sat(width - side.tabX() - side.panel, 3);
  const start = tabStart(view, tab_space);
  // The scrollbar shows while the pointer is where the wheel scrolls the tabs.
  const over_tabs = u.pointer !== null && u.pointer.y === 0 && u.pointer.x >= side.tabX() && noOverlay(u);
  const thumb = over_tabs ? tabThumb(view, width - side.tabX() - side.panel) : null;
  for (let i = start; i < model.count; i++) {
    const tab = model.tabs[i];
    const len = tabExtent(view, i, start, tab_space - x);
    if (len === 0) break;
    const active = i === view.selection.active;
    const number = `${i + (u.prefs.preset === "tmux" ? 0 : 1)}`;
    const focus = view.selection.tabs[i]?.focus;
    const p = tab.title.length === 0 ? panes.find(p => p.id === focus) : undefined;
    // The label is cut to leave a space at its end, unless the bar already cuts the tab.
    const name = p ? untitledTab(p) : tab.title;
    let label = byteSlice(name, sat(len, number.length + (len < tabWidth(view, i) ? 2 : 3)));
    const cut = label.length < name.length;
    if (cut) label = label.trimEnd();
    const text = columns(label);
    const cells = ["▐", ...number, "▌", ...text].slice(0, len);
    while (cells.length < len) cells.push(" ");
    const [open, badge, end, plain, faded] = active
      ? [tab_open_active, tab_badge_active, tab_badge_end_active, tab_active, tab_fade_active]
      : [tab_open, tab_badge, tab_badge_end, tab_inactive, tab_fade];
    const label_end = number.length + 2 + text.length;
    const styles = cells.map((_, c) =>
      c === 0
        ? open
        : c <= number.length
          ? badge
          : c === number.length + 1
            ? end
            : cut && c >= label_end - 2 && c < label_end
              ? faded[c - (label_end - 2)]
              : plain,
    );
    writeTabCells(w, cells, styles, x, thumb);
    x += len;
  }
  // The add button keeps the tabs' half-cell gap.
  w.write(button_edge + "▐" + button + "+" + button_edge + "▌");
  w.write("\x1b[0m");
  if (u.tab_drop_x !== null)
    w.write(`\x1b[1;${side.tabX() + u.tab_drop_x + 1}H\x1b[1m` + palette.fg("strong") + "│\x1b[0m");
  if (model.count === 0) {
    const prefix_key = keymap.prefixName(u.prefs.prefix);
    const empty = ` No panes. ${prefix_key} ${bindings.format(bindings.first(u.prefs.preset, { name: "new" }, true)!)}: agent picker | ${prefix_key} ${bindings.format(bindings.first(u.prefs.preset, { name: "help" }, true)!)}: shortcuts`;
    w.write(`\x1b[2;${side.area().x + 1}H`);
    w.write(byteSlice(empty, side.area().w));
  }
  const area = side.area();
  let hovered_uri: string | null = null;
  let link_pointer = false;
  let resize_hover: Axis | null = null;
  // Pane images go in last, cut around the boxes drawn over them.
  const pictured: { pane: Pane; rect: Rect; hidden: boolean }[] = [];
  const covered: Rect[] = [];
  const cover = (box: Rect | null) => {
    if (box) covered.push(box);
  };
  const link_rect = u.link_card ? linkTooltip.geometry(width, height, u.link_card.link, u.link_card.thumbnail) : null;
  const on_link_card = u.pointer !== null && link_rect !== null && link_rect.contains(u.pointer.x, u.pointer.y);
  const card_rect =
    !u.link_tooltip || u.agent_launcher !== null || u.corgi_setup !== null || u.pointer === null
      ? null
      : u.resource_card
        ? resourceTooltip.geometry(width, height, side.width, u.resource_card.anchor, u.resource_card.gpus)
        : null;
  // The card hides links beneath it. Workspace rows it covers still take
  // presses, so they keep their own pointer.
  const on_card =
    u.pointer !== null &&
    card_rect !== null &&
    card_rect.contains(u.pointer.x, u.pointer.y) &&
    side.hit(u.pointer.x, u.pointer.y).tag !== "workspace";
  if (u.pointer) {
    const pointer = u.pointer;
    if (on_link_card) {
      link_pointer = linkTooltip.copyAt(link_rect!, pointer.x, pointer.y);
    } else if (on_card) {
      link_pointer = resourceTooltip.sortAt(card_rect!, pointer.x, pointer.y, u.resource_card!.gpus) !== null;
    } else if (u.scope_menu !== null) {
      link_pointer =
        side.hit(pointer.x, pointer.y).tag === "agent_scope" ||
        ScopeMenu.hit(side, width, height, pointer.x, pointer.y) !== null;
    } else if (
      u.agent_launcher === null &&
      u.corgi_setup === null &&
      u.agent_search === null &&
      u.menu === null &&
      u.tab_menu === null &&
      u.dialog === null
    ) {
      if (u.port_menu) {
        const menu = u.port_menu;
        for (const ws of u.workspaces) {
          if (ws.id !== menu.workspace) continue;
          const index = menu.hit(ws, width, height, pointer.x, pointer.y);
          if (index !== null) hovered_uri = sidebar.workspaceUrl(ws, index);
          break;
        }
      } else {
        link_pointer =
          sidebar.worktreeAt(side, u.workspaces, pointer.x, pointer.y) !== null ||
          sidebar.portWorkspace(side, u.workspaces, pointer.x, pointer.y) !== null ||
          corgiBadge.hit(u.corgi_badge, side.width, pointer.x, pointer.y);
        const found = side.hit(pointer.x, pointer.y);
        switch (found.tag) {
          case "toggle":
          case "workspace_new":
          case "agent_scope":
          case "agent_new":
          case "agent_options":
            link_pointer = true;
            break;
          case "workspace":
            link_pointer = link_pointer || side.unreadHit(u.workspaces[found.workspace], pointer.x, pointer.y);
            break;
          default:
            break;
        }
        // Pushing and just-pushed badges ignore clicks, so only Push and Retry point.
        const git = sidebar.gitActionWorkspace(side, u.workspaces, u.git_hover, pointer.x, pointer.y);
        if (git) link_pointer = link_pointer || git.git_push.phase === "idle" || git.git_push.phase === "failed";
        if (pointer.y === 0 && pointer.x >= side.tabX()) {
          const add_x = side.tabX() + addTabX(view, width - side.tabX() - side.panel);
          link_pointer = link_pointer || (pointer.x >= add_x && pointer.x < add_x + 3);
        }
        hovered_uri = sidebar.portLink(side, u.workspaces, pointer.x, pointer.y);
        // The sidebar's last column drags its width, ahead of any control there.
        if (side.width > 0 && pointer.x === side.width - 1) resize_hover = "horizontal";
        else if (u.review_width > 0 && pointer.x === width - u.review_width) resize_hover = "horizontal";
        else if (u.review_width > 0 && pointer.x > width - u.review_width && pointer.y === u.review_split)
          resize_hover = "vertical";
        else if (side.splitHandle(pointer.x, pointer.y)) resize_hover = "vertical";
        else {
          const hit = view.dividerAt(area, pointer.x, pointer.y);
          if (hit) resize_hover = hit.axis;
        }
      }
    }
  }
  if (u.corgi_setup !== null && u.pointer)
    link_pointer = u.corgi_setup.hit(width, height, u.pointer.x, u.pointer.y, u.inference, u.prefs) !== null;
  if (u.pointer) {
    const pointer = u.pointer;
    if (u.menu) {
      const menu = u.menu;
      const found = menu.hit(pointer.x, pointer.y);
      link_pointer =
        found.tag === "command" || found.tag === "previous" || found.tag === "next"
          ? true
          : found.tag === "close"
            ? pointer.y === menu.y && pointer.x >= menu.x && pointer.x < menu.x + menu.width
            : false;
    } else if (u.tab_menu) {
      link_pointer = u.tab_menu.hit(width, height, pointer.x, pointer.y) !== null;
    } else if (u.dialog) {
      const dialog_view = NameView.init(width, height, u.dialog);
      // Clicks outside the dialog also cancel; only the buttons point.
      const inside = pointer.x >= dialog_view.x && pointer.x < dialog_view.x + dialog_view.width;
      link_pointer =
        inside && pointer.y === dialog_view.buttons_y && dialog_view.hit(pointer.x, pointer.y).tag !== "none";
    }
  }
  if (u.agent_launcher !== null && u.pointer) {
    const pointer = u.pointer;
    const found = side.hit(pointer.x, pointer.y).tag;
    link_pointer =
      u.agent_launcher.hit(width, height, side, pointer.x, pointer.y) !== null ||
      u.agent_launcher.worktreeHit(width, height, side, pointer.x, pointer.y) !== null ||
      (u.agent_launcher.worktreeButton(width, height, side)?.contains(pointer.x, pointer.y) ?? false) ||
      found === "agent_new" ||
      found === "agent_options";
  }
  for (const place of view.placements(area)) {
    if (place.rect.w === 0 || place.rect.h === 0) continue;
    const p = panes.find(pane => pane.id === place.id);
    if (!p) continue;
    const r = place.rect;
    p.terminal.updateRender();
    let hovered: bigint | null = null;
    if (u.pointer && r.contains(u.pointer.x, u.pointer.y) && !on_card && !on_link_card && noOverlay(u)) {
      const link = linkTooltip.at(p.terminal, r, u.pointer.x, u.pointer.y);
      hovered = link?.id ?? null;
      hovered_uri = link?.uri ?? hovered_uri;
    }
    // Dialogs, the launcher, Corgi setup, the workspace drawer and the review panel's keys dim the panes behind them.
    const dim =
      u.dialog !== null ||
      u.agent_launcher !== null ||
      u.corgi_setup !== null ||
      u.sidebar_drawer !== null ||
      u.review_keys;
    w.write(p.terminal.rows(p.id, r.x, r.y, r.w, r.h, dim, hovered));
    w.write("\x1b[0m");
    if (p.restoring.length > 0) {
      drawRestoring(
        w,
        r,
        {
          command: p.restoring,
          name: p.label.length > 0 ? p.label : p.agent.name.length > 0 ? p.agent.name : providerName(p.agent),
          meta: restoringMeta(p, u.conversations),
          dig: p.dormant ? "asleep" : p.forking ? "forking" : "restoring",
        },
        Date.now() - p.restoring_since,
      );
    }
    // Kitty can't dim an image, so dimmed and covered panes keep their
    // images uploaded but don't place them.
    const hidden =
      dim || dragging || u.copy_mode || u.signin_draw !== null || u.signin_exit !== null || p.restoring.length > 0;
    if (u.supports_kitty_graphics) pictured.push({ pane: p, rect: r, hidden });
  }
  drawDividers(w, view, area, !u.sidebar_focus);
  // Under the sidebar, which covers what a drawer hides.
  if (u.ghost) cover(drawGhost(w, u.ghost, side.drawer !== null ? side.width : u.ghost.area.x));
  // The host may leave its last mouse report at the window edge.
  if (u.pointer && u.pointer.x > 0 && !dragging && !on_card && noOverlay(u))
    side.hovered = sidebar.agentIndexAt(side, entries, u.pointer.x, u.pointer.y);
  side.spotlight = u.worktree_spotlight;
  // A moving row's tint and a link's thumbnail are placed again by each frame that shows them.
  if (u.supports_kitty_graphics) w.write(rowGlide.hide + linkThumbnail.hide);
  side.draw(w, entries, workspaces);
  if (u.git_hover !== null) sidebar.drawGitAction(w, side, u.workspaces, u.git_hover);
  if (u.review_draw) u.review_draw(w);
  if (u.corgi_badge === "image") {
    w.write(corgiBadge.hide);
    if (side.width > 0 && !badgeCovered(u, side, width, height)) w.write(corgiBadge.place());
  }
  const paste_at = u.paste_card ? placeCard(view, panes, area, u.paste_card, u) : null;
  if (paste_at && u.pointer && pasteCard.linkAt(u.paste_card!, paste_at, u.pointer.x, u.pointer.y)) link_pointer = true;
  if (paste_at) {
    cover(new Rect(paste_at.x, paste_at.y, paste_at.w, paste_at.h));
    if (paste_at.arrow) cover(new Rect(paste_at.arrow.x, paste_at.arrow.y, 1, 1));
  }
  if (u.prefix) {
    drawPrefixBar(w, area, u.prefs.preset, u.prefs.prefix);
    if (area.h > 0) cover(new Rect(area.x, area.y + area.h - 1, area.w, 1));
  } else {
    // A card that doesn't fit its pane says why in the status line instead.
    const unplaced = u.paste_card !== null && paste_at === null ? u.paste_card.body.text() : null;
    const text =
      hovered_uri ??
      unplaced ??
      (u.message.length > 0
        ? u.message
        : u.copy_mode
          ? "SCROLL  j/k move  y copy viewport  q exit"
          : u.sidebar_focus
            ? "SIDEBAR  ↑↓ move  ↵ open  Esc back"
            : "");
    // Beside the sidebar while it has focus, clear of its box's bottom edge.
    cover(writeChip(w, text, width, height, u.pointer, u.sidebar_focus ? side.width : 0));
  }
  // The prefix bar covers the area's last row.
  const cursor_rows = area.y + area.h - (u.prefix && area.h > 0 ? 1 : 0);
  if (model.count > 0 && !u.copy_mode && !u.link_tooltip && !u.review_focused && noOverlay(u)) {
    for (const place of view.placements(area)) {
      if (place.id !== view.selection.tabs[view.selection.active].focus || place.rect.h === 0) continue;
      const p = panes.find(pane => pane.id === place.id && pane.restoring.length === 0);
      if (!p) continue;
      const cursor = p.terminal.cursor();
      if (cursor && cursor.x < place.rect.w && cursor.y < place.rect.h && place.rect.y + cursor.y < cursor_rows)
        w.write(`\x1b[${place.rect.y + cursor.y + 1};${place.rect.x + cursor.x + 1}H\x1b[?25h`);
    }
  }
  if (paste_at) w.write(pasteCard.draw(u.paste_card!, paste_at, u.paste_copied));
  if (u.worktree_card) {
    const ws = u.workspaces.find(ws => ws.id === u.worktree_card!.workspace);
    if (ws) {
      const badge = sidebar.worktreeBadge(side, u.workspaces, ws.id),
        now = milliTimestamp(),
        shown = worktreeTooltip.listing(ws.worktrees, u.worktree_card, now);
      const rect = worktreeTooltip.geometry(
        width,
        height,
        side.width,
        badge?.y ?? u.worktree_card.anchor,
        shown.entries.length,
        shown.closed,
        u.worktree_card.lines(),
      );
      if (rect) {
        worktreeTooltip.draw(w, rect, ws.name, ws.cwd, ws.worktrees, u.worktree_card, badge, now);
        cover(rect);
        if (u.pointer && worktreeTooltip.sortAt(rect, u.pointer.x, u.pointer.y) !== null) link_pointer = true;
      } else cover(writeChip(w, "Worktrees: enlarge terminal · Esc to close", width, height, u.pointer));
    }
  } else if (u.link_tooltip && !u.link_card && u.agent_launcher === null && u.corgi_setup === null && u.pointer) {
    const pointer = u.pointer;
    if (u.resource_card) {
      if (card_rect) {
        const name = u.workspaces.find(ws => ws.id === u.resource_card!.workspace)?.name ?? "workspace";
        resourceTooltip.draw(w, card_rect, name, u.resources, u.resource_card, pointer);
        cover(card_rect);
      }
    } else if (corgiBadge.hit(u.corgi_badge, side.width, pointer.x, pointer.y)) {
      const box = subagentTooltip.drawOverview(
        w,
        u.conversations,
        u.system_usage,
        u.system_working,
        u.system_model,
        u.system_model_name,
        u.release,
        u.accounts,
        width,
        height,
      );
      cover(box);
    } else {
      const git = sidebar.gitActionWorkspace(side, u.workspaces, u.git_hover, pointer.x, pointer.y);
      if (git) cover(sidebar.drawGitTooltip(w, git, width, height, pointer.x, pointer.y));
      else {
        const agent = sidebar.agentAt(side, u.agents, pointer.x, pointer.y);
        if (agent)
          cover(subagentTooltip.draw(w, u.conversations, agent, width, height, pointer.x, pointer.y, u.accounts));
      }
    }
  }
  if (u.copy_feedback && width >= 27 && height >= 5) {
    cover(new Rect(width - 27, 1, 27, 3));
    const toast_x = width - 26;
    w.write("\x1b7" + new Style({ fg: "line", bg: "bg" }).sgr());
    w.write(`\x1b[2;${toast_x}H╭─────────────────────────╮`);
    w.write(
      `\x1b[3;${toast_x}H│ ` +
        palette.fg("strong") +
        "● \x1b[1mCopied to clipboard\x1b[22m" +
        palette.fg("line") +
        "   │",
    );
    w.write(`\x1b[4;${toast_x}H╰─────────────────────────╯`);
    w.write("\x1b[0m\x1b8");
  }
  covered.push(...menuBoxes(u, width, height));
  if (u.menu) u.menu.draw(w);
  if (u.tab_menu) u.tab_menu.draw(w, width, height);
  if (u.port_menu) {
    const menu = u.port_menu;
    const ws = u.workspaces.find(item => item.id === menu.workspace);
    if (ws) menu.draw(w, ws, width, height);
  }
  if (u.dialog) {
    const dialog = u.dialog;
    let number = model.count + 1;
    if ("rename" in dialog.target) {
      const target = dialog.target.rename;
      const i = model.tabs.slice(0, model.count).findIndex(tab => tab.id === target);
      if (i >= 0) number = i + 1;
    }
    NameView.init(width, height, dialog).draw(dialog, w, number);
  }
  if (u.scope_menu) {
    u.scope_menu.draw(w, side, width, height, u.workspaces, u.prefs.agents as Scope);
    cover(ScopeMenu.bounds(side, width, height));
  }
  if (u.agent_launcher) u.agent_launcher.draw(w, width, height, side);
  if (u.corgi_setup) u.corgi_setup.draw(w, u.inference, u.prefs, width, height);
  cover(signinExit.draw(w, u.added_feedback, width, height, u.signin_exit));
  // A sign-in takes the whole screen, its cursor included.
  if (u.signin_draw) {
    hovered_uri = u.signin_draw(w, on_link_card ? null : u.pointer)?.uri ?? null;
    link_pointer = on_link_card && linkTooltip.copyAt(link_rect!, u.pointer!.x, u.pointer!.y);
    resize_hover = null;
  } else side.searchCursor(w);
  if (u.signin_exit) w.write("\x1b[?25l");
  if (u.link_card && link_rect && u.pointer) {
    w.write("\x1b[?25l");
    linkTooltip.draw(w, link_rect, u.link_card, linkTooltip.copyAt(link_rect, u.pointer.x, u.pointer.y));
    if (u.link_card.thumbnail) w.write(linkThumbnail.place(link_rect, u.link_card.thumbnail));
    cover(link_rect);
  }
  if (u.images && u.cell_pixels) {
    const { images, cell_pixels } = u;
    for (const { pane, rect, hidden } of pictured) {
      const read = (id: string, offset: number) => pane.terminal.image(id, offset);
      w.write(images.draw(pane.terminal.images, rect, cell_pixels, read, hidden ? [rect] : covered));
    }
  }
  if (dragging) w.write("\x1b[?25l");
  // Include the shape in each complete frame so reconnects and overlay changes
  // cannot leave the host pointer stuck on a previously hovered link.
  // iTerm2 has a pointing hand and an open hand, but no closed-hand shape.
  // "default" also clears its override because unrecognized names reset it.
  const axis = u.resizing ?? resize_hover;
  const shape = dragging
    ? u.iterm2_pointer
      ? "fleur"
      : "grabbing"
    : axis !== null
      ? axis === "horizontal"
        ? u.iterm2_pointer
          ? "sb_h_double_arrow"
          : "ew-resize"
        : u.iterm2_pointer
          ? "sb_v_double_arrow"
          : "ns-resize"
      : link_pointer || hovered_uri !== null
        ? handShape(u.iterm2_pointer)
        : "default";
  w.write(`\x1b]22;${shape}\x1b\\`);
  w.write("\x1b[?2026l");
  return w.buffered();
}

/** What a reopened or forked agent's card says under the corgi digging its
 * title out, or a dormant one's under the corgi asleep. */
export interface Restoring {
  command: string;
  name: string;
  /** Provider, model and folder. */
  meta: string;
  dig: corgiAnimation.Dig | "asleep";
}
/** "claude · Opus 4.7 · ~/dev/corgi", leaving out a model Corgi hasn't seen. */
function restoringMeta(p: Pane, conversations: any[]): string {
  const folder = directoryLabel(p.agent.cwd.length > 0 ? p.agent.cwd : p.cwd, process.env.HOME ?? null, 160);
  const model = conversations.find(c => c.id === p.agent.conversation)?.model_name ?? "";
  return model.length > 0 ? `${providerName(p.agent)} · ${model} · ${folder}` : `${providerName(p.agent)} · ${folder}`;
}
/** A command's words as a shell reads them, each flag kept with its value. */
export function shellUnits(command: string): string[] {
  const words: [number, number][] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && command[i] === " ") i += 1;
    if (i === command.length) break;
    const start = i;
    let quoted = false;
    for (; i < command.length; i++) {
      if (command[i] === "\\" && !quoted) i += 1;
      else if (command[i] === "'") quoted = !quoted;
      else if (command[i] === " " && !quoted) break;
    }
    // The last word Corgi keeps takes the rest.
    if (words.length === 64) {
      words[63][1] = command.length;
      break;
    }
    words.push([start, Math.min(i, command.length)]);
  }
  const units: string[] = [];
  for (let k = 0; k < words.length && units.length < 64; k++) {
    const start = words[k][0];
    if (command[start] === "-" && k + 1 < words.length && command[words[k + 1][0]] !== "-") k += 1;
    units.push(command.slice(start, words[k][1]));
  }
  return units;
}
/** Lines of the command after "$ ", breaking between words as a shell prints
 * it: " \\" ends each line but the last, and the rest indent four. */
export interface CommandLine {
  first: number;
  count: number;
}
export function commandLines(units: string[], width: number, limit = 16): CommandLine[] {
  const out: CommandLine[] = [];
  let start = 0;
  let used = 2;
  units.forEach((unit, i) => {
    const cells = displayWidth(unit);
    if (i > start && used + 1 + cells + 2 > width && out.length + 1 < limit) {
      out.push({ first: start, count: i - start });
      start = i;
      used = 4 + cells;
    } else used += cells + (i > start ? 1 : 0);
  });
  out.push({ first: start, count: units.length - start });
  return out;
}
/** A card over a reopened or forked agent's old screen until the agent draws
 * its own: the corgi digs the title out, centered; the agent's name,
 * provider, model and folder, and the command it runs sit under it. Rows
 * that don't fit go, the command first. */
export function drawRestoring(w: Writer, r: Rect, band: Restoring, shown_ms: number): void {
  const panel = new Style({ fg: "text", bg: "surface" }).sgr();
  const border = new Style({ fg: "line", bg: "surface" }).sgr();
  const word = band.dig === "asleep" ? corgiAnimation.Asleep.wordWidth : corgiAnimation.Dig.wordWidth(band.dig);
  const lead = corgiAnimation.Dig.lead;
  if (r.w < word + 4 || r.h === 0) return;
  const units = shellUnits(band.command);
  const text = Math.max(displayWidth(band.name), displayWidth(band.meta), Math.min(displayWidth(band.command) + 2, 58));
  const bw = Math.min(r.w, Math.max(text + 6, word + 2 * lead + 6));
  const inner = sat(bw, 6);
  const lines = commandLines(units, inner);
  // Borders and padding, the title, then a gap and the details that fit.
  let details = 2 + lines.length;
  while (details > 0 && 6 + details > r.h) details = details > 2 ? 2 : 0;
  const bh = details > 0 ? 6 + details : Math.min(r.h, 5);
  const bx = r.x + Math.floor((r.w - bw) / 2);
  const by = r.y + Math.floor((r.h - bh) / 2);
  if (bh >= 3) {
    for (let row = 0; row < bh; row++) {
      w.write(`\x1b[${by + row + 1};${bx + 1}H` + border);
      const edge = row === 0 || row + 1 === bh;
      w.write(row === 0 ? "╭" : row + 1 === bh ? "╰" : "│");
      if (edge) w.write("─".repeat(bw - 2));
      else {
        w.write(panel);
        w.splat(" ", bw - 2);
        w.write(border);
      }
      w.write(row === 0 ? "╮" : row + 1 === bh ? "╯" : "│");
    }
  } else
    for (let row = 0; row < bh; row++) {
      w.write(`\x1b[${by + row + 1};${bx + 1}H` + panel);
      w.splat(" ", bw);
    }
  // The title is centered; the corgi's scene sits before it when it fits.
  const title_y = by + Math.min(Math.floor(bh / 2), 2);
  const word_x = bx + Math.floor((bw - word) / 2);
  const scene = word_x >= bx + 1 + lead;
  w.write(`\x1b[${title_y + 1};${(scene ? word_x - lead : word_x) + 1}H` + panel);
  if (band.dig === "asleep") w.write(corgiAnimation.writeAsleep(scene ? corgiAnimation.Asleep.width : word));
  else w.write(corgiAnimation.writeUnearth(scene ? corgiAnimation.Dig.width(band.dig) : word, shown_ms, band.dig));
  if (details === 0) return w.write("\x1b[0m");
  const x = bx + 3;
  const y = by + 4;
  w.write(`\x1b[${y + 1};${x + 1}H` + new Style({ fg: "strong", bg: "surface", bold: true }).sgr());
  writeEllipsis(w, band.name, inner);
  w.write(`\x1b[${y + 2};${x + 1}H` + new Style({ fg: "muted", bg: "surface" }).sgr());
  writeEllipsis(w, band.meta, inner);
  if (details > 2)
    lines.forEach((line, i) => {
      let out = units.slice(line.first, line.first + line.count).join(" ");
      if (byteLength(out) > 512) out = byteSlice(out, 512);
      if (i + 1 < lines.length && byteLength(out) + 2 <= 512) out += " \\";
      w.write(`\x1b[${y + 3 + i};${x + 1}H`);
      if (i === 0) {
        w.write(
          new Style({ fg: "muted", bg: "surface", bold: true }).sgr() +
            "$ " +
            new Style({ fg: "faint", bg: "surface" }).sgr(),
        );
        writeEllipsis(w, out, sat(inner, 2));
      } else {
        w.write(new Style({ fg: "faint", bg: "surface" }).sgr() + "    ");
        writeEllipsis(w, out, sat(inner, 4));
      }
    });
  w.write("\x1b[0m");
}
/** The box-drawing glyph joining a divider cell with its neighbors on each side. */
function dividerGlyph(up: boolean, down: boolean, left: boolean, right: boolean, horizontal: boolean): string {
  if (up && down) return left && right ? "┼" : left ? "┤" : right ? "├" : "│";
  if (left && right) return up ? "┴" : down ? "┬" : "─";
  if (up) return left ? "┘" : right ? "└" : "│";
  if (down) return left ? "┐" : right ? "┌" : "│";
  return horizontal ? "│" : "─";
}
/** The bottom half of the pane area as entering `g`'s agent would show it,
 * dimmed under a dashed edge naming it from column `left`, past a drawer.
 * Every cell sits where entering leaves it, so entering only reveals the rest. */
export function drawGhost(w: Writer, g: Ghost, left = g.area.x): Rect | null {
  const { pane, rect, area } = g;
  const cut = area.y + Math.floor(area.h / 2);
  if (cut === area.y || area.w === 0) return null;
  w.write("\x1b[0m" + ghost_band);
  for (let y = cut; y < area.y + area.h; y++) {
    w.write(`\x1b[${y + 1};${area.x + 1}H`);
    w.splat(" ", area.w);
  }
  const from = Math.max(0, cut - rect.y);
  if (from < rect.h) {
    pane.terminal.updateRender();
    w.write(rowsFrom(pane.terminal.rows(pane.id, rect.x, rect.y, rect.w, rect.h, true, null), rect, from));
  }
  const label = new Writer(),
    room = area.x + area.w - left;
  writeEllipsis(label, pane.label || pane.agent.name || providerName(pane.agent), sat(room, 8));
  const name = label.buffered();
  w.write(`\x1b[0m\x1b[${cut};${left + 1}H${ghost_edge}┄┄ ${name} `);
  w.write("┄".repeat(sat(room, 4 + displayWidth(name))) + "\x1b[0m");
  // The dashed edge sits on the row above the band.
  return new Rect(area.x, cut - 1, area.w, area.y + area.h - cut + 1);
}
/** `rows` from viewport row `from` on: each row opens with its own cursor move and style. */
function rowsFrom(rows: string, rect: Rect, from: number): string {
  if (from === 0) return rows;
  const at = rows.indexOf(`\x1b[${rect.y + from + 1};${rect.x + 1}H`);
  return at < 0 ? "" : rows.slice(at);
}
/** Without `outline`, as while the sidebar has focus, no pane's border stands out. */
export function drawDividers(w: Writer, view: LayoutView, area: Rect, outline = true): void {
  const borders: Border[] = view.borders(area);
  let focused = new Rect();
  for (const place of view.placements(area))
    if (outline && place.id === view.selection.tabs[view.selection.active].focus) focused = place.rect;
  for (const border of borders) {
    const r = border.rect;
    for (let y = r.y; y < r.y + r.h; y++) {
      let highlighted = touchesPane(focused, r.x, y);
      w.write(highlighted ? divider_focused : divider_plain);
      w.write(`\x1b[${y + 1};${r.x + 1}H`);
      for (let x = r.x; x < r.x + r.w; x++) {
        const selected = touchesPane(focused, x, y);
        if (selected !== highlighted) {
          w.write(selected ? divider_focused : divider_plain);
          highlighted = selected;
        }
        let left = false;
        let right = false;
        let up = false;
        let down = false;
        for (const other of borders) {
          if (x > area.x && other.rect.contains(x - 1, y)) left = true;
          if (x + 1 < area.x + area.w && other.rect.contains(x + 1, y)) right = true;
          if (y > area.y && other.rect.contains(x, y - 1)) up = true;
          if (y + 1 < area.y + area.h && other.rect.contains(x, y + 1)) down = true;
        }
        w.write(dividerGlyph(up, down, left, right, border.axis === "horizontal"));
      }
    }
  }
  w.write("\x1b[0m");
}
export function touchesPane(r: Rect, x: number, y: number): boolean {
  if (r.w === 0 || r.h === 0) return false;
  // Include the junction cells at the corners of the selected pane.
  return x + 1 >= r.x && x <= r.x + r.w && y + 1 >= r.y && y <= r.y + r.h;
}
