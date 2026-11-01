// Mirrors the tests in sidebar.zig.
import { expect, test } from "bun:test";
import * as i18n from "./i18n";
import * as palette from "./palette";
import { Style, colors, fg, fgRgb, bgRgb, mix, underline } from "./palette";
import * as corgiAnimation from "./corgi_animation";
import * as corgiFrames from "./corgi_frames";
import { Terminal } from "./pane/terminal";
import { View as ContextView } from "./usage/context_window";
import * as sim from "./providers/sim";
import * as agentSections from "./agent_sections";
import * as sidebarRows from "./sidebar_rows";
import { section } from "./agent_order";
import { Writer, displayWidth, writeClipped, directoryLabel } from "./text";
import {
  View,
  entry,
  animationKey,
  groupEnd,
  workspaceEntry,
  work,
  drawResources,
  resourceAt,
  agentAt,
  writeExit,
  writeRevealedDetail,
  linkRange,
  portLabel,
  portLink,
  portName,
  portWorkspace,
  writePortLabel,
  drawPorts,
  PortMenu,
  ScopeMenu,
  gitWorkspace,
  relativeTime,
  elapsed,
  panel,
  active_name,
  active_meta,
  active_bar,
  ghost_bar,
  rule_underline,
  dotted_underline,
  lists_x,
  spotlight_dim,
  unlit,
  nap_fg,
  hover_rgb,
  hover_bg,
  type Entry,
  type WorkspaceEntry,
  type Hit,
  type RenameState,
  drawGitTooltip,
} from "./sidebar";
import { Dialog } from "./name_dialog";
import type { RenameTarget } from "./inline_rename";

