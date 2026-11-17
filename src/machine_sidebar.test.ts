import * as viewerRef from "./viewer_ref";
import { localEndpoint } from "./machine_connection";
import { sshEndpoint } from "./ssh_path";
import { expect, setSystemTime, spyOn, test } from "bun:test";
import { Workspaces } from "./machine_sidebar";
import * as machineAdd from "./machine_add";
import { Endpoint, type Status } from "./machine_connection";
import { Probe } from "./terminal_info";
import { Host } from "./host";
import * as sidebar from "./sidebar";
import * as corgiBadge from "./corgi_badge";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";
import { Controller } from "./controller";
import * as preferences from "./preferences";
import * as palette from "./palette";
import { Snapshot, Work, Process } from "./trackers/resources";
import { transport } from "./fixtures/transport";
import * as worktrees from "./fixtures/worktrees";

function endpoint(name: string): Endpoint {
  const endpoint =
    name === "local"
      ? localEndpoint("/socket", new Probe(), new Host())
      : sshEndpoint(
          { name, target: name, executable: "/corgi", socket: "/socket", home: "/home" },
          new Probe(),
          new Host(),
        );
  endpoint.instance = endpoint.workspaces_instance = `${name}-daemon`;
  endpoint.workspaces = [sidebar.workspaceEntry({ id: 1, name: `${name} project`, cwd: "/project", active: true })];
  return endpoint;
}
/** Machines shown by one view, as the machine viewer builds it. */
function world(...names: string[]) {
  const endpoints = names.map(endpoint);
  const view = new Controller(endpoints[0].machine, new Host());
  for (const e of endpoints) {
    view.adopt(e.machine);
    e.controller = view;
  }
  const chosen: { machine: string; workspace: number | null }[] = [];
  view.onMachine = (machine, focus) =>
    void chosen.push({ machine: machine.name, workspace: focus && "workspace" in focus ? focus.workspace : null });
  return { endpoints, view, chosen, workspaces: new Workspaces(endpoints, view) };
}
test("with this computer alone, the dropdown opens only to add a machine", () => {
  const { endpoints, view, workspaces } = world("local");
  workspaces.show();
  expect(workspaces.open).toBe(false);
  const adds = new machineAdd.Adds({ hosts: () => ["devbox"], saved: () => [], add: () => new Promise(() => {}) });
  const picker = new Workspaces(endpoints, view, adds);
  expect(picker.visible).toBe(false);
  picker.show();
  expect(picker.open).toBe(true);
  expect(picker.list.rows().map(row => row.kind)).toEqual(["all", "machine", "divider", "host"]);
});

