import { expect, spyOn, test } from "bun:test";
import { Workspaces } from "./machine_sidebar";
import { Endpoint, type Status } from "./machine_connection";
import { Probe } from "./terminal_info";
import { Host } from "./host";
import * as sidebar from "./sidebar";
import * as corgiBadge from "./corgi_badge";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";
import { Controller } from "./controller";
import * as preferences from "./preferences";
import { Snapshot, Work, Process } from "./trackers/resources";

function endpoint(name: string): Endpoint {
  const profile =
    name === "local" ? null : { name, target: name, executable: "/corgi", socket: "/socket", home: "/home" };
  const endpoint = new Endpoint(profile, "/socket", new Probe(), new Host());
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
  expect(view.machineScope()).toBe("");
  const [a, b] = view.workspaceRows();
  // The first machine's rows keep their ids; another's are set apart.
  expect(a.id).toBe(1);
  expect(view.rowOf(b.id)).toEqual({ machine: remote.machine, id: 1 });
  expect(b.unavailable).toContain("Reconnecting");
  expect(b.connecting).toBe(true);
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
  // A replacement daemon: the cached rows name nothing on it.
  remote.instance = "replacement";
  view.selectRow(b.id);
  expect(chosen).toHaveLength(1);
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
  const original = screen(side, local.workspaces);
  side.workspace_scope = view.machineScope();
  expect(screen(side, local.workspaces)).toBe(original);
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
  const resources = (key: number) => (view as any).rowResources(key) as Snapshot | null;
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
  expect(displayed).toMatch(/work\s+● online/);
  workspaces.move(2);
  workspaces.selectFilter();
  expect(view.machineScope()).toBe("work");
  expect(view.workspaceRows().map(row => row.name)).toEqual(["work project"]);
  remote.pause();
  expect(view.workspaceRows()[0].unavailable).toContain("Paused");
  expect(view.workspaceRows()[0].connecting).toBe(false);
  workspaces.show();
  workspaces.retry();
  expect<Status>(remote.status).toBe("connecting");
  expect(workspaces.visible).toBe(true);
});

test("ghost workspace cards retain status and readings, with a connection indicator", () => {
  const row = sidebar.workspaceEntry({
    id: 1,
    name: "my project",
    cwd: "/project",
    active: true,
    working: 2,
    machine: "work",
  });
  Object.assign(row.resources, { known: true, cpu: 17, memory: 12582912n });
  const side = sidebar.View.init(100, 30, true, 0, 0).withWidth(44).withWorkspaces(1, 0);
  side.resources.enabled = true;
  const live = screen(side, [row]).split("\n");
  row.unavailable = "Connecting…";
  const ghost = screen(side, [row]).split("\n");
  expect(ghost[2]).toBe(live[2]);
  expect(ghost[3]).toContain("▶2");
  expect(ghost[3]).toContain("work ×");
  expect(ghost[4]).toBe(live[4]);
  expect(ghost[4]).toContain("CPU 17%");
  expect(ghost[4]).toContain("Memory 12M");
  row.connecting = true;
  const first = frame(side, [row], "", 0);
  const next = frame(side, [row], "", 800);
  expect(first.text).toContain("work ↔");
  expect(next.text).toBe(first.text);
  expect(next.lines[2]).not.toBe(first.lines[2]);
  expect(next.lines[3]).not.toBe(first.lines[3]);
  expect(next.lines.filter((line, i) => line !== first.lines[i])).toHaveLength(2);
  expect(frame(side, [row], "", 2000)).toEqual(first);
  row.connecting = false;
  expect(frame(side, [row], "", 800)).toEqual(frame(side, [row], "", 0));
  row.connecting = true;
  row.machine = "a-machine-name-wider-than-the-sidebar";
  expect(screen(side, [row], "", 80)).toContain("… ↔");
});
test("connection transitions never move workspace content or status hitboxes", () => {
  for (const width of [24, 28, 44])
    for (const machine of ["work", "a-machine-name-wider-than-the-sidebar"])
      for (const active of [false, true])
        for (const resources of [false, true]) {
          const row = sidebar.workspaceEntry({
            id: 1,
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
            row.unavailable = connecting ? "Connecting…" : "Paused";
            row.connecting = connecting;
            for (const now of [0, 400, 800, 1200, 1600])
              expect(screen(side, [row], "", now).replace(/[↔×]/g, " ")).toBe(live);
            expect(side.unreadRange(row)).toEqual(unread);
          }
          row.unavailable = "";
          row.connecting = false;
          expect(screen(side, [row])).toBe(live);
        }
});
test("cached rows stay bound to the old daemon while its replacement is loading", () => {
  const {
    endpoints: [, remote],
    view,
    chosen,
  } = world("local", "work");
  const old = view.workspaceRows()[1].id;
  remote.instance = "new-daemon";
  expect(view.workspaceRows()[1].id).toBe(old);
  view.selectRow(old);
  expect(chosen).toEqual([]);
  remote.workspaces_instance = remote.instance;
  view.selectRow(view.workspaceRows()[1].id);
  expect(chosen).toEqual([{ machine: "work", workspace: 1 }]);
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
    expect(other.view.workspaceRows().map(row => row.id)).toEqual([before[0], before[2], before[1]]);
    const grouped = view.sidebarView([]);
    expect([0, 1, 2].map(i => grouped.workspaceHeader(i))).toEqual([true, true, true]);
  } finally {
    save.mockRestore();
  }
});
