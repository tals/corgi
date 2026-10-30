import { expect, spyOn, test } from "bun:test";
import * as mirror from "./mirror";
import * as keyboard from "./keyboard";
import * as viewerNative from "./viewer_native";
import { Terminal } from "./pane/terminal";
import { n } from "./native_ffi";
import { transport } from "./fixtures/transport";
import { Controller } from "./controller";
import { Frame, same } from "./composition";
import { Differ } from "./frame_diff";
import { Rect, View as LayoutView } from "./layout";
import type { RequestInput } from "./protocol";
import { Writer } from "./text";
import * as viewer from "./viewer";
import * as viewerVersion from "./viewer_version";

const connection = transport(async () => ({}));
function snapshot(count: number) {
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  return {
    workspaces: [
      {
        id: 1,
        name: "workspace",
        cwd: "",
        model: {
          nodes: ids.map(pane => ({ pane })),
          tabs: ids.map((id, root) => ({ id, root, title: String(id) })),
          revision: 0,
        },
      },
    ],
    panes: ids.map(id => ({
      id,
      workspace: 1,
      tab: id,
      cols: 132,
      rows: 47,
      agent: { provider: "codex", state: "working" },
    })),
    conversations: [],
    headless_sessions: [],
  };
}

test("snapshot metadata keeps hidden native terminals unallocated", () => {
  const runtime = new mirror.Runtime(),
    source = new Terminal(84, 19),
    create = spyOn(Terminal, "create");
  try {
    runtime.receive(connection, snapshot(16));
    expect(runtime.panes).toHaveLength(16);
    expect(create).not.toHaveBeenCalled();
    source.feed("visible pane\x1b[2;3H");
    const first = runtime.panes[0].terminal;
    first.receive(source.surface(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith(84, 19);
    expect(first.inner.cols).toBe(84);
    expect(first.inner.rows).toBe(19);
    expect(first.inner.liveText()).toContain("visible pane");
    const handle = first.handle;
    runtime.receive(connection, snapshot(15));
    expect(runtime.panes[0].terminal).toBe(first);
    expect(first.handle).toBe(handle);
    expect(create).toHaveBeenCalledTimes(1);
    runtime.destroy();
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    runtime.destroy();
    source.destroy();
    create.mockRestore();
  }
});

test("a first input-mode query initializes the same default terminal once", () => {
  const reference = new Terminal(1, 1),
    pane = new mirror.Terminal(connection, 1, 0, 0),
    create = spyOn(Terminal, "create");
  try {
    expect(create).not.toHaveBeenCalled();
    expect(pane.bracketedPaste()).toBe(viewerNative.bracketedPaste(reference.handle));
    expect(pane.pasteEvents()).toBe(viewerNative.pasteEvents(reference.handle));
    expect(pane.mouseEvents()).toBe(viewerNative.mouseEvents(reference.handle));
    for (const codepoint of [keyboard.arrow_up, 13, 127, 97])
      expect(viewerNative.encodeKey(pane.handle, { codepoint, mods: { ctrl: true } })).toBe(
        viewerNative.encodeKey(reference.handle, { codepoint, mods: { ctrl: true } }),
      );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith(1, 1);
  } finally {
    pane.destroy();
    reference.destroy();
    create.mockRestore();
  }
});

test("clearing, sending, holding and destroying an untouched mirror do not initialize it", async () => {
  const source = new Terminal(20, 4),
    pane = new mirror.Terminal(connection, 1, 80, 24),
    create = spyOn(Terminal, "create"),
    free = spyOn(n, "terminal_free");
  try {
    pane.clearSelection();
    pane.scrollViewport("bottom");
    pane.send("input");
    await pane.flush();
    pane.holding_selection = true;
    pane.receive(source.surface(1));
    expect(pane.known).toBeNull();
    pane.clearSelection();
    const empty = source.surface(1);
    pane.receive({ ...empty, surface: { ...empty.surface, cols: 0 } });
    pane.destroy();
    pane.destroy();
    expect(create).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
    expect(() => pane.inner).toThrow("TerminalClosed");
    expect(() => pane.receive(source.surface(1))).toThrow("TerminalClosed");
    expect(create).not.toHaveBeenCalled();
  } finally {
    pane.destroy();
    create.mockRestore();
    free.mockRestore();
    source.destroy();
  }
});

test("first surface installs modes and later resize preserves one native lifetime", () => {
  const source = new Terminal(20, 4),
    pane = new mirror.Terminal(connection, 1, 80, 24),
    create = spyOn(Terminal, "create"),
    free = spyOn(n, "terminal_free");
  try {
    source.feed("\x1b[?1h\x1b[?2004h\x1b[?1003hfirst\x1b[2;3H");
    const first = source.surface(1);
    pane.receive(first);
    expect(pane.known).toEqual(first.stamp);
    expect(pane.bracketedPaste()).toBe(true);
    expect(pane.mouseEvents()).toBe(true);
    expect(viewerNative.encodeKey(pane.handle, { codepoint: keyboard.arrow_up, mods: {} })).toBe("\x1bOA");
    const handle = pane.handle;
    source.resize(31, 7);
    source.feed("\x1b[Hresized\x1b[3;8H");
    const resized = source.surface(1);
    pane.receive(resized);
    expect(pane.handle).toBe(handle);
    expect(pane.inner.cols).toBe(31);
    expect(pane.inner.rows).toBe(7);
    expect(pane.cursor()).toEqual(resized.surface.cursor);
    expect(pane.known).toEqual(resized.stamp);
    expect(create).toHaveBeenCalledTimes(1);
    pane.destroy();
    pane.destroy();
    expect(free).toHaveBeenCalledTimes(1);
    expect(() => pane.handle).toThrow("TerminalClosed");
    expect(() => pane.receive(resized)).toThrow("TerminalClosed");
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    pane.destroy();
    create.mockRestore();
    free.mockRestore();
    source.destroy();
  }
});

function retained(pane: mirror.Terminal) {
  pane.updateRender();
  const frame = new Frame(),
    writer = new Writer();
  writer.write("\x1b[0m\x1b[H\x1b[J");
  frame.pane(writer, pane, 1, new Rect(0, 0, 20, 4));
  frame.cursor = pane.cursor();
  frame.cursor_at = writer.s.length;
  return frame.finish(writer.s);
}

test("released mirrors restore styled cells, links, cursor and input modes before another surface arrives", () => {
  const source = new Terminal(20, 4),
    pane = new mirror.Terminal(connection, 1, 80, 24),
    differ = Differ.create(20, 4),
    host = new Terminal(20, 4);
  try {
    source.feed(
      "\x1b[?1h\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[31;4m界 é\x1b[0m" +
        "\x1b]8;id=kept;https://example.com\x1b\\link\x1b]8;;\x1b\\\x1b[3;4H\x1b[?25h",
    );
    const view = source.surface(1);
    pane.receive(view);
    const before = retained(pane),
      identity = pane.inner.surface_identity,
      revision = pane.render_revision,
      cells = pane.inner.surface(1).surface,
      links = pane.hyperlinks();
    host.feed(differ.diff(before));
    const displayed = host.surface(1).surface;
    expect(pane.release()).toBe(true);
    expect(pane.release()).toBe(false);
    expect(Reflect.get(pane, "native")).toBeNull();
    expect(pane.known).toEqual(view.stamp);
    expect(pane.bracketedPaste()).toBe(true);
    expect(pane.mouseEvents()).toBe(true);
    expect(viewerNative.encodeKey(pane.handle, { codepoint: keyboard.arrow_up, mods: {} })).toBe("\x1bOA");
    expect(pane.inner.surface_identity).not.toBe(identity);
    expect(pane.render_revision).toBeGreaterThan(revision);
    expect(pane.inner.surface(1).surface).toEqual(cells);
    expect(pane.hyperlinks()).toEqual(links);
    expect(pane.cursor()).toEqual(view.surface.cursor);
    const after = retained(pane);
    expect(same(before, after)).toBe(false);
    host.feed(differ.diff(after));
    expect(host.surface(1).surface).toEqual(displayed);
  } finally {
    pane.destroy();
    source.destroy();
    differ.destroy();
    host.destroy();
  }
});

test("release preserves a pending viewport, queued input and selection guards", () => {
  const source = new Terminal(20, 4),
    pane = new mirror.Terminal(connection, 1, 20, 4);
  try {
    source.feed("history\r\n".repeat(12) + "visible text");
    const view = source.surface(1);
    pane.receive(view);
    pane.select(0, 0, 3, 0);
    const selected = pane.selectedText();
    expect(pane.release()).toBe(false);
    expect(pane.selectedText()).toBe(selected);
    pane.clearSelection();
    pane.holding_selection = true;
    expect(pane.release()).toBe(false);
    pane.holding_selection = false;
    pane.send("queued input");
    pane.scrollViewport("top");
    expect(pane.offset).toBe(0);
    expect(pane.release()).toBe(true);
    pane.cursor();
    expect(pane.offset).toBe(0);
    expect(pane.bottom).toBe(view.bottom);
    expect(pane.known).toEqual(view.stamp);
    expect(Buffer.from(pane.pending).toString()).toBe("queued input");
    pane.receive(source.surface(1, 0));
    expect(pane.offset).toBe(0);
    expect(pane.known?.offset).toBe(0);
    expect(pane.release()).toBe(true);
    pane.destroy();
    expect(pane.release()).toBe(false);
    expect(() => pane.inner).toThrow("TerminalClosed");
  } finally {
    pane.destroy();
    source.destroy();
  }
});

test("new rows, resize and replacement install correctly after an inactive mirror is released", () => {
  const source = new Terminal(20, 4),
    replacement = new Terminal(11, 3),
    pane = new mirror.Terminal(connection, 1, 20, 4),
    reference = new mirror.Terminal(connection, 1, 20, 4);
  const install = (input: ReturnType<Terminal["surface"]>) => {
    pane.receive(input);
    reference.receive(input);
    expect(pane.inner.surface(1).surface).toEqual(reference.inner.surface(1).surface);
    expect(pane.cursor()).toEqual(reference.cursor());
    expect(pane.known).toEqual(input.stamp);
  };
  try {
    source.feed("\x1b[31m界 wide line\x1b[0m\x1b[2;3H");
    install(source.surface(1));
    expect(pane.release()).toBe(true);
    source.feed("\x1b[1;1Hx\x1b[K\x1b[3;4H");
    install(source.surface(1));
    expect(pane.release()).toBe(true);
    source.resize(11, 3);
    source.feed("\x1b[Hresized");
    install(source.surface(1));
    expect(pane.release()).toBe(true);
    replacement.feed("\x1b[32mreplacement\x1b[0m\x1b[2;2H");
    install(replacement.surface(1));
  } finally {
    pane.destroy();
    reference.destroy();
    source.destroy();
    replacement.destroy();
  }
});

test("failed native hydration preserves the receipt and can retry", () => {
  const source = new Terminal(20, 4),
    pane = new mirror.Terminal(connection, 1, 20, 4);
  source.feed("retained");
  const view = source.surface(1);
  pane.receive(view);
  pane.release();
  const receive = spyOn(viewerNative, "receiveFrame").mockImplementationOnce(() => {
    throw Error("OutOfMemory");
  });
  try {
    expect(() => pane.inner).toThrow("OutOfMemory");
    expect(Reflect.get(pane, "native")).toBeNull();
    expect(pane.known).toEqual(view.stamp);
    receive.mockRestore();
    expect(pane.inner.liveText()).toContain("retained");
  } finally {
    receive.mockRestore();
    pane.destroy();
    source.destroy();
  }
});

function syncingView(state: object) {
  const requests: RequestInput<"viewer.sync">[] = [],
    view = new Controller(
      transport(async (op, fields) => {
        expect(op).toBe("viewer.sync");
        requests.push(fields as RequestInput<"viewer.sync">);
        return { viewer_protocol: viewerVersion.version, surfaces: [], session_hash: null };
      }),
    );
  view.width = 100;
  view.height = 30;
  view.corgi_badge = "none";
  view.prefs.sidebar_width = 28;
  view.prefs.corgi_intensity = 0;
  view.review_summaries.want = () => {};
  view.receiveSnapshot(state);
  return { view, requests, sync: () => viewer.sync(view, { seq: 0n }, false) };
}

test("same-stamp focus returns restore an evicted pane without an RPC surface", async () => {
  const f = syncingView(snapshot(2)),
    source = new Terminal(72, 29);
  try {
    source.feed("\x1b[?1h\x1b[?2004hretained pane\x1b[2;3H");
    for (const p of f.view.runtime.panes) p.terminal.receive(source.surface(p.id));
    const second = f.view.runtime.pane(2)!.terminal,
      known = second.known;
    await f.sync();
    expect(Reflect.get(second, "native")).toBeNull();
    f.view.focusPane(2);
    expect(second.bracketedPaste()).toBe(true);
    expect(viewerNative.encodeKey(second.handle, { codepoint: keyboard.arrow_up, mods: {} })).toBe("\x1bOA");
    const identity = second.inner.surface_identity;
    await f.sync();
    expect(f.requests.at(-1)!.interests[0].known).toEqual(known);
    expect(second.inner.surface_identity).toBe(identity);
    expect(second.inner.liveText()).toContain("retained pane");
    expect(Reflect.get(f.view.runtime.pane(1)!.terminal, "native")).toBeNull();
  } finally {
    viewer.close(f.view);
    source.destroy();
  }
});

test("sync pins all split panes and both sidebar preview layouts without native recreation", async () => {
  const state = snapshot(6),
    f = syncingView({
      ...state,
      workspaces: [
        {
          ...state.workspaces[0],
          model: {
            nodes: [
              { split: { axis: "horizontal", ratio: 500, first: 1, second: 2 } },
              { pane: 1 },
              { pane: 2 },
              { pane: 3 },
              { pane: 6 },
            ],
            tabs: [
              { id: 1, root: 0, title: "split" },
              { id: 3, root: 3, title: "ghost" },
              { id: 6, root: 4, title: "hidden" },
            ],
            revision: 0,
          },
        },
        {
          id: 2,
          name: "preview",
          cwd: "",
          model: {
            nodes: [{ split: { axis: "horizontal", ratio: 500, first: 1, second: 2 } }, { pane: 4 }, { pane: 5 }],
            tabs: [{ id: 4, root: 0, title: "preview split" }],
            revision: 0,
          },
        },
      ],
      panes: state.panes.map(p => ({
        ...p,
        workspace: p.id === 4 || p.id === 5 ? 2 : 1,
        tab: p.id <= 2 ? 1 : p.id === 5 ? 4 : p.id,
      })),
    }),
    source = new Terminal(72, 29),
    workspace = f.view.runtime.workspaces.items[1],
    ghost = spyOn(f.view, "sidebarGhost").mockImplementation(() => ({
      pane: f.view.runtime.pane(3)!,
      rect: f.view.area(),
      area: f.view.area(),
    })),
    preview = spyOn(f.view, "sidebarWorkspaceGhost").mockImplementation(() => ({
      name: "preview",
      view: new LayoutView(workspace.model, f.view.navigation.selection(f.view.runtime.workspaces, workspace)),
    }));
  for (const pane of f.view.runtime.panes) pane.terminal.receive(source.surface(pane.id));
  const create = spyOn(Terminal, "create"),
    identities = f.view.runtime.panes.map(p => p.terminal.inner.surface_identity);
  try {
    for (let i = 0; i < 3; i++) {
      await f.sync();
      f.view.compose();
      for (let id = 1; id <= 5; id++)
        expect(f.view.runtime.pane(id)!.terminal.inner.surface_identity).toBe(identities[id - 1]);
      expect(Reflect.get(f.view.runtime.pane(6)!.terminal, "native")).toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
    expect(f.requests[0].interests.map(interest => interest.pane)).toEqual([1, 2, 3]);
  } finally {
    create.mockRestore();
    ghost.mockRestore();
    preview.mockRestore();
    viewer.close(f.view);
    source.destroy();
  }
});
