//! One complete frame of the viewer: tabs, panes, sidebar and overlays.
//! Mirrors render.zig.
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import { Rect, View as LayoutView, Model, type Axis, type Border } from "./layout";
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
} from "./sidebar";
import { ResizeView, TabMenu } from "./commands";
import { Dialog, View as NameView } from "./name_dialog";
import type { Menu as LauncherMenu } from "./agent_launcher";
import { Menu as SetupMenu, type Status as SetupStatus } from "./corgi_setup";
import * as corgiBadge from "./corgi_badge";
import * as pasteCard from "./paste_card";
import * as resourceTooltip from "./resource_tooltip";
import * as subagentTooltip from "./subagent_tooltip";
import { View as UsageView } from "./usage/live";
import * as corgiAnimation from "./corgi_animation";
import * as keymap from "./keymap";
import * as bindings from "./bindings";
import { Preferences } from "./preferences";
import { providerName, type Pane } from "./mirror";
import type { Notice } from "./host_clipboard";
import { Writer, displayWidth, writeEllipsis, directoryLabel, sat, byteLength, byteSlice } from "./text";

export type Pointer = { x: number; y: number };
/** The focused pane's outline. The divider tests parse it back. */
export let divider_focused: string;
let tab_active: string,
  tab_inactive: string,
  button: string,
  chip: string,
  hint_key: string,
  hint_label: string,
  bar: string,
  divider_plain: string;
palette.derived(() => {
  tab_active = new Style({ fg: "strong", bg: "selected", bold: true }).sgr();
  tab_inactive = new Style({ fg: "faint", bg: "bg" }).sgr();
  button = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  chip = new Style({ fg: "text", bg: "selected" }).sgr();
  hint_key = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  hint_label = new Style({ fg: "faint", bg: "surface" }).sgr();
  bar = new Style({ bg: "surface" }).sgr();
  divider_focused = new Style({ fg: "accent", bold: true }).sgr();
  divider_plain = new Style({ fg: "line" }).sgr();
});

export interface Ui {
  prefs: Preferences;
  pointer: Pointer | null;
  iterm2_pointer: boolean;
  link_tooltip: boolean;
  resources: any;
  resource_hover: number | null;
  resource_card: resourceTooltip.State | null;
  git_hover: number | null;
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
  /** The prefix key was pressed and waits for the next one. */
  prefix: boolean;
  menu: ResizeView | null;
  tab_menu: TabMenu | null;
  port_menu: PortMenu | null;
  scope_menu: ScopeMenu | null;
  scope_label: string;
  agent_search: Search | null;
  tab_drop_x: number | null;
  dialog: Dialog | null;
  sidebar_open: boolean;
  corgi_badge: corgiBadge.Mode;
  supports_kitty_graphics: boolean;
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
}
export function ui(fields: Partial<Ui> & { message: string; copy_mode: boolean }): Ui {
  return {
    prefs: new Preferences(),
    pointer: null,
    iterm2_pointer: false,
    link_tooltip: false,
    resources: { workspaces: [] },
    resource_hover: null,
    resource_card: null,
    git_hover: null,
    agent_launcher: null,
    corgi_setup: null,
    paste_card: null,
    paste_copied: false,
    inference: {
      choice: "auto",
      provider: null,
      model: "",
      locked: false,
      launches: { codex: 0, claude: 0 },
      models: { codex: "", claude: "" },
    },
    copy_feedback: false,
    prefix: false,
    menu: null,
    tab_menu: null,
    port_menu: null,
    scope_menu: null,
    scope_label: "",
    agent_search: null,
    tab_drop_x: null,
    dialog: null,
    sidebar_open: true,
    corgi_badge: "none",
    supports_kitty_graphics: false,
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
    ...fields,
  };
}
export function tabWidth(tab: { title: string }, index: number): number {
  const digits = index + 1 >= 10 ? 2 : 1;
  return Math.max(10, 2 + (tab.title.length > 0 ? Math.min(byteLength(tab.title), 16) : digits));
}
function tabExtent(tab: { title: string }, index: number, first: number, remaining: number): number {
  const width = tabWidth(tab, index);
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
    used += tabWidth(model.tabs[start - 1], start - 1);
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
  for (let i = start; i <= index; i++) used += tabWidth(view.model.tabs[i], i);
  while (start < index && used > width) {
    used -= tabWidth(view.model.tabs[start], start);
    start += 1;
  }
  return start;
}
function tabsBefore(model: Model, index: number): number {
  let used = 0;
  for (let i = 0; i < index; i++) used += tabWidth(model.tabs[i], i);
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
  const last = tabsBefore(view.model, maxTabStart(view, available));
  const track = addTabX(view, width);
  if (last === 0 || track < 2) return null;
  const len = Math.min(6, track - 1);
  const start = Math.floor(
    ((track - len) * tabsBefore(view.model, tabStart(view, available)) + Math.floor(last / 2)) / last,
  );
  return { start: Math.min(start, track - len), len };
}
export let track_rule: string, thumb_rule: string;
palette.derived(() => {
  track_rule = "\x1b[4:4m" + palette.underline("line");
  thumb_rule = "\x1b[4m" + palette.underline("text");
});
/** Writes a tab's cells from column `left`, underlined as the scrollbar's
 * track or thumb while the tabs overflow. */