const selected_bg = palette.bg("selected");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const has = (haystack: string, needle: string) => haystack.includes(needle);
const draw = (view: View, entries: Entry[], workspaces: WorkspaceEntry[], now?: number) => {
  const w = new Writer();
  if (now === undefined) view.draw(w, entries, workspaces);
  else view.drawAt(w, entries, workspaces, now);
  return w.buffered();
};
const shifted = (bytes: string, columns: number) =>
  bytes.replace(/\x1b\[(\d+);(\d+)H/g, (_, row, column) => `\x1b[${row};${Number(column) + columns}H`);
/** The previous framing boundary: render a local list, then rewrite its CUPs. */
function bufferedSidebar(view: View, entries: Entry[], workspaces: WorkspaceEntry[], now: number): string {
  const writer = new Writer(),
    lists = new Writer();
  for (let row = 0; row < view.rows; row++) writer.write(`\x1b[${row + 1};1H${panel}` + " ".repeat(lists_x));
  view.lists().drawAt(lists, entries, workspaces, now);
  writer.write(shifted(lists.s, lists_x));
  // Keep the outer box identical while exercising the replaced boundary independently.
  (view as unknown as { drawBox(writer: Writer): void }).drawBox(writer);
  const badges = new Writer();
  (view.lists() as unknown as { drawBadges(writer: Writer): void }).drawBadges(badges);
  writer.write(shifted(badges.s, lists_x));
  return writer.s;
}

function hostText(bytes: string, cols = 100, rows = 30): string {
  const host = new Terminal(cols, rows);
  host.feed(bytes);
  const text = host.text();
  host.destroy();
  return text;
}
const H = (tag: string, value?: number): Hit =>
  value === undefined ? ({ tag } as Hit) : ({ tag, [tag]: value } as Hit);
const hot = work({ id: 1, known: true, cpu: 182, memory: 3n * 2n ** 30n, read: 0n, written: 0n, cpu_pressure: true });

test("resource row omits unavailable metrics and I/O, and preserves real zeros", () => {
  const view = View.init(100, 30, true, 0, 0);
  let w = new Writer();
  drawResources(w, work({ id: 1 }), view, false, false);
  expect(has(w.s, "--")).toBe(false);
  expect(has(w.s, "C")).toBe(false);
  expect(has(w.s, "M")).toBe(false);
  expect(has(w.s, "↕")).toBe(false);
  expect(has(w.s, "›")).toBe(false);
  w = new Writer();
  drawResources(w, work({ id: 1, known: true, cpu: 0, memory: 0n, read: 0n, written: 0n }), view, false, false);
  expect(has(w.s, "CPU 0%")).toBe(true);
  expect(has(w.s, "Memory 0M")).toBe(true);
  expect(has(w.s, "›")).toBe(true);
  w = new Writer();
  drawResources(
    w,
    work({ id: 1, known: true, cpu: 0, memory: 0n, read: 3_000_000n, written: 1_000_000n }),
    view,
    false,
    false,
  );
  expect(has(w.s, "↕")).toBe(false);
  expect(has(w.s, "M/s")).toBe(false);
});

test("resource readings turn off as a whole", () => {
  let view = View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
  let w = new Writer();
  drawResources(w, hot, view, false, false);
  expect(has(w.s, "CPU 182%")).toBe(true);
  expect(has(w.s, "Memory 3.0G")).toBe(true);
  expect(has(w.s, "\x1b[22m" + fg("warm") + "CPU")).toBe(true);
  // Narrower sidebars shorten labels rather than clipping values.
  w = new Writer();
  drawResources(w, hot, view.withWidth(26), false, false);
  expect(has(w.s, "CPU 182%")).toBe(true);
  expect(has(w.s, "Mem 3.0G")).toBe(true);
  expect(has(w.s, "Memory")).toBe(false);
  w = new Writer();
  drawResources(w, hot, view.withWidth(20), false, false);
  expect(has(w.s, "C 182%")).toBe(true);
  expect(has(w.s, "M 3.0G")).toBe(true);
  expect(has(w.s, "Mem")).toBe(false);
  w = new Writer();
  view.resources = { enabled: false };
  drawResources(w, hot, view, false, false);
  expect(has(w.s, "C")).toBe(false);
  view.resources = { enabled: true };
  const entries = [workspaceEntry({ id: 1, name: "a", cwd: "", active: true, resources: hot })];
  expect(resourceAt(view, entries, 3, 4)).not.toBeNull();
  let quiet = view.clone();
  quiet.rows = 20;
  expect(resourceAt(quiet, entries, 3, 4)).toBeNull();
  quiet = view.clone();
  quiet.resources = { enabled: false };
  expect(resourceAt(quiet, entries, 3, 4)).toBeNull();
});

test("readings off removes the resource row and moves the separator under the status", () => {
  let view = View.init(100, 30, true, 0, 0);
  view.resources = { enabled: false };
  const paged = view.withWorkspaces(8, 99);
  expect(paged.workspaceCapacity()).toBe(5);
  expect(paged.workspace_offset).toBe(3);
  expect(paged.hit(24, 2)).toEqual(H("workspace", 3));
  expect(paged.hit(24, 3)).toEqual(H("workspace", 3));
  expect(paged.hit(24, 4)).toEqual(H("workspace", 4));
  expect(paged.hit(24, 11)).toEqual(H("workspace", 7));
  expect(paged.hit(24, 12)).toEqual(H("none"));
  expect(paged.workspaceDrop(5, 4)!.index).toBe(4);
  const entries = [
    workspaceEntry({
      id: 1,
      name: "first",
      cwd: "",
      active: false,
      resources: hot,
      stats: { tools: 12, input: 0, output: 0, tokens_known: false },
    }),
    workspaceEntry({ id: 2, name: "second", cwd: "", active: true, resources: hot }),
  ];
  view = view.withWorkspaces(entries.length, 0);
  const frame = draw(view, [], entries);
  expect(has(frame, "182%")).toBe(false);
  expect(has(frame, "\x1b[4;3H" + panel + rule_underline)).toBe(true);
  expect(has(frame, rule_underline + "⚒12")).toBe(true);
  expect(has(frame, "\x1b[5;3H" + active_name + "second")).toBe(true);
  // The last workspace has no separator.
  expect(has(frame, "\x1b[6;3H" + active_meta + "\x1b[4;")).toBe(false);
  expect(resourceAt(view, entries, 3, 4)).toBeNull();
});

test("directory labels keep path boundaries, Unicode and terminal safety", () => {
  expect(directoryLabel("/home/tal/dev/corgi", "/home/tal", 256)).toBe("~/dev/corgi");
  expect(directoryLabel("/home/tally", "/home/tal", 256)).toBe("/home/tally");
  expect(directoryLabel("/home/tal/项目", "/home/tal", 256)).toBe("~/项目");
  expect(directoryLabel("/tmp/\x1b[2J\noops", null, 256)).toBe("/tmp/?[2J?oops");
  const w = new Writer();
  writeClipped(w, "ab项目", 5);
  expect(w.s).toBe("ab项");
});

test("all three workspace rows select while bottom controls remain distinct", () => {
  const view = View.init(100, 30, true, 0, 0).withWorkspaces(2, 0);
  expect(view.hit(24, 2)).toEqual(H("workspace", 0));
  expect(view.hit(24, 3)).toEqual(H("workspace", 0));
  expect(view.hit(24, 4)).toEqual(H("workspace", 0));
  expect(view.hit(24, 5)).toEqual(H("workspace", 1));
  expect(view.hit(24, 6)).toEqual(H("workspace", 1));
  expect(view.hit(24, 7)).toEqual(H("workspace", 1));
  expect(view.hit(2, 12)).toEqual(H("none"));
  expect(view.hit(2, 13)).toEqual(H("none"));
  expect(view.hit(17, 0)).toEqual(H("workspace_new"));
  expect(view.hit(21, 0)).toEqual(H("workspace_new"));
  expect(view.hit(22, 0)).toEqual(H("none"));
  expect(view.hit(23, 0)).toEqual(H("toggle"));
  expect(View.init(100, 12, true, 0, 0).width).toBe(0);
  const compact = View.init(100, 13, true, 0, 0).withWorkspaces(2, 0);
  expect(compact.hit(24, 3)).toEqual(H("workspace", 0));
  expect(compact.hit(24, 4)).toEqual(H("workspace", 0));
  expect(compact.hit(24, 5)).toEqual(H("none"));
  const paged = view.withWorkspaces(8, 99);
  expect(paged.workspaceCapacity()).toBe(4);
  expect(paged.workspace_offset).toBe(4);
  expect(paged.hit(24, 9)).toEqual(H("workspace", 6));
  expect(paged.hit(24, 12)).toEqual(H("workspace", 7));
  expect(paged.workspaceThumb()).toEqual({ start: 6, len: 5 });
  expect(paged.withWorkspaces(8, 0).workspaceThumb()).toEqual({ start: 0, len: 5 });
  expect(view.withWorkspaces(4, 0).workspaceThumb()).toBeNull();
  expect(draw(paged, [], [], 0)).not.toContain(" <  > ");
});

test("unpushed badge retains its columns beside a long workspace name", () => {
  const view = View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
  const out = draw(
    view,
    [],
    [workspaceEntry({ id: 1, name: "abcdefghijklmnopqrstuvwxyz", cwd: "/tmp", active: true, git_ahead: 123 })],
  );
  expect(has(out, "abcdefghijklmnopqrs")).toBe(true);
  expect(has(out, "abcdefghijklmnopqrst")).toBe(false);
  expect(has(out, "\x1b[3;23H" + fg("warm") + "↑123")).toBe(true);
});

test("active workspace bar is a half block with or without Kitty graphics", () => {
  const entries = [
    workspaceEntry({ id: 1, name: "Other", cwd: "/tmp", active: false }),
    workspaceEntry({ id: 2, name: "Project", cwd: "/tmp", active: true }),
  ];
  for (const supported of [true, false]) {
    const view = View.init(100, 30, true, 0, 0).withWorkspaces(entries.length, 0);
    view.supports_kitty_graphics = supported;
    const out = draw(view, [], entries);
    for (const row of ["\x1b[6;2H", "\x1b[7;2H", "\x1b[8;2H"]) expect(has(out, row + active_bar)).toBe(true);
    expect(has(out, "\x1b[3;2H" + active_bar)).toBe(false);
    expect(has(out, active_name + "Project")).toBe(true);
  }
});

test("a dragged workspace takes the selected tint and a strong bar", () => {
  const entries = [
    workspaceEntry({ id: 1, name: "Other", cwd: "/tmp", active: false }),
    workspaceEntry({ id: 2, name: "Project", cwd: "/tmp", active: true }),
  ];
  const view = View.init(100, 30, true, 0, 0).withWorkspaces(entries.length, 0);
  view.dragged_workspace = 0;
  const out = draw(view, [], entries);
  expect(has(out, active_name + "Other")).toBe(true);
  for (const row of ["\x1b[3;2H", "\x1b[4;2H", "\x1b[5;2H"]) expect(has(out, row + ghost_bar)).toBe(true);
  expect(has(out, "\x1b[6;2H" + active_bar)).toBe(true);
});

test("unnamed agent rows show the provider name and keep explicit session names", () => {
  const entries = [
    entry({ target: { pane: 1 }, provider: "opencode2", state: "idle" }),
    entry({ target: { pane: 2 }, provider: "opencode2", name: "Align UI elements", state: "idle" }),
  ];
  const view = View.init(100, 30, true, 0, entries.length).withEntries(entries);
  const out = hostText(draw(view, entries, []));
  expect(out).toContain("OpenCode");
  expect(out).toContain("Align UI elements");
  expect(out).not.toContain("opencode2");
});

test("agent rows take the workspace bars: active when focused outside groups, strong when dragged", () => {
  const group = entry({
    target: { group: 1 },
    name: "corgi",
    provider: "codex",
    state: "idle",
    group: { agents: 2, working: 0, attention: 0, folded: false, current: true },
  });
  const agents_only = [
    entry({ target: { pane: 1 }, name: "api refactor", provider: "codex", state: "idle", focused: true }),
    entry({ target: { pane: 2 }, name: "release notes", provider: "claude", state: "idle" }),
  ];
  const grouped = [group, ...agents_only];
  let view = View.init(100, 30, true, 0, agents_only.length).withEntries(agents_only);
  for (const dragged of [null, 1]) {
    view.dragged = dragged;
    const out = draw(view, agents_only, []);
    for (let row = 0; row < 4; row++) {
      expect(has(out, `\x1b[${view.middle() + 3 + row};2H${active_bar}`)).toBe(row < 2);
      expect(has(out, `\x1b[${view.middle() + 3 + row};2H${ghost_bar}`)).toBe(dragged !== null && row >= 2);
    }
  }
  view.dragged = null;
  view = view.withEntries(grouped);
  expect(has(draw(view, grouped, []), active_bar)).toBe(false);
});

test("a hovered agent's rows tint halfway to selected, and a selected one keeps its tint", () => {
  const entries = [
    entry({ target: { pane: 1 }, name: "api refactor", provider: "codex", state: "idle" }),
    entry({ target: { pane: 2 }, name: "release notes", provider: "claude", state: "idle" }),
  ];
  const view = View.init(100, 30, true, 0, entries.length).withEntries(entries);
  view.hovered = 0;
  let out = draw(view, entries, []);
  for (let row = 0; row < 4; row++)
    expect(has(out, `\x1b[${view.middle() + 3 + row};2H\x1b[0m` + hover_bg)).toBe(row < 2);
  // The sleeper blends against the tint, not the panel.
  const sleeper = corgiAnimation.idle(6, { background: hover_rgb });
  expect(count(out, sleeper)).toBe(1);
  entries[0].focused = true;
  out = draw(view, entries, []);
  expect(has(out, hover_bg)).toBe(false);
  expect(has(out, "\x1b[0m" + selected_bg)).toBe(true);
});

test("subagent badge shares the second row without reserving empty space", () => {
  const e = entry({
    target: { pane: 1 },
    name: "Long agent title",
    provider: "codex",
    state: "working",
    activity: "abcdefghijklmnopqrstu",
    subagents: { running: 2, blocked: 0, waiting: true },
  });
  for (const width of [20, 28, 40]) {
    const view = View.init(100, 30, true, 0, 1).withWidth(width);
    const out = draw(view, [e], []);
    expect(has(out, `\x1b[18;${width - 3}H` + fg("accent") + "↳2")).toBe(true);
    expect(has(out, "Waiting")).toBe(true);
    expect(view.hit(width - 3, 17)).toEqual(H("entry", 0));
  }
  e.subagents = { running: 0, blocked: 0, waiting: false };
  const out = draw(View.init(100, 30, true, 0, 1), [e], []);
  expect(has(out, "↳")).toBe(false);
  expect(has(out, e.activity)).toBe(true);
});

test("an empty agent list names every provider's command", () => {
  const remove = sim.register();
  try {
    const out = draw(View.init(100, 30, true, 0, 1), [], []);
    expect(has(out, "codex  or  claude\x1b")).toBe(true);
    expect(has(out, "or  sim\x1b")).toBe(true);
  } finally {
    remove();
  }
});

test("an unread agent takes the bold dot and a bold name, and working takes the arrow", () => {
  const e = entry({
    target: { pane: 1 },
    name: "Release notes",
    provider: "codex",
    state: "idle",
    attention: "finished",
  });
  const view = View.init(100, 30, true, 0, 1);
  const lit = "\x1b[1m" + fg("accent");
  let out = draw(view, [e], []);
  expect(has(out, lit + "●")).toBe(true);
  expect(has(out, "\x1b[1m" + fg("strong") + "Release notes")).toBe(true);
  e.state = "working";
  out = draw(view, [e], []);
  expect(has(out, lit + "▶")).toBe(true);
  expect(has(out, "\x1b[22m" + fg("text") + "Release notes")).toBe(true);
});

test("a paused agent takes the pause glyph, green while unread and gray once read", () => {
  const e = entry({
    target: { pane: 1 },
    name: "Squash history",
    provider: "claude",
    state: "idle",
    attention: "finished",
    paused: true,
  });
  const view = View.init(100, 30, true, 0, 1);
  let out = draw(view, [e], []);
  expect(has(out, "\x1b[1m" + fg("accent") + "‖")).toBe(true);
  expect(has(out, "\x1b[1m" + fg("strong") + "Squash history")).toBe(true);
  expect(has(out, "●")).toBe(false);
  expect(has(out, "Paused")).toBe(false);
  e.attention = "none";
  out = draw(view, [e], []);
  expect(has(out, fg("muted") + "‖")).toBe(true);
  expect(has(out, "○")).toBe(false);
  // Only an idle agent shows it.
  e.state = "working";
  out = draw(view, [e], []);
  expect(has(out, "‖")).toBe(false);
});

test("workspace status uses agent colors and keeps usage on its second row", () => {
  const view = View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
  const stats = (tools: number) => ({ tools, input: 0, output: 0, tokens_known: true });
  let out = draw(
    view,
    [],
    [
      workspaceEntry({
        id: 1,
        name: "Project",
        cwd: "/tmp",
        active: false,
        working: 1,
        attention: 2,
        unread: 3,
        stats: stats(12),
      }),
    ],
  );
  expect(has(out, "\x1b[4;3H" + panel + "\x1b[22m\x1b[1m" + fg("accent") + "▶1")).toBe(true);
  expect(has(out, "\x1b[1m" + fg("warm") + " ●2")).toBe(true);
  expect(has(out, "\x1b[1m" + fg("accent") + "3 unread →")).toBe(true);
  expect(has(out, "⚒12")).toBe(true);
  expect(has(out, "\x1b[4;24H" + panel + "⚒12")).toBe(true);
  const empty = workspaceEntry({ id: 1, name: "Project", cwd: "/tmp", active: true });
  out = draw(view, [], [empty]);
  expect(has(out, "unread")).toBe(false);
  expect(has(out, "▶0")).toBe(false);
  expect(has(out, "⚒0")).toBe(false);
  expect(has(out, "\x1b[4;3H" + active_meta + "\x1b[22m" + fg("muted") + "○")).toBe(true);
  expect(has(out, "—")).toBe(false);
  expect(has(out, "\x1b[4;25H" + panel + "⚒0")).toBe(false);
  const away = { ...empty, active: false, stats: stats(1) };
  out = draw(view, [], [away]);
  expect(has(out, "unread")).toBe(false);
  away.working = 1;
  away.attention = 1;
  away.stats = stats(999_000);
  out = draw(view, [], [away]);
  expect(has(out, "unread")).toBe(false);
  expect(has(out, "\x1b[1m" + fg("warm") + " ●1")).toBe(true);
});

test("unread label and arrow share their hit area across sidebar widths", () => {
  const ws = workspaceEntry({
    id: 1,
    name: "Project",
    cwd: "/tmp",
    active: false,
    unread: 3,
    working: 1,
    attention: 2,
  });
  for (const width of [20, 28, 40]) {
    const view = View.init(100, 30, true, 0, 0).withWidth(width).withWorkspaces(1, 0);
    const out = draw(view, [], [ws]);
    const range = view.unreadRange(ws);
    expect(has(out, `\x1b[4;${range.start + 1}H\x1b[22m\x1b[1m` + fg("accent") + "3 unread →")).toBe(true);
    expect(view.unreadHit(ws, range.start, 3)).toBe(true);
    expect(view.unreadHit(ws, range.end - 1, 3)).toBe(true);
    expect(view.unreadHit(ws, range.start - 1, 3)).toBe(false);
    expect(view.unreadHit(ws, range.end, 3)).toBe(false);
    expect(view.unreadHit(ws, range.start, 2)).toBe(false);
  }
  ws.unread = 0;
  const view = View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
  expect(view.unreadHit(ws, view.unreadRange(ws).start, 3)).toBe(false);
});

test("compaction herds on the second agent row ahead of waiting and summaries", () => {
  const e = entry({
    target: { pane: 1 },
    name: "Agent title",
    provider: "codex",
    state: "working",
    compacting: true,
    compacting_since: 1_000_000,
    activity: "Old summary",
    subagents: { running: 0, blocked: 0, waiting: true },
  });
  // Lists 28 columns wide, past the box column.
  const view = View.init(100, 30, true, 0, 1).withWidth(28 + lists_x);
  draw(view, [], [], 0); // Forget herds from earlier draws.
  // The herd starts scattered beside the pile; the corgi pushes it together
  // and curls into the ellipsis, which stays. Then the time taken shows.
  const cases: [number, string][] = [
    [1000, "⣿  C o  mp  a ct  i n  g "],
    [1000 + 12 * 110, "Compacting‹o[/\\]~     "],
    [1000 + 28 * 110, "Compacting...         "],
    [1000 + 29 * 110, "Compacting…         3s"],
    [93_000, "Compacting…     1m 32s"],
  ];
  for (const [now, row] of cases) {
    const text = hostText(draw(view, [e], [], now));
    expect(text).toContain(row + " │");
    expect(text).not.toContain("Old summary");
    expect(text).not.toContain("Waiting on agents");
  }
  // Too narrow to herd: the text stays, and the pile still moves.
  const out = draw(view.withWidth(23), [e], [], 1000);
  expect(has(out, "\x1b[18;6H" + fg("text") + "Compacting…")).toBe(true);
  expect(has(out, "⣿")).toBe(true);
  expect(hostText(draw(view.withWidth(23), [e], [], 93_000))).not.toContain("1m 32s");
});

test("compaction follows its start across scrolling, narrow rows and unseen restarts", () => {
  const e = entry({
    target: { pane: 952 },
    name: "Compacting agent",
    state: "working",
    compacting: true,
    compacting_since: 1_000_000,
  });
  const view = View.init(100, 30, true, 0, 1).withWidth(28 + lists_x);
  const entries = [e, ...Array.from({ length: view.capacity }, (_, i) => entry({ target: { pane: 960 + i } }))];
  view.count = entries.length;
  draw(view, [], [], 0);
  // First seen partway through, not at the scattered opening frame.
  expect(hostText(draw(view, entries, [], 2320))).toContain("Compacting‹o[/\\]~     ");
  view.offset = 1;
  expect(hostText(draw(view, entries, [], 2400))).not.toContain("Compacting agent");
  view.offset = 0;
  expect(hostText(draw(view, entries, [], 2430))).toContain("Compacting ~ᐯ•ᴥ•ᐯ");
  const settled = draw(view, entries, [], 4190);
  expect(hostText(settled)).toContain("Compacting…         3s");
  view.offset = 1;
  draw(view, entries, [], 4200);
  view.offset = 0;
  expect(hostText(draw(view, entries, [], 4300))).toContain("Compacting…         3s");
  draw(view.withWidth(23), entries, [], 4400);
  expect(hostText(draw(view, entries, [], 4500))).toContain("Compacting…         3s");
  // A second compaction can begin without a visible non-compacting frame.
  e.compacting_since = 5_000_000;
  expect(hostText(draw(view, entries, [], 5000))).toContain("C o  mp  a ct  i n  g ");
});

const endpoint = (fields: Record<string, unknown>) => ({
  label: "",
  label_pending: false,
  pid: 12,
  pane: 1,
  name: "web",
  transport: "tcp",
  bind_address: "127.0.0.1",
  port: 3000,
  ipv6: false,
  interfaces: [],
  scheme: "unknown",
  http_status: null,
  probed_at: 0,
  ...fields,
});

test("workspace port labels contain OSC8 URLs selected per viewer", () => {
  const ifaces = [{ name: "tailscale0", address: "100.80.1.2", kind: "tailscale", ipv6: false }];
  const endpoints = [endpoint({ bind_address: "*", scheme: "http", http_status: 200, interfaces: ifaces })];
  const ws = workspaceEntry({
    id: 1,
    name: "test",
    cwd: "/tmp",
    active: true,
    ports: { processes_available: true, ports_available: true, workspaces: [{ id: 1, background: 2, endpoints }] },
  });
  let w = new Writer();
  drawPorts(w, ws, 25, false);
  expect(has(w.s, ";http://localhost:3000\x1b\\")).toBe(true);
  ws.remote_links = true;
  w = new Writer();
  drawPorts(w, ws, 25, false);
  expect(has(w.s, "http://100.80.1.2:3000")).toBe(true);
});

test("non-browser endpoints have no link-out control", () => {
  const endpoints = [
    endpoint({ pid: 12, name: "dns", transport: "udp", port: 5353 }),
    endpoint({ pid: 13, name: "db", bind_address: "::1", port: 5432, ipv6: true }),
  ];
  const ws = workspaceEntry({
    id: 1,
    name: "test",
    cwd: "/tmp",
    active: true,
    remote_links: true,
    ports: { processes_available: true, ports_available: true, workspaces: [{ id: 1, endpoints }] },
  });
  const w = new Writer();
  drawPorts(w, ws, 60, false);
  expect(w.s).toBe("");
});

test("port hit testing matches clipped labels and outer terminal receives link metadata", () => {
  const endpoints = [
    endpoint({ scheme: "http", http_status: 200 }),
    endpoint({ port: 3001, scheme: "http", http_status: 200 }),
  ];
  const entries = [
    workspaceEntry({
      id: 1,
      name: "test",
      cwd: "/tmp",
      active: true,
      ports: { processes_available: true, ports_available: true, workspaces: [{ id: 1, endpoints }] },
    }),
  ];
  const view = View.init(80, 24, true, 0, 0).withWorkspaces(1, 0);
  expect(portLink(view, entries, 1, 4)).toBeNull();
  expect(portWorkspace(view, entries, 12, 2)!.id).toBe(1);
  expect(portWorkspace(view, entries, 1, 2)).toBeNull();
  const w = new Writer();
  view.draw(w, [], entries);
  expect(has(w.s, "Open Link ↗ 2")).toBe(true);
  expect(has(w.s, "http://")).toBe(false);
  const menu = new PortMenu(1);
  menu.draw(w, entries[0], 80, 24);
  const host = new Terminal(80, 24);
  host.feed(w.s);
  const links = host.hyperlinks();
  host.destroy();
  expect(links.length).toBe(2);
  expect(links[0].uri).toBe("http://localhost:3000");
  const rect = PortMenu.bounds(80, 24);
  expect(menu.hit(entries[0], 80, 24, rect.x + 3, rect.y + 2)).toBe(0);
  expect(menu.hit(entries[0], 80, 24, 0, 0)).toBeNull();
  const single = { ...entries[0], ports: { workspaces: [{ id: 1, endpoints: endpoints.slice(0, 1) }] } };
  expect(portLink(view, [single], 13, 2)).toBe("http://localhost:3000");
});

test("inferred link names share clipped hit geometry and name chooser destinations", () => {
  const endpoints = [
    endpoint({ label: "Finance Dashboard", scheme: "http", http_status: 200 }),
    endpoint({ pid: 13, pane: 2, label: "API Docs", port: 3001, scheme: "http", http_status: 200 }),
  ];
  const works = [{ id: 1, endpoints: endpoints.slice(0, 1) }];
  const ws = workspaceEntry({ id: 1, name: "test", cwd: "/tmp", active: true, ports: { workspaces: works } });
  for (const width of [20, 28, 40]) {
    const view = View.init(100, 30, true, 0, 0).withWidth(width).withWorkspaces(1, 0);
    const range = linkRange(view, ws, [ws]);
    expect(portLink(view, [ws], range.start, 2)).toBe("http://localhost:3000");
    expect(portLink(view, [ws], range.end, 2)).toBeNull();
    expect(portLink(view, [ws], range.start - 1, 2)).toBeNull();
  }
  works[0].endpoints = endpoints;
  expect(portLabel(ws)).toBe("Open Link ↗ 2");
  const w = new Writer();
  new PortMenu(1).draw(w, ws, 100, 30);
  expect(has(w.s, "Finance Dashboard · http://localhost:3000")).toBe(true);
  expect(has(w.s, "API Docs · http://localhost:3001")).toBe(true);
});

test("only a link still being named animates its placeholder dots", () => {
  const endpoints = [endpoint({ label_pending: true, scheme: "http", http_status: 200 })];
  const ws = workspaceEntry({
    id: 1,
    name: "test",
    cwd: "/tmp",
    active: true,
    ports: { workspaces: [{ id: 1, endpoints }] },
  });
  expect(portName(ws)).toBeNull();
  let w = new Writer();
  writePortLabel(w, portLabel(ws), 40, portName(ws) === null, 0);
  expect(w.s.startsWith("Open \x1b[38;2;")).toBe(true);
  expect(w.s.endsWith(" ↗")).toBe(true);
  endpoints[0] = endpoint({ label: "Docs", scheme: "http", http_status: 200 });
  expect(portName(ws)).toBe("Docs");
  w = new Writer();
  writePortLabel(w, portLabel(ws), 40, portName(ws) === null, 0);
  expect(w.s).toBe("Docs ↗");
});

test("corgi frames occupy one column per glyph in the terminal", () => {
  for (const routine of [corgiFrames.wag, corgiFrames.fetch, corgiFrames.sniff])
    for (const frame of routine) {
      expect(displayWidth(frame)).toBe([...frame].length);
      expect(displayWidth(frame)).toBeLessThanOrEqual(18);
    }
});

test("idle face replaces stale activity while working activity remains useful", () => {
  const e = entry({
    target: { pane: 1 },
    name: "Agent",
    provider: "codex",
    state: "idle",
    activity: "Reading source files",
  });
  const view = View.init(100, 30, true, 0, 1);
  let out = draw(view, [e], []);
  expect(has(out, "ᐯ◡ᴥ◡ᐯ") || has(out, "ᐯ◡ω◡ᐯ") || has(out, "ᐯ◡ˑ◡ᐯ")).toBe(true);
  expect(has(out, e.activity)).toBe(false);
  draw(view, [], []); // Hide the old row; labels below have no corgi to replace.
  const states: [string, string][] = [
    ["blocked", "Needs input"],
    ["initializing", "Starting session"],
    ["done", "Session ended"],
  ];
  for (const [state, label] of states) {
    e.state = state;
    out = draw(view, [e], []);
    expect(has(out, label)).toBe(true);
    expect(has(out, e.activity)).toBe(false);
  }
  e.state = "working";
  out = draw(view, [e], []);
  expect(has(out, e.activity)).toBe(true);
  e.activity = "";
  out = draw(view, [e], []);
  expect(has(out, "Working")).toBe(false);
  expect(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].some(glyph => has(out, glyph))).toBe(true);
  expect(has(out, "\x1b[1m" + fg("accent") + "▶")).toBe(true);
});

