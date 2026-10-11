import { expect, test } from "bun:test";
import {
  frame,
  ui,
  tabStart,
  maxTabStart,
  revealTab,
  tabThumb,
  track_rule,
  thumb_rule,
  tabDrop,
  drawDividers,
  drawGhost,
  divider_focused,
  drawRestoring,
  shellUnits,
  commandLines,
  drawPrefixBar,
  type Pointer,
  type Restoring,
} from "./render";
import { Model, Selection, View, Rect, type Axis } from "./layout";
import * as palette from "./palette";
import * as sidebar from "./sidebar";
import * as resourceTooltip from "./resource_tooltip";
import * as corgiBadge from "./corgi_badge";
import { TabMenu } from "./commands";
import { Menu as LauncherMenu } from "./agent_launcher";
import { Writer } from "./text";
import type { Prefix } from "./keymap";

function emptyView() {
  return new View(new Model(), new Selection());
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test("unread pointer follows the clickable workspace and respects overlays", () => {
  const view = emptyView();
  const workspaces = [
    sidebar.workspaceEntry({ id: 1, name: "Read", cwd: "/tmp", active: true }),
    sidebar.workspaceEntry({ id: 2, name: "Unread", cwd: "/tmp", active: false, unread: 2 }),
  ];
  const side = sidebar.View.init(100, 30, true, 0, 0).withWorkspaces(workspaces.length, 0);
  const range = side.unreadRange(workspaces[1]);
  for (const c of [
    { x: range.start, y: 6, open: true, hand: true },
    { x: range.end - 1, y: 6, open: true, hand: true },
    { x: range.end, y: 6, open: true, hand: false },
    { x: range.start, y: 3, open: true, hand: false },
    { x: range.start, y: 6, open: false, hand: false },
  ]) {
    const output = frame(
      view,
      [],
      100,
      30,
      ui({ pointer: { x: c.x, y: c.y }, message: "", copy_mode: false, workspaces, sidebar_open: c.open }),
    );
    expect(output).toContain(c.hand ? "\x1b]22;pointer\x1b\\" : "\x1b]22;default\x1b\\");
  }
});

test("the agent under the pointer takes the hover tint until the pointer leaves it", () => {
  const view = emptyView();
  const entries = [
    sidebar.entry({ target: { pane: 1 }, name: "api refactor", provider: "codex", state: "idle", attention: "none" }),
    sidebar.entry({ target: { pane: 2 }, name: "release notes", provider: "claude", state: "idle", attention: "none" }),
  ];
  const tint = palette.bgRgb(palette.mix(palette.colors.bg, palette.colors.selected, 50));
  const top = sidebar.View.init(100, 30, true, 0, entries.length).middle() + 2;
  const cases: { pointer: Pointer | null; tinted?: number; scope_menu?: boolean; drag?: boolean }[] = [
    { pointer: { x: 5, y: top }, tinted: top },
    { pointer: { x: 20, y: top + 3 }, tinted: top + 2 },
    { pointer: { x: 0, y: top } },
    { pointer: { x: 60, y: top } },
    { pointer: null },
    { pointer: { x: 5, y: top }, scope_menu: true },
    { pointer: { x: 5, y: top + 2 }, drag: true },
  ];
  for (const c of cases) {
    const output = frame(
      view,
      [],
      100,
      30,
      ui({
        pointer: c.pointer,
        message: "",
        copy_mode: false,
        agents: entries,
        scope_menu: c.scope_menu ? new sidebar.ScopeMenu() : null,
        dragged_agent: c.drag ? new sidebar.Preview(0, 0) : null,
      }),
    );
    if (c.tinted !== undefined) {
      expect(count(output, tint)).toBe(2);
      for (const row of [0, 1]) expect(output).toContain(`\x1b[${c.tinted + row + 1};2H\x1b[0m${tint}`);
    } else expect(output).not.toContain(tint);
  }
});

test("resource card points only at its sortable column headers", () => {
  const view = emptyView();
  const workspaces = [sidebar.workspaceEntry({ id: 1, name: "Busy", cwd: "/tmp", active: true })];
  const side = sidebar.View.init(100, 30, true, 0, 0).withWorkspaces(workspaces.length, 0);
  const rect = resourceTooltip.geometry(100, 30, side.width, 2)!;
  const header = rect.y + 14;
  for (const c of [
    { x: rect.x + rect.w - 32, y: header, hand: true },
    { x: rect.x + rect.w - 20, y: header, hand: true },
    { x: rect.x + rect.w - 3, y: header, hand: true },
    { x: rect.x + rect.w - 33, y: header, hand: false },
    { x: rect.x + rect.w - 2, y: header, hand: false },
    { x: rect.x + rect.w - 20, y: header + 1, hand: false },
  ]) {
    const output = frame(
      view,
      [],
      100,
      30,
      ui({
        pointer: { x: c.x, y: c.y },
        link_tooltip: true,
        resource_card: new resourceTooltip.State({ workspace: workspaces[0].id, anchor: 2 }),
        message: "",
        copy_mode: false,
        workspaces,
      }),
    );
    expect(output).toContain("TOP PROCESSES");
    expect(output).toContain(c.hand ? "\x1b]22;pointer\x1b\\" : "\x1b]22;default\x1b\\");
  }
});

test("dividers and the sidebar edge show resize pointers", () => {
  const m = new Model();
  const selection = new Selection();
  const view = new View(m, selection);
  const left = m.newTab("");
  m.split(left, "horizontal");
  m.split(left, "vertical");
  selection.reconcile(m);
  const cases: { x: number; y: number; shape: string; resizing?: Axis; menu?: boolean; iterm2?: boolean }[] = [
    { x: 63, y: 5, shape: "ew-resize" },
    { x: 40, y: 15, shape: "ns-resize" },
    { x: 27, y: 12, shape: "ew-resize" },
    { x: 50, y: 5, shape: "default" },
    // A frame edge is not a divider.
    { x: 99, y: 5, shape: "default" },
    // A drag keeps its pointer after leaving the one-cell divider.
    { x: 50, y: 5, resizing: "vertical", shape: "ns-resize" },
    { x: 63, y: 5, menu: true, shape: "default" },
    { x: 40, y: 15, iterm2: true, shape: "sb_v_double_arrow" },
  ];
  for (const c of cases) {
    const output = frame(
      view,
      [],
      100,
      30,
      ui({
        pointer: { x: c.x, y: c.y },
        iterm2_pointer: c.iterm2 === true,
        resizing: c.resizing ?? null,
        tab_menu: c.menu ? new TabMenu({ tab: m.tabs[0].id, anchor_x: 0 }) : null,
        message: "",
        copy_mode: false,
      }),
    );
    expect(output).toContain(`\x1b]22;${c.shape}\x1b\\`);
  }
});

test("tab drop slots follow midpoints and clipped visible tabs", () => {
  const m = new Model();
  const selection = new Selection();
  const view = new View(m, selection);
  m.newTab("one");
  m.newTab("two");
  m.newTab("three");
  selection.reconcile(m);
  selection.active = 2;
  selection.offset = 2;
  expect(tabDrop(view, 40, 4)!.index).toBe(0);
  expect(tabDrop(view, 40, 5)!.index).toBe(1);
  expect(tabDrop(view, 40, 35)!.index).toBe(3);
  // Scrolled to the end, only tab three fits: the left gap is before it, not tab one.
  expect(tabDrop(view, 13, 0)!.index).toBe(2);
  expect(tabDrop(view, 13, 12)!.index).toBe(3);
  expect(tabDrop(view, 13, 12)!.x).toBe(9);
  expect(tabDrop(view, 13, 13)).toBeNull();
  expect(tabDrop(view, 3, 0)).toBeNull();
});

test("the tab bar scrolls by whole tabs and reveals a tab with the smallest change", () => {
  const m = new Model();
  const selection = new Selection();
  const view = new View(m, selection);
  for (let i = 0; i < 6; i++) m.newTab("");
  selection.reconcile(m);
  // Forty columns fit four ten-column tabs.
  expect(maxTabStart(view, 40)).toBe(2);
  expect(tabStart(view, 40)).toBe(0);
  expect(revealTab(view, 40, 3)).toBe(0);
  expect(revealTab(view, 40, 4)).toBe(1);
  expect(revealTab(view, 40, 5)).toBe(2);
  selection.offset = 9;
  expect(tabStart(view, 40)).toBe(2);
  expect(revealTab(view, 40, 3)).toBe(2);
  expect(revealTab(view, 40, 1)).toBe(1);
  expect(maxTabStart(view, 60)).toBe(0);
  // A tab wider than the bar shows alone.
  expect(maxTabStart(view, 5)).toBe(5);
  expect(revealTab(view, 5, 4)).toBe(4);
});

test("the tab bar underlines its scrollbar only while hovered and overflowing", () => {
  const m = new Model();
  const selection = new Selection();
  const view = new View(m, selection);
  for (let i = 0; i < 4; i++) m.newTab("");
  selection.reconcile(m);
  expect(tabThumb(view, 43)).toBeNull();
  const hover = () => ui({ sidebar_open: false, pointer: { x: 5, y: 0 }, message: "", copy_mode: false });
  const fits = frame(view, [], 43, 10, hover());
  expect(fits).not.toContain(track_rule);
  expect(fits).not.toContain(thumb_rule);
  for (let i = 0; i < 2; i++) m.newTab("");
  selection.reconcile(m);
  expect(tabThumb(view, 43)).toEqual({ start: 0, len: 6 });
  selection.offset = 1;
  expect(tabThumb(view, 43)).toEqual({ start: 17, len: 6 });
  selection.offset = 2;
  expect(tabThumb(view, 43)).toEqual({ start: 34, len: 6 });
  selection.offset = 0;
  // The knob starts the first tab; the dotted track runs on under all four.
  const hovered = frame(view, [], 43, 10, hover());
  expect(count(hovered, thumb_rule)).toBe(1);
  expect(count(hovered, track_rule)).toBe(4);
  // Off the tab row, with no pointer, or under a menu, it hides.
  for (const c of [
    ui({ sidebar_open: false, pointer: { x: 5, y: 1 }, message: "", copy_mode: false }),
    ui({ sidebar_open: false, message: "", copy_mode: false }),
    ui({
      sidebar_open: false,
      pointer: { x: 5, y: 0 },
      tab_menu: new TabMenu({ tab: m.tabs[0].id, anchor_x: 0 }),
      message: "",
      copy_mode: false,
    }),
  ]) {
    const plain = frame(view, [], 43, 10, c);
    expect(plain).not.toContain(track_rule);
    expect(plain).not.toContain(thumb_rule);
  }
});

interface TestCell {
  glyph: string | null;
  highlighted: boolean;
}
/** The cells drawDividers paints on a 100x30 screen. */
function testDividerCells(view: View, area: Rect): TestCell[][] {
  const out = new Writer();
  drawDividers(out, view, area);
  const cells: TestCell[][] = Array.from({ length: 30 }, () =>
    Array.from({ length: 100 }, () => ({ glyph: null, highlighted: false })),
  );
  let x = 0;
  let y = 0;
  let highlighted = false;
  let rest = out.buffered();
  while (rest.length > 0) {
    if (rest[0] === "\x1b") {
      const end = rest.search(/[Hm]/);
      const params = rest.slice(2, end);
      if (rest[end] === "H") {
        const [row, col] = params.split(";");
        y = Number(row) - 1;
        x = Number(col) - 1;
      } else highlighted = params === divider_focused.slice(2, -1);
      rest = rest.slice(end + 1);
      continue;
    }
    const ch = String.fromCodePoint(rest.codePointAt(0)!);
    cells[y][x] = { glyph: ch, highlighted };
    x += 1;
    rest = rest.slice(ch.length);
  }
  return cells;
}
function expectOutline(cells: TestCell[][], highlighted: [number, number][], plain: [number, number][]) {
  for (const [points, expected] of [
    [highlighted, true],
    [plain, false],
  ] as const)
    for (const [x, y] of points) {
      expect(cells[y][x].glyph).not.toBeNull();
      expect(cells[y][x].highlighted).toBe(expected);
    }
}

test("focus outline includes the outer edges and corners of the focused pane", () => {
  const area = new Rect(28, 1, 72, 29);
  const m = new Model();
  const selection = new Selection();
  const view = new View(m, selection);
  const left = m.newTab("");
  const right = m.split(left, "horizontal");
  selection.reconcile(m);
  selection.focus(m, left);
  let cells = testDividerCells(view, area);
  expectOutline(
    cells,
    [
      [28, 1],
      [40, 1],
      [40, 29],
      [28, 10],
      [63, 10],
      [63, 1],
      [63, 29],
    ],
    [
      [90, 1],
      [99, 10],
    ],
  );
  expect(cells[1][28].glyph).toBe("┌");
  expect(cells[29][28].glyph).toBe("└");
  expect(cells[1][63].glyph).toBe("┬");
  const split = view.placements(area);
  expect(split[0].rect).toEqual(new Rect(29, 2, 34, 27));
  expect(split[1].rect).toEqual(new Rect(64, 2, 35, 27));

  selection.focus(m, right);
  cells = testDividerCells(view, area);
  expectOutline(
    cells,
    [
      [99, 1],
      [90, 1],
      [90, 29],
      [99, 10],
      [63, 10],
    ],
    [[28, 10]],
  );
  // The outer frame is not a divider, so pressing it starts no drag.
  expect(view.dividerAt(area, 89, 1)).toBeNull();
  selection.tab().zoom = true;
  expect(view.placements(area)[0].rect).toEqual(area);
  cells = testDividerCells(view, area);
  expect(cells[1][99].glyph).toBeNull();
});

test("focus outline follows stacked and nested splits", () => {
  const area = new Rect(28, 1, 72, 29);
  const m = new Model();
  const selection = new Selection();
  const view = new View(m, selection);
  const top = m.newTab("");
  const bottom = m.split(top, "vertical");
  selection.reconcile(m);
  selection.focus(m, bottom);
  let cells = testDividerCells(view, area);
  expectOutline(
    cells,
    [
      [28, 20],
      [99, 20],
      [50, 29],
      [50, 15],
    ],
    [
      [50, 1],
      [28, 5],
    ],
  );
  const right = m.split(bottom, "horizontal");
  selection.reconcile(m);
  selection.focus(m, right);
  cells = testDividerCells(view, area);
  expectOutline(
    cells,
    [
      [99, 20],
      [90, 29],
      [90, 15],
      [63, 20],
      [63, 15],
    ],
    [
      [40, 29],
      [28, 20],
    ],
  );
});

/** Whether `bytes` moves the cursor to `position` and writes `text` there,
 * after any styles. */
function testDrawsAt(bytes: string, position: string, text: string): boolean {
  let from = 0;
  while (true) {
    const at = bytes.indexOf(position, from);
    if (at < 0) return false;
    const rest = bytes.slice(at + position.length).replace(/^(?:\x1b\[[0-9;:]*m)*/, "");
    if (rest.startsWith(text)) return true;
    from = at + 1;
  }
}

test("badge redraw preserves cached pixels and shifts only the workspace heading", () => {
  const view = emptyView();
  const u = ui({ message: "", copy_mode: false, corgi_badge: "image" });
  const shown = frame(view, [], 100, 30, u);
  expect(shown).not.toContain("\x1b[2J");
  expect(shown).toContain("\x1b[H\x1b[J");
  expect(shown).toContain("a=p,i=730031");
  expect(shown).not.toContain("a=t,");
  expect(testDrawsAt(shown, "\x1b[1;7H", "workspaces")).toBe(true);
  u.pointer = { x: 2, y: 0 };
  u.link_tooltip = true;
  const usage_popup = frame(view, [], 100, 30, u);
  expect(usage_popup).toContain("Observed tokens");
  expect(usage_popup).not.toContain("Since Corgi started");
  expect(usage_popup).toContain("— tokens");
  u.link_tooltip = false;
  u.agent_launcher = new LauncherMenu({ workspace: 1, selected: "codex", last: "codex", pinned: true });
  const popup = frame(view, [], 100, 30, u);
  expect(popup).toContain("New agent");
  expect(popup).toContain("a=p,i=730031");
  expect(popup).not.toContain("a=t,");
  u.agent_launcher = null;
  // The scope menu opens below the workspaces, clear of the badge.
  u.scope_menu = new sidebar.ScopeMenu();
  const scope = frame(view, [], 100, 30, u);
  expect(scope).toContain("This workspace");
  expect(scope).toContain("a=p,i=730031");
  u.scope_menu = null;
  // A context menu leaves the badge up unless it opens over it.
  u.tab_menu = new TabMenu({ pane: true, tab: 1, anchor_x: 50, anchor_y: 10 });
  expect(frame(view, [], 100, 30, u)).toContain("a=p,i=730031");
  u.tab_menu = new TabMenu({ workspace: true, tab: 1, anchor_x: 2, anchor_y: 1 });
  const covered = frame(view, [], 100, 30, u);
  expect(covered).toContain(corgiBadge.hide);
  expect(covered).not.toContain("a=p,i=730031");
  u.tab_menu = null;
  u.sidebar_open = false;
  const hidden = frame(view, [], 100, 30, u);
  expect(hidden).toContain(corgiBadge.hide);
  expect(hidden).not.toContain("a=p,i=730031");
  u.sidebar_open = true;
  u.corgi_badge = "emoji";
  const emoji = frame(view, [], 100, 30, u);
  expect(emoji).toContain(corgiBadge.emoji);
  expect(emoji).not.toContain("\x1b_G");
  expect(testDrawsAt(emoji, "\x1b[1;7H", "workspaces")).toBe(true);
});

test("a reopened agent's card sits mid-pane: title centered, details left, command wrapped", () => {
  const band: Restoring = {
    command: "claude --dangerously-skip-permissions --resume '4ee5c02d-691c-4045-8744-930f330494fd'",
    name: "corgi menu work",
    meta: "claude · Opus 4.7 · ~/dev/corgi",
    dig: "restoring",
  };
  let out = new Writer();
  drawRestoring(out, new Rect(0, 0, 80, 24), band, 3000);
  const drawn = out.buffered();
  const border = new palette.Style({ fg: "line", bg: "surface" }).sgr();
  // A 64-column box, ten rows tall, in the middle of the pane.
  expect(drawn).toContain("\x1b[8;9H" + border + "╭");
  expect(drawn).toContain("\x1b[17;9H" + border + "╰");
  // The title centered, the corgi's scene before it.
  expect(drawn).toContain("\x1b[10;19H");
  expect(drawn).toContain(palette.fg("accent") + "Restoring…");
  // The details from the box's left padding.
  expect(drawn).toContain(
    "\x1b[12;12H" + new palette.Style({ fg: "strong", bg: "surface", bold: true }).sgr() + "corgi menu work",
  );
  expect(drawn).toContain(
    "\x1b[13;12H" + new palette.Style({ fg: "muted", bg: "surface" }).sgr() + "claude · Opus 4.7 · ~/dev/corgi",
  );
  expect(drawn).toContain(
    "$ " + new palette.Style({ fg: "faint", bg: "surface" }).sgr() + "claude --dangerously-skip-permissions \\",
  );
  expect(drawn).toContain(
    "\x1b[15;12H" +
      new palette.Style({ fg: "faint", bg: "surface" }).sgr() +
      "    --resume '4ee5c02d-691c-4045-8744-930f330494fd'",
  );

  // A small pane keeps the title, alone, and drops the details.
  out = new Writer();
  drawRestoring(out, new Rect(0, 0, 40, 6), band, 3000);
  expect(out.buffered()).toContain("Restoring…");
  expect(out.buffered()).not.toContain("corgi menu work");
  expect(out.buffered()).not.toContain("o›");

  // A fork's card says so.
  out = new Writer();
  drawRestoring(out, new Rect(0, 0, 80, 24), { ...band, dig: "forking" }, 3000);
  expect(out.buffered()).toContain(palette.fg("accent") + "Forking…");

  // A dormant agent's corgi sleeps until its pane is clicked, in the same card.
  out = new Writer();
  drawRestoring(out, new Rect(0, 0, 80, 24), { ...band, dig: "asleep" }, 3000);
  const asleep = out.buffered();
  expect(asleep).toContain("\x1b[17;9H" + border + "╰");
  expect(asleep).toContain("~ᐯ◡ᴥ◡ᐯ");
  expect(asleep).toContain(palette.fg("accent") + "Click to resume");
  expect(asleep).not.toContain("Restoring…");
});

test("a command wraps between its words, each flag kept with its value", () => {
  const units = shellUnits("CLAUDE_CONFIG_DIR=~/.w claude --model opus --resume 'it'\\''s' --fork-session");
  expect(units).toEqual(["CLAUDE_CONFIG_DIR=~/.w", "claude", "--model opus", "--resume 'it'\\''s'", "--fork-session"]);
  // "$ CLAUDE_CONFIG_DIR=~/.w claude --model opus \\", then indented lines.
  const lines = commandLines(units, 46);
  expect(lines).toEqual([
    { first: 0, count: 3 },
    { first: 3, count: 2 },
  ]);
  expect(commandLines(units, 200).length).toBe(1);
});

/** The text `bytes` shows, without its escape sequences. */
function testVisible(bytes: string): string {
  return bytes.replace(/\x1b\][^\x1b]*\x1b\\|\x1b[^\]][\x20-\x3f]*[\x40-\x7e]/g, "");
}