function writeTabCells(w: Writer, cells: Buffer, left: number, thumb: TabThumb | null): void {
  if (thumb === null) return w.write(cells.toString());
  let lit: boolean | null = null;
  let run = 0;
  for (let i = 0; i < cells.length; i++) {
    const column = left + i;
    const on = column >= thumb.start && column < thumb.start + thumb.len;
    if (lit !== on) {
      if (i > run) w.write(cells.subarray(run, i).toString());
      run = i;
      w.write(on ? thumb_rule : track_rule);
    }
    lit = on;
  }
  w.write(cells.subarray(run).toString());
}
export function addTabX(view: LayoutView, width: number): number {
  const model = view.model;
  const available = sat(width, 3);
  let x = 0;
  const first = tabStart(view, available);
  for (let i = first; i < model.count; i++) {
    const len = tabExtent(model.tabs[i], i, first, available - x);
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
    const len = tabExtent(model.tabs[i], i, first, available - start);
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
    const len = tabExtent(model.tabs[i], i, first, available - left);
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
    u.dialog === null
  );
}
/** An open overlay reaches the badge. The launcher and scope menu open clear of it. */
function badgeCovered(u: Ui, side: SidebarView, width: number, height: number): boolean {
  const boxes: Rect[] = [];
  if (u.agent_search) boxes.push(new Rect(0, side.middle() + 1, side.width, 1));
  if (u.menu) boxes.push(new Rect(u.menu.x, u.menu.y, u.menu.width, u.menu.rows + 3));
  if (u.tab_menu) {
    const b = u.tab_menu.bounds(width, height);
    boxes.push(new Rect(b.x, b.y, b.width, u.tab_menu.lines() + 2 * b.padding));
  }
  if (u.port_menu) boxes.push(sidebar.PortMenu.bounds(width, height));
  if (u.dialog) {
    const d = NameView.init(width, height, u.dialog);
    boxes.push(new Rect(d.x, d.y, d.width, d.height));
  }
  return boxes.some(corgiBadge.overlaps);
}
/** The host's name for the pointing hand. iTerm2 takes X11 cursor names. */
export function handShape(iterm2: boolean): string {
  return iterm2 ? "hand2" : "pointer";
}
/** Draw one row of text over the window's bottom-left corner, like a browser's
 * link preview. Panes keep the row otherwise. It moves to the bottom-right
 * corner when the pointer is where it would go. */
