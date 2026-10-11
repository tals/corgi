import { expect, spyOn, test } from "bun:test";
import { Controller, cardEffect, pasteKey, forkName } from "./controller";
import * as preferences from "./preferences";
import { TabMenu } from "./commands";
import { Dialog } from "./name_dialog";
import { Menu as LauncherMenu } from "./agent_launcher";
import * as hostClipboard from "./host_clipboard";
import * as keyboard from "./keyboard";
import * as viewer from "./viewer";

/** A controller with no daemon: these tests send no requests. */
function controller(): any {
  return new Controller({
    socket: "",
    request: async () => {
      throw Error("UnexpectedRequest");
    },
  });
}
const bytes = (text: string) => new TextEncoder().encode(text);
/** One workspace per folder, each with one pane, as `session.snapshot` sends them. */
function folders(...cwds: string[]) {
  return {
    workspaces: cwds.map((cwd, i) => ({
      id: i + 1,
      name: cwd,
      cwd,
      model: { nodes: [{ pane: i + 1 }], tabs: [{ id: i + 1, root: 0, title: "" }], revision: 0 },
    })),
    panes: cwds.map((_, i) => ({
      id: i + 1,
      workspace: i + 1,
      tab: i + 1,
      cols: 80,
      rows: 24,
      agent: { provider: null, attention: "none", observation: { completed: 0, read: 0 } },
    })),
    conversations: [],
    native_sessions: [],
  };
}

test("the tab menu starts a prefix only with the configured prefix key", async () => {
  const s = controller();
  s.prefs = Object.assign(new preferences.Preferences(), { prefix: "ctrl_a" });
  s.tab_menu = new TabMenu({ tab: 1, anchor_x: 0 });
  await s.key(2);
  expect(s.prefix).toBe(false);
  expect(s.tab_menu).not.toBeNull();
  await s.key(1);
  expect(s.prefix).toBe(true);
  expect(s.tab_menu).toBeNull();
});

test("the full-screen help covers the panes, a prefix alone does not", () => {
  const s = controller();
  expect(s.coversPanes()).toBe(false);
  s.beginPrefix();
  expect(s.coversPanes()).toBe(false);
  s.openHelp();
  expect(s.coversPanes()).toBe(true);
  s.closeMenu();
  expect(s.coversPanes()).toBe(false);
});

test("a paste goes to the field that owned the keyboard when it began", async () => {
  const s = controller();
  s.input_state.attached = true;
  s.name_dialog = Dialog.init({ rename: 1 }, "");
  await s.input(bytes("\x1b[200~ab\x1b[201~"));
  expect(s.name_dialog.name()).toBe("ab");
  expect(s.input_state.paste).toBeNull();
  // The launcher takes keys before a dialog it was opened over.
  s.agent_launcher = new LauncherMenu({ workspace: 1, selected: "add", last: "codex", pinned: true, managing: true });
  expect(s.pasteTarget()).toBe("launcher");
  s.agent_launcher.selected = "codex";
  expect(s.pasteTarget()).toBe("discard");
  s.agent_launcher = null;
  s.name_dialog = null;
  s.beginPrefix();
  expect(s.pasteTarget()).toBe("discard");
});

test("a paste read from the host clipboard goes where a paste would", async () => {
  const clipboard = Object.assign(new hostClipboard.State(), { support: "on" });
  const s = controller();
  s.host_clipboard = clipboard;
  s.name_dialog = Dialog.init({ rename: 1 }, "");
  // Text is read for the dialog; an image has nowhere to go.
  await s.pasteEvent("image/png text/plain");
  expect(s.paste_target).toBe("name");
  expect(clipboard.out.endsWith(";dGV4dC9wbGFpbg==\x1b\\")).toBe(true);
  await s.pasteResult({ text: "a\x03b" });
  expect(s.name_dialog.name()).toBe("a b");
  expect(s.paste_target).toBeNull();
  clipboard.reading = null;
  await s.pasteEvent("image/png");
  expect(s.message).toBe(hostClipboard.Failure.message("not_pane"));
  // Text that could end a bracketed paste is refused, as Ghostty would.
  s.paste_target = "name";
  await s.pasteResult({ text: "x\x1b[201~y" });
  expect(s.name_dialog.name()).toBe("a b");
});

test("esc closes the paste card and does nothing else; a click or another key also closes it", async () => {
  expect(cardEffect("\x1b[27u")).toBe("dismiss");
  expect(cardEffect("\x1b[<0;5;5M")).toBe("close");
  expect(cardEffect("\x1b[<64;5;5M")).toBe("close");
  expect(cardEffect("\x1b[<35;5;5M")).toBe("keep");
  expect(cardEffect("\x1b[<0;5;5m")).toBe("keep");
  expect(cardEffect("\x1b[I")).toBe("keep");
  expect(cardEffect("\x1b[A")).toBe("close");
  expect(pasteKey(keyboard.decode("\x1b[118;9u")!)).toBe("cmd");
  expect(pasteKey(keyboard.decode("\x1b[118;6u")!)).toBe("ctrl_shift");
  expect(pasteKey(keyboard.decode("\x1b[118;5u")!)).toBeNull();
  const s = controller();
  s.paste_card = { pane: 1, notice: {}, pressed: false, copied: false };
  await s.key(27);
  expect(s.paste_card).toBeNull();
});