test("agent lifecycle labels follow the viewer language while activity stays verbatim", () => {
  const labels: Record<i18n.Locale, string[]> = {
    en: ["Starting session", "Needs input", "Session ended", "Waiting on agents"],
    zh: ["正在启动会话", "等待输入", "会话已结束", "等待智能体"],
    ja: ["セッションを開始中", "入力待ち", "セッション終了", "エージェント待ち"],
    ko: ["세션 시작 중", "입력 필요", "세션 종료됨", "에이전트 대기 중"],
    ru: ["Запуск сеанса", "Ждёт ввода", "Сеанс завершён", "Ожидание агентов"],
  };
  const view = View.init(100, 30, true, 0, 1).withWidth(50),
    e = entry({ target: { pane: 9512 }, name: "Agent", activity: "Starting session" }),
    previous = i18n.language();
  view.corgi_intensity = 0;
  try {
    for (const language of i18n.locales) {
      i18n.setLanguage(language);
      for (const [index, state] of ["initializing", "blocked", "done", "working"].entries()) {
        e.state = state;
        e.subagents.waiting = state === "working";
        const rendered = hostText(draw(view, [e], [], 0));
        expect(rendered).toContain(labels[language][index]);
        if (language !== "en") for (const english of labels.en) expect(rendered).not.toContain(english);
      }
      e.subagents.waiting = false;
      expect(hostText(draw(view, [e], [], 0))).toContain("Starting session");
    }
  } finally {
    i18n.setLanguage(previous);
  }
});

test("a startup ghost stays dimmed in working through its first idle prompt", () => {
  const e = entry({ target: { pane: 1 }, name: "New agent", provider: "codex", starting: true }),
    view = View.init(100, 30, true, 0, 1),
    dim = fgRgb(mix(colors.bg, colors.text, 50));
  for (const focused of [false, true]) {
    e.focused = focused;
    e.section = "working";
    let out = "";
    for (const state of ["unknown", "initializing", "idle"]) {
      e.state = state;
      out = draw(view, [e], []);
      expect(out).toContain(dim + "New agent");
      if (state === "initializing") expect(out).toContain(dim + "Starting session");
    }
    // Manual order and the other sections keep their usual appearance.
    for (const section of [null, "ready", "idle", "done"] as const) {
      e.section = section;
      out = draw(view, [e], []);
      expect(out).toContain(fg("text") + "New agent");
    }
    e.section = "working";
    e.state = "working";
    e.starting = false;
    e.activity = "Reading files";
    out = draw(view, [e], []);
    expect(out).toContain(fg("text") + "New agent");
    expect(out).not.toContain("Starting session");
    e.starting = true;
  }
});

test("agents header names its scope and opens the scope menu left of New", () => {
  for (const width of [20, 28, 40]) {
    const view = View.init(100, 30, true, 0, 0).withWidth(width);
    view.scope_label = "all";
    expect(view.hit(1, view.middle())).toEqual(H("none"));
    expect(view.hit(view.scopeStart() - 1, view.middle())).toEqual(H("none"));
    expect(view.hit(view.scopeStart(), view.middle())).toEqual(H("agent_scope"));
    const end = width === 20 ? 10 : 15;
    expect(view.hit(end - 1, view.middle())).toEqual(H("agent_scope"));
    if (width > 20) expect(view.hit(end, view.middle())).toEqual(H("none"));
    expect(view.hit(width - 10, view.middle())).toEqual(H("agent_new"));
    view.scope_label = "a workspace with a long name";
    const header = hostText(draw(view, [], [])).split("\n")[view.middle()];
    // The label never runs into the New button; at the narrowest only the arrow is left.
    expect(header).toContain("agents");
    expect(header).toContain("New");
    if (width > 20) expect(header).toContain("…");
  }
});

test("scope menu offers only the current workspace and all agents", () => {
  const workspaces = [
    workspaceEntry({ id: 4, name: "corgi", cwd: "/tmp", active: true, agents: 3, working: 2, attention: 1 }),
    workspaceEntry({ id: 7, name: "blog", cwd: "/tmp", active: false, agents: 1 }),
    workspaceEntry({ id: 9, name: "notes", cwd: "/tmp", active: false }),
  ];
  const view = View.init(100, 30, true, 0, 0).withWorkspaces(3, 0);
  const b = ScopeMenu.bounds(view, 100, 30);
  expect(b.h).toBe(8);
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 1)).toBe("workspace");
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 2)).toBe("all");
  // The blank row and the sort heading are no choices.
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 3)).toBeNull();
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 4)).toBeNull();
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 5)).toBe("activity");
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 6)).toBe("manual");
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 7)).toBeNull();
  expect(ScopeMenu.hit(view, 100, 30, b.x, b.y + 1)).toBeNull();
  const w = new Writer();
  new ScopeMenu().draw(w, view, 100, 30, workspaces, "all", "manual");
  const text = hostText(w.s);
  const lines = text.split("\n");
  expect(lines[b.y + 1].trimEnd()).toBe("  │   This workspace     3 │");
  expect(lines[b.y + 2].trimEnd()).toBe("  │ ✓ All                4 │");
  expect(lines[b.y + 3].trimEnd()).toBe("  │                        │");
  expect(lines[b.y + 4].trimEnd()).toBe("  │   Sort                 │");
  // Each sort says what it does: activity by its sections' glyphs.
  expect(lines[b.y + 5].trimEnd()).toBe("  │   By activity    ▶ ● ○ │");
  expect(lines[b.y + 6].trimEnd()).toBe("  │ ✓ Manual    as dragged │");
  expect(lines[b.y + 7].trimEnd()).toBe("  ╰────────────────────────╯");
  for (const ws of workspaces) expect(text).not.toContain(ws.name);
});

