import { test, expect } from "bun:test";
import * as json from "./json";
import type { View as WireView } from "./protocol";
import { validateInterests, queue, targetViewer, viewerShowing, copy, action, viewers } from "./viewer_protocol";
import { version, compatible, require as requireVersion } from "./viewer_version";
function peer(id = 1) {
  return {
    viewer: true,
    dead: false,
    viewer_id: id,
    view_workspace: 1,
    view_focus: 1,
    watched: true,
    active_seq: id,
    controls: [] as any[],
    next_control: 1,
    interests: [{ pane: 1 }],
    result: null as any,
    queue(value: any) {
      this.result = value;
    },
  };
}
test("a viewer reads the view the daemon writes", () => {
  const written: WireView<{ revision: number }> = {
    type: "view",
    viewer_protocol: 3,
    session: { revision: 4 },
    session_hash: 7,
    resources: null,
    resources_hash: 9,
    surfaces: [],
    bell_seq: 2,
    bell_kind: "needs_input",
    controls: [{ seq: 5, kind: "focus", id: 1 }],
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
  expect(version).toBe(3);
  expect(compatible({ viewer_protocol: 3 })).toBe(true);
  for (const value of [null, 3, {}, { viewer_protocol: "3" }, { viewer_protocol: 2 }])
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
  const one = peer(),
    two = peer(2),
    server = { clients: [one, two] };
  expect(targetViewer(server, null)).toBe(one);
  expect(targetViewer(server, 2)).toBe(two);
  expect(() => viewerShowing(server, 1)).toThrow("AmbiguousViewer");
  one.dead = true;
  expect(viewerShowing(server, 1)).toBe(two);
  expect(() => targetViewer(server, 3)).toThrow("NoViewer");
});
test("controls remain ordered and bounded", () => {
  const target = peer();
  queue(target, { kind: "focus", id: 1 });
  expect(target.controls[0].seq).toBe(1);
  for (let i = 1; i < 64; i++) queue(target, { kind: "focus", id: i });
  expect(() => queue(target, { kind: "workspace", id: 1 })).toThrow("ViewerBusy");
});
test("OSC52 copy chooses most recently active interested viewer and replaces pending copy", () => {
  const one = peer(),
    two = peer(2),
    s = { clients: [one, two] };
  copy(s, 1, "old");
  queue(two, { kind: "focus", id: 3 });
  copy(s, 1, "new");
  expect(one.controls).toHaveLength(0);
  expect(two.controls.map(c => c.kind)).toEqual(["focus", "action"]);
  expect(two.controls.at(-1).value).toBe("new");
  expect(two.controls.at(-1).seq).toBe(3);
});
test("relaunch validates absolute executable and goes to viewer showing pane", () => {
  const target = peer(),
    source = peer(2);
  source.viewer = false;
  const s = { clients: [target, source] };
  expect(() => action(s, source, { name: "relaunch", value: "relative", pane: 1 })).toThrow("InvalidExecutable");
  action(s, source, { name: "relaunch", value: "/usr/bin/corgi", pane: 1 });
  expect(source.result).toEqual({ ok: true, viewer: 1, queued: true });
  expect(target.controls[0].name).toBe("relaunch");
  expect(viewers(s)).toEqual([{ id: 1, workspace: 1, pane: 1, watched: true }]);
});
