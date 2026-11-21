import { Parser } from "./terminal_input";
import { expect, spyOn, test } from "bun:test";
import { Machine } from "./machine";
import { Controller } from "./controller";
import { Endpoint, localEndpoint } from "./machine_connection";
import { Probe } from "./terminal_info";
import { Host } from "./host";
import { State } from "./navigation";
import { Runtime } from "./mirror";
import { transport } from "./fixtures/transport";
import * as viewer from "./viewer";
import * as protocol from "./protocol";
import * as sidebar from "./sidebar";

const snapshot = () => ({
  workspaces: [1, 2, 3].map(id => ({
    id,
    name: `workspace-${id}`,
    cwd: "/tmp",
    model: {
      nodes: [{ pane: id * 10 }, { pane: id * 10 + 1 }],
      tabs: [
        { id: id * 10, root: 0, title: `first-${id}` },
        { id: id * 10 + 1, root: 1, title: `second-${id}` },
      ],
      revision: 0,
    },
  })),
  panes: [10, 11, 20, 21, 30, 31].map(id => ({ id, name: `pane-${id}`, cols: 80, rows: 24 })),
});
/** The daemon's view: `session` when it changed, and `controls`. */
const reply = (session: object | null, controls: protocol.Wire<protocol.Control[]>) =>
  ({
    type: "view",
    viewer_protocol: protocol.viewer_version,
    session,
    session_hash: 0n,
    resources: null,
    resources_hash: 0n,
    surfaces: [],
    controls,
    viewer: 1,
    bell_seq: 0n,
    bell_kind: "none",
    detach: false,
  }) as unknown as protocol.Reply<"viewer.sync">;
const never = transport(async () => {
  throw Error("UnexpectedRequest");
});

test("selection survives an unloaded catalog and resolves only against an authoritative snapshot", () => {
  const runtime = new Runtime(),
    navigation = new State();
  navigation.switchWorkspace(runtime.workspaces, 3);
  expect(navigation.current(runtime.workspaces).id).toBe(0);
  expect(navigation.workspace_id).toBe(3);
  runtime.receive(never, snapshot());
  expect(navigation.current(runtime.workspaces).id).toBe(3);
  runtime.receive(never, { workspaces: snapshot().workspaces.slice(0, 2) });
  expect(navigation.current(runtime.workspaces).id).toBe(1);
  expect(() => navigation.switchWorkspace(runtime.workspaces, 99)).toThrow("NoWorkspace");
  runtime.destroy();
});

test("a selected cached workspace is highlighted immediately, before its metadata arrives", async () => {
  const endpoint = localEndpoint("/tmp/corgi-loading-test/control.sock", new Probe(), new Host());
  const view = new Controller(endpoint.machine);
  endpoint.controller = view;
  endpoint.workspaces = [1, 2, 3].map(id =>
    sidebar.workspaceEntry({ id, name: `workspace-${id}`, cwd: "/tmp", active: id === 1 }),
  );
  // Include a second machine so the sidebar uses the cached catalog.
  const local = localEndpoint("/tmp/corgi-loading-test/local.sock", new Probe(), new Host());
  view.adopt(local.machine);
  try {
    endpoint.choose({ workspace: 3 }, endpoint.instance);
    expect(endpoint.machine.navigation.workspace_id).toBe(3);
    expect(
      view
        .workspaceRows()
        .filter(w => w.active)
        .map(w => w.name),
    ).toEqual(["workspace-3"]);
    const loading = endpoint.render();
    expect(typeof loading === "string" ? loading : loading.text()).toContain("Loading tabs…");
    view.receiveSnapshot(snapshot());
    expect(view.current().id).toBe(3);
    const rendered = endpoint.render();
    const frame = typeof rendered === "string" ? rendered : rendered.text();
    expect(frame).toContain("first-3");
    expect(frame).toContain("Loading pane…");
    expect(frame).not.toContain("No panes.");
  } finally {
    await endpoint.close();
    await local.close();
  }
});

