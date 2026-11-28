import { test, expect, afterEach, spyOn } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "./server";
import type { View as WireView } from "./protocol";
import * as protocol from "./protocol";
import {
  validateInterests,
  queue,
  targetViewer,
  viewerShowing,
  copy,
  action,
  viewers,
  publish,
  remember,
  open,
  sync,
  surfaces,
  resolveHoverLink,
  hoverLinkRevision,
  image,
  start,
  receipt,
} from "./viewer_protocol";
import { Actor } from "./conversations";
import { Dictionary } from "./link_evidence";
import { Worker } from "./usage/worker";
import { fingerprint } from "./wrapped_link";
import { Pane, Ghost } from "./runtime";
import { Terminal } from "./pane/terminal";
import * as viewer_stream from "./viewer_stream";
import { Snapshot, Work, Process } from "./trackers/resources";
import { Workspace } from "./workspace";
import { version, compatible, require as requireVersion } from "./viewer_version";
import * as client_socket from "./fixtures/client_socket";
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers) {
    server.runtime.destroy();
    Reflect.get(server, "loop").close();
  }
  servers.length = 0;
});
function fixture() {
  const server = new Server("", "", "0".repeat(64));
  servers.push(server);
  return server;
}
function peer(server: Server, id = 1, socket: client_socket.Recorder | null = null) {
  const client = server.addClient(socket, socket !== null);
  client.viewer = true;
  client.viewer_id = id;
  client.view_workspace = 1;
  client.view_focus = 1;
  client.active_seq = id;
  client.interests = [{ pane: 1, cols: 80, rows: 24 }];
  return client;
}

function scheduledViewer() {
  const server = fixture(),
    socket = new client_socket.Recorder(),
    client = peer(server, 1, socket);
  let now = 100,
    next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
    const id = ++next;
    timers.set(id, { at: now + ms, run });
    return id;
  }) as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(id => {
    timers.delete(Number(id));
  });
  const output: any[] = [];
  const queue = spyOn(client, "queue").mockImplementation(value => {
    output.push(value);
  });
  client.stream = { sequence: 1, sent: now, wake: 0n, session_hash: null, resources_hash: null, heartbeat: 250 };
  return {
    server,
    client,
    socket,
    timers,
    output,
    advance(to: number) {
      now = to;
      for (const [id, task] of timers)
        if (task.at <= now) {
          timers.delete(id);
          task.run();
        }
    },
    close() {
      client.close();
      queue.mockRestore();
      timer.mockRestore();
      cancel.mockRestore();
      clock.mockRestore();
    },
  };
}

