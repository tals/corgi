import { expect, test } from "bun:test";
import { Dialog, type Preview, type Agent } from "./workspace_archive";
import { processes, compareAgents, preview as inventory } from "./archive_inventory";
import { Runtime, Pane } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import type { Root } from "./trackers/resources";
import { Writer } from "./text";
import { Rect } from "./layout";

export function preview(): Preview {
  return {
    workspace: 1,
    name: "app",
    agents: [],
    processes: [],
    links: [],
    processes_available: true,
    processes_partial: false,
    links_available: true,
  };
}

test("archive review shows one agent list and keeps all names, processes and links scrollable", () => {
  const dialog = new Dialog(1, "app"),
    p = preview();
  p.agents = Array.from({ length: 12 }, (_, i) => ({
    target: { pane: i + 1 },
    name: `Agent ${i}`,
    provider: "claude",
    activity: "",
    running: i < 5,
    state: i < 5 ? "working" : "idle",
    attention: "none",
    paused: false,
    unread: false,
  }));
  p.processes = Array.from({ length: 80 }, (_, i) => ({ pid: 100 + i, name: `process ${i}`, brand: null }));
  p.links = Array.from({ length: 20 }, (_, i) => `http://localhost:${8000 + i}`);
  dialog.preview = p;
  const text = dialog
    .lines()
    .map(l => l.text)
    .join("\n");
  expect(text).toContain("Agents (12)");
  expect(text).not.toContain("Other open agents");
  expect(text).toContain("Agent 11");
  expect(text).not.toContain("· claude");
  expect(text).toContain("process 79");
  dialog.offset = 10000;
  const view = dialog.view(80, 24),
    out = new Writer();
  view.draw(out);
  expect(out.buffered()).toContain("http://localhost:8019");
  expect(out.buffered()).toContain("Archive workspace");
  expect(view.body_y + view.body_height).toBeLessThan(view.buttons_y);
  expect(dialog.key("\r")).toEqual({ name: "archive-cancel" });
});