test("opening the machine dropdown cancels a worktree entry waiting for history", async () => {
  const { view, workspaces } = world("local", "work");
  try {
    view.launch_previews.connect(transport(async () => ({ ok: true })));
    view.receiveSnapshot({
      workspaces: [
        {
          id: 1,
          name: "app",
          cwd: "/src/app",
          worktrees: worktrees.app(),
          model: { nodes: [], tabs: [], revision: 0 },
        },
      ],
      panes: [],
    });
    await view.perform({ name: "worktrees", value: view.workspaceRef(1) });
    await view.perform({ name: "worktree-enter" });
    expect(view.worktree_card.pending_enter).not.toBeNull();
    workspaces.show();
    expect(workspaces.open).toBe(true);
    view.launch_previews.applyHistory({ full: true, entries: [] });
    view.launch_previews.changed = true;
    view.updateLaunchPreview();
    expect(view.agent_launcher).toBeNull();
    expect(workspaces.open).toBe(true);
  } finally {
    view.launch_previews.disconnect();
    view.runtime.destroy();
  }
});
function screen(side: sidebar.View, entries: sidebar.WorkspaceEntry[], extra = "", now = 0): string {
  return frame(side, entries, extra, now).text;
}
function frame(side: sidebar.View, entries: sidebar.WorkspaceEntry[], extra = "", now = 0) {
  const writer = new Writer();
  side.drawAt(writer, [], entries, now);
  const terminal = new Terminal(side.cols, side.rows);
  try {
    terminal.feed(writer.buffered() + extra);
    return { text: terminal.text(), lines: terminal.surface(0).surface.lines };
  } finally {
    terminal.destroy();
  }
}
test("all workspaces list each machine's rows by their own ids, cached ones until it answers", () => {
  const {
    endpoints: [local, remote],
    view,
    chosen,
  } = world("local", "work");
  local.status = "online";
  expect(view.machineScope()).toBe("all");
  const [a, b] = view.workspaceRows();
  // Even local rows are qualified; both daemons may use the same local ID.
  expect(a.id).toBe(view.workspaceRef(1, local.machine));
  expect(view.rowOf(b.id)).toEqual({ machine: remote.machine, id: 1 });
  expect(b.unavailable).toContain("Connecting");
  // It glimmers once connecting has taken a second.
  expect(b.connecting).toBe(false);
  Reflect.set(remote, "connecting", { since: performance.now() - 1000, from: null });
  expect(view.workspaceRows()[1].connecting).toBe(true);
  expect(b.active).toBe(false);
  view.selectRow(b.id);
  expect(chosen).toEqual([{ machine: "work", workspace: 1 }]);
  remote.updated = 1;
  remote.status = "online";
  expect(view.machineScope()).toBe("all");
  expect(view.workspaceRows()[1].unavailable).toBe("");
  expect(view.workspaceRows()[1].connecting).toBe(false);
  remote.status = "offline";
  expect(view.machineScope()).toBe("all");
  expect(view.workspaceRows()[1].name).toBe("work project");
  expect(view.workspaceRows()[1].unavailable).toContain("offline");
  // A replacement daemon: select the machine, not an obsolete workspace ID.
  remote.instance = "replacement";
  view.selectRow(b.id);
  expect(chosen).toEqual([
    { machine: "work", workspace: 1 },
    { machine: "work", workspace: null },
  ]);
});
test("a connecting machine's glimmer asks for a frame at its next step", () => {
  const {
    endpoints: [local, remote],
    view,
  } = world("local", "work");
  local.status = "online";
  view.width = 100;
  view.height = 30;
  view.prefs.corgi_intensity = 0;
  setSystemTime(new Date(10_030));
  try {
    // Its first second connecting is quiet: no glimmer, nothing to animate.
    view.compose(false);
    expect(view.nextFrame()).toBe(Infinity);
    Reflect.set(remote, "connecting", { since: performance.now() - 1000, from: null });
    view.compose(false);
    expect(view.nextFrame()).toBe(10_080);
    setSystemTime(new Date(10_080));
    view.compose(false);
    expect(view.nextFrame()).toBe(10_160);
    remote.updated = 1;
    remote.status = "online";
    view.compose(false);
    expect(view.nextFrame()).toBe(Infinity);
  } finally {
    setSystemTime();
    view.runtime.destroy();
  }
});
test("selecting a cached row on the shown machine waits for its live workspace", () => {
  const {
    endpoints: [, remote],
    view,
    chosen,
  } = world("local", "work");
  view.switchMachine(remote.machine);
  const row = view.workspaceRows().find(row => view.rowOf(row.id)?.machine === remote.machine)!;
  expect(remote.machine.runtime.workspaces.items).toHaveLength(0);
  view.selectRow(row.id);
  expect(chosen).toEqual([{ machine: "work", workspace: 1 }]);
});
test("a local-only viewer has the unchanged header and no machine decoration", () => {
  const {
    endpoints: [local],
    view,
    workspaces,
  } = world("local");
  local.status = "online";
  workspaces.show();
  expect(workspaces.open).toBe(false);
  const side = sidebar.View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
  const original = screen(
    side,
    view.workspaceRows().filter(row => view.rowOf(row.id)?.machine === local.machine),
  );
  side.workspace_scope = view.machineScope();
  expect(
    screen(
      side,
      view.workspaceRows().filter(row => view.rowOf(row.id)?.machine === local.machine),
    ),
  ).toBe(original);
  expect(side.workspaceScope()).toBeNull();
});
test("resource cards read each row's own machine and reject a replaced or disconnected daemon", () => {
  const {
    endpoints: [local, remote],
    view,
    workspaces,
  } = world("local", "work");
  for (const [index, e] of [local, remote].entries()) {
    e.status = "online";
    e.machine.runtime.resources = Object.assign(new Snapshot(), {
      cores: index + 2,
      workspaces: [
        Object.assign(new Work(1), { known: true, cpu: 10, processes: [new Process(index + 100, 1n, e.name)] }),
      ],
    });
  }
  const resources = (key: viewerRef.Workspace) => (view as any).rowResources(key);
  const detail = spyOn(view, "resourceDetail");
  try {
    const rows = view.workspaceRows();
    for (const [index, row] of rows.entries()) {
      const snapshot = resources(row.id)!;
      expect(snapshot.cores).toBe(index + 2);
      expect(snapshot.workspaces[0].id).toBe(row.id);
      expect(snapshot.workspaces[0].processes[0].pid).toBe(index + 100);
      expect([local, remote][index].machine.runtime.resources.workspaces[0].id).toBe(1);
      detail.mockReturnValue(row.id);
      workspaces.watchResources();
      expect(Reflect.get(local, "resource_detail")).toBe(index === 0 ? 1 : null);
      expect(Reflect.get(remote, "resource_detail")).toBe(index === 1 ? 1 : null);
    }
    remote.status = "offline";
    expect(resources(rows[1].id)).toBeNull();
    remote.status = "online";
    remote.instance = "new-daemon";
    expect(resources(rows[1].id)).toBeNull();
    detail.mockReturnValue(rows[1].id);
    workspaces.watchResources();
    expect(Reflect.get(remote, "resource_detail")).toBeNull();
  } finally {
    detail.mockRestore();
  }
});
test("the inline filter fits beside the badge and its hitbox follows the drawn text", () => {
  for (const width of [24, 28, 32, 40, 60])
    for (const mode of ["none", "emoji", "image"] as const) {
      const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(width);
      side.corgi_badge = mode;
      side.workspace_scope = "all";
      const box = side.workspaceScope()!;
      expect(corgiBadge.overlaps(box)).toBe(false);
      expect(side.hit(box.x, 0).tag).toBe("workspace_scope");
      expect(side.hit(box.x + box.w - 1, 0).tag).toBe("workspace_scope");
      const header = screen(side, []).split("\n")[0];
      expect(header).toContain("all ▾");
      if (width >= 32) {
        expect(header).toContain("workspaces all ▾");
        expect(box.x).toBe(mode === "none" ? 13 : 17);
      }
      expect(header).toContain("[ + ]");
      const add = header.indexOf("[ + ]");
      for (let x = add; x < add + 5; x++) expect(side.hit(x, 0).tag).toBe("workspace_new");
      expect(header).toContain("<");
    }
});
test("the dropdown filters rows and keeps statuses available through outages", () => {
  const {
    endpoints: [local, remote],
    view,
    workspaces,
  } = world("local", "work");
  local.status = remote.status = "online";
  remote.updated = 1;
  workspaces.show();
  const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(28).withWorkspaces(2, 0);
  side.workspace_scope = "all";
  const displayed = screen(side, view.workspaceRows(), workspaces.draw(side));
  expect(displayed).toContain("All workspaces");
  expect(displayed).toMatch(/work\s+online ●/);
  workspaces.move(2);
  workspaces.selectFilter();
  expect(view.machineScope()).toBe("work");
  expect(view.workspaceRows().map(row => row.name)).toEqual(["work project"]);
  remote.status = "incompatible";
  expect(view.workspaceRows()[0].unavailable).toContain("Incompatible");
  expect(view.workspaceRows()[0].connecting).toBe(false);
  workspaces.show();
  workspaces.retry();
  expect<Status>(remote.status).toBe("connecting");
  expect(workspaces.visible).toBe(true);
});
test("^X twice in a row removes the highlighted SSH machine, never this computer", () => {
  const {
    endpoints: [local, remote],
    view,
    workspaces,
  } = world("local", "work");
  local.status = remote.status = "online";
  remote.updated = 1;
  workspaces.show();
  const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(28);
  const shown = () => screen(side, view.workspaceRows(), workspaces.draw(side));
  expect(shown()).toContain(" ^X  remove   !  details");
  workspaces.cursor = 1;
  expect([workspaces.remove(), workspaces.remove()]).toEqual([null, null]);
  workspaces.cursor = 2;
  expect(workspaces.remove()).toBeNull();
  expect(shown()).toMatch(/work\s+\^X  again to remove/);
  // Moving off it, or away and back, asks again.
  workspaces.move(-1);
  workspaces.move(1);
  expect(shown()).not.toContain("again");
  expect(workspaces.remove()).toBeNull();
  expect(workspaces.remove()).toBe(remote);
  expect(shown()).not.toContain("again");
});
test("a removed machine leaves the sidebar, its filter and the dropdown; its header menu removes it", async () => {
  const {
    endpoints: [local, remote],
    endpoints,
    view,
    workspaces,
  } = world("local", "work");
  local.status = remote.status = "online";
  remote.updated = 1;
  const removed: string[] = [];
  view.onRemoveMachine = machine => removed.push(machine.name);
  view.openMachineMenu(local.machine, 1, 2);
  expect(view.tab_menu).toBeNull();
  view.openMachineMenu(remote.machine, 1, 2);
  expect(view.tab_menu!.entries().map(entry => entry.label)).toEqual(["Fold", "Remove machine"]);
  expect(view.tab_menu!.highlightedItem()).toBe("fold");
  await Reflect.get(view, "key").call(view, "f".charCodeAt(0));
  expect([remote.machine.collapsed, view.tab_menu]).toEqual([true, null]);
  view.openMachineMenu(remote.machine, 1, 2);
  expect(view.tab_menu!.entries()[0].label).toBe("Unfold");
  await Reflect.get(view, "key").call(view, "x".charCodeAt(0));
  expect([removed, view.tab_menu]).toEqual([["work"], null]);
  // The viewer lets it go, and the highlight keeps to a row.
  workspaces.show();
  workspaces.cursor = 2;
  view.machine_filter = remote.machine;
  endpoints.splice(1, 1);
  view.forget(remote.machine);
  workspaces.settle();
  expect(workspaces.cursor).toBe(1);
  expect(view.machine_filter).toBeNull();
  expect(view.workspaceRows().map(row => row.name)).toEqual(["local project"]);
  expect(workspaces.visible).toBe(false);
  // The machine shown can't be let go.
  view.forget(local.machine);
  expect(view.machines).toEqual([local.machine]);
});