test("a quiet stream shows it's alive at the interval its viewer asked for", () => {
  const f = scheduledViewer();
  try {
    f.client.stream!.heartbeat = 1000;
    f.client.stream!.wake = 1n;
    f.advance(600);
    publish(f.server, f.client, 1n);
    expect(f.output).toHaveLength(0);
    f.advance(1100);
    publish(f.server, f.client, 1n);
    expect(f.output).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("a throttled stream sends its latest frame at the deadline without a maintenance tick", () => {
  const f = scheduledViewer();
  try {
    f.advance(110);
    publish(f.server, f.client, 1n);
    f.advance(115);
    publish(f.server, f.client, 2n);
    expect(f.timers.size).toBe(1);
    expect([...f.timers.values()][0].at).toBe(116);
    expect(f.output).toHaveLength(0);
    f.advance(116);
    expect(f.output).toHaveLength(1);
    expect(f.client.stream?.wake).toBe(2n);
    expect(f.timers.size).toBe(0);
    publish(f.server, f.client, 2n);
    expect(f.timers.size).toBe(0);
  } finally {
    f.close();
  }
});

test("a blocked stream retains one latest frame and resumes when output drains", () => {
  const f = scheduledViewer();
  try {
    f.socket.buffered = 13;
    publish(f.server, f.client, 1n);
    f.advance(150);
    publish(f.server, f.client, 2n);
    expect(f.timers.size).toBe(0);
    expect(f.output).toHaveLength(0);
    f.socket.buffered = 0;
    f.client.flushed();
    expect(f.timers.size).toBe(1);
    f.advance(150);
    expect(f.output).toHaveLength(1);
    expect(f.client.stream?.wake).toBe(2n);
  } finally {
    f.close();
  }
});

test("stream reconfiguration and client pause cancel deferred frames", () => {
  const f = scheduledViewer();
  try {
    publish(f.server, f.client, 1n);
    expect(f.timers.size).toBe(1);
    remember(f.client, { session_hash: 0n, resources_hash: 0n, surfaces: [] } as any, 1n);
    expect(f.timers.size).toBe(0);
    publish(f.server, f.client, 2n);
    expect(f.timers.size).toBe(1);
    f.client.pause();
    f.advance(200);
    expect(f.output).toHaveLength(0);
    expect(f.timers.size).toBe(0);
  } finally {
    f.close();
  }
});
test("viewer wire version checked on every exchange", () => {
  expect(compatible({ viewer_protocol: version })).toBe(true);
  for (const value of [null, version, {}, { viewer_protocol: String(version) }, { viewer_protocol: version - 1 }])
    expect(() => requireVersion(value)).toThrow("IncompatibleViewerProtocol");
});
test("incremental streams are opt-in and missing handoff state asks for a fresh base", async () => {
  const server = fixture(),
    client = peer(server);
  const request = protocol.decode("viewer.stream", { sequence: 1, interests: [] });
  const legacy = await start(server, client, request);
  expect(legacy.frame).toBeUndefined();
  expect(legacy.view.patches).toBeUndefined();
  expect(client.stream?.delivery).toBeUndefined();
  const next = await start(server, client, { ...request, incremental: true, sequence: 2 });
  expect(next.frame).toBe(1n);
  expect(next.view.patches).toEqual([]);
  expect(receipt(server, client, { sequence: 1, frame: 99n, active: false })).toBe(false);
  expect(receipt(server, client, { sequence: 2, frame: 1n, active: false })).toBe(true);
  client.stream = null;
  expect(receipt(server, client, { sequence: 2, frame: 1n, active: false })).toBe(false);
});
test("interest bounds and repeated pane validation match daemon", () => {
  expect(() => validateInterests([{ pane: 1, cols: 500, rows: 200 }])).not.toThrow();
  for (const i of [
    { pane: 1, cols: 0, rows: 1 },
    { pane: 1, cols: 501, rows: 1 },
    { pane: 1, cols: 1, rows: 201 },
  ])
    expect(() => validateInterests([i])).toThrow("InvalidSize");
  expect(() =>
    validateInterests([
      { pane: 1, cols: 1, rows: 1 },
      { pane: 1, cols: 1, rows: 1 },
    ]),
  ).toThrow("InvalidTarget");
  expect(() => validateInterests(Array(65).fill({ pane: 1, cols: 1, rows: 1 }))).toThrow("TooManyPanes");
});
test("unqualified controls target oldest live viewer and pane routes reject ambiguity", () => {
  const server = fixture(),
    one = peer(server),
    two = peer(server, 2);
  expect(targetViewer(server, null)).toBe(one);
  expect(targetViewer(server, 2)).toBe(two);
  expect(() => viewerShowing(server, 1)).toThrow("AmbiguousViewer");
  one.dead = true;
  expect(viewerShowing(server, 1)).toBe(two);
  expect(() => targetViewer(server, 3)).toThrow("NoViewer");
});
test("controls remain ordered and bounded, and wake their viewer", () => {
  const s = fixture(),
    target = peer(s);
  s.dirty = false;
  queue(s, target, { kind: "focus", id: 1 });
  expect(target.controls[0].seq).toBe(1n);
  expect(s.dirty).toBe(true);
  for (let i = 1; i < 64; i++) queue(s, target, { kind: "focus", id: i });
  expect(() => queue(s, target, { kind: "workspace", id: 1 })).toThrow("ViewerBusy");
});
test("OSC52 copy chooses most recently active interested viewer and replaces pending copy", () => {
  const s = fixture(),
    one = peer(s),
    two = peer(s, 2);
  copy(s, 1, "old");
  queue(s, two, { kind: "focus", id: 3 });
  copy(s, 1, "new");
  expect(one.controls).toHaveLength(0);
  expect(two.controls.map(c => c.kind)).toEqual(["focus", "action"]);
  expect(two.controls.at(-1)?.value).toBe("new");
  expect(two.controls.at(-1)?.seq).toBe(3n);
});
test("relaunch validates absolute executable and goes to viewer showing pane", () => {
  const s = fixture(),
    target = peer(s),
    source = peer(s, 2),
    result = spyOn(source, "queue").mockImplementation(() => {});
  source.viewer = false;
  expect(() => action(s, source, protocol.decode("action", { name: "relaunch", value: "relative", pane: 1 }))).toThrow(
    "InvalidExecutable",
  );
  action(s, source, protocol.decode("action", { name: "relaunch", value: "/usr/bin/corgi", pane: 1 }));
  expect(result).toHaveBeenCalledWith({ ok: true, viewer: 1, queued: true });
  expect(target.controls[0].name).toBe("relaunch");
  expect(viewers(s)).toEqual([{ id: 1, pid: 0, active: 1, workspace: 1, pane: 1, watched: true }]);
});
test("viewers are listed in order with their process and how recently each was used", () => {
  const s = fixture(),
    one = peer(s),
    two = peer(s, 2);
  one.viewer_pid = 111;
  two.viewer_pid = 222;
  one.active_seq = 5;
  two.active_seq = 9;
  expect(viewers(s).map(v => [v.id, v.pid, v.active])).toEqual([
    [1, 111, 5],
    [2, 222, 9],
  ]);
});
test("open from a pane goes to the viewer showing it", () => {
  const s = fixture(),
    one = peer(s),
    two = peer(s, 2),
    source = peer(s, 3),
    result = spyOn(source, "queue").mockImplementation(() => {});
  source.viewer = false;
  two.view_focus = 4;
  action(s, source, protocol.decode("action", { name: "open", value: "/tmp", pane: 4 }));
  expect(result).toHaveBeenCalledWith({ ok: true, viewer: 2, queued: true });
  expect(two.controls[0]).toMatchObject({ kind: "action", name: "open", value: "/tmp" });
  expect(one.controls).toHaveLength(0);
});
test("a pane's link goes to the viewer showing it, else the one used last, when that one opens links", () => {
  const s = fixture(),
    shows = peer(s),
    elsewhere = peer(s, 2),
    over_ssh = peer(s, 3),
    source = peer(s, 4),
    result = spyOn(source, "queue").mockImplementation(() => {});
  source.viewer = false;
  // An older viewer, or one with no browser of its own, isn't asked.
  expect(() => action(s, source, protocol.decode("action", { name: "open-url", value: "http://x/", pane: 1 }))).toThrow(
    "NoViewer",
  );
  shows.links = elsewhere.links = true;
  elsewhere.interests = [{ pane: 9, cols: 80, rows: 24 }];
  over_ssh.interests = [];
  elsewhere.active_seq = 10;
  over_ssh.active_seq = 20;
  action(s, source, protocol.decode("action", { name: "open-url", value: "http://localhost:3000/", pane: 1 }));
  expect(result).toHaveBeenLastCalledWith({ ok: true, viewer: 1, queued: true });
  expect(shows.controls[0]).toMatchObject({ kind: "action", name: "open-url", value: "http://localhost:3000/" });
  // A pane no viewer shows: the one used last, unless it can't open links,
  // when the pane's program opens the link itself rather than on another computer.
  expect(() =>
    action(s, source, protocol.decode("action", { name: "open-url", value: "https://example.com/", pane: 7 })),
  ).toThrow("NoViewer");
  over_ssh.active_seq = 5;
  action(s, source, protocol.decode("action", { name: "open-url", value: "https://example.com/", pane: 7 }));
  expect(result).toHaveBeenLastCalledWith({ ok: true, viewer: 2, queued: true });
  // Nor does one showing the pane, used last, hand it to another that opens links.
  over_ssh.interests = [{ pane: 1, cols: 80, rows: 24 }];
  over_ssh.active_seq = 30;
  expect(() =>
    action(s, source, protocol.decode("action", { name: "open-url", value: "http://localhost:3000/", pane: 1 })),
  ).toThrow("NoViewer");
  // `corgi action open-url` names no pane: it goes to a viewer as any action does.
  shows.links = false;
  action(s, source, protocol.decode("action", { name: "open-url", value: "https://example.com/" }));
  expect(result).toHaveBeenLastCalledWith({ ok: true, viewer: 1, queued: true });
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "https://x/\nrm"])
    expect(() => action(s, source, protocol.decode("action", { name: "open-url", value, pane: 1 }))).toThrow(
      "InvalidURL",
    );
});
test("a viewer says whether it opens links with each sync", async () => {
  const s = fixture();
  s.runtime.workspaces.items.push(new Workspace(1, "/tmp"));
  const client = peer(s);
  spyOn(client, "queue").mockImplementation(() => {});
  await sync(s, client, protocol.decode("viewer.sync", { workspace: 1, interests: [], links: true }));
  expect(client.links).toBe(true);
  await sync(s, client, protocol.decode("viewer.sync", { workspace: 1, interests: [] }));
  expect(client.links).toBe(false);
});
test("an empty workspace does not ask older viewers to detach", async () => {
  const s = fixture();
  s.runtime.workspaces.items.push(new Workspace(1, "/tmp"));
  const client = peer(s),
    sent = spyOn(client, "queue").mockImplementation(() => {});
  await sync(s, client, protocol.decode("viewer.sync", { workspace: 1, interests: [] }));
  expect(sent.mock.calls[0][0]).toMatchObject({ type: "view", detach: false });
});
test("resource receipts reuse published samples across viewers and follow detail and replacement", async () => {
  const s = fixture();
  s.runtime.workspaces.items.push(new Workspace(1, "/tmp"));
  const snapshot = new Snapshot(),
    work = new Work(1);
  work.processes.push(new Process(7, 9n, "worker"));
  snapshot.workspaces.push(work);
  s.runtime.resources.current = snapshot;
  const project = spyOn(snapshot, "forViewer"),
    one = peer(s),
    two = peer(s, 2),
    sent = spyOn(one, "queue").mockImplementation(() => {}),
    other = spyOn(two, "queue").mockImplementation(() => {});
  const request = (client: typeof one, detail: number | null, receipt: bigint | null = null) =>
    sync(
      s,
      client,
      protocol.decode("viewer.sync", {
        workspace: 1,
        interests: [],
        resource_detail: detail,
        resources_hash: receipt,
      }),
    );
  await request(one, null);
  const first = sent.mock.calls.at(-1)![0] as WireView<unknown, Snapshot>;
  expect(first.resources?.workspaces[0].processes).toEqual([]);
  await request(two, null);
  expect((other.mock.calls.at(-1)![0] as WireView).resources_hash).toBe(first.resources_hash);
  await request(one, null, first.resources_hash);
  expect((sent.mock.calls.at(-1)![0] as WireView).resources).toBeNull();
  expect(project).toHaveBeenCalledTimes(1);
  await request(one, 1, first.resources_hash);
  expect((sent.mock.calls.at(-1)![0] as WireView<unknown, Snapshot>).resources?.workspaces[0].processes).toEqual(
    work.processes,
  );
  expect(project).toHaveBeenCalledTimes(2);
  await request(one, null);
  expect(project).toHaveBeenCalledTimes(2);
  s.runtime.resources.current = Object.assign(new Snapshot(), { host_memory: 1234n });
  await request(one, null, first.resources_hash);
  const next = sent.mock.calls.at(-1)![0] as WireView<unknown, Snapshot>;
  expect(next.resources?.host_memory).toBe(1234n);
  expect(next.resources_hash).not.toBe(first.resources_hash);
});
test("surface modes follow the live terminal while a restored ghost supplies its screen", async () => {
  const s = fixture(),
    ws = new Workspace(1, "/tmp");
  s.runtime.workspaces.items.push(ws);
  const id = ws.model.newTab("one"),
    terminal = new Terminal(80, 24),
    pane = new Pane(id, terminal, "/tmp"),
    client = peer(s),
    sent = spyOn(client, "queue").mockImplementation(() => {});
  s.runtime.panes.push(pane);
  terminal.feed("LIVE\x1b[?2004h");
  const request = () =>
    sync(
      s,
      client,
      protocol.decode("viewer.sync", {
        workspace: 1,
        focus: id,
        interests: [{ pane: id, cols: 80, rows: 24 }],
      }),
    );
  await request();
  let view = (sent.mock.calls.at(-1)![0] as WireView).surfaces[0];
  expect(view.modes.bracketed_paste).toBe(true);
  expect(view.surface.lines.join("")).toContain("LIVE");
  const frozen = new Terminal(80, 24);
  frozen.feed("RESTORED");
  pane.ghost = new Ghost(frozen, terminal.surface_revision, "");
  await request();
  view = (sent.mock.calls.at(-1)![0] as WireView).surfaces[0];
  expect(view.modes.bracketed_paste).toBe(true);
  expect(view.surface.lines.join("")).toContain("RESTORED");
  client.interests[0].known = view.stamp;
  surfaces(s, client);
  expect(sent.mock.calls.at(-1)![0]).toEqual({ ok: true, surfaces: [] });
});
test("the data connection reads its viewer's surfaces and receipts without becoming a viewer", async () => {
  const s = fixture(),
    ws = new Workspace(1, "/tmp"),
    pane = new Pane(1, new Terminal(80, 24), "/tmp");
  ws.model.newTab("pane");
  s.runtime.workspaces.items.push(ws);
  s.runtime.panes.push(pane);
  pane.terminal.feed("pane output");
  const control = peer(s),
    data = s.addClient(null, false),
    metadata = spyOn(control, "queue").mockImplementation(() => {}),
    content = spyOn(data, "queue").mockImplementation(() => {});
  expect(() => surfaces(s, data)).toThrow("NotAttached");
  data.watching = true;
  data.watch_viewer = control.viewer_id;
  await sync(
    s,
    control,
    protocol.decode("viewer.sync", {
      interests: [{ pane: 1, cols: 80, rows: 24 }],
      surfaces: false,
    }),
  );
  expect(metadata.mock.calls[0][0]).toMatchObject({ type: "view", surfaces: [] });
  surfaces(s, data);
  const reply = content.mock.calls[0][0] as protocol.ReplyPayloads["viewer.surfaces"];
  expect(reply.surfaces).toHaveLength(1);
  expect(reply.surfaces[0].surface.lines.join("")).toContain("pane output");
  expect(viewers(s)).toHaveLength(1);
  control.interests[0].known = reply.surfaces[0].stamp;
  surfaces(s, data);
  expect(content.mock.calls[1][0]).toEqual({ ok: true, surfaces: [] });
  expect(() => image(s, data, { pane: 2, image: "1", offset: 0 })).toThrow("NoPane");
  control.dead = true;
  expect(() => surfaces(s, data)).toThrow("NoViewer");
});
test("a fresh daemon's starter gives way to onboarding, and waits for any other viewer's folder", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-open-")));
  try {
    const opened = async (fields: object, before = (_: Server) => {}) => {
      const s = new Server(join(dir, "control.sock"), "", "0".repeat(64));
      servers.push(s);
      await s.runtime.workspaces.add("", "/");
      await before(s);
      const client = s.addClient(null, false),
        reply = spyOn(client, "queue").mockImplementation(() => {});
      spyOn(s, "execute").mockImplementation(async () => ({}) as any);
      await open(s, client, protocol.decode("viewer.open", fields));
      return { s, reply: reply.mock.calls[0][0] as any };
    };
    // Onboarding opens on the button that makes a workspace, and the first one made is still 1.
    const fresh = await opened({ onboarding: true, cwd: dir });
    expect([fresh.s.runtime.workspaces.items, fresh.s.default_folder_pending, fresh.reply.workspace]).toEqual([
      [],
      false,
      Workspace.Id.none,
    ]);
    expect(await fresh.s.runtime.workspaces.add("", dir)).toBe(1);
    // A workspace made before onboarding attached keeps its id, and the next one doesn't repeat it.
    const made = await opened({ onboarding: true, cwd: dir }, s => s.runtime.workspaces.add("", dir));
    expect(made.s.runtime.workspaces.items.map(w => w.id)).toEqual([2]);
    expect(await made.s.runtime.workspaces.add("", dir)).toBe(3);
    // So does one made and closed again.
    const closed = await opened({ onboarding: true, cwd: dir }, async s =>
      s.runtime.closeWorkspace(await s.runtime.workspaces.add("", dir), false),
    );
    expect(closed.s.runtime.workspaces.items).toEqual([]);
    expect(await closed.s.runtime.workspaces.add("", dir)).toBe(3);
    const attached = await opened({ cwd: dir });
    expect(attached.s.runtime.workspaces.items.map(w => [w.id, w.cwd])).toEqual([[1, dir]]);
    expect(attached.reply.workspace).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a new viewer opens on the pane last used in the preferred workspace", async () => {
  const s = fixture(),
    ws = new Workspace(1, "/tmp");
  s.runtime.workspaces.items.push(ws);
  s.runtime.workspaces.next_id = 2;
  const first = ws.model.newTab("first"),
    second = ws.model.newTab("second");
  for (const id of [first, second]) s.runtime.panes.push(new Pane(id, new Terminal(80, 24), "/tmp"));
  const use = (cl: ReturnType<typeof peer>, pane: number) =>
    sync(
      s,
      cl,
      protocol.decode("viewer.sync", { interests: [{ pane, cols: 80, rows: 24 }], focus: pane, workspace: 1 }),
    );
  const user = peer(s),
    idle = peer(s, 2);
  spyOn(user, "queue").mockImplementation(() => {});
  spyOn(idle, "queue").mockImplementation(() => {});
  // Both start on the first pane; only the viewer that moves takes over.
  await use(user, second);
  expect(ws.focus).toBe(second);
  await use(idle, first);
  expect(ws.focus).toBe(second);
  const next = s.addClient(null, false),
    reply = spyOn(next, "queue").mockImplementation(() => {});
  await open(s, next, protocol.decode("viewer.open", {}));
  expect(reply.mock.calls[0][0]).toMatchObject({ workspace: 1, focus: second });
});
test("a stream forgets the screens of panes its viewer stopped watching", async () => {
  const s = fixture(),
    ws = new Workspace(1, "/tmp");
  s.runtime.workspaces.items.push(ws);
  const panes = [ws.model.newTab("one"), ws.model.newTab("two")];
  for (const id of panes) s.runtime.panes.push(new Pane(id, new Terminal(80, 24), "/tmp"));
  const client = peer(s),
    interests = panes.map(pane => ({ pane, cols: 80, rows: 24 }));
  spyOn(client, "queue").mockImplementation(() => {});
  await start(
    s,
    client,
    protocol.decode("viewer.stream", { sequence: 1, incremental: true, workspace: 1, focus: panes[0], interests }),
  );
  const retained = () => [...(Reflect.get(client.stream!.delivery!, "retained") as Map<number, unknown>).keys()];
  expect(retained()).toEqual(panes);
  await sync(s, client, protocol.decode("viewer.sync", { workspace: 1, focus: panes[0], interests: [interests[0]] }));
  expect(retained()).toEqual([panes[0]]);
});

test("unrelated live output cannot stale a wrapped hover but changed target cells do", async () => {
  const server = fixture(),
    terminal = new Terminal(18, 24),
    pane = new Pane(1, terminal, "/tmp");
  server.runtime.panes.push(pane);
  const client = peer(server),
    sent = spyOn(client, "queue").mockImplementation(() => {});
  const url = "https://example.org/long-report";
  terminal.feed(url);
  const first = terminal.surface(1),
    q = {
      pane: 1,
      x: 2,
      y: 1,
      binding: pane.attachment.generation,
      offset: null,
      identity: first.stamp.identity,
      revision: first.stamp.revision,
      fingerprint: fingerprint(first.surface.lines.slice(0, 9)),
    };
  terminal.feed("\x1b[22;1Hbusy");
  expect(terminal.surface_revision).toBeGreaterThan(q.revision);
  await resolveHoverLink(server, client, q);
  expect(sent.mock.calls.at(-1)![0]).toMatchObject({ target: { uri: url } });
  terminal.feed("\x1b[2;1Hnew");
  await resolveHoverLink(server, client, q);
  expect(sent.mock.calls.at(-1)![0]).toMatchObject({ target: null });
});

test("only an exact missing spelling wakes a viewer and only once", async () => {
  const server = fixture(),
    workspace = new Workspace(1, "/tmp"),
    pane = new Pane(workspace.model.newTab("shell"), new Terminal(32, 5), "/tmp"),
    client = peer(server);
  server.runtime.workspaces.items.push(workspace);
  server.runtime.panes.push(pane);
  const actor = new Actor({ id: 7 }),
    dictionary = new Dictionary();
  pane.attachment.select(actor);
  server.usage = new Worker();
  spyOn(server.usage, "linkEvidence").mockReturnValue(dictionary);
  spyOn(client, "queue").mockImplementation(() => {});
  pane.terminal.feed("https://example.org/rec\r\nord");
  const view = pane.terminal.surface(1);
  await resolveHoverLink(server, client, {
    pane: 1,
    x: 2,
    y: 1,
    binding: pane.attachment.generation,
    offset: null,
    identity: view.stamp.identity,
    revision: view.stamp.revision,
    fingerprint: fingerprint(view.surface.lines),
  });
  for (let i = 0; i < 100; i++) {
    dictionary.add("https://other.test/" + i);
    expect(hoverLinkRevision(server, client)).toBe(0n);
  }
  dictionary.add("https://example.org/record");
  expect(hoverLinkRevision(server, client)).toBe(1n);
  const request = protocol.decode("viewer.stream", { sequence: 1, interests: client.interests });
  const notice = { pane: 1, seq: 1 };
  expect((await start(server, client, request)).view.wrapped_notice).toEqual(notice);
  expect(client.hover_link.recheck(true)).toBeUndefined();
  expect((await start(server, client, { ...request, sequence: 2 })).view.wrapped_notice).toEqual(notice);
  dictionary.add("https://other.test/again");
  expect(hoverLinkRevision(server, client)).toBe(1n);
  server.usage.stop();
});
