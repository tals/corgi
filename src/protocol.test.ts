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
  expect(protocol.decode("theme", { theme: { foreground: { r: 1, g: 2, b: 3 } } }).theme?.foreground?.g).toBe(2);
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
      .command,
  ).toEqual({ "pane.close": { target: 3 } });
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

// These assertions are checked by the repository typecheck.
function requestTypes() {
  const located = protocol.decode("session.locate", { pane: 1 });
  const pane: number = located.pane;
  // @ts-expect-error locate requests have no workspace field
  located.workspace;
  // @ts-expect-error pane identifiers are numeric
  const invalid: protocol.RequestInput<"session.locate"> = { pane: "1" };
  // @ts-expect-error required fields cannot be omitted
  const missing: protocol.RequestInput<"session.locate"> = {};
  const input: protocol.RequestInput<"viewer.search"> = { pane, needle: "text" };
  // @ts-expect-error close commands do not accept workspace
  const wrongCommand: protocol.CommandInput = { "pane.close": { target: 1, workspace: 2 } };
  // @ts-expect-error command schemas retain required fields
  const missingCommand: protocol.CommandInput = { "agent.command": { command: "echo hi" } };
  const partialSemantics: protocol.CommandInput = {
    "agent.command": { index: 1, command: "echo hi", semantics: { provider: "codex" } },
  };
  const beside: protocol.CommandInput = { "pane.move": { target: 1, destination: { beside: { other: 2 } } } };
  const visibility: protocol.CommandInput = { "agent.visibility": { hidden: {} } };
  // @ts-expect-error command text must remain a string
  const wrongText: protocol.CommandInput = { "pane.send": { target: 1, text: 2 } };
  const search = protocol.decode("viewer.search", input);
  const skip: bigint = search.skip;
  // @ts-expect-error normalized counters are never numbers
  const numericSkip: number = search.skip;
  const smallInput: protocol.RequestInput<"viewer.search"> = { pane, needle: "text", skip: 2 };
  const smallCommand: protocol.CommandInput = { "pane.read": { target: pane, lines: 2 } };
  const command = protocol.command(protocol.decodeCommand(smallCommand));
  if (command.op === "pane.read") {
    const lines: bigint = command.payload.lines;
    void lines;
  }
  void numericSkip;
  void smallInput;
  return { invalid, missing, missingCommand, partialSemantics, beside, visibility, wrongCommand, wrongText, skip };
}

test("protocol normalizes small, wide, and default integer fields by their widths", () => {
  const sync = protocol.decode("viewer.sync", {
    interests: [{ pane: 1n, cols: 80n, rows: 24, offset: 0, known: { identity: 1, revision: 2, offset: null } }],
    session_hash: 0xffffffffffffffffn,
  });
  expect(sync.ack).toBe(0n);
  expect(sync.workspace).toBe(0);
  expect(sync.session_hash).toBe(0xffffffffffffffffn);
  expect(sync.interests[0]).toEqual({
    pane: 1,
    cols: 80,
    rows: 24,
    offset: 0n,
    known: { identity: 1n, revision: 2n, offset: null },
  });
  expect(protocol.decode("viewer.search", { pane: 1, needle: "x" }).skip).toBe(0n);
  expect(protocol.decode("pane.acknowledge", { pane: 1 }).through).toBe(0n);
  expect(protocol.decode("test.advance", { ms: -2 }).ms).toBe(-2n);
  const imported = protocol.decode("onboarding.copy", {
    operation: 1,
    source: "tmux",
    workspaces: [{ id: "ws", name: "ws", tabs: [] }],
  });
  expect(imported.operation).toBe(1n);
  expect(imported.workspaces[0].session).toBe(0n);
  expect(imported.workspaces[0].activity).toBe(0n);
});

test("command normalization keeps wide counters bigint and bounded IDs numbers", () => {
  expect(protocol.decodeCommand({ "pane.read": { target: 1n } })).toEqual({
    "pane.read": { target: 1, lines: 100n, view: "history" },
  });
  expect(protocol.decodeCommand({ "pane.read": { target: 1, lines: 2 } })).toEqual({
    "pane.read": { target: 1, lines: 2n, view: "history" },
  });
  expect(protocol.decodeCommand({ "tab.move": { target: 1n, destination: { workspace: 2n } } })).toEqual({
    "tab.move": { target: 1, destination: { workspace: 2 } },
  });
  const command = protocol.command(protocol.decodeCommand({ "agent.command": { index: 3, command: "echo hi" } }));
  if (command.op !== "agent.command") throw Error("WrongCommand");
  expect(command.payload.index).toBe(3n);
  expect(protocol.decodeCommand({ "split.ratio": { target: 1n, other: 2, ratio: 50n, expected: 4 } })).toEqual({
    "split.ratio": { target: 1, other: 2, ratio: 50, expected: 4n },
  });
});