test("translated narrow headers keep scope and new-agent controls separately reachable", () => {
  const previous = i18n.language();
  try {
    for (const language of i18n.locales) {
      i18n.setLanguage(language);
      for (const width of [20, 22, 28, 40]) {
        const view = View.init(100, 30, true, 0, 0).withWidth(width);
        view.scope_label = "app";
        const row = hostText(draw(view, [], [])).split("\n")[view.middle()],
          scope = displayWidth(row.slice(0, row.indexOf("▾"))),
          options = displayWidth(row.slice(0, row.lastIndexOf("▾"))),
          label = row.includes(i18n.t`New`) ? i18n.t`New` : "+",
          create = displayWidth(row.slice(0, row.indexOf(label)));
        expect(scope, `${language} ${width}: ${row}`).toBeLessThan(create);
        expect(create).toBeLessThan(options);
        expect(view.hit(scope, view.middle())).toEqual(H("agent_scope"));
        expect(view.hit(create, view.middle())).toEqual(H("agent_new"));
        expect(view.hit(options, view.middle())).toEqual(H("agent_options"));
      }
    }
  } finally {
    i18n.setLanguage(previous);
  }
});

test("grouped list draws one-row headers with a margin guide and measures rows per entry", () => {
  const entries = [
    entry({
      target: { group: 1 },
      name: "corgi",
      provider: "codex",
      state: "idle",
      group: { agents: 2, working: 1, attention: 0, folded: false, current: true },
    }),
    entry({ target: { pane: 1 }, name: "api refactor", provider: "codex", state: "blocked", focused: true }),
    entry({ target: { pane: 2 }, name: "release notes", provider: "claude", state: "done" }),
    entry({
      target: { group: 2 },
      name: "blog",
      provider: "codex",
      state: "idle",
      group: { agents: 1, working: 0, attention: 1, folded: true, current: false },
    }),
  ];
  const view = View.init(100, 30, true, 0, entries.length).withEntries(entries);
  const top = view.middle() + 2;
  expect(view.capacity).toBe(4);
  for (const [row, index] of [
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
  ])
    expect(view.hit(5, top + row)).toEqual(H("entry", index));
  expect(view.hit(5, top + 6)).toEqual(H("none"));
  expect(agentAt(view, entries, 5, top)).toBeNull();
  const out = draw(view, entries, []);
  const lines = hostText(out).split("\n");
  const rows = lines.slice(top, top + 6).map(line => line.slice(0, 80).trimEnd());
  // The focused agent's rail turns heavy but stays continuous.
  expect(rows).toEqual([
    " ▾ corgi ━━━━━━━━━━━ 1▶ 1○ │",
    " ┣●  api refactor          │",
    " ┃   Needs input           │",
    " ╰○  release notes         │",
    "     Session ended         │",
    " ▸ blog ━━━━━━━━━━━━━━━ 1● │",
  ]);
  expect(has(out, new Style({ fg: "accent" }).sgr() + selected_bg + "┣")).toBe(true);
  // Without Kitty graphics there is no separator; with it, a dotted one under the text.
  expect(has(out, "\x1b[4:4m")).toBe(false);
  const rich = view.clone();
  rich.corgi_badge = "emoji";
  rich.supports_kitty_graphics = true;
  const richOut = draw(rich, entries, []);
  expect(has(richOut, `\x1b[${top + 3};6H\x1b[4:4m`)).toBe(true);
  expect(Math.floor(count(richOut, dotted_underline) / 2)).toBe(1);
  // Selected at the end of its group, the rail still spans both rows.
  const last = entries.map((e, i) => ({ ...e, focused: i === 2 }));
  const lastRows = hostText(draw(view.withEntries(last), last, []))
    .split("\n")
    .slice(top + 1, top + 5)
    .map(line => line.slice(0, 80).trimEnd());
  expect(lastRows).toEqual([
    " ├●  api refactor          │",
    " │   Needs input           │",
    " ┣○  release notes         │",
    " ┃   Session ended         │",
  ]);
});

test("grouped scrolling fits more rows when headers are shorter", () => {
  const entries = Array.from({ length: 7 }, (_, i) =>
    entry({ target: i % 3 === 0 ? { group: i } : { pane: i }, provider: "codex", state: "idle" }),
  );
  // 13 rows leave five list rows: three entries where only two agents fit.
  // Scrolled into a group, its pinned header takes one, except at the end,
  // where the last entries fill the list.
  const view = View.init(100, 13, true, 0, entries.length).withEntries(entries);
  expect(view.capacity).toBe(3);
  expect(view.pinned(1)).toEqual([0]);
  expect(view.maxOffset()).toBe(4);
  expect(view.pinned(4)).toEqual([]);
  expect(view.reveal(3)).toBe(2);
  expect(View.init(100, 13, true, 99, entries.length).withEntries(entries).offset).toBe(4);
});

test("worktree groups branch off the workspace rail and pin their headers above scrolled rows", () => {
  const worktree = { workspace: 1, path: "/repo/.worktrees/one", ghost: false };
  const agent = (pane: number, name: string, inside: boolean) =>
    entry({ target: { pane }, name, provider: "codex", state: "done", worktree: inside ? worktree : null });
  const entries = [
    entry({
      target: { group: 1 },
      name: "corgi",
      group: { agents: 3, working: 0, attention: 0, folded: false, current: true },
    }),
    agent(1, "direct", false),
    entry({
      target: { worktree: worktree.path, workspace: 1 },
      name: "one",
      worktree,
      group: { agents: 2, working: 0, attention: 0, folded: false, current: false },
    }),
    agent(2, "first", true),
    agent(3, "second", true),
    entry({
      target: { group: 2 },
      name: "blog",
      group: { agents: 1, working: 0, attention: 0, folded: true, current: false },
    }),
    entry({
      target: { group: 3 },
      name: "site",
      group: { agents: 1, working: 0, attention: 0, folded: true, current: false },
    }),
    entry({
      target: { group: 4 },
      name: "docs",
      group: { agents: 1, working: 0, attention: 0, folded: true, current: false },
    }),
    entry({
      target: { group: 5 },
      name: "notes",
      group: { agents: 1, working: 0, attention: 0, folded: true, current: false },
    }),
  ];
  const rows = (view: View, n: number) => {
    const top = view.middle() + 2;
    return hostText(draw(view, entries, []))
      .split("\n")
      .slice(top, top + n)
      .map(line => line.slice(0, 80).trimEnd());
  };
  const whole = View.init(100, 30, true, 0, entries.length).withEntries(entries);
  expect(whole.pinned(0)).toEqual([]);
  expect(rows(whole, 9)).toEqual([
    " ▾ corgi ━━━━━━━━━━━━━━ 3○ │",
    " ├○  direct                │",
    " │   Session ended         │",
    " ├▾ ⌥ one ───────────── 2○ │",
    " ├○  first                 │",
    " │   Session ended         │",
    " ╰○  second                │",
    "     Session ended         │",
    " ▸ blog ━━━━━━━━━━━━━━━ 1○ │",
  ]);
  // Scrolled to "second", corgi's and the worktree's headers stay on top;
  // the lower one underlines its row, and both hit as themselves.
  const scrolled = View.init(100, 13, true, 4, entries.length).withEntries(entries);
  expect(scrolled.offset).toBe(4);
  expect(scrolled.pinned(4)).toEqual([0, 2]);
  expect(scrolled.pinned(2)).toEqual([0]);
  expect(rows(scrolled, 5)).toEqual([
    " ▾ corgi ━━━━━━━━━━━━━━ 3○ │",
    " ├▾ ⌥ one ───────────── 2○ │",
    " ╰○  second                ┃",
    "     Session ended         ┃",
    " ▸ blog ━━━━━━━━━━━━━━━ 1○ │",
  ]);
  const top = scrolled.middle() + 2;
  expect([0, 1, 2, 4].map(row => scrolled.hit(5, top + row))).toEqual([
    H("entry", 0),
    H("entry", 2),
    H("entry", 4),
    H("entry", 5),
  ]);
  const out = draw(scrolled, entries, []);
  expect(has(out, `\x1b[${top + 2};2H\x1b[0m${palette.bg("bg")}${rule_underline}`)).toBe(true);
  expect(count(out, rule_underline)).toBe(1);
});

test("a lit worktree keeps its colors while the rest of the agent list fades", () => {
  const worktree = { workspace: 1, path: "/repo/.worktrees/one", ghost: false };
  const entries = [
    entry({ target: { pane: 1 }, name: "direct", provider: "codex", state: "done" }),
    entry({
      target: { worktree: worktree.path, workspace: 1 },
      name: "one",
      worktree,
      group: { agents: 1, working: 0, attention: 0, folded: false, current: false },
    }),
    entry({ target: { pane: 2 }, name: "inside", provider: "codex", state: "done", worktree }),
  ];
  const faded = (sgr: string) => {
    const w = new Writer();
    writeExit(w, sgr, spotlight_dim);
    return w.buffered();
  };
  const view = View.init(100, 30, true, 0, entries.length).withEntries(entries);
  const plain = draw(view, entries, []);
  expect(has(plain, "\x1b[22m" + fg("text") + "direct")).toBe(true);
  view.spotlight = { workspace: 1, path: worktree.path };
  const lit = draw(view, entries, []);
  expect(has(lit, "\x1b[22m" + faded(fg("text")) + "direct")).toBe(true);
  expect(has(lit, "\x1b[22m" + fg("text") + "inside")).toBe(true);
  expect(has(lit, faded(fg("text")) + "one")).toBe(false);
  expect(hostText(lit)).toBe(hostText(plain));
  // With no path, the workspace's own rows stay lit and its worktrees fade.
  view.spotlight = { workspace: 1, path: null };
  const main = draw(view, entries, []);
  expect(has(main, "\x1b[22m" + fg("text") + "direct")).toBe(true);
  expect(has(main, "\x1b[22m" + faded(fg("text")) + "inside")).toBe(true);
});

test("in All, a lit main checkout keeps its workspace's header and direct rows", () => {
  const worktree = { workspace: 1, path: "/repo/.worktrees/one", ghost: false };
  const entries = [
    entry({ target: { group: 1 }, name: "repo" }),
    entry({ target: { pane: 1 }, name: "direct" }),
    entry({ target: { worktree: worktree.path, workspace: 1 }, name: "one", worktree }),
    entry({ target: { pane: 2 }, name: "inside", worktree }),
    entry({ target: { group: 2 }, name: "other" }),
    entry({ target: { pane: 3 }, name: "elsewhere" }),
  ];
  expect(unlit(entries, null)).toEqual([false, false, false, false, false, false]);
  expect(unlit(entries, { workspace: 1, path: null })).toEqual([false, false, true, true, true, true]);
  expect(unlit(entries, { workspace: 1, path: worktree.path })).toEqual([true, true, false, false, true, true]);
});

test("agent list shows a scrollbar on the border only when it overflows", () => {
  const entries = Array.from({ length: 6 }, (_, i) => entry({ target: { pane: i }, provider: "codex", state: "idle" }));
  // 23 rows leave ten list rows: five agents.
  const fits = View.init(80, 23, true, 0, 5).withEntries(entries.slice(0, 5));
  expect(fits.thumb()).toBeNull();
  expect(has(draw(fits, entries.slice(0, 5), [], 0), "┃")).toBe(false);
  const top = View.init(80, 23, true, 0, entries.length).withEntries(entries);
  expect(top.thumb()!.start).toBe(0);
  expect(top.thumb()!.len).toBe(8);
  expect(View.init(80, 23, true, 99, entries.length).withEntries(entries).thumb()!.start).toBe(2);
  const out = draw(top, entries, [], 0);
  expect(count(out, "┃")).toBe(8);
  expect(has(out, "\x1b[14;28H")).toBe(true);
  expect(has(out, "/6")).toBe(false);
  expect(top.hit(5, top.rows - 2)).toEqual(H("entry", 4));
  // The search hint takes the bottom row.
  const searching = View.init(80, 24, true, 0, 5)
    .withSearch({ text: "", cursor: 0, selection: null })
    .withEntries(entries.slice(0, 5));
  expect(searching.capacity).toBe(5);
  expect(searching.hit(5, searching.rows - 1)).toEqual(H("none"));
});

