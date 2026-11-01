import { expect, test, spyOn } from "bun:test";
import { Controller } from "./controller";
import { transport } from "./fixtures/transport";
import * as json from "./json";
import * as mirror from "./mirror";
import * as protocol from "./protocol";
import * as viewer from "./viewer";
import * as sim from "./providers/sim";
import { Provider } from "./providers";
import { Terminal } from "./pane/terminal";
import * as viewerNative from "./viewer_native";

test("provider names use the registered display name, not the wire id", () => {
  const unregister = sim.register();
  try {
    for (const [provider, name] of [
      ["codex", "Codex"],
      ["claude", "Claude"],
      ["pi", "Pi"],
      ["opencode2", "OpenCode"],
      [sim.sim, "Sim"],
      [null, "agent"],
    ] as const) {
      expect(mirror.providerName(mirror.agent({ provider }))).toBe(name);
    }
  } finally {
    unregister();
  }
});

test("a provider the viewer doesn't know reads as none", () => {
  expect(mirror.agent({ provider: "future" }).provider).toBeNull();
  expect(mirror.providerName(mirror.agent({ provider: "future" }))).toBe("agent");
});

test("a snapshot's sessions and last agents from a provider the viewer doesn't know are dropped", () => {
  const runtime = new mirror.Runtime();
  try {
    runtime.receive(null as any, {
      workspaces: [{ id: 1, model: { nodes: [], tabs: [], revision: 0 }, last_agent: "future" }],
      headless_sessions: [
        { id: 1, workspace: 1, provider: "future", session: "a" },
        { id: 2, workspace: 1, provider: "codex", session: "b" },
      ],
      last_agent: "future",
    });
    expect(runtime.sessions.map(s => s.provider)).toEqual(["codex"]);
    expect([runtime.last_agent, runtime.workspaces.items[0].last_agent]).toEqual([Provider.first, null]);
  } finally {
    runtime.destroy();
  }
});
test("a snapshot whose stars the viewer can't read shows none", () => {
  const runtime = new mirror.Runtime();
  try {
    runtime.receive(null as any, {
      workspaces: [{ id: 1, model: { nodes: [], tabs: [], revision: 0 }, starred_sessions: [{ provider: "claude" }] }],
    });
    expect(runtime.workspaces.items[0].starred_sessions).toEqual([]);
  } finally {
    runtime.destroy();
  }
});
test("cached pane rows follow surfaces, selection, geometry, dimming and hovered links", () => {
  const source = new Terminal(32, 3),
    pane = new mirror.Terminal(
      transport(async () => ({})),
      1,
      32,
      3,
    );
  const draw = (x = 0, dim = false, hover: bigint | null = null) => {
    const rows = pane.rows(1, x, 1, 30, 3, dim, hover);
    expect(rows).toBe(viewerNative.rows(pane.handle, 1, x, 1, 30, 3, dim, hover));
    return rows;
  };
  try {
    source.feed("\x1b]8;;https://example.com/\x1b\\Docs\x1b]8;;\x1b\\ plain");
    pane.receive(source.surface(1));
    const first = draw();
    expect(draw()).toBe(first);
    expect(draw(2)).not.toBe(first);
    expect(draw(0, true)).not.toBe(first);
    expect(draw(0, false, pane.hyperlinks()[0].id)).not.toBe(first);
    pane.select(0, 0, 3, 0);
    expect(draw()).not.toBe(first);
    pane.clearSelection();
    expect(draw()).toBe(first);
    source.feed("\r\x1b[2KChanged");
    pane.receive(source.surface(1));
    expect(draw()).not.toBe(first);
    expect(draw()).toContain("Changed");
  } finally {
    pane.destroy();
    source.destroy();
  }
});