test("archive review handles narrow screens and neutralizes terminal controls in external text", () => {
  const dialog = new Dialog(1, "app\x1b[2J"),
    p = preview();
  p.processes = [{ pid: 1, name: "bad\x1b]52;c;secret\x07", brand: null }];
  dialog.preview = p;
  for (const [width, height] of [
    [1, 1],
    [10, 10],
    [30, 15],
    [80, 24],
  ]) {
    const out = new Writer();
    dialog.view(width, height).draw(out);
    expect(out.buffered()).not.toContain("\x1b]");
    expect(out.buffered()).not.toMatch(/\x1b\[-/);
  }
});

test("archive inventory keeps agent child servers, excludes other workspaces, and sorts by process start", () => {
  const root: Root = {
    key: 1,
    pid: 10,
    start: 1n,
    workspace: 1,
    agent_pid: 11,
    provider: "claude",
    pane: 1,
    session: null,
  };
  const items = [
    { pid: 10, parent: 1, start: 1n, name: "bash" },
    { pid: 11, parent: 10, start: 2n, name: "claude" },
    { pid: 12, parent: 11, start: 3n, name: "node" },
    { pid: 13, parent: 11, start: 5n, name: "python" },
    { pid: 14, parent: 1, start: 6n, name: "unrelated" },
  ];
  items.push({ pid: 15, parent: 12, start: 7n, name: "dash" });
  const argv = (pid: number) => (pid === 13 ? ["python3", "-m", "http.server"] : ["node", "server.js"]);
  expect(processes(items, [root], argv)).toEqual([
    { pid: 13, name: "http.server", brand: "python" },
    { pid: 12, name: "server", brand: "node" },
  ]);
  expect(processes(items, [{ ...root, start: 99n }], argv)).toEqual([]);
  expect(processes(items, [{ ...root, provider: null }], argv).map(p => p.name)).not.toContain("bash");
  expect(processes(items, [root], () => ["/bin/sh", "-c", "command"])).toEqual([]);
  expect(processes(items, [root], () => ["node", "/opt/bin/claude"])).toEqual([]);
});

const agent = (fields: Partial<Agent> = {}): Agent => ({
  target: { pane: 1 },
  name: "Claude",
  provider: "claude",
  activity: "",
  running: false,
  state: "idle",
  attention: "none",
  paused: false,
  unread: false,
  ...fields,
});

test("empty process and served-link sections disappear without hiding unavailable process data", () => {
  const d = new Dialog(1, "app");
  d.preview = { ...preview(), agents: [agent()] };
  const text = d
    .lines()
    .map(l => l.text)
    .join("\n");
  expect(text).toBe("Agents (1)\nClaude");
  expect(d.view(80, 24).warning.join(" ")).not.toContain("links");
  d.preview.processes_available = false;
  expect(d.lines().map(l => l.text)).toContain("Process information unavailable");
});

test("archive rows reuse status glyphs and brand marks while keeping long names on one row", () => {
  const d = new Dialog(1, "app");
  d.preview = {
    ...preview(),
    agents: [
      agent({ name: "Long name ".repeat(30), state: "working", running: true }),
      agent({ attention: "finished", unread: true }),
    ],
    processes: [{ pid: 1, name: "server", brand: "bun" }],
  };
  const marks: string[] = [],
    w = new Writer(),
    v = d.view(80, 24);
  expect(v.lines.filter(l => l.row)).toHaveLength(3);
  v.draw(w, (brand, _x, _y) => {
    marks.push(brand);
    return "";
  });
  expect(marks).toEqual(["claude", "claude", "bun"]);
  expect(w.buffered()).toContain("▶");
  expect(w.buffered()).toContain("●");
  expect(w.buffered()).not.toContain("PID");
});

test("archive ordering uses running, unread, then other agents, newest first within each bucket", () => {
  const agents = [
    { name: "other new", running: false, unread: false, since: 900 },
    { name: "working old", running: true, unread: false, since: 10 },
    { name: "unread old", running: false, unread: true, since: 5 },
    { name: "working new", running: true, unread: false, since: 30 },
    { name: "working unread", running: true, unread: true, since: 20 },
    { name: "unread new", running: false, unread: true, since: 40 },
    { name: "other old", running: false, unread: false, since: 600 },
  ];
  expect(agents.sort(compareAgents).map(a => a.name)).toEqual([
    "working new",
    "working unread",
    "working old",
    "unread new",
    "unread old",
    "other new",
    "other old",
  ]);
});

test("archive navigation wraps and reveals every agent above the ghost with matching row clicks", () => {
  const d = new Dialog(1, "app");
  d.preview = {
    ...preview(),
    agents: Array.from({ length: 32 }, (_, i) => agent({ target: { pane: i + 1 }, name: `Task ${i}` })),
  };
  expect(d.key("down")).toEqual({ name: "archive-next" });
  expect(d.key("up")).toEqual({ name: "archive-prev" });
  const area = new Rect(25, 2, 75, 27);
  const box = d.view(100, 30, area).box;
  for (let i = 0; i < 32; i++) {
    d.move(true);
    const v = d.view(100, 30, area);
    v.revealSelection();
    expect(v.box).toEqual(box);
    expect(d.selectedAgent()?.name).toBe(`Task ${i}`);
    expect(d.key("\r")).toEqual({ name: "archive-jump", value: i });
    expect(v.box.y + v.box.h).toBeLessThanOrEqual(area.y + Math.floor(area.h / 2) - 1);
    const y = v.body_y + i + 1 - d.offset;
    expect(y).toBeGreaterThanOrEqual(v.body_y);
    expect(y).toBeLessThan(v.body_y + v.body_height);
    expect(v.hit(v.box.x + 5, y)).toEqual({ name: "archive-jump", value: i });
    const out = new Writer();
    v.draw(out);
    const hidden = 32 - Math.min(32, d.offset + v.body_height - 1);
    if (hidden) expect(out.buffered()).toContain(`... ${hidden} more agents`);
    else expect(out.buffered()).not.toContain("more agents");
  }
  d.move(true);
  expect(d.selected).toBe(0);
  let v = d.view(100, 30, area);
  v.revealSelection();
  expect(v.hit(v.box.x + 5, v.body_y + 1 - d.offset)).toEqual({ name: "archive-jump", value: 0 });
  d.move(false);
  expect(d.selected).toBe(31);
  v = d.view(100, 30, area);
  v.revealSelection();
  expect(v.hit(v.box.x + 5, v.body_y + 32 - d.offset)).toEqual({ name: "archive-jump", value: 31 });
  d.pending = true;
  d.move(false);
  expect(d.selected).toBe(31);
  d.pending = false;
  d.selected = "cancel";
  d.move(false);
  expect(d.selectedAgent()?.name).toBe("Task 31");
  d.selected = "confirm";
  expect(d.view(100, 30, area).box).toEqual(box);
});

test("archive inventory uses real unread and starting state and readable provider names", async () => {
  using r = new Runtime();
  const ws = new Workspace(1, "/tmp", "app");
  r.workspaces.items.push(ws);
  for (let i = 0; i < 4; i++) {
    const p = new Pane(ws.model.newTab(i === 1 ? "Waiting for review" : ""), Terminal.create(40, 10), "/tmp");
    p.agent().provider = "claude";
    p.agent().state = "idle";
    p.agent().changed_at = (i + 1) * 100;
    if (i === 1) p.agent().observation.completed = 1n;
    if (i === 2) ws.starting.add(`pane:${p.id}`);
    if (i === 3) p.agent().state = "blocked";
    r.panes.push(p);
  }
  const p = await inventory(r, 1, false);
  expect(p.agents.map(a => [a.name, a.running, a.unread])).toEqual([
    ["Claude", true, false],
    ["Claude", true, false],
    ["Waiting for review", false, true],
    ["Claude", false, false],
  ]);
});