test("workspace and tab input runs while a network update is unresolved, and shell input waits for it", async () => {
  const endpoint = localEndpoint("/tmp/corgi-input-loading-test/control.sock", new Probe(), new Host());
  const view = new Controller(endpoint.machine);
  endpoint.controller = view;
  view.input_state.attached = true;
  view.receiveSnapshot(snapshot());
  let finish!: () => void;
  const step = spyOn(endpoint as unknown as { step(): Promise<boolean> }, "step").mockImplementation(
    () => new Promise<boolean>(resolve => (finish = () => resolve(true))),
  );
  try {
    endpoint.pump(true);
    await Reflect.get(endpoint, "ui_task");
    const side = view.sidebarView([]);
    for (const input of new Parser().feed(
      Buffer.from(`\x1b[<0;3;${side.workspaceY(2) + 1}M\x1b[<0;3;${side.workspaceY(2) + 1}m`),
    ))
      endpoint.enqueue(input);
    endpoint.pump(true);
    await Reflect.get(endpoint, "ui_task");
    expect(view.current().id).toBe(3);
    for (const input of new Parser().feed(Uint8Array.from([2, 110, 120]))) endpoint.enqueue(input);
    endpoint.pump(true);
    await Reflect.get(endpoint, "ui_task");
    expect(endpoint.machine.navigation.tabs(endpoint.machine.runtime.workspaces).active).toBe(1);
    expect(endpoint.machine.runtime.panes.flatMap(p => p.terminal.pending)).toEqual([120]);
    expect(step).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    await Reflect.get(endpoint, "task");
    step.mockRestore();
    await endpoint.close();
  }
});

test("a late viewer.open default cannot replace a newer workspace or tab selection", async () => {
  let finish!: (value: unknown) => void;
  const conn = transport(async op => {
    if (op === "viewer.open") return new Promise(resolve => (finish = resolve));
    if (op === "session.snapshot") return snapshot();
    return {};
  });
  const view = new Controller(conn);
  view.host.prefs.onboarding_complete = true;
  const opening = viewer.open(view, "/tmp", {});
  view.receiveSnapshot(snapshot());
  view.switchWorkspace(2);
  view.switchWorkspace(3);
  view.focusPane(31);
  finish({ viewer_protocol: protocol.viewer_version, workspace: 1, focus: 10, bell_seq: 0 });
  try {
    await opening;
    expect(view.current().id).toBe(3);
    expect(view.focused()?.id).toBe(31);
  } finally {
    viewer.close(view);
  }
});

test("terminal input waits in its pane before its surface and after navigating away", async () => {
  const endpoint = localEndpoint("/tmp/corgi-surface-loading-test/control.sock", new Probe(), new Host());
  const view = new Controller(endpoint.machine);
  endpoint.controller = view;
  view.receiveSnapshot(snapshot());
  try {
    endpoint.status = "online";
    endpoint.fresh = endpoint.ready = true;
    const pane = endpoint.machine.runtime.pane(10)!;
    pane.terminal.send("early");
    view.switchWorkspace(2);
    pane.terminal.send("late");
    expect(Buffer.from(pane.terminal.pending).toString()).toBe("earlylate");
    endpoint.render();
    expect(endpoint.ready).toBe(false);
  } finally {
    await endpoint.close();
  }
});

test("a focus from another daemon instance cannot select a reused workspace ID", async () => {
  const endpoint = localEndpoint("/tmp/corgi-replaced-selection-test/control.sock", new Probe(), new Host());
  const view = new Controller(endpoint.machine);
  endpoint.controller = view;
  endpoint.instance = "new-daemon";
  view.receiveSnapshot(snapshot());
  view.switchWorkspace(2);
  try {
    endpoint.choose({ workspace: 3 }, "old-daemon");
    expect(view.current().id).toBe(2);
  } finally {
    await endpoint.close();
  }
});

test("rendering and navigation wait to subscribe until viewer attachment completes", async () => {
  const requests: string[] = [];
  let finish!: (value: unknown) => void;
  const conn = transport(async op => {
    requests.push(op);
    if (op === "viewer.open") return new Promise(resolve => (finish = resolve));
    if (op === "session.snapshot") return snapshot();
    return {};
  });
  const view = new Controller(never),
    machine = new Machine(conn);
  view.host.prefs.onboarding_complete = true;
  view.adopt(machine);
  view.receiveSnapshot(snapshot(), machine);
  view.switchMachine(machine);
  view.switchWorkspace(2);
  try {
    view.frame();
    view.updateLaunchPreview();
    expect(requests).not.toContain("agent.subscribe");
    const opening = viewer.open(view, "/tmp", {});
    view.frame();
    view.updateLaunchPreview();
    expect(requests).not.toContain("agent.subscribe");
    finish({ viewer_protocol: protocol.viewer_version, workspace: 1, focus: 10, bell_seq: 0 });
    await opening;
    expect(view.current().id).toBe(2);
    expect(requests).toContain("agent.subscribe");
    const subscribed = requests.filter(op => op === "agent.subscribe").length;
    view.resetConnection();
    view.switchWorkspace(3);
    view.frame();
    view.updateLaunchPreview();
    expect(requests.filter(op => op === "agent.subscribe")).toHaveLength(subscribed);
  } finally {
    viewer.close(view);
  }
});