test("pane rows memoize native rendering and preserve link groups", () => {
  const source = new Terminal(32, 3),
    pane = new mirror.Terminal(
      transport(async () => ({})),
      1,
      32,
      3,
    ),
    direct = new Terminal(40, 8),
    rendered = new Terminal(40, 8);
  try {
    source.feed(
      "\x1b[31;1mRed 界 é 🐕\x1b[0m\r\n\x1b]8;id=docs;https://example.com/\x1b\\Docs\x1b]8;;\x1b\\ plain " +
        "\x1b]8;id=docs;https://example.com/\x1b\\More\x1b]8;;\x1b\\ " +
        "\x1b]8;id=other;https://example.com/\x1b\\Other\x1b]8;;\x1b\\",
    );
    pane.receive(source.surface(1));
    const reference = viewerNative.rows(pane.handle, 1, 3, 2, 32, 3, false, null),
      rows = spyOn(viewerNative, "rows"),
      links = spyOn(pane.inner, "hyperlinks");
    try {
      const output = pane.rows(1, 3, 2, 32, 3, false, null);
      expect(rows).toHaveBeenCalledTimes(1);
      expect(pane.rows(1, 3, 2, 32, 3, false, null)).toBe(output);
      expect(rows).toHaveBeenCalledTimes(1);
      expect(links).not.toHaveBeenCalled();
      direct.feed(output + "\x1b[1;1H");
      rendered.feed(reference + "\x1b[1;1H");
      // A native redraw namespaces the mirror's IDs again. Compare the complete
      // snapshot with a bijective rename, retaining link grouping and targets.
      const snapshot = (terminal: Terminal) => {
        const ids = new Map<string, number>();
        return terminal
          .snapshot()
          .toString()
          .replace(/\x1b\]8;id=([^;]*);/g, (_, id: string) => {
            if (!ids.has(id)) ids.set(id, ids.size);
            return `\x1b]8;id=${ids.get(id)};`;
          });
      };
      expect(snapshot(direct)).toBe(snapshot(rendered));
      for (const terminal of [direct, rendered]) {
        const captured = terminal.hyperlinks();
        expect(captured).toHaveLength(3);
        expect(captured[0].id).toBe(captured[1].id);
        expect(captured[0].id).not.toBe(captured[2].id);
        expect(captured.map(link => link.uri)).toEqual(Array(3).fill("https://example.com/"));
      }
      expect(pane.hyperlinks()).toHaveLength(3);
      expect(links).toHaveBeenCalledTimes(1);
      pane.hyperlinks();
      expect(links).toHaveBeenCalledTimes(1);
      pane.rows(1, 3, 2, 30, 3, false, null);
      pane.rows(1, 3, 2, 32, 3, true, null);
      pane.rows(1, 3, 2, 32, 3, false, pane.hyperlinks()[0].id);
      expect(rows).toHaveBeenCalledTimes(4);
      pane.select(0, 0, 2, 0);
      pane.rows(1, 3, 2, 32, 3, false, null);
      expect(rows).toHaveBeenCalledTimes(5);
      pane.clearSelection();
      source.feed("\x1b[2J\x1b[Hnew surface");
      pane.receive(source.surface(1));
      expect(pane.rows(1, 3, 2, 32, 3, false, null)).toContain("new surface");
      expect(rows).toHaveBeenCalledTimes(6);
      expect(pane.hyperlinks()).toEqual([]);
      expect(links).toHaveBeenCalledTimes(2);
    } finally {
      rows.mockRestore();
      links.mockRestore();
    }
  } finally {
    source.destroy();
    pane.destroy();
    direct.destroy();
    rendered.destroy();
  }
});

test("viewer scalars retain their bigint type after small and large wire replies", async () => {
  let value = 1n;
  const requests: any[] = [];
  const view = new Controller(
    transport(async (op, fields) => {
      requests.push({ op, fields });
      return json.parse(
        json.stringify({
          viewer_protocol: protocol.viewer_version,
          session: null,
          session_hash: value,
          resources: null,
          resources_hash: value,
          viewer: 1,
          controls: [{ seq: value, kind: "focus", id: 1 }],
          surfaces: [],
          bell_seq: value,
          bell_kind: "none",
          detach: false,
        }),
      );
    }),
  );
  view.receiveSnapshot({
    workspaces: [{ id: 1, model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "" }], revision: 0 } }],
    panes: [{ id: 1, cols: 80, rows: 24, binding: 1 }],
  });
  const bell = { seq: 0n };
  try {
    for (const next of [1n, 0xffffffffffffffffn]) {
      value = next;
      await viewer.sync(view, bell, false);
      expect(view.runtime.snapshot_hash).toBe(value);
      expect(view.runtime.resources_hash).toBe(value);
      expect(view.input_state.last_control).toBe(value);
      expect(bell.seq).toBe(value);
      await viewer.sync(view, bell, false);
      expect(requests.at(-1).fields.ack).toBe(value);
      expect(requests.at(-1).fields.session_hash).toBe(value);
    }
    expect(view.runtime.panes[0].binding).toBe(1n);
  } finally {
    viewer.close(view);
  }
});