test("under a divider, the dropdown lists the SSH config's other hosts, searches as typed, and ↵ adds one in place", () => {
  const {
    endpoints: [local, remote],
    endpoints,
    view,
  } = world("local", "work");
  local.status = remote.status = "online";
  remote.updated = 1;
  const runs: { name: string; target: string }[] = [];
  const adds = new machineAdd.Adds({
    hosts: () => ["work", "devbox", "pi"],
    saved: () => [],
    add: (name, target) => {
      runs.push({ name, target });
      return new Promise(() => {});
    },
  });
  const workspaces = new Workspaces(endpoints, view, adds);
  workspaces.show();
  const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(28).withWorkspaces(2, 0);
  side.workspace_scope = "all";
  const rows = () => frame(side, [], workspaces.draw(side)).text.split("\n");
  const open = rows();
  expect(open[3]).toMatch(/│ +Search or type a host +│/);
  expect(open[4]).toMatch(/✓ all +All workspaces/);
  expect(open[5]).toMatch(/local +online ●/);
  expect(open[6]).toMatch(/work +online ●/);
  expect(open[7]).toMatch(/├─+┤/);
  expect(open[8]).toMatch(/│ +devbox +│/);
  expect(open[9]).toMatch(/│ +pi +│/);
  const bottom = open.findIndex(line => line.includes("╰"));
  // Down from the last machine steps over the divider, and up steps back.
  workspaces.cursor = 2;
  workspaces.move(1);
  expect(workspaces.list.row()).toMatchObject({ kind: "host", name: "devbox" });
  expect(rows()[8]).toMatch(/devbox +add/);
  workspaces.move(-1);
  expect(workspaces.cursor).toBe(2);
  // The field and the divider are no rows to press, but inside the box.
  const x = open[7].indexOf("├") + 2;
  expect([3, 7, 8].map(y => workspaces.hit(side, x, y))).toEqual(["inside", "inside", 4]);
  expect(workspaces.hit(side, x, 20)).toBeNull();
  // Typing searches, and offers a host nothing names; the box stays put.
  for (const byte of Buffer.from("nas")) workspaces.list.key(byte);
  let shown = rows();
  expect(shown[3]).toMatch(/│  nas +│/);
  // The cursor sits in the field, past what's typed.
  const field_x = shown[3].indexOf("nas");
  expect(workspaces.draw(side)).toEndWith(`\x1b[4;${field_x + 4}H\x1b[?25h`);
  expect(shown[4]).toMatch(/├─+┤/);
  expect(shown[5]).toMatch(/\+ nas/);
  expect(shown.findIndex(line => line.includes("╰"))).toBe(bottom);
  expect(workspaces.list.row()).toMatchObject({ kind: "host", target: "nas", typed: true });
  // Typing reaches no host: until ↵, its row only says ↵ adds it.
  expect(rows()[5]).toMatch(/\+ nas +add/);
  // ↵ adds it, and the list stays open with the add's progress.
  expect(workspaces.selectFilter()).toBe(false);
  expect([workspaces.open, runs]).toEqual([true, [{ name: "nas", target: "nas" }]]);
  expect(rows()[5]).toMatch(/\+ nas +Checking…/);
  expect(view.machineScope()).toBe("all");
  // Esc leaves the search before the dropdown.
  expect(workspaces.list.leave()).toBe(true);
  shown = rows();
  expect(shown[3]).toMatch(/Search or type a host/);
  workspaces.hide();
  expect(workspaces.list.query).toBeNull();
});
test("machine filter colors connection states and measured reception, including clipped notes", () => {
  const {
    endpoints: [local, remote],
    view,
    workspaces,
  } = world("local", "a-long-remote-machine-name");
  local.status = "online";
  remote.updated = 1;
  workspaces.show();
  // A connect after a stall shows at once.
  const cases: [Status, palette.Token, string][] = [
    ["online", "accent", "▂▄▆█"],
    ["stalled", "warm", "Connection"],
    ["connecting", "warm", "Connecting"],
    ["offline", "hot", "offline"],
    ["incompatible", "hot", "Incompatible"],
  ];
  remote.stats.answer(20, false);
  // The remote's row is under the field, "all" and local.
  for (const width of [28, 44, 64]) {
    const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(width);
    for (const [status, color, label] of cases) {
      remote.status = status;
      for (const cursor of [0, 2]) {
        workspaces.cursor = cursor;
        const rendered = frame(side, [], workspaces.draw(side));
        expect(rendered.text.split("\n")[6]).toContain(label);
        expect(rendered.lines[6]).toContain(`38;2;${palette.colors[color].join(";")}`);
        if (status !== "online") expect(rendered.text.split("\n")[6]).not.toContain("▂▄▆█");
      }
    }
  }
  // One from online still looks online for its first second, as the sidebar does.
  const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(64);
  remote.status = "online";
  remote.status = "connecting";
  expect(frame(side, [], workspaces.draw(side)).text.split("\n")[6]).toContain("online ▂▄▆█");
  expect(view.machine_filter).toBeNull();
});

