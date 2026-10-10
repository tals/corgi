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
    viewer.deinit(s);
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
    viewer.deinit(s);
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
    viewer.deinit(s);
  }
});