function writeChip(w: Writer, raw: string, width: number, height: number, pointer: Pointer | null): void {
  const text = raw.replace(/^ +/, "");
  if (width < 4 || height === 0 || text.length === 0) return;
  const clipped = new Writer();
  writeEllipsis(clipped, text, width - 2);
  const body = clipped.buffered();
  const chip_width = displayWidth(body) + 2;
  const covered = pointer !== null && pointer.y === height - 1 && pointer.x < chip_width;
  const x = covered ? width - chip_width : 0;
  w.write(`\x1b[${height};${x + 1}H\x1b]8;;\x1b\\${chip} ${body} \x1b[0m`);
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
  let side = SidebarView.init(width, height, u.sidebar_open, u.sidebar_offset, entries.length)
    .withSearch(u.agent_search)
    .withWidth(u.prefs.sidebar_width);
  side.resources = u.prefs.resources;
  side = side.withWorkspaces(u.workspaces.length, u.workspace_offset).withEntries(entries);
  side.corgi_badge = u.corgi_badge;
  side.supports_kitty_graphics = u.supports_kitty_graphics;
  side.scope_label = u.scope_label;
  side.resource_hover = u.resource_hover;
  side.sleeping_corgis = u.prefs.sleeping_corgis;
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
  const tab_space = sat(width - side.tabX(), 3);
  const start = tabStart(view, tab_space);
  // The scrollbar shows while the pointer is where the wheel scrolls the tabs.
  const over_tabs = u.pointer !== null && u.pointer.y === 0 && u.pointer.x >= side.tabX() && noOverlay(u);
  const thumb = over_tabs ? tabThumb(view, width - side.tabX()) : null;
  for (let i = start; i < model.count; i++) {
    const tab = model.tabs[i];
    const len = tabExtent(tab, i, start, tab_space - x);
    if (len === 0) break;
    w.write(i === view.selection.active ? tab_active : tab_inactive);
    const text = tab.title.length === 0 ? `${i + (u.prefs.preset === "tmux" ? 0 : 1)}` : byteSlice(tab.title, 16);
    const text_len = Math.min(byteLength(text), len);
    const padding = Math.floor((len - text_len) / 2);
    // A tab is at most 18 columns wide.
    const cells = Buffer.alloc(18, " ");
    Buffer.from(text).copy(cells, padding, 0, text_len);
    writeTabCells(w, cells.subarray(0, len), x, thumb);
    x += len;
  }
  w.write(button + " + ");
  w.write("\x1b[0m");
  if (u.tab_drop_x !== null)
    w.write(`\x1b[1;${side.tabX() + u.tab_drop_x + 1}H\x1b[1m` + palette.fg("strong") + "│\x1b[0m");
  if (model.count === 0) {
    const prefix_key = keymap.prefixName(u.prefs.prefix);
    const empty = ` No panes. ${prefix_key} ${bindings.format(bindings.first(u.prefs.preset, { name: "new" }, true)!)}: agent picker | ${prefix_key} ${bindings.format(bindings.first(u.prefs.preset, { name: "help" }, true)!)}: shortcuts`;
    w.write(`\x1b[2;${side.width + 1}H`);
    w.write(byteSlice(empty, side.area().w));
  }
  const area = side.area();
  let hovered_uri: string | null = null;
  let link_pointer = false;
  let resize_hover: Axis | null = null;
  const card_rect =
    !u.link_tooltip || u.agent_launcher !== null || u.corgi_setup !== null || u.pointer === null
      ? null
      : u.resource_card
        ? resourceTooltip.geometry(width, height, side.width, u.resource_card.anchor)
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
    if (on_card) {
      link_pointer = resourceTooltip.sortAt(card_rect!, pointer.x, pointer.y) !== null;
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
          sidebar.portWorkspace(side, u.workspaces, pointer.x, pointer.y) !== null ||
          corgiBadge.hit(u.corgi_badge, side.width, pointer.x, pointer.y);
        const found = side.hit(pointer.x, pointer.y);
        switch (found.tag) {
          case "toggle":
          case "workspace_new":
          case "workspace_previous":
          case "workspace_next":
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
          const add_x = side.tabX() + addTabX(view, width - side.tabX());
          link_pointer = link_pointer || (pointer.x >= add_x && pointer.x < add_x + 3);
        }
        hovered_uri = sidebar.portLink(side, u.workspaces, pointer.x, pointer.y);
        // The sidebar's last column drags its width, ahead of any control there.
        if (side.width > 0 && pointer.x === side.width - 1) resize_hover = "horizontal";
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
      found === "agent_new" ||
      found === "agent_options";
  }
  for (const place of view.placements(area)) {
    if (place.rect.w === 0 || place.rect.h === 0) continue;
    const p = panes.find(pane => pane.id === place.id);
    if (!p) continue;
    const r = place.rect;
    p.terminal.updateRender();
    let hovered: number | bigint | null = null;
    if (u.pointer && r.contains(u.pointer.x, u.pointer.y) && !on_card && noOverlay(u)) {
      for (const link of p.terminal.hyperlinks()) {
        if (link.row === u.pointer.y - r.y && link.start <= u.pointer.x - r.x && u.pointer.x - r.x < link.end) {
          hovered = link.id;
          hovered_uri = link.uri;
          break;
        }
      }
    }
    // Dialogs and Corgi setup dim the panes behind them.
    w.write(p.terminal.rows(p.id, r.x, r.y, r.w, r.h, u.dialog !== null || u.corgi_setup !== null, hovered));
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
  }
  drawDividers(w, view, area);
  // The host may leave its last mouse report at the window edge.
  if (u.pointer && u.pointer.x > 0 && !dragging && !on_card && noOverlay(u))
    side.hovered = sidebar.agentIndexAt(side, entries, u.pointer.x, u.pointer.y);
  side.draw(w, entries, workspaces);
  if (u.git_hover !== null) sidebar.drawGitAction(w, side, u.workspaces, u.git_hover);
  if (u.corgi_badge === "image") {
    w.write(corgiBadge.hide);
    if (side.width > 0 && !badgeCovered(u, side, width, height)) w.write(corgiBadge.place());
  }
  const paste_at = u.paste_card ? placeCard(view, panes, area, u.paste_card, u) : null;
  if (paste_at && u.pointer && pasteCard.linkAt(u.paste_card!, paste_at, u.pointer.x, u.pointer.y)) link_pointer = true;
  if (u.prefix) drawPrefixBar(w, area, u.prefs.preset, u.prefs.prefix);
  else {
    // A card that doesn't fit its pane says why in the status line instead.
    const unplaced = u.paste_card !== null && paste_at === null ? u.paste_card.body.text() : null;
    const text =
      hovered_uri ??
      unplaced ??
      (u.message.length > 0 ? u.message : u.copy_mode ? "SCROLL  j/k move  y copy viewport  q exit" : "");
    writeChip(w, text, width, height, u.pointer);
  }
  // The prefix bar covers the area's last row.
  const cursor_rows = area.y + area.h - (u.prefix && area.h > 0 ? 1 : 0);
  if (model.count > 0 && !u.copy_mode && !u.link_tooltip && noOverlay(u)) {
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
  if (u.link_tooltip && u.agent_launcher === null && u.corgi_setup === null && u.pointer) {
    const pointer = u.pointer;
    if (u.resource_card) {
      if (card_rect) {
        const name = u.workspaces.find(ws => ws.id === u.resource_card!.workspace)?.name ?? "workspace";
        resourceTooltip.draw(w, card_rect, name, u.resources, u.resource_card);
      }
    } else if (corgiBadge.hit(u.corgi_badge, side.width, pointer.x, pointer.y)) {
      subagentTooltip.drawOverview(
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
    } else {
      const git = sidebar.gitActionWorkspace(side, u.workspaces, u.git_hover, pointer.x, pointer.y);
      if (git) sidebar.drawGitTooltip(w, git, width, height, pointer.x, pointer.y);
      else {
        const agent = sidebar.agentAt(side, u.agents, pointer.x, pointer.y);
        if (agent) subagentTooltip.draw(w, u.conversations, agent, width, height, pointer.x, pointer.y);
      }
    }
  }
  if (u.copy_feedback && width >= 27 && height >= 5) {
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
  if (u.scope_menu) u.scope_menu.draw(w, side, width, height, u.workspaces, u.prefs.agents as Scope);
  if (u.agent_launcher) u.agent_launcher.draw(w, width, height, side);
  if (u.corgi_setup) u.corgi_setup.draw(w, u.inference, u.prefs, width, height);
  side.searchCursor(w);
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
export function drawDividers(w: Writer, view: LayoutView, area: Rect): void {
  const borders: Border[] = view.borders(area);
  let focused = new Rect();
  for (const place of view.placements(area))
    if (place.id === view.selection.tabs[view.selection.active].focus) focused = place.rect;
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