test("wide protocol integers reject rounded numbers and enforce their range", () => {
  for (const value of [1.5, NaN, Infinity, "2"]) {
    expect(() => protocol.decode("viewer.search", { pane: 1, needle: "x", skip: value })).toThrow("UnexpectedToken");
    expect(() => protocol.decodeCommand({ "pane.read": { target: 1, lines: value } })).toThrow("UnexpectedToken");
  }
  expect(() => protocol.decode("viewer.search", { pane: 1, needle: "x", skip: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
    "Overflow",
  );
  expect(() => protocol.decodeCommand({ "pane.read": { target: 1, lines: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(
    "Overflow",
  );
  expect(() => protocol.decode("viewer.search", { pane: 1, needle: "x", skip: -1 })).toThrow("Overflow");
  expect(() => protocol.decode("viewer.search", { pane: 1, needle: "x", skip: 1n << 64n })).toThrow("Overflow");
  expect(() => protocol.decode("test.advance", { ms: 1n << 63n })).toThrow("Overflow");
  expect(protocol.decode("test.advance", { ms: -(1n << 63n) }).ms).toBe(-(1n << 63n));
});

test("normalized protocol values preserve JSON integer tokens", () => {
  const source = '{"pane":1,"needle":"x","skip":18446744073709551615}';
  const request = protocol.decode("viewer.search", json.parse(source));
  expect(json.stringify(request)).toBe(source);
  const small = '{"lines":2,"view":"history","target":1}';
  const command = protocol.command(protocol.decodeCommand({ "pane.read": json.parse(small) }));
  expect(json.stringify(command.payload)).toBe(small);
});

test("command defaults normalize nested semantics and tagged destinations", () => {
  const input: protocol.CommandInput = {
    "agent.command": { index: 1, command: "echo hi", semantics: { provider: "codex" } },
  };
  expect(protocol.decodeCommand(input)).toEqual({
    "agent.command": {
      index: 1n,
      command: "echo hi",
      hidden: false,
      name: null,
      original: null,
      semantics: {
        provider: "codex",
        suggested_name: "",
        model: "",
        model_name: "",
        account: "",
        mode: "",
        yolo: false,
        default_account: false,
      },
      resolve: true,
      cwd: null,
    },
  });
  expect(protocol.decodeCommand({ "agent.visibility": { hidden: { codex: true } } })).toEqual({
    "agent.visibility": { hidden: { codex: true, claude: false } },
  });
  expect(protocol.decodeCommand({ "agent.move": { workspace: 1n, target: { native: 2n } } })).toEqual({
    "agent.move": { workspace: 1, target: { native: 2 }, before: null },
  });
  const move = { "pane.move": { target: 1n, destination: { beside: { other: 2n } } } };
  expect(protocol.decodeCommand(move)).toEqual({
    "pane.move": { target: 1, destination: { beside: { other: 2, direction: "right" } } },
  });
  expect(move["pane.move"].destination.beside).toEqual({ other: 2n });
});

test("command schemas reject unknown nested fields while requests stay lenient", () => {
  for (const value of [
    { "agent.command": { index: 1, command: "x", semantics: { newer: 1 } } },
    { "agent.visibility": { hidden: { newer: true } } },
    { "agent.move": { workspace: 1, target: { newer: 2 } } },
    { "pane.move": { target: 1, destination: { beside: { other: 2, newer: 3 } } } },
    { "pane.move": { target: 1, destination: { workspace: 2 } } },
    { "tab.move": { target: 1, destination: { new_tab: "x" } } },
  ])
    expect(() => protocol.decodeCommand(value)).toThrow("UnknownField");
  expect(() => protocol.decodeCommand({ "pane.move": { target: 1, destination: { beside: {} } } })).toThrow(
    "MissingField",
  );
  expect(() =>
    protocol.decodeCommand({ "pane.move": { target: 1, destination: { beside: 1, new_tab: "x" } } }),
  ).toThrow("UnexpectedToken");
  expect(
    protocol.decode("viewer.sync", { interests: [{ pane: 1, cols: 80, rows: 24, newer: true }] }).interests[0],
  ).toEqual({
    pane: 1,
    cols: 80,
    rows: 24,
    offset: null,
    known: null,
  });
});