test("git badge hit area follows sidebar width and workspace scroll", () => {
  const entries = [
    workspaceEntry({ id: 1, name: "one", cwd: "/tmp", active: false }),
    workspaceEntry({ id: 2, name: "two", cwd: "/tmp", active: true, git_ahead: 14 }),
    workspaceEntry({ id: 3, name: "three", cwd: "/tmp", active: false }),
  ];
  const view = View.init(100, 20, true, 0, 0).withWidth(36).withWorkspaces(3, 1);
  expect(gitWorkspace(view, entries, 31, 2)!.id).toBe(2);
  expect(gitWorkspace(view, entries, 30, 2)).toBeNull();
  expect(gitWorkspace(view, entries, 34, 2)).toBeNull();
  expect(gitWorkspace(view, entries, 32, 3)).toBeNull();
  expect(gitWorkspace(view, entries, 32, 5)).toBeNull();
  expect(gitWorkspace(View.init(100, 20, false, 0, 0), entries, 32, 2)).toBeNull();
});

test("compaction time reads to the second, then to the minute past an hour", () => {
  expect(elapsed(-5)).toBe("0s");
  expect(elapsed(59_999)).toBe("59s");
  expect(elapsed(60_000)).toBe("1m 0s");
  expect(elapsed(92_400)).toBe("1m 32s");
  expect(elapsed(3_900_000)).toBe("1h 5m");
});

test("commit relative time humanizes elapsed and future timestamps", () => {
  expect(relativeTime(10000, 10010)).toBe("just now");
  expect(relativeTime(10000, 10060)).toBe("1 minute ago");
  expect(relativeTime(10000, 17200)).toBe("2 hours ago");
  expect(relativeTime(17200, 10000)).toBe("in 2 hours");
});

test("content wipes over the old corgi in terminal cells and then clears it", () => {
  const host = new Terminal(100, 30);
  const e = entry({ target: { pane: 10001 }, name: "Agent", provider: "codex", state: "working" });
  const view = View.init(100, 30, true, 0, 1);
  host.feed(draw(view, [e], [], 0));
  e.activity = "Reading files";
  host.feed(draw(view, [e], [], 100));
  host.feed(draw(view, [e], [], 145));
  // Two revealed cells overlay the old tail and ear; the awake face stays below.
  expect(host.text()).toContain("Re•");
  e.state = "working";
  e.activity = "OK";
  expect(has(draw(view, [e], [], 150), "ᐯ◡ᴥ◡ᐯ")).toBe(false);
  host.feed(draw(view, [e], [], 550));
  const completed = host.text();
  host.destroy();
  expect(completed).toContain("OK                    ");
  expect(completed).not.toContain("ᐯ");
});

test("reveal pads short text and never splits a wide glyph or moves the ellipsis", () => {
  const cases: [string, number, number, string][] = [
    ["OK", 10, 6, "OK    "],
    ["界abcdef", 5, 1, " "],
    ["界abcdef", 5, 3, "界a"],
    ["界abcdef", 5, 5, "界ab…"],
  ];
  for (const [text, room, revealed, expected] of cases) {
    const w = new Writer();
    writeRevealedDetail(w, text, room, revealed, null);
    expect(w.s).toBe(expected);
  }
});

test("closing card keeps its glyphs and geometry while all colors fade into the panel", () => {
  const frame =
    "\x1b[19;1H" + new Style({ bg: "surface" }).sgr() + " \x1b[1m" + fg("strong") + "Agent" + rule_underline + " corgi";
  let w = new Writer();
  writeExit(w, frame, 0);
  expect(w.s).toBe(frame);
  w = new Writer();
  writeExit(w, frame, 0.5);
  expect(has(w.s, fgRgb(mix(colors.strong, colors.bg, 50)) + "Agent")).toBe(true);
  expect(has(w.s, "\x1b[19;1H")).toBe(true);
  w = new Writer();
  writeExit(w, frame, 1);
  expect(w.s).toBe(
    "\x1b[19;1H" + new Style({ bg: "bg" }).sgr() + " \x1b[1m" + fg("bg") + "Agent\x1b[4m" + underline("bg") + " corgi",
  );
});

test("a moved row rides a Kitty tint from where it was and shows as it lands; elsewhere its background tints", () => {
  const worktree = { workspace: 1, path: "/repo/.worktrees/one", ghost: false };
  const moved = (ms: number): Entry[] => [
    entry({ target: { pane: 2 }, name: "stays", provider: "codex" }),
    entry({
      target: { worktree: worktree.path, workspace: 1 },
      name: "one",
      worktree,
      group: { agents: 1, working: 0, attention: 0, folded: false, current: false },
    }),
    { ...entry({ target: { pane: 1 }, name: "moves", provider: "codex", worktree }), moved: { from: 0, ms } },
  ];
  const kitty = View.init(100, 30, true, 0, 3).withEntries(moved(0));
  kitty.supports_kitty_graphics = true;
  kitty.cell = { width: 10, height: 20 };
  const top = kitty.middle() + 2;
  // Halfway there, the tint is between the row it left and the one it lands
  // on, and the row's text is still hidden.
  let out = draw(kitty, moved(150), [], 0);
  const at = (row: number) => `\x1b[${row};${lists_x + 1}H\x1b_Ga=T`;
  expect(has(out, `${at(top + 2)},f=100,i=730120,p=1,Y=10,`)).toBe(true);
  expect(has(out, fgRgb(colors.bg) + "moves")).toBe(true);
  // Landed, the row shows and the tint fades on it.
  out = draw(kitty, moved(400), [], 0);
  expect(has(out, at(top + 4))).toBe(true);
  expect(has(out, ",Y=0,")).toBe(true);
  expect(has(out, fg("text") + "moves")).toBe(true);
  expect(has(draw(kitty, moved(2000), [], 0), "_G")).toBe(false);
  // Without Kitty graphics, the row shows at once on a tinted background.
  const plain = View.init(100, 30, true, 0, 3).withEntries(moved(0));
  out = draw(plain, moved(0), [], 0);
  expect(has(out, "_G")).toBe(false);
  expect(has(out, fg("text") + "moves")).toBe(true);
  expect(has(out, bgRgb(colors.bg.map((v, n) => Math.round(v + (colors.accent[n] - v) * 0.2)) as palette.Rgb))).toBe(
    true,
  );
});

test("only one sleeping corgi puffs at a time, and turning them off leaves a faint Z", () => {
  const entries = Array.from({ length: 4 }, (_, i) =>
    entry({ target: { pane: i + 1 }, name: "Agent", provider: "claude", state: "idle" }),
  );
  const view = View.init(100, 30, true, 0, entries.length);
  view.scope_label = "Corgi";
  let puffed = false;
  let now = 0;
  let out = "";
  while (now < corgiAnimation.dream_period_ms) {
    out = draw(view, entries, [], now);
    const letters = count(out, "ᶻ") + count(out, "z");
    expect(letters).toBeLessThanOrEqual(2);
    puffed = puffed || letters > 0;
    now += 150;
  }
  expect(puffed).toBe(true);
  expect(count(out, "~ᐯ◡ᴥ◡ᐯ")).toBe(entries.length);
  // A focused row is selected, where the sleeper is muted.
  entries[0].focused = true;
  out = draw(view, entries, [], now);
  expect(count(out, fg("muted") + "~ᐯ◡ᴥ◡ᐯ")).toBe(1);
  entries[0].focused = false;
  view.corgi_intensity = 0;
  out = draw(view, entries, [], 0);
  expect(has(out, "ᐯ◡ᴥ◡ᐯ")).toBe(false);
  expect(count(out, "\x1b[22m" + nap_fg + "ᶻ")).toBe(entries.length);
  // Question marks outside escape sequences would be a placeholder label.
  expect(count(out, "\x1b[?")).toBe(count(out, "?"));
});

test("zero intensity cancels fetch and reveals immediately but leaves compaction alone", () => {
  const e = entry({ target: { pane: 951 }, name: "intensity", state: "working" });
  const view = View.init(100, 30, true, 0, 1);
  draw(view, [], [], 0);
  draw(view, [e], [], 0);
  const presentation = corgiAnimation.observe(animationKey(e), "awake", 0)!;
  presentation.playback.enter("fetch", 0);
  expect(presentation.playback.active).toBe(true);
  view.corgi_intensity = 0;
  e.activity = "Ready immediately";
  const out = draw(view, [e], [], 100);
  expect(hostText(out)).toContain("Ready immediately");
  expect(out).not.toContain("ᐯ");
  expect(presentation.playback.active).toBe(false);
  expect(presentation.last_corgi).toBeNull();
  expect(presentation.reveal_started_ms).toBeNull();
  expect(corgiAnimation.frameDelay()).toBe(75);
  e.compacting = true;
  e.compacting_since = 100_000;
  draw(view, [e], [], 100);
  const compacting = draw(view, [e], [], 1420);
  expect(hostText(compacting)).toContain("Compacting");
  expect(hostText(compacting)).toContain("ᐯ•ᴥ•ᐯ");
  view.corgi_intensity = 100;
  expect(draw(view, [e], [], 1420)).toBe(compacting);
});

test("context shows on the name line only near compaction and dims while compacting", () => {
  const entries = [
    entry({
      target: { pane: 1 },
      name: "migrate checkpoints",
      provider: "codex",
      state: "working",
      context: new ContextView({ used: 190_000n, window: 258_400n, at: 1 }),
    }),
    entry({
      target: { pane: 2 },
      name: "api refactor",
      provider: "codex",
      state: "working",
      context: new ContextView({ used: 120_000n, window: 258_400n, at: 1 }),
    }),
    entry({
      target: { pane: 3 },
      name: "release notes",
      provider: "claude",
      state: "working",
      compacting: true,
      context: new ContextView({ used: 380_000n, window: 1_000_000n, compacts_at: 400_000n, at: 1 }),
    }),
  ];
  const out = draw(View.init(100, 30, true, 0, entries.length), entries, []);
  const text = hostText(out);
  // 74% of the window is 74% of the way: warm, and the name gives way.
  expect(text).toContain("migrate checkpoi… 74%");
  expect(has(out, fg("warm") + "74%")).toBe(true);
  // 46% of the way shows nothing.
  expect(text).toContain("api refactor");
  expect(text).not.toContain("46%");
  // 38% of a 1M window is 95% of the way to a learned 400k: hot, faded toward the row.
  expect(has(out, fgRgb(mix(colors.hot, colors.bg, 60)) + "38%")).toBe(true);
});
test("the drawer runs the workspace list to the bottom and leaves panes and tabs where folded", () => {
  const folded = View.init(100, 30, false, 0, 0);
  const open = View.init(100, 30, true, 0, 0);
  open.drawer = "workspaces";
  const view = open.withWorkspaces(12, 0);
  expect(view.area()).toEqual(folded.area());
  expect(view.tabX()).toBe(folded.tabX());
  expect(view.workspaceCapacity()).toBe(9);
  expect(view.hit(24, 28)).toEqual(H("workspace", 8));
  expect(view.hit(24, 29)).toEqual(H("none"));
  const entries = Array.from({ length: 12 }, (_, i) =>
    workspaceEntry({ id: i + 1, name: `ws${i + 1}`, cwd: "/tmp", active: i === 0 }),
  );
  const text = hostText(draw(view, [], entries));
  expect(text).toContain("ws9");
  expect(text).not.toContain("agents");
});

test("the agents drawer runs the agent list from the top, under its header alone", () => {
  const open = View.init(100, 30, true, 0, 0);
  open.drawer = "agents";
  const entries = Array.from({ length: 20 }, (_, i) =>
    entry({ target: { pane: i + 1 }, name: `agent${i + 1}`, provider: "claude", state: "idle" }),
  );
  const view = open.withEntries(entries);
  expect(view.area()).toEqual(View.init(100, 30, false, 0, 0).area());
  // Its box's top edge, the header, a gap, then the list down to the bottom edge.
  expect(view.listRows()).toBe(26);
  expect(view.hit(10, 3)).toEqual(H("entry", 0));
  expect(view.hit(10, 2)).toEqual(H("none"));
  expect(view.hit(24, 0)).toEqual(H("none"));
  view.focus = "agents";
  const lines = hostText(draw(view, entries, [workspaceEntry({ id: 1, name: "Project", cwd: "/tmp", active: true })]))
    .split("\n")
    .map(line => line.slice(0, 28));
  expect(lines[0]).toBe("┌" + "─".repeat(26) + "┐");
  expect(lines[1]).toContain("agents");
  expect(lines[29]).toBe("└" + "─".repeat(26) + "┘");
  expect(lines.join("\n")).toContain("agent13");
  // A drawer doesn't search, so it shows no `/`.
  expect(lines[2]).not.toContain("/ search");
  expect(lines.join("\n")).not.toContain("workspaces");
  expect(lines.join("\n")).not.toContain("Project");
});

