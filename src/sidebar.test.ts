// Mirrors the tests in sidebar.zig.
import { expect, test } from "bun:test";
import * as palette from "./palette";
import { Style, colors, fg, fgRgb, bgRgb, mix, underline } from "./palette";
import * as corgiAnimation from "./corgi_animation";
import * as corgiFrames from "./corgi_frames";
import { Terminal } from "./pane/terminal";
import { View as ContextView } from "./usage/context_window";
import { Writer, displayWidth, writeClipped, writeDirectory, directoryLabel } from "./text";
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
} from "./sidebar";

const selected_bg = palette.bg("selected");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const has = (haystack: string, needle: string) => haystack.includes(needle);
const draw = (view: View, entries: Entry[], workspaces: WorkspaceEntry[], now?: number) => {
  const w = new Writer();
  if (now === undefined) view.draw(w, entries, workspaces);
  else view.drawAt(w, entries, workspaces, now);
  return w.buffered();
};
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

test("compact paths preserve root and folder within column budget", () => {
  let w = new Writer();
  writeDirectory(w, "~/dev/personal/corgi", 15);
  expect(w.s).toBe("~/.../corgi");
  w = new Writer();
  writeDirectory(w, "/very/long/parent/项目", 12);
  expect(w.s).toBe("/.../项目");
  w = new Writer();
  writeDirectory(w, "~/extraordinarilylongfolder", 14);
  expect(displayWidth(w.s)).toBeLessThanOrEqual(14);
  expect(w.s.endsWith("folder")).toBe(true);
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
    compacting_since: 500_000,
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
    [92_500, "Compacting…     1m 32s"],
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
  expect(hostText(draw(view.withWidth(23), [e], [], 92_500))).not.toContain("1m 32s");
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
  expect(b.h).toBe(4);
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 1)).toBe("workspace");
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 2)).toBe("all");
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 3)).toBeNull();
  expect(ScopeMenu.hit(view, 100, 30, 5, b.y + 5)).toBeNull();
  expect(ScopeMenu.hit(view, 100, 30, b.x, b.y + 1)).toBeNull();
  const w = new Writer();
  new ScopeMenu().draw(w, view, 100, 30, workspaces, "all");
  const text = hostText(w.s);
  const lines = text.split("\n");
  expect(lines[b.y + 1].trimEnd()).toBe("  │   This workspace     3 │");
  expect(lines[b.y + 2].trimEnd()).toBe("  │ ✓ All                4 │");
  expect(lines[b.y + 3].trimEnd()).toBe("  ╰────────────────────────╯");
  for (const ws of workspaces) expect(text).not.toContain(ws.name);
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
  // 14 rows leave five list rows above the bottom one: three entries where
  // only two agents fit. Scrolled into a group, its pinned header takes one.
  const view = View.init(100, 14, true, 0, entries.length).withEntries(entries);
  expect(view.capacity).toBe(3);
  expect(view.maxOffset()).toBe(5);
  expect(view.reveal(3)).toBe(2);
  expect(View.init(100, 14, true, 99, entries.length).withEntries(entries).offset).toBe(5);
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
  const scrolled = View.init(100, 14, true, 99, entries.length).withEntries(entries);
  expect(scrolled.offset).toBe(4);
  expect(scrolled.pinned(4)).toEqual([0, 2]);
  expect(scrolled.pinned(2)).toEqual([0]);
  expect(rows(scrolled, 5)).toEqual([
    " ▾ corgi ━━━━━━━━━━━━━━ 3○ │",
    " ├▾ ⌥ one ───────────── 2○ │",
    " ╰○  second                ┃",
    "     Session ended         ┃",
    " ▸ blog ━━━━━━━━━━━━━━━ 1○ ┃",
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
  // 24 rows leave ten list rows above the bottom one: five agents.
  const fits = View.init(80, 24, true, 0, 5).withEntries(entries.slice(0, 5));
  expect(fits.thumb()).toBeNull();
  expect(has(draw(fits, entries.slice(0, 5), [], 0), "┃")).toBe(false);
  const top = View.init(80, 24, true, 0, entries.length).withEntries(entries);
  expect(top.thumb()!.start).toBe(0);
  expect(top.thumb()!.len).toBe(8);
  expect(View.init(80, 24, true, 99, entries.length).withEntries(entries).thumb()!.start).toBe(2);
  const out = draw(top, entries, [], 0);
  expect(count(out, "┃")).toBe(8);
  expect(has(out, "\x1b[14;28H")).toBe(true);
  expect(has(out, "/6")).toBe(false);
  expect(top.hit(5, top.rows - 2)).toEqual(H("entry", 4));
  // The search hint takes the bottom row.
  const searching = View.init(80, 24, true, 0, 5).withSearch({ text: "", cursor: 0 }).withEntries(entries.slice(0, 5));
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
  view.focus = "agents";
  let lines = box(view);
  expect(lines[12]).toBe(" ".repeat(27) + "│");
  expect(lines[13]).toBe(edge("┌", "┤"));
  expect(lines[20]).toBe("│" + " ".repeat(26) + "│");
  expect(lines[29]).toBe(edge("└", "┘"));
  expect([0, 12, 13, 29].map(y => view.outlines(y))).toEqual([false, false, true, true]);
  view.focus = "workspaces";
  lines = box(view);
  expect(lines[1]).toBe(edge("┌", "┤"));
  expect(lines[13]).toBe(edge("└", "┤"));
  expect(lines[29]).toBe(" ".repeat(27) + "│");
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
  expect(View.init(100, 30, true, 0, 0, 10).listRows()).toBe(17);
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