test("mirrored observations keep exact completion counters", () => {
  const small = mirror.agent({ observation: { completed: 1, read: 0 } });
  expect(small.observation.completed).toBe(1n);
  expect(mirror.unread(small.observation)).toBe(true);
  const large = mirror.agent(
    json.parse('{"observation":{"completed":18446744073709551615,"read":18446744073709551614}}'),
  );
  mirror.acknowledge(large.observation, large.observation.completed);
  expect(large.observation.read).toBe(0xffffffffffffffffn);
  expect(mirror.unread(large.observation)).toBe(false);
});

test("a pick asks for the viewer's rows and reads any failure as no match", async () => {
  const requests: any[] = [];
  let reply: unknown = {
    ok: true,
    match: { x: 0, y: 1, end_x: 4, end_y: 1 },
    shown: "hello",
    copy: "hello",
  };
  const term = new mirror.Terminal(
    transport(async (op, fields) => {
      requests.push({ op, fields });
      return reply;
    }),
    3,
    10,
    4,
  );
  try {
    term.bottom = 40;
    expect(await term.pick("word", 2, 1)).toEqual({
      match: { x: 0, y: 1, end_x: 4, end_y: 1 },
      shown: "hello",
      copy: "hello",
    });
    term.offset = 12;
    await term.pick("line", 2, 1, { x: 5, y: 3 });
    expect(requests).toEqual([
      { op: "viewer.pick", fields: { pane: 3, offset: 40, unit: "word", x: 2, y: 1, to_x: null, to_y: null } },
      { op: "viewer.pick", fields: { pane: 3, offset: 12, unit: "line", x: 2, y: 1, to_x: 5, to_y: 3 } },
    ]);
    reply = { err: "UnknownOperation" };
    expect(await term.pick("word", 0, 0)).toBeNull();
  } finally {
    term.destroy();
  }
});

test("a pinned highlight stays while its text does and goes when it changes", () => {
  const t = Terminal.create(10, 4);
  const term = new mirror.Terminal(
    transport(async () => {
      throw Error("unused");
    }),
    1,
    10,
    4,
  );
  try {
    t.feed("hello you\r\nabcdefghijklmno");
    term.receive(t.surface(1));
    expect(term.pinnedMatches()).toBe(false);
    // The mirror breaks the soft-wrapped word where the daemon unwraps it.
    term.pin({ x: 0, y: 1, end_x: 4, end_y: 2 }, "abcdefghijklmno");
    expect(term.selectedText()).toBe("abcdefghij\nklmno");
    expect(term.pinnedMatches()).toBe(true);
    t.feed("\x1b[1;1Hjello");
    term.receive(t.surface(1));
    expect(term.selection).not.toBeNull();
    term.pin({ x: 0, y: 0, end_x: 4, end_y: 0 }, "jello");
    t.feed("\x1b[1;1Hjelly");
    term.receive(t.surface(1));
    expect(term.selection).toBeNull();
    expect(term.pinned).toBeNull();
    expect(term.pinnedMatches()).toBe(false);
    // A drag selection is not pinned, so changed text keeps it.
    term.select(0, 0, 4, 0);
    t.feed("\x1b[1;1Hhello");
    term.receive(t.surface(1));
    expect(term.selection).toEqual({ x: 0, y: 0, end_x: 4, end_y: 0 });
    term.pin({ x: 0, y: 0, end_x: 4, end_y: 0 }, "hello");
    term.clearSelection();
    expect(term.pinned).toBeNull();
  } finally {
    term.destroy();
    t.destroy();
  }
});

test("row joins drop their newline and the whitespace around it", () => {
  expect(mirror.joinRows("abc   \n  def\nghi")).toBe("abcdefghi");
  expect(mirror.joinRows(" a b ")).toBe(" a b ");
});

test("an account's YOLO and Show come from the snapshot, and an older daemon's has none", () => {
  const runtime = new mirror.Runtime(),
    workspaces = [{ id: 1, model: { nodes: [], tabs: [], revision: 0 } }];
  try {
    runtime.receive(null as any, {
      workspaces,
      account_yolo: ["/accounts/work", 3],
      account_hidden: ["/accounts/side"],
    });
    expect([runtime.account_yolo, runtime.account_hidden]).toEqual([["/accounts/work"], ["/accounts/side"]]);
    runtime.receive(null as any, { workspaces });
    expect([runtime.account_yolo, runtime.account_hidden]).toEqual([[], []]);
  } finally {
    runtime.destroy();
  }
});