test("ghost workspace cards keep readings and move their connection indicator to the header", () => {
  const row = sidebar.workspaceEntry({
    id: viewerRef.workspace(1, 1),
    name: "my project",
    cwd: "/project",
    active: true,
    working: 2,
    machine: "work",
    link_quality: 4,
  });
  Object.assign(row.resources, { known: true, cpu: 17, memory: 12582912n });
  const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(44).withWorkspaces(1, 0, ["work"]);
  side.resources.enabled = true;
  const live = screen(side, [row]).split("\n");
  expect(live[2]).toContain("▂▄▆█");
  row.unavailable = "Connecting…";
  row.link_quality = 0;
  const ghost = screen(side, [row]).split("\n");
  expect(ghost[2]).toContain("work");
  expect(ghost[2]).toContain("▂▄▆█");
  expect(ghost[3]).toBe(live[3]);
  expect(ghost[4]).toContain("▶2");
  expect(ghost[4]).not.toMatch(/work|↔|×/);
  expect(ghost[5]).toBe(live[5]);
  expect(ghost[5]).toContain("CPU 17%");
  expect(ghost[5]).toContain("Memory 12M");
  row.connecting = true;
  row.connection_status = { label: "connecting", seconds: 4, color: "warm" };
  expect(screen(side, [row]).split("\n")[2]).toContain("connecting 4s");
  expect(screen(side, [row]).split("\n")[2]).not.toContain("▂▄▆█");
  const first = frame(side, [row], "", 0);
  const next = frame(side, [row], "", 800);
  expect(next.text).toBe(first.text);
  expect(next.lines[3]).not.toBe(first.lines[3]);
  expect(next.lines.filter((line, i) => line !== first.lines[i])).toHaveLength(1);
  expect(frame(side, [row], "", 2000)).toEqual(first);
  row.connecting = false;
  row.connection_status = null;
  expect(frame(side, [row], "", 800)).toEqual(frame(side, [row], "", 0));
});