test("escape in the launcher's search clears the query, then closes the launcher", async () => {
  const s = controller();
  s.agent_launcher = new LauncherMenu({ workspace: 1, selected: "codex", last: "codex", pinned: true });
  // Collapsed, so the test needs no sidebar to scroll the list.
  Object.assign(s.agent_launcher.resume_view, {
    focused: true,
    searching: true,
    query: Dialog.init({ pane: 0 }, "ab"),
  });
  await s.key(27);
  expect(s.agent_launcher).not.toBeNull();
  expect(s.agent_launcher.resume_view.searching).toBe(true);
  expect(s.agent_launcher.resume_view.query.name()).toBe("");
  await s.key(27);
  expect(s.agent_launcher).toBeNull();
});

test("a fork's name is its title marked as a fork, cut to fit", () => {
  expect(forkName("refactor")).toBe("refactor (fork)");
  const long = forkName("x".repeat(72) + "⑂⑂");
  expect(long).toBe("x".repeat(72) + " (fork)");
  expect(Buffer.from(long).toString()).toBe(long);
});

test("open shows the workspace already on that folder", async () => {
  const s = controller();
  s.receiveSnapshot(folders("/a", "/b"));
  try {
    await s.perform({ name: "open", value: "/b" });
    expect(s.current().id).toBe(2);
    await expect(s.perform({ name: "open", value: "b" })).rejects.toThrow("InvalidDirectory");
  } finally {
    viewer.close(s);
  }
});

test("a new viewer scrolls the agent list where the last one left the same list", () => {
  const update = spyOn(preferences, "update").mockImplementation(() => {});
  const s = controller();
  s.receiveSnapshot(folders("/a", "/b"));
  try {
    s.navigation.workspace_id = 2;
    s.prefs.agent_scroll = { workspace: 1, offset: 3 };
    s.restoreAgentScroll();
    expect(s.agentOffset().get()).toBe(0);
    s.prefs.agent_scroll = { workspace: 2, offset: 3 };
    s.restoreAgentScroll();
    expect(s.agentOffset().get()).toBe(3);
    s.saveAgentScroll();
    expect(update).not.toHaveBeenCalled();
    s.agentOffset().set(5);
    s.saveAgentScroll();
    expect(update).toHaveBeenLastCalledWith({ agent_scroll: { workspace: 2, offset: 5 } });
    // The "All" list keeps its own scroll.
    s.prefs.agents = "all";
    s.restoreAgentScroll();
    expect(s.agentOffset().get()).toBe(0);
    s.saveAgentScroll();
    expect(update).toHaveBeenLastCalledWith({ agent_scroll: { workspace: null, offset: 0 } });
  } finally {
    update.mockRestore();
    viewer.close(s);
  }
});

test("open adds a workspace for a folder no workspace is on", async () => {
  const commands: any[] = [];
  let snapshot = folders("/a");
  const s = new Controller({
    socket: "",
    request: async (op, fields) => {
      if (op !== "session.command") return snapshot;
      commands.push(fields?.command);
      snapshot = folders("/a", "/b");
      return { result: { pane: 2, workspace: 2 } };
    },
  });
  s.receiveSnapshot(snapshot);
  try {
    await s.perform({ name: "open", value: "/b" });
    expect(commands).toEqual([{ "workspace.create": { name: "", cwd: "/b" } }]);
    expect(s.current().id).toBe(2);
  } finally {
    viewer.close(s);
  }
});

/** Two agents side by side in workspace 1, and one in workspace 2. */
function pair() {
  return {
    workspaces: [
      {
        id: 1,
        name: "/a",
        cwd: "/a",
        model: {
          nodes: [{ split: { axis: "horizontal", ratio: 500, first: 1, second: 2 } }, { pane: 1 }, { pane: 2 }],
          tabs: [{ id: 1, root: 0, title: "" }],
          revision: 0,
        },
      },
      {
        id: 2,
        name: "/b",
        cwd: "/b",
        model: { nodes: [{ pane: 3 }], tabs: [{ id: 2, root: 0, title: "" }], revision: 0 },
      },
    ],
    panes: [1, 2, 3].map(id => ({
      id,
      workspace: id < 3 ? 1 : 2,
      tab: id < 3 ? 1 : 2,
      cols: 40,
      rows: 24,
      agent: {
        provider: "claude",
        name: `agent ${id}`,
        state: "idle",
        attention: "none",
        observation: { completed: 0, read: 0 },
      },
    })),
    conversations: [],
    native_sessions: [],
  };
}
/** A controller on `pair()` that records what panes are sent. */
function steering() {
  const s = controller();
  s.input_state.attached = true;
  s.receiveSnapshot(pair());
  const sent: [number, string][] = [];
  s.sendInput = (term: any, data: any) => sent.push([term.id, Buffer.from(data).toString()]);
  return { s, sent };
}