test("the prefix bar spans the pane area's bottom row and drops hints that do not fit", () => {
  const cases: { width: number; prefix?: Prefix; text: string }[] = [
    { width: 60, text: " PREFIX  Esc cancel  Ctrl+B send prefix  ? shortcuts        " },
    { width: 60, prefix: "ctrl_a", text: " PREFIX  Esc cancel  Ctrl+A send prefix  ? shortcuts        " },
    { width: 40, text: " PREFIX  Esc cancel  ? shortcuts        " },
    { width: 25, text: " PREFIX  ? shortcuts     " },
    { width: 12, text: " PREFIX     " },
    { width: 5, text: " PREF" },
  ];
  for (const c of cases) {
    const out = new Writer();
    drawPrefixBar(out, new Rect(30, 1, c.width, 20), "corgi", c.prefix ?? "ctrl_b");
    expect(out.buffered().startsWith("\x1b[21;31H")).toBe(true);
    expect(testVisible(out.buffered())).toBe(c.text);
  }
});

test("a ghost dims the bottom half of the pane area, each row where entering leaves it", () => {
  const area = new Rect(28, 1, 72, 20),
    rect = new Rect(29, 2, 70, 18);
  const pane: any = {
    id: 3,
    label: "",
    agent: { name: "release notes", provider: "claude" },
    terminal: {
      updateRender() {},
      rows: (_id: number, x: number, y: number, _w: number, h: number, dimmed: boolean) =>
        Array.from({ length: h }, (_, row) => `\x1b[${y + row + 1};${x + 1}H${dimmed ? "dim" : ""}row${row}`).join(""),
    },
  };
  const out = new Writer();
  drawGhost(out, { pane, rect, area });
  const text = out.buffered();
  // The cut is row 11: rows above it stay as they were.
  expect(text).not.toContain("row8");
  expect(text).toContain("\x1b[12;30Hdimrow9");
  expect(text).toContain("\x1b[20;30Hdimrow17");
  expect(text).toContain("\x1b[11;29H");
  expect(text).toContain("┄┄ release notes ┄");
});