test("machine header bands use the palette and keep reception bars right aligned", () => {
  const name = "a-machine-name-wider-than-the-sidebar";
  const row = sidebar.workspaceEntry({
    id: viewerRef.workspace(1, 1),
    name: "project",
    cwd: "/project",
    active: false,
    machine: name,
  });
  try {
    for (const theme of ["corgi", "animal_style"] as const) {
      palette.use(theme, { foreground: [25, 25, 25], background: [245, 245, 245], ansi: Array(16).fill(null) });
      for (const width of [24, 28, 44]) {
        const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(width).withWorkspaces(1, 0, [name]);
        for (const quality of [0, 1, 2, 3, 4, null] as const) {
          row.link_quality = quality;
          const rendered = frame(side, [row]);
          const header = rendered.text.split("\n")[2];
          const indicator = quality === null ? "" : "▂▄▆█";
          if (indicator) expect(header.indexOf(indicator)).toBe(width - 6);
          else expect(header).not.toMatch(/[▁▂▄▆█]/);
          expect(rendered.lines[2]).toContain(`48;2;${palette.colors.surface.join(";")}`);
          expect(rendered.text.split("\n")[3]).toContain("project");
          expect(side.hit(3, 3)).toEqual({ tag: "workspace", workspace: 0 });
        }
      }
    }
  } finally {
    palette.use("corgi");
  }
});