test("the focused list sits in a box in the focused pane's outline, sharing the rule", () => {
  const outline = new Style({ bg: "bg" }).sgr() + fgRgb(palette.outline);
  const view = View.init(100, 30, true, 0, 0);
  expect(has(draw(view, [], []), outline)).toBe(false);
  const box = (v: View) =>
    hostText(draw(v, [], []))
      .split("\n")
      .map(line => line.slice(0, 28));
  const edge = (left: string, right: string) => left + "─".repeat(26) + right;
  // The rule carries a grip in its middle, unboxed or boxed.
  const grip = " ⠶⠶⠶ ";
  const rule = (left: string, stroke: string, right: string) =>
    left + stroke.repeat(10) + grip + stroke.repeat(10) + right;
  let lines = box(view);
  expect(lines[13]).toBe(rule("  ", "━", "┥"));
  expect(has(draw(view, [], []), panel + fg("line") + "━")).toBe(true);
  expect(has(draw(view, [], []), fg("faint") + grip + fg("line") + "━")).toBe(true);
  view.focus = "agents";
  lines = box(view);
  expect(lines[12]).toBe(" ".repeat(27) + "│");
  expect(lines[13]).toBe(rule("┌─", "─", "┤"));
  // The row its search opens in shows its key.
  expect(lines[15]).toBe("│ / search" + " ".repeat(17) + "│");
  expect(lines[22]).toBe("│" + " ".repeat(26) + "│");
  expect(lines[29]).toBe(edge("└", "┘"));
  expect([0, 12, 13, 29].map(y => view.outlines(y))).toEqual([false, false, true, true]);
  view.focus = "workspaces";
  lines = box(view);
  expect(lines[1]).toBe(edge("┌", "┤"));
  expect(lines[13]).toBe(rule("└─", "─", "┤"));
  expect(lines[29]).toBe(" ".repeat(27) + "│");
  expect(lines[15].trim()).toBe("│");
  expect([0, 12, 13, 29].map(y => view.outlines(y))).toEqual([false, true, true, false]);
  view.drawer = "workspaces";
  lines = box(view);
  expect(lines[1]).toBe(edge("┌", "┤"));
  expect(lines[29]).toBe(edge("└", "┘"));
  // A focused list's thumb takes its outline's color; the other keeps the plain one.
  const many = Array.from({ length: 20 }, (_, i) =>
    entry({ target: { pane: i + 1 }, name: `agent${i + 1}`, provider: "claude", state: "idle" }),
  );
  const listed = View.init(100, 30, true, 0, 0).withEntries(many);
  const thumb = outline + "┃";
  expect(has(draw(listed, many, []), thumb)).toBe(false);
  listed.focus = "agents";
  expect(has(draw(listed, many, []), thumb)).toBe(true);
});

test("a dragged split moves the agents header within bounds", () => {
  const half = View.init(100, 30, true, 0, 0);
  expect(half.middle()).toBe(14);
  expect(half.splitHandle(5, 13)).toBe(true);
  expect(half.splitHandle(27, 13)).toBe(false);
  expect(View.init(100, 30, true, 0, 0, 10).middle()).toBe(10);
  expect(View.init(100, 30, true, 0, 0, 2).middle()).toBe(6);
  expect(View.init(100, 30, true, 0, 0, 40).middle()).toBe(25);
  expect(View.init(100, 30, true, 0, 0, 10).listRows()).toBe(18);
});

test("an unfolded group scrolls into view as far as it fits, its header at most on top", () => {
  const header = (id: number) =>
    entry({ target: { group: id }, group: { agents: 0, working: 0, attention: 0, folded: false, current: false } });
  const agents = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => entry({ target: { pane: from + i } }));
  // 14 list rows: the first group takes 11, so the second's header sits on the 12th.
  const small = [header(1), ...agents(1, 5), header(2), ...agents(10, 2)];
  let view = View.init(100, 30, true, 0, small.length).withEntries(small);
  const shown = view.revealGroup(6);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThanOrEqual(6);
  view = View.init(100, 30, true, shown, small.length).withEntries(small);
  expect(small.length - 1).toBeLessThan(shown + view.fits(shown));
  // A group longer than the list stops with its header on top.
  const big = [header(1), ...agents(1, 5), header(2), ...agents(10, 9)];
  expect(View.init(100, 30, true, 0, big.length).withEntries(big).revealGroup(6)).toBe(6);
  // One already in view doesn't move the list.
  const near = [header(1), ...agents(1, 1), header(2), ...agents(10, 2)];
  expect(View.init(100, 30, true, 0, near.length).withEntries(near).revealGroup(2)).toBe(0);
});

test("a worktree's group runs while rows are its checkout's", () => {
  const info = { workspace: 1, path: "/w", ghost: false };
  const entries = [
    entry({ target: { worktree: "/w", workspace: 1 }, worktree: info }),
    entry({ target: { pane: 1 }, worktree: info }),
    entry({ target: { asleep: "s", provider: "claude" }, worktree: info }),
    entry({ target: { worktree: "/v", workspace: 1 }, worktree: { ...info, path: "/v" } }),
    entry({ target: { pane: 2 } }),
  ];
  expect(groupEnd(entries, 0)).toBe(3);
  expect(groupEnd(entries, 3)).toBe(4);
});

test("on a host with GPUs every resource row keeps a GPU place, used or not", () => {
  const view = Object.assign(View.init(100, 30, true, 0, 0).withWorkspaces(1, 0), { gpus: true }),
    calm = { ...hot, cpu_pressure: false },
    plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""),
    row = (fields: Partial<typeof hot>, v: View = view) => {
      const w = new Writer();
      drawResources(w, work({ ...calm, ...fields }), v, false, false);
      return plain(w.s);
    };
  const idle = row({ gpu: 0 }),
    busy = row({ gpu: 150, gpu_shown: true });
  expect(idle).not.toMatch(/ G \d/);
  expect(busy).toContain("G 150%");
  // CPU and memory sit in the same columns either way.
  expect(idle.indexOf("M 3.0G")).toBe(busy.indexOf("M 3.0G"));
  expect(idle.length).toBe(busy.length);
  // Without GPUs the row keeps its two halves.
  expect(row({ gpu: 150, gpu_shown: true }, Object.assign(view.clone(), { gpus: false }))).toContain("Memory 3.0G");
  const wide = row({ gpu: 150, gpu_shown: true }, view.withWidth(40));
  expect(wide).toContain("CPU 182%");
  expect(wide).toContain("Mem 3.0G");
  expect(wide).toContain("GPU 150%");
});

test("the push popover shows what the push and each commit change", () => {
  const none = { files: 0, insertions: 0, deletions: 0 };
  const commit = (subject: string, diff: typeof none) => ({
    hash: "abc1234",
    subject,
    author: "A",
    date: "2026-10-23 10:00",
    timestamp: 0,
    diff,
  });
  const ws = workspaceEntry({
    id: 1,
    name: "w",
    cwd: "/tmp",
    active: true,
    git_ahead: 2,
    git_commits: [commit("Grow", { files: 1, insertions: 1, deletions: 0 }), commit("Empty", none)],
  });
  let w = new Writer();
  drawGitTooltip(w, { ...ws, git_diff: { files: 3, insertions: 120, deletions: 4 } }, 100, 30, 0, 0);
  let text = hostText(w.s);
  expect(text).toMatch(/↑ 2 unpushed commits +3 files {2}\+120 −4 │/);
  expect(text).toMatch(/abc1234 {2}Grow +│ *\n.*A · 2026-10-23 10:00 · +1 file {5}\+1 −0 │/);
  expect(text).toMatch(/abc1234 {2}Empty +│ *\n.*A · 2026-10-23 10:00 · +│/);
  w = new Writer();
  drawGitTooltip(w, { ...ws, git_commits: [commit("Grow", none)] }, 100, 30, 0, 0);
  expect(hostText(w.s)).not.toContain("file");
});

test("the agent list draws into the bottom row and cuts off the entry that runs past it", () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry({ target: { pane: i + 1 }, name: `agent ${i}` }));
  const view = View.init(80, 20, true, 0, entries.length).withEntries(entries);
  const lines = hostText(draw(view, entries, []), 80, 20).split("\n");
  expect(lines[19]).toContain("agent 4");
  expect(view.hit(5, 19)).toEqual({ tag: "entry", entry: 4 });
  // Scrolling still stops where the last entry fits whole.
  expect(view.maxOffset()).toBe(6);
  const focused = View.init(80, 20, true, 0, entries.length).withEntries(entries);
  focused.focus = "agents";
  expect(hostText(draw(focused, entries, []), 80, 20).split("\n")[19]).not.toContain("agent 4");
});

test("badges count agents scrolled out of sight and point at the farthest, so the rest show with it", () => {
  const working = new Set([0, 1, 7]);
  const entries = Array.from({ length: 10 }, (_, i) =>
    entry({
      target: { pane: i + 1 },
      name: `agent ${i}`,
      state: working.has(i) ? "working" : i === 8 ? "blocked" : "idle",
      attention: i === 9 ? "finished" : "none",
    }),
  );
  const view = View.init(80, 21, true, 3, entries.length).withEntries(entries);
  const lines = hostText(draw(view, entries, []), 80, 21).split("\n");
  expect(lines[11]).toContain(" 2 ▶ ↑ ");
  expect(lines[20]).toContain(" 1 ▶ 1 ● 1 ● ↓ ");
  const above = view.lists().badge("above")!,
    below = view.lists().badge("below")!;
  expect(view.hit(above.x + lists_x + 1, above.y)).toEqual({ tag: "active", offset: 0 });
  expect(view.hit(below.x + lists_x + 1, below.y)).toEqual({ tag: "active", offset: 6 });
  // There, the three it counted all show, and nothing is left below.
  const scrolled = View.init(80, 21, true, 6, entries.length).withEntries(entries);
  const shown = hostText(draw(scrolled, entries, []), 80, 21);
  for (const n of [7, 8, 9]) expect(shown).toContain(`agent ${n}`);
  expect(scrolled.lists().badge("below")).toBeNull();
  const top = View.init(80, 21, true, 0, entries.length).withEntries(entries);
  expect(top.lists().badge("above")).toBeNull();
  const searching = view.withSearch({ text: "", cursor: 0, selection: null });
  expect(searching.lists().badge("below")).toBeNull();
});

test("a badge scrolls no farther than keeps the nearest it counts in view", () => {
  const working = new Set([2, 25, 40, 60]);
  const entries = Array.from({ length: 64 }, (_, i) =>
    entry({ target: { pane: i + 1 }, name: `agent ${i}`, state: working.has(i) ? "working" : "idle" }),
  );
  const view = View.init(80, 21, true, 30, entries.length).withEntries(entries);
  const above = view.lists().badge("above")!,
    below = view.lists().badge("below")!;
  expect(above.offset).toBe(25);
  // The farthest, 60, would scroll 40 out of sight above; 40 goes to the bottom.
  const scrolled = View.init(80, 21, true, below.offset, entries.length).withEntries(entries);
  const shown = hostText(draw(scrolled, entries, []), 80, 21);
  expect(shown).toContain("agent 40");
  expect(shown).not.toContain("agent 60");
  expect(scrolled.lists().badge("below")).not.toBeNull();
});

test("a focused agent list scrolls its last agent fully into view", () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry({ target: { pane: i + 1 }, name: `agent ${i}` }));
  const view = View.init(80, 22, true, 99, entries.length);
  view.focus = "agents";
  const focused = view.withEntries(entries);
  expect(focused.offset).toBe(6);
  expect(hostText(draw(focused, entries, []), 80, 22).split("\n")[18]).toContain("agent 9");
});