test("prefixed arrows walk the panes into the sidebar, which opens the agent under its cursor", async () => {
  const { s, sent } = steering();
  try {
    s.focusPane(2);
    await s.input(bytes("\x02\x1b[D"));
    expect(s.focused().id).toBe(1);
    // Inside the repeat window, the next arrow needs no prefix.
    await s.input(bytes("\x1b[D"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 1 } });
    expect(s.frame()).toContain("SIDEBAR");
    // Plain arrows stay in the agent list and wrap, inside the repeat window too.
    await s.input(bytes("\x1b[B"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 2 } });
    await s.input(bytes("\x1b[B"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 1 } });
    // A prefixed arrow crosses to the workspaces, and back to the agent it left.
    await s.input(bytes("\x02\x1b[A"));
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 1 });
    await s.input(bytes("\x02\x1b[B\x1b[A"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 2 } });
    await s.key(13);
    expect(s.sidebar_focus).toBeNull();
    expect(s.focused().id).toBe(2);
    expect(sent).toEqual([]);
  } finally {
    viewer.close(s);
  }
});

test("a workspace row opens that workspace; Esc leaves the sidebar as it was", async () => {
  const { s, sent } = steering();
  try {
    s.focusPane(1);
    await s.input(bytes("\x02\x1b[D\x02\x1b[A\x1b[B"));
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 2 });
    await s.key(27);
    expect(s.sidebar_focus).toBeNull();
    expect(s.current().id).toBe(1);
    await s.input(bytes("\x02\x1b[D\x02\x1b[A\x1b[A\x1b[C"));
    expect(s.sidebar_focus).toBeNull();
    expect(s.current().id).toBe(2);
    expect(sent).toEqual([]);
  } finally {
    viewer.close(s);
  }
});

test("the repeat window closes with time or another key, and the arrow goes to the pane", async () => {
  const { s, sent } = steering();
  try {
    s.focusPane(1);
    await s.input(bytes("\x02\x1b[C"));
    expect(s.focused().id).toBe(2);
    s.repeat_until = Date.now() - 1;
    await s.input(bytes("\x1b[D"));
    expect(s.focused().id).toBe(2);
    await s.input(bytes("\x02\x1b[Dx\x1b[C"));
    expect(s.focused().id).toBe(1);
    expect(sent.map(([, text]) => text).join("")).toContain("x");
    expect(sent.at(-1)![0]).toBe(1);
  } finally {
    viewer.close(s);
  }
});

test("a hidden sidebar shows while it has focus, and a prefixed command hands the keyboard back", async () => {
  const update = spyOn(preferences, "update").mockImplementation(() => {});
  const { s } = steering();
  try {
    s.sidebar_open = false;
    s.focusPane(1);
    await s.input(bytes("\x02\x1b[D"));
    expect(s.sidebar_open).toBe(true);
    await s.key(27);
    expect(s.sidebar_open).toBe(false);
    await s.input(bytes("\x02\x1b[D"));
    // The prefix keeps the sidebar's focus for an arrow ...
    await s.input(bytes("\x02\x1b[A"));
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 1 });
    // ... and gives it back for anything else.
    await s.input(bytes("\x02m"));
    expect(s.sidebar_focus).toBeNull();
    expect(s.sidebar_open).toBe(false);
    expect(s.focused().id).toBe(1);
  } finally {
    update.mockRestore();
    viewer.close(s);
  }
});

test("the sidebar's cursor ghosts an agent no pane shows, where entering it puts it", async () => {
  const { s } = steering();
  try {
    s.prefs.agents = "all";
    s.focusPane(1);
    await s.input(bytes("\x02\x1b[D\x1b[B"));
    // Pane 2 is on screen, so nothing is ghosted.
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 2 } });
    expect(s.sidebarGhost()).toBeNull();
    await s.input(bytes("\x1b[B\x1b[B"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 3 } });
    const ghost = s.sidebarGhost();
    expect(ghost.pane.id).toBe(3);
    expect(ghost.area).toEqual(s.area());
    await s.key(13);
    expect(s.focused().id).toBe(3);
    expect(s.layoutView().placements(s.area())).toEqual([{ id: 3, rect: ghost.rect }]);
    // Ghosting a hibernated agent doesn't wake it, and a peeking sidebar's
    // ghost is laid out without it.
    s.focusPane(1);
    s.pane(3).dormant = true;
    s.sidebar_open = false;
    // Up passes workspace 1's header, then wraps.
    await s.input(bytes("\x02\x1b[D\x1b[A\x1b[A"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 3 } });
    expect(s.sidebarGhost().area.x).toBe(0);
    await s.expireInput();
    expect(s.pane(3).dormant).toBe(true);
  } finally {
    viewer.close(s);
  }
});