test("a focus control that comes before the session showing its pane waits for it", async () => {
  const endpoint = localEndpoint("/tmp/corgi-control-wait-test/control.sock", new Probe(), new Host());
  const view = new Controller(endpoint.machine);
  endpoint.controller = view;
  const machine = endpoint.machine;
  const two = snapshot();
  two.workspaces = two.workspaces.slice(0, 2);
  two.panes = two.panes.filter(p => p.id < 30);
  try {
    await viewer.receive(view, reply(two, []), { seq: 0n }, false, machine);
    const focus = [{ seq: 1, kind: "focus", id: 31 }] as protocol.Wire<protocol.Control[]>;
    await viewer.receive(view, reply(null, focus), { seq: 0n }, false, machine);
    expect(machine.waiting_controls).toEqual(focus);
    expect(machine.last_control).toBe(0n);
    expect(view.message).toBe("");
    machine.waiting_controls = [];
    await viewer.receive(view, reply(snapshot(), focus), { seq: 0n }, false, machine);
    expect(machine.waiting_controls).toEqual([]);
    expect(machine.last_control).toBe(1n);
    expect(view.focused()?.id).toBe(31);
  } finally {
    await endpoint.close();
  }
});

test("a focus control waits past any time limit while the daemon says its pane is there, and goes once it says it's gone", async () => {
  let there = true;
  const machine = new Machine(
    transport(async op => {
      const full = snapshot();
      if (op === "session.snapshot" && !there) full.panes = full.panes.filter(p => p.id !== 31);
      return full;
    }),
  );
  const view = new Controller(machine);
  // A session from before pane 31's workspace was made.
  const without = snapshot();
  without.workspaces = without.workspaces.slice(0, 2);
  without.panes = without.panes.filter(p => p.id < 30);
  const focus = [{ seq: 1, kind: "focus", id: 31 }] as protocol.Wire<protocol.Control[]>;
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  const receive = async () => {
    await viewer.receive(view, reply(null, focus), { seq: 0n }, false, machine);
    await Bun.sleep(0);
  };
  try {
    await viewer.receive(view, reply(without, []), { seq: 0n }, false, machine);
    await receive();
    expect(machine.control_check?.state).toBe("there");
    // Long past the old two seconds, the session that shows it may still come.
    clock.mockReturnValue(10_000);
    there = false;
    await receive();
    expect(machine.control_check?.state).toBe("gone");
    expect(machine.last_control).toBe(0n);
    await receive();
    expect(machine.last_control).toBe(1n);
    expect(machine.waiting_controls).toEqual([]);
    expect(view.message).toBe("");
  } finally {
    clock.mockRestore();
    viewer.close(view);
  }
});

test("a machine in the background opens the links its panes ask for, while its other controls wait", async () => {
  const shown = new Machine(never),
    background = new Machine(never, "atlas", true);
  const view = new Controller(shown);
  view.adopt(background);
  const controls = [
    { seq: 1, kind: "action", name: "open-url", value: "http://localhost:3000/" },
    { seq: 2, kind: "focus", id: 31 },
    { seq: 3, kind: "action", name: "open-url", value: "https://example.com/" },
  ] as protocol.Wire<protocol.Control[]>;
  expect(viewer.leadingLinks(controls)).toEqual(controls.slice(0, 1));
  await viewer.receive(view, reply(null, controls), { seq: 0n }, false, background);
  expect(view.effects).toEqual([{ open_url: "http://localhost:3000/", machine: background.id }]);
  expect(background.last_control).toBe(1n);
  // The focus waits for its machine to be shown, and the link behind it with it.
  expect(background.waiting_controls).toEqual(controls.slice(1));
});