test("build and upload metrics fit on the machine row at both sidebar widths", () => {
  const machine = "nocap";
  const row = sidebar.workspaceEntry({
    id: viewerRef.workspace(1, 1),
    name: "project",
    cwd: "/project",
    active: true,
    machine,
  });
  for (const [label, compact, metrics] of [
    ["Building linux-x64…", "Building…", "12s"],
    ["Uploading", "↑", "42% 512 KiB/s"],
    ["Installing…", "Installing…", ""],
  ]) {
    row.connection_status = { label, compact, metrics, color: "warm", seconds: null };
    for (const width of [28, 44]) {
      const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(width).withWorkspaces(1, 0, [machine]);
      const lines = screen(side, [row]).split("\n");
      expect(lines[2]).toContain("nocap");
      expect(lines[2]).toContain([width === 28 ? compact : label, metrics].filter(Boolean).join(" "));
      expect(lines[3]).toContain("project");
      expect(side.hit(3, 3)).toEqual({ tag: "workspace", workspace: 0 });
    }
  }
  const longName = "build-server-with-a-long-name";
  row.machine = longName;
  row.connection_status = { label: "Uploading", compact: "↑", metrics: "42% 512 KiB/s", color: "warm", seconds: null };
  const narrow = sidebar.View.init(100, 30, true, 0, 0).withWidth(28).withWorkspaces(1, 0, [longName]);
  expect(screen(narrow, [row]).split("\n")[2]).toMatch(/… +(?:↑ +)?42% 512 KiB\/s/);
});

test("header quality comes from the current connection, without rating local or offline machines as healthy", () => {
  const {
    endpoints: [local, remote],
    view,
  } = world("local", "work");
  local.updated = remote.updated = 1;
  // Nothing is measured, nor shown, in a first connect's first second.
  expect(view.workspaceRows().map(row => row.link_quality)).toEqual([null, null]);
  local.status = remote.status = "online";
  expect(view.workspaceRows().map(row => row.link_quality)).toEqual([null, null]);
  local.stats.answer(20, false);
  remote.stats.answer(20, false);
  expect(view.workspaceRows().map(row => row.link_quality)).toEqual([null, 4]);
  for (const status of ["stalled", "offline", "connecting", "incompatible"] as const) {
    remote.status = status;
    expect(view.workspaceRows().map(row => row.link_quality)).toEqual([null, 0]);
  }
});
test("machine headers keep their timer visible when a state or machine name is clipped", () => {
  const {
    endpoints: [local, remote],
    view,
  } = world("local", "a-machine-name-wider-than-the-sidebar");
  local.updated = remote.updated = 1;
  remote.status = "connecting";
  Reflect.set(remote, "task", Promise.resolve());
  Reflect.set(remote, "task_started", performance.now() - 123000);
  Reflect.set(remote, "connecting", { since: performance.now() - 123000, from: null });
  const row = view.workspaceRows()[1];
  expect(row.connection_status?.seconds).toBe(123);
  for (const width of [24, 28, 44]) {
    const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(width).withWorkspaces(1, 0, [row.machine]);
    const header = screen(side, [row]).split("\n")[2];
    expect(header).toContain("123s");
    expect(header).toContain("a-m");
    expect(header).not.toContain("retrying");
    expect(header).not.toContain("▂▄▆█");
    expect(header.indexOf("123s")).toBe(width - 6);
  }
});
test("connection transitions never move workspace content or status hitboxes", () => {
  for (const width of [24, 28, 44])
    for (const machine of ["work", "a-machine-name-wider-than-the-sidebar"])
      for (const active of [false, true])
        for (const resources of [false, true]) {
          const row = sidebar.workspaceEntry({
            id: viewerRef.workspace(1, 1),
            name: "my 世界 project é with a long title",
            cwd: "/project",
            active,
            machine,
            working: 2,
            attention: 1,
            unread: 3,
          });
          Object.assign(row.resources, { known: true, cpu: 17, memory: 12582912n });
          const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(width).withWorkspaces(1, 0);
          side.resources.enabled = resources;
          const live = screen(side, [row]);
          const unread = side.unreadRange(row);
          for (const connecting of [true, false]) {
            row.unavailable = connecting ? "Connecting…" : "Incompatible";
            row.connecting = connecting;
            for (const now of [0, 400, 800, 1200, 1600])
              expect(screen(side, [row], "", now).replace(/[↔×]/g, " ")).toBe(live);
            expect(side.unreadRange(row)).toEqual(unread);
          }
          row.unavailable = "";
          row.connecting = false;
          row.connection_status = null;
          expect(screen(side, [row])).toBe(live);
        }
});
test("cached rows select only the machine while its replacement is loading", () => {
  const {
    endpoints: [, remote],
    view,
    chosen,
  } = world("local", "work");
  const old = view.workspaceRows()[1].id;
  remote.instance = "new-daemon";
  expect(view.workspaceRows()[1].id).toBe(old);
  view.selectRow(old);
  expect(chosen).toEqual([{ machine: "work", workspace: null }]);
  remote.workspaces_instance = remote.instance;
  view.selectRow(view.workspaceRows()[1].id);
  expect(chosen).toEqual([
    { machine: "work", workspace: null },
    { machine: "work", workspace: 1 },
  ]);
});

