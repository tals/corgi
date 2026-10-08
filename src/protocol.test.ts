import { test, expect } from "bun:test";
import * as protocol from "./protocol";
import * as json from "./json";
import { Model, Selection } from "./layout";
import samples from "./fixtures/protocol-requests.json";
test("every op decodes a sample request", () => {
  expect(Object.keys(samples).sort()).toEqual([...protocol.operations].sort());
  for (const op of protocol.operations) {
    expect(protocol.parse({ op })).toBe(op);
    expect(() => protocol.decode(op, samples[op])).not.toThrow();
  }
});
test("a client's envelope writes what the hand-written requests did", () => {
  for (const [op, payload, expected] of [
    ["hello", {}, { op: "hello", protocol: 1 }],
    ["shutdown", {}, { op: "shutdown" }],
    ["server.reload", { executable: "/bin/corgi" }, { op: "server.reload", protocol: 1, executable: "/bin/corgi" }],
    [
      "session.command",
      { command: { "pane.close": { target: 3 } } },
      { op: "session.command", protocol: 1, command: { "pane.close": { target: 3 } } },
    ],
    [
      "viewer.open",
      { cwd: "/tmp", onboarding: true },
      { op: "viewer.open", protocol: 1, viewer_protocol: 3, cwd: "/tmp", theme: null, onboarding: true },
    ],
    ["focus", { pane: 3, viewer: 2 }, { op: "focus", pane: 3, viewer: 2 }],
    ["workspace.switch", { workspace: 1, viewer: null }, { op: "workspace.switch", workspace: 1 }],
  ] as const)
    expect(protocol.envelope(op, payload)).toEqual(expected);
});
test("a malformed theme reads as none instead of failing the request", () => {
  for (const value of [{ theme: { foreground: 7 } }, { theme: "dark" }, {}])
    expect(protocol.decode("theme", value).theme).toBeNull();
  expect(protocol.decode("theme", { theme: { foreground: { r: 1, g: 2, b: 3 } } }).theme.foreground.g).toBe(2);
});
test("a reply's err names a rejection a client can switch on", () => {
  expect(protocol.rejection("StaleLayout")).toBe("StaleLayout");
  expect(protocol.rejection("GitPushInProgress")).toBe("GitPushInProgress");
  expect(protocol.rejection("InvalidJson")).toBe("ServerRejected");
  expect(protocol.rejection("")).toBe("ServerRejected");
});
test("the ops that wait for an import, a reload or a push", () => {
  expect(
    protocol.operations
      .filter(op => protocol.exclusion(op) !== "none")
      .map(op => `${op} ${protocol.exclusion(op)}\n`)
      .join(""),
  ).toBe(
    "session.command layout\nserver.reload reload\ngit.push push\nonboarding.handoff import\nonboarding.copy import\nshutdown shutdown\n",
  );
});
test("a session command stays strict inside a lenient request", () => {
  expect(
    protocol.decode("session.command", { op: "session.command", newer: 1, command: { "pane.close": { target: 3 } } })
      .command["pane.close"].target,
  ).toBe(3);
  expect(() => protocol.decode("session.command", { command: { "pane.close": { target: 3, newer: 1 } } })).toThrow(
    "UnknownField",
  );
  expect(() => protocol.decode("session.command", { command: { "pane.move": { target: 3 } } })).toThrow("MissingField");
  expect(() => protocol.decode("session.command", {})).toThrow("MissingField");
});
test("shared arrangement round trip is independent of viewer selection", () => {
  const original = new Model(),
    first = original.newTab("first"),
    split = original.split(first, "horizontal");
  original.newTab("second");
  const selection = new Selection();
  selection.reconcile(original);
  selection.focus(original, first);
  selection.tab().zoom = true;
  original.moveTab(original.tabs[1].id, 0);
  original.close(split);
  const restored = Model.fromData(json.parse(json.stringify(original)));
  selection.reconcile(restored);
  expect(selection.tab().focus).toBe(first);
  expect(selection.active).toBe(1);
  expect(selection.tab().zoom).toBe(true);
});
test("typed request boundaries reject malformed commands and retain wide counters", () => {
  expect(() => protocol.decodeCommand({ "pane.input": { target: { pane: 1 }, data: "x" } })).toThrow("UnexpectedToken");
  expect(() => protocol.decodeCommand({ "pane.resize": { target: 1, ratio: 65536, axis: "horizontal" } })).toThrow(
    "Overflow",
  );
  expect(() => protocol.decode("viewer.sync", { interests: [{ pane: 1, cols: -1, rows: 24 }] })).toThrow("Overflow");
  expect(() => protocol.decode("pane.paste", { pane: 1, image: { mime: "image/png", path: 9 } })).toThrow(
    "UnexpectedToken",
  );
  expect(protocol.decode("pane.acknowledge", { pane: 1, through: 0xffffffffffffffffn }).through).toBe(
    0xffffffffffffffffn,
  );
});
