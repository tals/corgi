import { test, expect, afterEach, spyOn } from "bun:test";
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
  open,
  sync,
} from "./viewer_protocol";
import { Pane, Ghost } from "./runtime";
import { Terminal } from "./pane/terminal";
import { Snapshot, Work, Process } from "./trackers/resources";
import { Workspace } from "./workspace";
import { version, compatible, require as requireVersion } from "./viewer_version";
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
function peer(server: Server, id = 1) {
  const client = server.addClient(-1, false);
  client.viewer = true;
  client.viewer_id = id;
  client.view_workspace = 1;
  client.view_focus = 1;
  client.active_seq = id;
  client.interests = [{ pane: 1, cols: 80, rows: 24 }];
  return client;
}
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
  expect(viewers(s)).toEqual([{ id: 1, workspace: 1, pane: 1, watched: true }]);
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
