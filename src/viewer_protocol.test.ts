import { test, expect, afterEach, spyOn } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "./server";
import * as json from "./json";
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
  image,
} from "./viewer_protocol";
import { Pane, Ghost } from "./runtime";
import { Terminal } from "./pane/terminal";
import { Snapshot, Work, Process } from "./trackers/resources";
import { Workspace } from "./workspace";
import { version, compatible, require as requireVersion } from "./viewer_version";
import { pair, n } from "./native_ffi";
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
function peer(server: Server, id = 1, fd = -1) {
  const client = server.addClient(fd, fd !== -1);
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
    [fd, remote] = pair(),
    client = peer(server, 1, fd);
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
  client.stream = { sequence: 1, sent: now, wake: 0n, session_hash: null, resources_hash: null };
  return {
    server,
    client,
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
      n.probe_close(remote);
      queue.mockRestore();
      timer.mockRestore();
      cancel.mockRestore();
      clock.mockRestore();
    },
  };
}

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
    f.client.output = Buffer.from("pending reply");
    publish(f.server, f.client, 1n);
    f.advance(150);
    publish(f.server, f.client, 2n);
    expect(f.timers.size).toBe(0);
    expect(f.output).toHaveLength(0);
    f.client.sent = f.client.output.length;
    f.client.flush();
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
test("a viewer reads the view the daemon writes", () => {
  const written: WireView<{ revision: number }> = {
    type: "view",
    viewer_protocol: version,
    session: { revision: 4 },
    session_hash: 7n,
    resources: null,
    resources_hash: 9n,
    surfaces: [],
    bell_seq: 2n,
    bell_kind: "needs_input",
    controls: [{ seq: 5n, kind: "focus", id: 1 }],
    viewer: 3,
    detach: true,
  };
  const read = json.parse(json.stringify(written));
  expect(read.session.revision).toBe(4);
  expect(read.resources).toBeNull();
  expect(read.session_hash).toBe(7);
  expect(read.resources_hash).toBe(9);
  expect(read.bell_kind).toBe("needs_input");
  expect(read.controls[0].seq).toBe(5);
  expect(read.viewer).toBe(3);
  expect(read.detach).toBe(true);
  written.session_hash = 0xffffffffffffffffn;
  expect(json.parse(json.stringify(written)).session_hash).toBe(0xffffffffffffffffn);
});
test("viewer wire version checked on every exchange", () => {
  expect(compatible({ viewer_protocol: version })).toBe(true);
  for (const value of [null, version, {}, { viewer_protocol: String(version) }, { viewer_protocol: version - 1 }])
    expect(() => requireVersion(value)).toThrow("IncompatibleViewerProtocol");
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
    data = s.addClient(-1, false),
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
  const receipt = pane.terminal.input_ack.sent(0);
  pane.terminal.input_ack.advance(50);
  surfaces(s, data);
  const acknowledged = (content.mock.calls[2][0] as protocol.ReplyPayloads["viewer.surfaces"]).surfaces[0];
  expect(acknowledged.input_ack).toEqual(receipt);
  expect(acknowledged.stamp).toEqual(reply.surfaces[0].stamp);
  expect(acknowledged.surface.lines).toEqual(reply.surfaces[0].surface.lines);
  surfaces(s, data);
  expect(content.mock.calls[3][0]).toEqual({ ok: true, surfaces: [] });
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
      const client = s.addClient(-1, false),
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
  const next = s.addClient(-1, false),
    reply = spyOn(next, "queue").mockImplementation(() => {});
  await open(s, next, protocol.decode("viewer.open", {}));
  expect(reply.mock.calls[0][0]).toMatchObject({ workspace: 1, focus: second });
});