test("the agent list stops scrolling once its last entry shows", () => {
  const entries: Entry[] = [];
  for (let g = 0; g < 4; g++) {
    const worktree = { workspace: 1, path: `/w/${g}`, ghost: false };
    entries.push(entry({ target: { worktree: worktree.path, workspace: 1 }, name: `wt ${g}`, worktree }));
    for (let a = 0; a < 3; a++)
      entries.push(entry({ target: { pane: g * 10 + a + 1 }, name: `agent ${g}.${a}`, worktree }));
  }
  const view = View.init(80, 31, true, 99, entries.length).withEntries(entries);
  expect(view.offset).toBe(8);
  const lines = hostText(draw(view, entries, []), 80, 31).split("\n");
  expect(lines[29]).toContain("agent 3.2");
  expect(lines[30]).toContain("~");
  // Past another workspace's worktree, its two pinned headers would leave
  // three rows empty at the end; they give way instead.
  const shape = "GddWaaWaWaaGddWaa";
  let pane = 0,
    group = 0,
    checkout: Entry["worktree"] = null;
  const grouped = [...shape].map(c => {
    if (c === "G") return entry({ target: { group: ++group }, name: `ws ${group}` });
    if (c === "W") {
      checkout = { workspace: group, path: `/w/${pane}`, ghost: false };
      return entry({ target: { worktree: checkout.path, workspace: group }, name: "wt", worktree: checkout });
    }
    return entry({ target: { pane: ++pane }, name: `agent ${pane}`, worktree: c === "a" ? checkout : null });
  });
  const end = View.init(80, 29, true, 99, grouped.length).withEntries(grouped);
  expect(end.offset).toBe(10);
  expect(end.pinned(end.offset)).toEqual([8]);
  expect(hostText(draw(end, grouped, []), 80, 29).split("\n")[28]).toContain("~");
});

test("activity sections draw centered headers, worktree labels over their rows", () => {
  const now = 100_000_000;
  const item = (
    pane: number,
    name: string,
    state: string,
    minutes: number,
    fields: Partial<agentSections.Item> = {},
  ) => ({
    key: `pane:${pane}`,
    entry: entry({ target: { pane }, name, provider: "claude", state, attention: "none", paused: pane === 5 }),
    workspace: 1,
    checkout: null,
    since: now - minutes * 60_000,
    pin: null,
    rank: 0,
    section: section(state, "none", pane === 5),
    ...fields,
  });
  const entries = agentSections.arrange(
    [
      item(1, "Zig bump", "idle", 180, { pin: 0 }),
      item(2, "Fix ssh test", "blocked", 2),
      item(3, "Linux build", "blocked", 9, { checkout: "/repo/release" }),
      item(4, "Sidebar", "working", 0),
      item(5, "Docs", "idle", 40),
      item(6, "Old idea", "idle", 300),
    ],
    { all: false, folded: new Set(), workspaces: [1], label: (_, checkout) => checkout?.slice(6) ?? "main" },
  );
  const view = View.init(100, 44, true, 0, entries.length).withEntries(entries);
  const lines = hostText(draw(view, entries, [], now), 100, 44)
    .split("\n")
    .map(line =>
      [...line]
        .slice(0, view.width - 1)
        .join("")
        .trimEnd(),
    );
  const start = lines.findIndex(line => line.includes("starred"));
  // Second lines with a corgi on them vary with its animation.
  expect(lines.slice(start, start + 20)).toEqual([
    "  ━━━━━ ★ starred 1 ━━━━━ ▾",
    "  ○  Zig bump",
    expect.any(String),
    // A blank row parts each section from the one above.
    "",
    "  ━━━━━ ▶ working 4 ━━━━━ ▾",
    "  ▶  Sidebar",
    expect.any(String),
    // Waiting on the user, or paused, an agent stays at work, with its own glyph.
    "  ●  Fix ssh test",
    "     Needs input",
    // A worktree labels the rows that sit together, without moving them.
    "  ⌥  release ┄┄┄┄┄┄┄┄┄┄┄┄┄",
    "  ●  Linux build",
    "     Needs input",
    // After a worktree's rows, the workspace's own checkout is named too.
    "  ⌥  main ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄",
    "  ‖  Docs",
    expect.any(String),
    "",
    "  ━━━━━━ ○ idle 1 ━━━━━━━ ▾",
    "  ○  Old idea",
    expect.any(String),
    "",
  ]);
  // Its name takes the needs-input color.
  expect(draw(view, entries, [], now)).toContain("\x1b[1m" + fg("warm") + "Fix ssh test");
});
test("an opening section scrolls to show all of it, or when too long, just its first agent", () => {
  const rows = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) =>
      entry({
        target: { pane: from + i },
        name: `agent ${from + i}`,
        provider: "claude",
        state: "idle",
        section: "idle",
      }),
    );
  const head = (section: "working" | "idle") =>
    entry({
      target: { section },
      name: section,
      group: { agents: 0, working: 0, attention: 0, folded: false, current: false, gap: section === "idle" },
    });
  const short = [head("working"), ...rows(4, 1), head("idle"), ...rows(2, 10)];
  let view = View.init(100, 30, true, 0, short.length).withEntries(short);
  // It fits: the list scrolls just enough to show all of it.
  const fit = view.revealSection(5);
  const shown = View.init(100, 30, true, fit, short.length).withEntries(short);
  expect(fit).toBeLessThanOrEqual(5);
  expect(shown.reveal(short.length - 1)).toBe(fit);
  expect(shown.reveal(5)).toBe(fit);
  const long = [head("working"), ...rows(4, 1), head("idle"), ...rows(19, 10)];
  view = View.init(100, 30, true, 0, long.length).withEntries(long);
  // Too long to fit: the header and its first agent show, without the header jumping to the top.
  const offset = view.revealSection(5);
  expect(offset).toBeLessThan(5);
  const scrolled = View.init(100, 30, true, offset, long.length).withEntries(long);
  expect(scrolled.reveal(6)).toBe(offset);
});
test.each([null, "/repo/topic"])("opening a large section reveals its first agent past subhead %s", checkout => {
  const rows = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => entry({ target: { pane: from + i }, name: `agent ${from + i}` })),
    entries = [
      entry({ target: { section: "working" } }),
      ...rows(1, 5),
      entry({
        target: { section: "idle" },
        group: { agents: 10, working: 0, attention: 0, folded: false, current: false, gap: true },
      }),
      entry({ target: { section: "idle", workspace: 1, checkout, run: 0 } }),
      ...rows(6, 10),
    ],
    view = View.init(100, 30, true, 0, entries.length).withEntries(entries),
    offset = view.revealSection(6),
    shown = View.init(100, 30, true, offset, entries.length).withEntries(entries);
  expect(shown.reveal(8)).toBe(offset);
  expect(shown.reveal(6)).toBe(offset);
  expect(offset).toBeLessThan(6);
});
test("the agent list's menu moves up to fit when the header sits low", () => {
  const view = View.init(100, 16, true, 0, 0).withWorkspaces(3, 0);
  const b = ScopeMenu.bounds(view, 100, 16);
  expect(b.h).toBe(8);
  expect(b.y + b.h).toBeLessThanOrEqual(15);
  expect(b.y).toBeLessThan(view.middle() + 1);
  expect(ScopeMenu.hit(view, 100, 16, 5, b.y + 5)).toBe("activity");
});
test("a row stepping aside draws off its place, never over the list's header", () => {
  const view = View.init(100, 30, true, 0, 2),
    entries = ["Alpha", "Beta"].map((name, i) =>
      entry({ target: { pane: i + 1 }, name, provider: "claude", state: "idle", attention: "none" }),
    );
  const lines = () =>
    hostText(draw(view, entries, [workspaceEntry({ id: 1, name: "ws", cwd: "", active: true })], 0)).split("\n");
  const row = (text: string, screen: string[]) => screen.findIndex(line => line.includes(text));
  const settled = lines();
  entries[1].slide = 2;
  expect(row("Beta", lines())).toBe(row("Beta", settled) + 2);
  // A click finds the row where it shows.
  const beta = row("Beta", settled) + 2;
  expect(view.withEntries(entries).hit(5, beta)).toEqual({ tag: "entry", entry: 1 });
  expect(view.withEntries(entries).hit(5, row("Beta", settled))).toEqual({ tag: "none" });
  entries[0].slide = -2;
  const pushed = lines();
  expect(row("Alpha", pushed)).toBe(-1);
  expect(pushed.slice(0, row("Alpha", settled))).toEqual(settled.slice(0, row("Alpha", settled)));
});
test("clicks follow the top row when successive reorders overlap animations", () => {
  const base = [1, 2, 3, 4].map(pane =>
    entry({ target: { pane }, name: `Agent ${pane}`, provider: "claude", state: "idle" }),
  );
  for (const graphics of [false, true]) {
    const state = new sidebarRows.State();
    state.update(1, base, [], 1000);
    state.update(1, [base[0], base[1], base[3], base[2]], [], 2000);
    for (const now of [2070, 2090, 2110, 2140, 2300]) {
      const entries = state.update(1, [base[0], base[2], base[1], base[3]], [], now),
        view = View.init(100, 30, true, 0, entries.length).withEntries(entries);
      view.supports_kitty_graphics = graphics;
      view.cell = graphics ? { width: 10, height: 20 } : null;
      const lines = hostText(draw(view, entries, [], now)).split("\n");
      expect(lines.some(line => line.includes("Agent 4"))).toBe(true);
      for (let y = 0; y < lines.length; y++) {
        const shown = entries.findIndex(e => lines[y].includes(e.name));
        if (shown >= 0) expect(view.hit(8, y)).toEqual({ tag: "entry", entry: shown });
      }
    }
  }
});

test.each(["normal", "search", "fade", "ghost", "graphics", "agents", "workspaces"] as const)(
  "positioned sidebar matches buffered output for %s rows",
  mode => {
    const checkout = { workspace: 1, path: "/repo/branch", ghost: false },
      entries = [
        entry({
          target: { group: 1 },
          name: "project",
          group: { agents: 3, working: 2, attention: 0, folded: false, current: true },
        }),
        entry({
          target: { pane: 99101 },
          name: "running 界",
          provider: "codex",
          state: "working",
          activity: "editing",
          focused: true,
        }),
        entry({ target: { worktree: checkout.path, workspace: 1 }, name: "branch", worktree: checkout }),
        entry({
          target: { pane: 99102 },
          name: "other",
          provider: "claude",
          state: "working",
          activity: "reading",
          worktree: checkout,
        }),
        entry({ target: { pane: 99103 }, name: "waiting", provider: "claude", state: "blocked" }),
      ],
      workspaces = [
        workspaceEntry({
          id: 1,
          name: "project",
          cwd: "/repo",
          active: true,
          agents: 3,
          working: 2,
          unread: 1,
          resources: hot,
        }),
      ];
    let view = View.init(100, 40, true, 0, entries.length).withEntries(entries).withWorkspaces(1, 0);
    view.corgi_intensity = 0;
    view.focus = "agents";
    if (mode === "search") view = view.withSearch({ text: "running", cursor: 5, selection: [1, 4] });
    if (mode === "fade" || mode === "graphics") {
      entries[1].exit = { frame_ms: 5000, progress: 0.4 };
      entries[3].enter = 0.3;
      entries[4].moved = { from: 0, ms: 150 };
      view.spotlight = { workspace: 1, path: checkout.path };
    }
    if (mode === "graphics") {
      view.supports_kitty_graphics = true;
      view.cell = { width: 8, height: 16 };
    }
    if (mode === "ghost") {
      entries[2].worktree = { ...checkout, ghost: true };
      entries[3].worktree = { ...checkout, ghost: true, end: true };
      view = view.withEntries(entries);
    }
    if (mode === "agents" || mode === "workspaces") view.drawer = mode;
    for (const origin of [0, 7]) {
      const expected = bufferedSidebar(view, entries, workspaces, 5000),
        writer = new Writer(origin);
      writer.write("prefix");
      view.drawAt(writer, entries, workspaces, 5000);
      expect(writer.s).toBe("prefix" + shifted(expected, origin));
      expect(writer.column).toBe(origin);
      writer.clear();
      view.searchCursor(writer);
      const cursor = new Writer();
      view.searchCursor(cursor);
      expect(writer.s).toBe(shifted(cursor.s, origin));
    }
  },
);

test("positioned git details keep nested columns and cursor save/restore unchanged", () => {
  const workspace = workspaceEntry({
    id: 1,
    name: "repo",
    cwd: "/repo",
    active: true,
    git_ahead: 1,
    git_diff: { files: 3, insertions: 120, deletions: 4 },
    git_commits: [
      {
        hash: "abc1234",
        subject: "change",
        author: "A",
        date: "2026-10-23",
        timestamp: 0,
        diff: { files: 2, insertions: 100, deletions: 3 },
      },
    ],
  });
  const plain = new Writer(),
    positioned = new Writer(9);
  drawGitTooltip(plain, workspace, 100, 30, 0, 0);
  drawGitTooltip(positioned, workspace, 100, 30, 0, 0);
  expect(positioned.s).toBe(shifted(plain.s, 9));
  expect(positioned.s).toContain("\x1b7");
  expect(positioned.s).toContain("\x1b8");
});