test("workspaces can be interleaved across disconnected machines and keep their saved order", () => {
  const {
    endpoints: [local, remote],
    view,
  } = world("local", "work");
  local.updated = remote.updated = 1;
  local.workspaces.push(sidebar.workspaceEntry({ id: 2, name: "second local", cwd: "/second", active: false }));
  view.width = 100;
  view.height = 50;
  const save = spyOn(preferences, "update").mockImplementation(() => {});
  try {
    const before = view.workspaceRows().map(row => row.id);
    const side = view.sidebarView([]);
    const from = side.workspaceY(2),
      to = side.workspaceY(1);
    expect(view.workspaceDragInput(5, from, 0, false)).toBe(true);
    view.workspaceDragInput(5, to, 32, false);
    view.workspaceDragInput(5, to, 0, true);
    expect(view.workspaceRows().map(row => row.id)).toEqual([before[0], before[2], before[1]]);
    const saved = [...view.prefs.workspace_order];
    const other = world("local", "work");
    for (const endpoint of other.endpoints)
      endpoint.instance = endpoint.workspaces_instance = `${endpoint.name}-restarted`;
    other.endpoints[0].workspaces = local.workspaces;
    other.endpoints[0].updated = other.endpoints[1].updated = 1;
    other.view.prefs.workspace_order = saved;
    expect(other.view.workspaceRows().map(row => row.id)).toEqual([
      other.view.workspaceRef(1, other.endpoints[0].machine),
      other.view.workspaceRef(1, other.endpoints[1].machine),
      other.view.workspaceRef(2, other.endpoints[0].machine),
    ]);
    const grouped = view.sidebarView([]);
    expect([0, 1, 2].map(i => grouped.workspaceHeader(i))).toEqual([true, true, true]);
  } finally {
    save.mockRestore();
  }
});