test("positioned activity sections and overflow badges keep their column offsets", () => {
  const entries = [
      entry({
        target: { section: "working" },
        group: { agents: 12, working: 12, attention: 0, folded: false, current: false },
      }),
      entry({ target: { section: "working", workspace: 1, checkout: "/topic", run: 0 }, name: "topic" }),
      ...Array.from({ length: 12 }, (_, index) =>
        entry({ target: { pane: 99300 + index }, name: `agent ${index}`, state: "working", section: "working" }),
      ),
    ],
    view = View.init(100, 30, true, 0, entries.length).withEntries(entries);
  view.corgi_intensity = 0;
  const expected = bufferedSidebar(view, entries, [], 5000),
    writer = new Writer(7);
  view.drawAt(writer, entries, [], 5000);
  expect(writer.s).toBe(shifted(expected, 7));
});

/** A rename open on `target` with the caret at the end of `text`, as the controller opens one. */
const renaming = (target: RenameTarget, text: string, fallback = "", message: string | null = null): RenameState => {
  const field = Dialog.init("agent" in target ? { agent: target.agent } : { workspace_name: target.workspace }, text);
  field.selected = false;
  field.position(field.len);
  return { target, field, message, fallback };
};
const three_workspaces = [1, 2, 3].map(id => workspaceEntry({ id, name: `ws${id}`, cwd: "/tmp", active: id === 1 }));
const agents = (n: number) =>
  Array.from({ length: n }, (_, i) => entry({ target: { pane: i + 1 }, name: `agent ${i}`, provider: "claude" }));

test("the rename field takes a row's name columns and says where its message goes", () => {
  const entries = agents(4);
  const view = View.init(100, 30, true, 0, entries.length).withWorkspaces(3, 0).withEntries(entries);
  // The name starts a column into the lists and runs to the git column.
  expect(view.fieldRect({ workspace: 1 }, three_workspaces)).toEqual({ x: 2, y: 2, width: 19, message_y: 3 });
  expect(view.fieldRect({ workspace: 3 }, three_workspaces)).toEqual({ x: 2, y: 8, width: 19, message_y: 9 });
  // Agent rows start two below the header; the name has the row past its dot.
  expect(view.fieldRect({ agent: 1 }, three_workspaces)).toEqual({ x: 5, y: 16, width: 21, message_y: 17 });
  expect(view.fieldRect({ agent: 4 }, three_workspaces)).toEqual({ x: 5, y: 22, width: 21, message_y: 23 });
  expect(view.fieldRect({ workspace: 9 }, three_workspaces)).toBeNull();
  expect(view.fieldRect({ agent: 9 }, three_workspaces)).toBeNull();
  expect(View.init(100, 30, false, 0, 0).fieldRect({ workspace: 1 }, three_workspaces)).toBeNull();
  expect(View.init(100, 30, false, 0, 0).fieldRect({ agent: 1 }, three_workspaces)).toBeNull();
  // Readings off shorten the workspace rows; the agent list moves with the split.
  const compact = View.init(100, 30, true, 0, entries.length, 10).withWorkspaces(3, 0).withEntries(entries);
  compact.resources = { enabled: false };
  expect(compact.fieldRect({ workspace: 3 }, three_workspaces)!.y).toBe(6);
  expect(compact.fieldRect({ agent: 1 }, three_workspaces)!.y).toBe(12);
  // The figure and the notes keep their columns at the right.
  const busy = entries.map(e => ("pane" in e.target && e.target.pane === 2 ? { ...e, notes: 2 } : e));
  expect(view.withEntries(busy).fieldRect({ agent: 2 }, three_workspaces)!.width).toBe(21 - 8);
});

test("a renamed row scrolled out of its list has no field, and the last visible line puts the message above", () => {
  const workspaces = Array.from({ length: 8 }, (_, i) =>
    workspaceEntry({ id: i + 1, name: `ws${i + 1}`, cwd: "/tmp", active: i === 0 }),
  );
  const entries = agents(20);
  const view = View.init(100, 30, true, 3, entries.length).withWorkspaces(8, 2).withEntries(entries);
  expect(view.workspaceCapacity()).toBe(4);
  expect(view.fieldRect({ workspace: 2 }, workspaces)).toBeNull();
  expect(view.fieldRect({ workspace: 3 }, workspaces)).toEqual({ x: 2, y: 2, width: 19, message_y: 3 });
  expect(view.fieldRect({ workspace: 6 }, workspaces)!.y).toBe(11);
  expect(view.fieldRect({ workspace: 7 }, workspaces)).toBeNull();
  expect(view.offset).toBe(3);
  expect(view.fieldRect({ agent: 3 }, workspaces)).toBeNull();
  expect(view.fieldRect({ agent: 4 }, workspaces)!.y).toBe(16);
  expect(view.fieldRect({ agent: 10 }, workspaces)!.y).toBe(28);
  expect(view.fieldRect({ agent: 11 }, workspaces)).toBeNull();
  // Boxed, the list ends a row higher: the seventh row shows its name line only.
  const boxed = View.init(100, 30, true, 0, entries.length);
  boxed.focus = "agents";
  const focused = boxed.withEntries(entries);
  expect(focused.fieldRect({ agent: 6 }, workspaces)).toEqual({ x: 5, y: 26, width: 21, message_y: 27 });
  expect(focused.fieldRect({ agent: 7 }, workspaces)).toEqual({ x: 5, y: 28, width: 21, message_y: 27 });
  expect(focused.fieldRect({ agent: 8 }, workspaces)).toBeNull();
});

test("the workspaces drawer finds a visible workspace row's field", () => {
  const workspaces = Array.from({ length: 12 }, (_, i) =>
    workspaceEntry({ id: i + 1, name: `ws${i + 1}`, cwd: "/tmp", active: i === 0 }),
  );
  const open = View.init(100, 30, true, 0, 0);
  open.drawer = "workspaces";
  const view = open.withWorkspaces(12, 0);
  expect(view.fieldRect({ workspace: 9 }, workspaces)).toEqual({ x: 2, y: 26, width: 19, message_y: 27 });
  expect(view.fieldRect({ workspace: 10 }, workspaces)).toBeNull();
  expect(view.fieldRect({ agent: 1 }, workspaces)).toBeNull();
  const agents_drawer = View.init(100, 30, true, 0, 0);
  agents_drawer.drawer = "agents";
  expect(agents_drawer.withWorkspaces(12, 0).fieldRect({ workspace: 1 }, workspaces)).toBeNull();
  const lines = hostText(draw(view.withRename(renaming({ workspace: 9 }, "ninth")), [], workspaces)).split("\n");
  expect(lines[26].startsWith("  ninth ")).toBe(true);
  expect(lines[26]).not.toContain("ws9");
});

test("a renamed row shows its field in place of the name, muted fallback while empty", () => {
  const entries = agents(3);
  const workspaces = three_workspaces.map(ws => (ws.id === 2 ? { ...ws, git_ahead: 3 } : ws));
  const view = View.init(100, 30, true, 0, entries.length).withWorkspaces(3, 0).withEntries(entries);
  const fill = new Style({ fg: "text", bg: "surface" }).sgr();
  const hint = new Style({ fg: "muted", bg: "surface" }).sgr();
  let out = draw(view.withRename(renaming({ workspace: 2 }, "renamed")), entries, workspaces);
  let lines = hostText(out).split("\n");
  expect(lines[5].startsWith("  renamed  ")).toBe(true);
  expect(lines[5]).not.toContain("ws2");
  // The rest of the row keeps its place, and the other rows their names.
  expect(lines[5]).toContain("↑3");
  expect(lines[2]).toContain("ws1");
  expect(lines[16]).toContain("agent 0");
  expect(has(out, fill + " ".repeat(19))).toBe(true);
  expect(has(out, fill + "renamed")).toBe(true);
  out = draw(view.withRename(renaming({ workspace: 2 }, "", "project")), entries, workspaces);
  lines = hostText(out).split("\n");
  expect(lines[5].startsWith("  project ")).toBe(true);
  expect(has(out, hint + "project")).toBe(true);
  out = draw(view.withRename(renaming({ agent: 2 }, "tagged")), entries, workspaces);
  lines = hostText(out).split("\n");
  // The field starts where the name stood.
  expect(
    hostText(draw(view, entries, workspaces))
      .split("\n")[18]
      .indexOf("agent 1"),
  ).toBe(5);
  expect(lines[18].slice(5, 12)).toBe("tagged ");
  expect(lines[18]).not.toContain("agent 1");
  expect(lines[16]).toContain("agent 0");
  expect(lines[20]).toContain("agent 2");
  expect(has(out, fill + " ".repeat(21))).toBe(true);
  out = draw(view.withRename(renaming({ agent: 2 }, "", "Claude")), entries, workspaces);
  expect(hostText(out).split("\n")[18].slice(5, 12)).toBe("Claude ");
  expect(has(out, hint + "Claude")).toBe(true);
  // A rename on a row that isn't listed changes nothing.
  view.corgi_intensity = 0;
  expect(draw(view.withRename(renaming({ agent: 9 }, "lost")), entries, workspaces, 5000)).toBe(
    draw(view, entries, workspaces, 5000),
  );
});

test("a rename's message takes the line below the field, or the one above on the list's last line", () => {
  const entries = agents(3);
  const view = View.init(100, 30, true, 0, entries.length).withWorkspaces(3, 0).withEntries(entries);
  let out = draw(view.withRename(renaming({ workspace: 2 }, "x", "", "Busy: try again")), entries, three_workspaces);
  let lines = hostText(out).split("\n");
  expect(lines[6].startsWith("  Busy: try again")).toBe(true);
  expect(has(out, fg("hot") + "Busy: try again")).toBe(true);
  // Clipped to the sidebar, short of the border.
  const long = "Could not rename this workspace";
  lines = hostText(draw(view.withRename(renaming({ workspace: 2 }, "x", "", long)), entries, three_workspaces)).split(
    "\n",
  );
  expect(lines[6].slice(2, 28)).toBe("Could not rename this w… │");
  out = draw(view.withRename(renaming({ agent: 2 }, "x", "", "Busy: try again")), entries, three_workspaces);
  lines = hostText(out).split("\n");
  expect(lines[18].slice(5, 7)).toBe("x ");
  expect(lines[19].startsWith("  Busy: try again")).toBe(true);
  // The seventh row of a boxed list shows its name line alone: the message goes above.
  const many = agents(20);
  const boxed = View.init(100, 30, true, 0, many.length);
  boxed.focus = "agents";
  const focused = boxed.withEntries(many).withRename(renaming({ agent: 7 }, "seventh", "", "Busy: try again"));
  lines = hostText(draw(focused, many, three_workspaces)).split("\n");
  expect(lines[28].slice(5, 12)).toBe("seventh");
  expect(lines[27].startsWith("│ Busy: try again")).toBe(true);
  expect(lines[29].slice(0, 28)).toBe("└" + "─".repeat(26) + "┘");
});

test("a name longer than the field shows its tail, and the caret follows it", () => {
  const entries = agents(3);
  const view = View.init(100, 30, true, 0, entries.length).withWorkspaces(3, 0).withEntries(entries);
  const long = "a very long workspace name indeed";
  const renamed = view.withRename(renaming({ workspace: 2 }, long));
  const lines = hostText(draw(renamed, entries, three_workspaces)).split("\n");
  expect(lines[5].slice(2, 21)).toBe("kspace name indeed ");
  const caret = (v: View) => {
    const w = new Writer();
    v.renameCursor(w, three_workspaces);
    return w.buffered();
  };
  expect(caret(renamed)).toBe("\x1b[0m\x1b[6;21H\x1b[?25h");
  expect(caret(view.withRename(renaming({ workspace: 1 }, "ws")))).toBe("\x1b[0m\x1b[3;5H\x1b[?25h");
  expect(caret(view.withRename(renaming({ workspace: 1 }, "", "folder")))).toBe("\x1b[0m\x1b[3;3H\x1b[?25h");
  expect(caret(view.withRename(renaming({ agent: 1 }, "abc")))).toBe("\x1b[0m\x1b[17;9H\x1b[?25h");
  // The caret sits where the field's text has it, not at its end.
  const inside = renaming({ agent: 1 }, "abc");
  inside.field.position(1);
  expect(caret(view.withRename(inside))).toBe("\x1b[0m\x1b[17;7H\x1b[?25h");
  expect(caret(view)).toBe("");
  expect(caret(view.withRename(renaming({ agent: 9 }, "lost")))).toBe("");
  const scrolled = View.init(100, 30, true, 3, 20).withWorkspaces(3, 0).withEntries(agents(20));
  expect(caret(scrolled.withRename(renaming({ agent: 1 }, "gone")))).toBe("");
});