test("a machine ordering workspaces by activity keeps its places among the others in its own order", () => {
  const {
    endpoints: [local, remote],
    view,
  } = world("local", "work");
  local.status = remote.status = "online";
  const model = { nodes: [], tabs: [], revision: 0 },
    snapshot = (names: string[], ids: number[], enabled: boolean) => ({
      workspace_auto_order: { enabled, pause_after: 5, stale_after: 10, archive_after: 480 },
      workspaces: ids.map(id => ({ id, name: names[id - 1], cwd: "/project", model })),
    });
  const locals = ["L1", "L2", "L3"],
    remotes = ["W1", "W2"];
  local.machine.runtime.receive(null as any, snapshot(locals, [1, 2, 3], false));
  remote.machine.runtime.receive(null as any, snapshot(remotes, [1, 2], false));
  const names = () => view.workspaceRows(true).map(row => row.name);
  // The viewer interleaves the machines: L1 W1 L2 W2 L3.
  const byName = new Map(view.workspaceRows(true).map(row => [row.name, row.id]));
  view.prefs.workspace_order = ["L1", "W1", "L2", "W2", "L3"].map(name => {
    const row = view.rowOf(byName.get(name)!)!;
    return JSON.stringify([row.machine.order_scope || row.machine.name, row.id]);
  });
  expect(names()).toEqual(["L1", "W1", "L2", "W2", "L3"]);
  // The local daemon orders its own by activity: L3, L1, L2.
  local.machine.runtime.receive(null as any, snapshot(locals, [3, 1, 2], true));
  expect(names()).toEqual(["L3", "W1", "L1", "W2", "L2"]);
  // The other machine, with auto-order off, keeps the viewer's order.
  remote.machine.runtime.receive(null as any, snapshot(remotes, [2, 1], false));
  expect(names()).toEqual(["L3", "W1", "L1", "W2", "L2"]);
});
test("collapsing an interleaved machine hides its cards without changing selection or saved order", () => {
  const {
    endpoints: [local, remote],
    view,
    chosen,
    workspaces,
  } = world("local", "work");
  local.status = remote.status = "online";
  remote.workspaces.push(sidebar.workspaceEntry({ id: 2, name: "second remote", cwd: "/second", active: false }));
  const original = view.workspaceRows().map(row => row.id);
  view.prefs.workspace_order = [original[1], original[0], original[2]].map(id =>
    JSON.stringify([view.rowOf(id)!.machine.order_scope, view.rowOf(id)!.id]),
  );
  const order = [...view.prefs.workspace_order];
  const machine = view.machine;
  view.toggleMachine(remote.machine);
  const folded = view.workspaceRows();
  expect(folded.map(row => row.id)).toEqual([original[1], original[0]]);
  expect(folded[0].collapsed).toBe(true);
  const side = sidebar.View.init(100, 30, true, 0, 0)
    .withWidth(44)
    .withWorkspaces(
      folded.length,
      0,
      folded.map(row => row.machine),
      folded.map(row => row.collapsed),
    );
  const rendered = screen(side, folded);
  expect(rendered).toContain("▸  work");
  expect(rendered).not.toContain("work project");
  expect(rendered).not.toContain("second remote");
  expect(rendered).toContain("local project");
  const header = sidebar.machineHeaderAt(side, 3, 2);
  expect(header?.machine).toBe("work");
  expect(side.hit(3, 2).tag).toBe("none");
  expect(side.hit(3, side.workspaceY(1))).toEqual({ tag: "workspace", workspace: 1 });
  expect(view.machine).toBe(machine);
  expect(chosen).toEqual([]);
  workspaces.show();
  workspaces.cursor = 2;
  workspaces.selectFilter();
  expect(view.machine).toBe(machine);
  expect(chosen).toEqual([]);
  expect(view.workspaceRows()).toHaveLength(1);
  view.toggleMachine(remote.machine);
  expect(view.workspaceRows().map(row => row.id)).toEqual([original[1], original[2]]);
  expect(view.prefs.workspace_order).toEqual(order);
});

test("workspace cycling skips intervention states but retains recovery and reveals collapsed machines", () => {
  const {
    endpoints: [local, remote],
    view,
  } = world("local", "work");
  local.status = "online";
  const select = spyOn(view, "selectRow").mockImplementation(() => {});
  try {
    for (const status of ["incompatible", "attention"] as const) {
      remote.status = status;
      view.navigateWorkspace(false);
      expect(select.mock.calls.at(-1)![0]).toBe(view.workspaceRef(1, local.machine));
    }
    for (const status of ["connecting", "stalled", "offline", "online"] as const) {
      remote.status = status;
      remote.machine.collapsed = true;
      view.navigateWorkspace(false);
      expect(select.mock.calls.at(-1)![0]).toBe(view.workspaceRef(1, remote.machine));
    }
  } finally {
    select.mockRestore();
  }
  view.selectRow(view.workspaceRef(1, remote.machine));
  expect(remote.machine.collapsed).toBe(false);
});

test("new machines expose controls and error badges before their first successful connection", () => {
  const {
    endpoints: [, remote],
    view,
    workspaces,
  } = world("local", "work");
  remote.status = "attention";
  remote.issue = "auth";
  remote.error = "Permission denied (publickey).";
  workspaces.show();
  expect(workspaces.open).toBe(true);
  expect(view.machineScope()).toBe("all");
  const rows = view.workspaceRows();
  const side = sidebar.View.init(100, 30, true, 0, 0)
    .withWidth(44)
    .withWorkspaces(
      rows.length,
      0,
      rows.map(row => row.machine),
    );
  const rendered = screen(side, rows).split("\n");
  const y = side.workspaceY(1) - 1;
  const x = rendered[y].indexOf("! auth");
  expect(x).toBeGreaterThan(0);
  expect(sidebar.machineDiagnosticAt(side, rows, x, y)).toBe(true);
  expect(sidebar.machineDiagnosticAt(side, rows, 3, y)).toBe(false);
});
