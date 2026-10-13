import * as protocol from "./protocol";
import { transport } from "./fixtures/transport";
import { expect, setSystemTime, spyOn, test } from "bun:test";
import { Controller, cardEffect, pasteKey, forkName, breadcrumbs } from "./controller";
import * as preferences from "./preferences";
import { TabMenu } from "./commands";
import { Dialog } from "./name_dialog";
import { Menu as LauncherMenu } from "./agent_launcher";
import { Menu as SetupMenu } from "./corgi_setup";
import * as hostClipboard from "./host_clipboard";
import * as keyboard from "./keyboard";
import * as viewer from "./viewer";
import { agent, type Pane } from "./mirror";
import * as summaries from "./review/summaries";
import * as sidebar from "./sidebar";

/** A controller with no daemon: these tests send no requests. */
function controller(): any {
  return new Controller({
    socket: "",
    request: transport(async () => {
      throw Error("UnexpectedRequest");
    }).request,
  });
}
const bytes = (text: string) => new TextEncoder().encode(text);

test("setup previews intensity drags and saves once on release, including outside the modal", async () => {
  const update = spyOn(preferences, "update").mockImplementation(() => {});
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.width = 100;
  s.height = 30;
  s.input_state.attached = true;
  s.corgi_setup = SetupMenu.open();
  const menu: SetupMenu = s.corgi_setup;
  menu.item = "flourishes";
  menu.openOptions(s.runtime.inference, s.prefs);
  try {
    let point: { x: number; y: number } | null = null;
    for (let y = 0; y < 30 && !point; y++)
      for (let x = 0; x < 100; x++) {
        const hit = menu.hit(100, 30, x, y, s.runtime.inference, s.prefs);
        if (hit && "intensity" in hit && hit.intensity === 0) {
          point = { x, y };
          break;
        }
      }
    expect(point).not.toBeNull();
    await s.mouse(`\x1b[<0;${point!.x + 1};${point!.y + 1}M`);
    expect(menu.previewIntensity(s.prefs)).toBe(0);
    expect(s.prefs.corgi_intensity).toBe(50);
    expect(update).not.toHaveBeenCalled();
    await s.mouse("\x1b[<32;150;35M");
    expect(menu.previewIntensity(s.prefs)).toBe(100);
    expect(update).not.toHaveBeenCalled();
    await s.mouse("\x1b[<0;150;35m");
    expect(s.prefs.corgi_intensity).toBe(100);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith({ corgi_intensity: 100 });
    await s.input(bytes("\x1b[H"));
    expect(s.prefs.corgi_intensity).toBe(0);
    expect(update).toHaveBeenCalledTimes(2);
    await s.input(bytes("\x1b[D"));
    expect(menu.focus).toBe("options");
    expect(update).toHaveBeenCalledTimes(2);
  } finally {
    update.mockRestore();
    viewer.close(s);
  }
});
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

test("Copy ID names the harness, session, id and paths, leaving out what isn't known", () => {
  const pane = (label: string, fields: object) => ({ label, cwd: "/repo/sub", agent: agent(fields) }) as Pane;
  const claude = pane("", {
    provider: "claude",
    name: "fix sidebar hover",
    session: "0b8e1c2a",
    cwd: "/repo",
    transcript: "/home/u/.claude/projects/-repo/0b8e1c2a.jsonl",
  });
  expect(breadcrumbs(claude)).toBe(
    [
      "harness: Claude Code",
      "session: fix sidebar hover",
      "id: 0b8e1c2a",
      "cwd: /repo",
      "transcript: /home/u/.claude/projects/-repo/0b8e1c2a.jsonl",
    ].join("\n"),
  );
  // A pane's own name wins; the pane's folder stands in for the agent's.
  expect(breadcrumbs(pane("review", { provider: "codex", name: "thread", session: "019a" }))).toBe(
    ["harness: Codex", "session: review", "id: 019a", "cwd: /repo/sub"].join("\n"),
  );
});

test("an agent marked unread stays unread in view until focus moves onto it", async () => {
  const sent: [string, any][] = [];
  const s: any = new Controller({
    socket: "",
    request: transport(async (op, fields) => {
      sent.push([op, fields]);
      return { ok: true };
    }).request,
  });
  const seen = () => {
    const snapshot = pair();
    for (const p of snapshot.panes) p.agent.observation = { completed: 1, read: 1 };
    return snapshot;
  };
  /** The daemon's snapshot once pane `id` is marked unread. */
  const marked = (id: number) => {
    const snapshot = seen();
    Object.assign(snapshot.panes[id - 1].agent, { attention: "finished", observation: { completed: 1, read: 0 } });
    return snapshot;
  };
  const acknowledged = async () => {
    sent.length = 0;
    await viewer.presented(s);
    return sent.filter(([op]) => op === "pane.acknowledge").map(([, fields]) => fields.pane);
  };
  s.receiveSnapshot(seen());
  try {
    s.focusPane(1);
    s.tab_menu = new TabMenu({ tab: 2, agent: true, anchor_x: 0 });
    await s.tabMenuAction("mark-unread");
    expect(sent.at(-1)).toEqual(["pane.mark_unread", { pane: 2, binding: 0n, conversation: 0, session: "" }]);
    s.receiveSnapshot(marked(2));
    expect(await acknowledged()).toEqual([]);
    s.focusPane(2);
    expect(await acknowledged()).toEqual([2]);
    // Marked while focused, it waits for focus to leave and come back.
    s.tab_menu = new TabMenu({ tab: 2, agent: true, anchor_x: 0 });
    await s.tabMenuAction("mark-unread");
    s.receiveSnapshot(marked(2));
    expect(await acknowledged()).toEqual([]);
    s.focusPane(1);
    expect(await acknowledged()).toEqual([]);
    s.focusPane(2);
    expect(await acknowledged()).toEqual([2]);
    // Out of view, the mark is let go; showing the pane again reads it.
    s.tab_menu = new TabMenu({ tab: 1, agent: true, anchor_x: 0 });
    await s.tabMenuAction("mark-unread");
    s.receiveSnapshot(marked(1));
    s.switchWorkspace(2);
    await acknowledged();
    expect(s.marked_unread.size).toBe(0);
  } finally {
    viewer.close(s);
  }
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
    request: transport(async (op, fields) => {
      if (op !== "session.command") return snapshot;
      commands.push(protocol.decode("session.command", fields).command);
      snapshot = folders("/a", "/b");
      return { result: { pane: 2, workspace: 2 } };
    }).request,
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

test("prefix w opens a folded sidebar's workspaces as a drawer over the panes, or focuses an open one", async () => {
  const update = spyOn(preferences, "update").mockImplementation(() => {});
  const { s, sent } = steering();
  try {
    s.sidebar_open = false;
    s.focusPane(1);
    const area = s.area();
    await s.input(bytes("\x02w"));
    expect(s.sidebar_focus.drawer).toBe("workspaces");
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 1 });
    expect(s.area()).toEqual(area);
    expect(s.frame()).not.toContain("agents");
    // Its own key puts it away; a prefixed arrow keeps to the workspaces.
    await s.input(bytes("\x02w"));
    expect(s.sidebar_focus).toBeNull();
    expect(s.sidebar_open).toBe(false);
    await s.input(bytes("\x02w\x02\x1b[B"));
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 1 });
    await s.input(bytes("\x1b[B"));
    await s.key(13);
    expect(s.current().id).toBe(2);
    expect(s.sidebar_focus).toBeNull();
    expect(s.sidebar_open).toBe(false);
    s.sidebar_open = true;
    await s.input(bytes("\x02w"));
    expect(s.sidebar_focus.drawer).toBeNull();
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 2 });
    expect(sent).toEqual([]);
  } finally {
    update.mockRestore();
    viewer.close(s);
  }
});

test("arrows the sidebar takes keep the repeat window open, so focus goes in and out without the prefix", async () => {
  const { s, sent } = steering();
  try {
    s.focusPane(1);
    await s.input(bytes("\x02\x1b[D"));
    for (let i = 0; i < 3; i++) {
      expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 1 } });
      await s.input(bytes("\x1b[C"));
      expect(s.sidebar_focus).toBeNull();
      expect(s.focused().id).toBe(1);
      await s.input(bytes("\x1b[D"));
    }
    expect(s.sidebar_focus).not.toBeNull();
    // Once the window lapses, the sidebar still takes its arrows, but the next one leaves for the pane.
    s.repeat_until = Date.now() - 1;
    await s.input(bytes("\x1b[C\x1b[D"));
    expect(s.sidebar_focus).toBeNull();
    expect(sent.map(([, text]) => text).join("")).toContain("\x1b[D");
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

test("a folded sidebar takes focus only as a drawer, which a prefixed command puts away", async () => {
  const update = spyOn(preferences, "update").mockImplementation(() => {});
  const { s } = steering();
  try {
    s.sidebar_open = false;
    s.focusPane(1);
    const area = s.area();
    await s.input(bytes("\x02\x1b[D"));
    expect(s.sidebar_focus).toBeNull();
    expect(s.sidebar_open).toBe(false);
    await s.input(bytes("\x02a"));
    expect(s.sidebar_focus.drawer).toBe("agents");
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 1 } });
    expect(s.area()).toEqual(area);
    expect(s.frame()).not.toContain("workspaces");
    await s.key(27);
    expect(s.sidebar_open).toBe(false);
    await s.input(bytes("\x02a"));
    // The prefix keeps the drawer for an arrow, which stays in its list ...
    await s.input(bytes("\x02\x1b[A"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 1 } });
    // ... and gives the keyboard back for anything else.
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
    // Ghosting a hibernated agent doesn't wake it, and a drawer's ghost
    // is laid out in the folded sidebar's area.
    s.focusPane(1);
    s.pane(3).dormant = true;
    s.sidebar_open = false;
    // Up passes workspace 1's header, then wraps.
    await s.input(bytes("\x02a\x1b[A\x1b[A"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 3 } });
    expect(s.sidebarGhost().area.x).toBe(0);
    await s.expireInput();
    expect(s.pane(3).dormant).toBe(true);
  } finally {
    viewer.close(s);
  }
});

test("the launcher names a new worktree, then adds it before starting the agent there", async () => {
  const checkout = (path: string, branch: string, primary: boolean) => ({
    path,
    head: "4f1c2a9e0b",
    branch: `refs/heads/${branch}`,
    primary,
    bare: false,
    detached: false,
    locked: null,
    prunable: null,
    available: true,
    comparison: null,
    changes: null,
    stale: false,
  });
  const snapshot = folders("/src/app");
  Object.assign(snapshot.workspaces[0], {
    worktrees: {
      common_dir: "/src/app/.git",
      base: { ref: "refs/heads/main", name: "main", head: "4f1c2a9e0b" },
      entries: [checkout("/src/app", "main", true), checkout("/src/app-topic", "topic", false)],
      agents: [],
      stale: false,
    },
  });
  const sent: [string, any][] = [];
  let refuse: string | null = "BranchExists";
  const s: any = new Controller({
    socket: "",
    request: transport(async (op, fields) => {
      sent.push([op, fields]);
      if (op === "worktree.add" && refuse) return { err: refuse };
      if (op === "session.command") return { result: { pane: 1 } };
      if (op === "git.branches")
        return {
          branches: [
            { ref: "refs/heads/main", name: "main", at: 2 },
            { ref: "refs/heads/topic", name: "topic", at: 1 },
          ],
        };
      return snapshot;
    }).request,
  });
  s.receiveSnapshot(snapshot);
  s.input_state.attached = true;
  s.openLauncher(true, "/src/app-topic");
  s.agent_launcher.selected = "claude";
  await s.key("w".charCodeAt(0));
  expect([s.agent_launcher.worktree.mode, s.agent_launcher.worktree.focus]).toEqual(["open", "branch"]);
  // Up goes to the last checkout, just above the form; n comes back.
  await s.input(bytes("\x1b[A"));
  expect([s.agent_launcher.worktree.focus, s.agent_launcher.worktree.hovered]).toEqual(["list", 1]);
  await s.key("n".charCodeAt(0));
  expect(s.agent_launcher.worktree.focus).toBe("branch");
  // Escape closes the box from the form in one press.
  await s.key(27);
  expect([s.agent_launcher.worktree.mode, s.agent_launcher === null]).toEqual(["closed", false]);
  await s.key("w".charCodeAt(0));
  for (const byte of bytes("log in")) await s.key(byte);
  // Tab moves to From, which searches the branches the daemon listed.
  await s.key(9);
  expect(s.agent_launcher.worktree.focus).toBe("from");
  // There Escape only dismisses From's list.
  await s.key(27);
  expect([s.agent_launcher.worktree.mode, s.agent_launcher.worktree.focus]).toEqual(["open", "branch"]);
  await s.key(9);
  for (const byte of bytes("top")) await s.key(byte);
  await s.key(13);
  expect(s.agent_launcher.worktree.focus).toBe("branch");
  await s.key(13);
  expect(s.agent_launcher.worktree.planned).toEqual({
    branch: "log-in",
    base: "refs/heads/topic",
    base_name: "topic",
    path: "/src/app/.worktrees/log-in",
  });
  expect(s.agent_launcher.place().label).toBe("log-in");
  // Git refuses: the form comes back with why, and nothing launches.
  await s.key("a".charCodeAt(0));
  expect([s.agent_launcher.worktree.mode, s.agent_launcher.worktree.focus]).toEqual(["open", "branch"]);
  expect(s.agent_launcher.worktree.error).toBe("A branch named log-in exists already");
  expect(sent.some(([op]) => op === "session.command")).toBe(false);
  refuse = null;
  await s.key(13);
  await s.key("a".charCodeAt(0));
  const add = sent.findLast(([op]) => op === "worktree.add")!;
  expect(add[1]).toEqual({
    workspace: 1,
    path: "/src/app/.worktrees/log-in",
    branch: "log-in",
    base: "refs/heads/topic",
  });
  const create = sent.find(([op]) => op === "session.command")!;
  expect(create[1].command["agent.create"]).toEqual({
    workspace: 1,
    cwd: "/src/app/.worktrees/log-in",
    provider: "claude",
  });
});

test("the launcher lights the checkout it starts agents in, as the overview lights a worktree", () => {
  const checkout = (path: string, branch: string, primary: boolean) => ({
    path,
    head: "4f1c2a9e0b",
    branch: `refs/heads/${branch}`,
    primary,
    bare: false,
    detached: false,
    locked: null,
    prunable: null,
    available: true,
    comparison: null,
    changes: null,
    stale: false,
  });
  const snapshot = folders("/src/app");
  Object.assign(snapshot.workspaces[0], {
    worktrees: {
      common_dir: "/src/app/.git",
      base: { ref: "refs/heads/main", name: "main", head: "4f1c2a9e0b" },
      entries: [checkout("/src/app", "main", true), checkout("/src/app-topic", "topic", false)],
      agents: [],
      stale: false,
    },
  });
  const s: any = new Controller({ socket: "", request: transport(async () => snapshot).request });
  s.receiveSnapshot(snapshot);
  s.openLauncher(true, "/src/app-topic");
  expect(s.spotlight()).toEqual({ workspace: 1, path: "/src/app-topic" });
  expect(s.agent_launcher.place().aside).toBe(true);
  s.closeLauncher();
  expect(s.spotlight()).toBeNull();
  // The main checkout lights the workspace's own rows; a worktree yet to be
  // added has no rows, so everything fades.
  s.openLauncher(true, "/src/app");
  expect(s.spotlight()).toEqual({ workspace: 1, path: null });
  expect(s.agent_launcher.place().aside).toBe(false);
  s.agent_launcher.worktree.planned = { branch: "next", base: "refs/heads/main", base_name: "main", path: "/src/n" };
  expect(s.spotlight()).toEqual({ workspace: 1, path: "/src/n" });
  s.closeLauncher();
  // An agent started on main that writes in topic is listed under topic,
  // so the launcher opened beside it starts there.
  Object.assign(snapshot.panes[0], { cwd: "/src/app", agent: { ...snapshot.panes[0].agent, provider: "codex" } });
  (snapshot.workspaces[0] as any).worktrees.agents = [
    { target: { pane: 1 }, path: "/src/app-topic", source: "write", stale: false },
  ];
  s.receiveSnapshot(snapshot);
  s.openLauncher(true);
  expect([s.agent_launcher.cwd, s.agent_launcher.place().label]).toEqual(["/src/app-topic", "topic"]);
  expect(s.spotlight()).toEqual({ workspace: 1, path: "/src/app-topic" });
});

test("an agent's review reads the checkout the list puts it under", () => {
  const checkout = (path: string, branch: string, primary: boolean) => ({
    path,
    head: "4f1c2a9e0b",
    branch: `refs/heads/${branch}`,
    primary,
    bare: false,
    detached: false,
    locked: null,
    prunable: null,
    available: true,
    comparison: null,
    changes: null,
    stale: false,
  });
  const snapshot = folders("/src/app");
  Object.assign(snapshot.panes[0], {
    cwd: "/src/app",
    agent: { ...snapshot.panes[0].agent, provider: "codex", cwd: "/src/app" },
  });
  Object.assign(snapshot.workspaces[0], {
    worktrees: {
      common_dir: "/src/app/.git",
      base: { ref: "refs/heads/main", name: "main", head: "4f1c2a9e0b" },
      entries: [checkout("/src/app", "main", true), checkout("/src/app-topic", "topic", false)],
      agents: [],
      stale: false,
    },
  });
  const s: any = new Controller({ socket: "", request: transport(async () => snapshot).request });
  s.receiveSnapshot(snapshot);
  expect(s.reviewTarget().cwd).toBe("/src/app");
  // Started on main but writing in topic, it's listed under topic.
  (snapshot.workspaces[0] as any).worktrees.agents = [
    { target: { pane: 1 }, path: "/src/app-topic", source: "write", stale: false },
  ];
  s.receiveSnapshot(snapshot);
  expect(s.reviewTarget().cwd).toBe("/src/app-topic");
});

test("the agent menu's diff line is read ahead for the focused agent, its neighbours and a hovered row", async () => {
  const panes = [1, 2, 3, 4, 5],
    state = (completed: number) => ({
      workspaces: [
        {
          id: 1,
          name: "/w",
          cwd: "/w",
          model: {
            nodes: panes.map(pane => ({ pane })),
            tabs: panes.map(id => ({ id, root: id - 1, title: "" })),
            revision: 0,
          },
        },
      ],
      panes: panes.map(id => ({
        id,
        workspace: 1,
        tab: id,
        cols: 40,
        rows: 24,
        cwd: "/w",
        agent: {
          provider: "claude",
          name: `agent ${id}`,
          cwd: `/w/${id}`,
          state: "idle",
          attention: "none",
          observation: { completed: id === 2 ? completed : 0, read: 0 },
        },
      })),
      conversations: [],
      native_sessions: [],
    });
  const s = controller(),
    reads: string[] = [];
  s.review_summaries = new summaries.Summaries(
    async root => {
      reads.push(root);
      return [[root, "faint"]];
    },
    async cwd => cwd,
  );
  s.width = 120;
  s.height = 40;
  s.input_state.attached = true;
  s.receiveSnapshot(state(0));
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    setSystemTime(new Date(1_000_000));
    s.focusPane(2);
    s.frame();
    await settle();
    // One at a time: the focused agent first, then those beside it.
    expect(reads).toEqual(["/w/2", "/w/1", "/w/3"]);
    // A hovered row waits a moment first, so a sweep down the list reads nothing.
    const entries = s.sidebarEntries(),
      view = s.sidebarView(entries);
    const y = Array.from({ length: 40 }, (_, y) => y).find(y => {
      const target = sidebar.agentAt(view, entries, 5, y)?.target;
      return target !== undefined && "pane" in target && target.pane === 5;
    });
    expect(y).toBeDefined();
    s.pointer = { x: 5, y };
    s.frame();
    setSystemTime(new Date(1_000_050));
    s.frame();
    await settle();
    expect(reads).toHaveLength(3);
    setSystemTime(new Date(1_000_150));
    s.frame();
    await settle();
    expect(reads.slice(3)).toEqual(["/w/5"]);
    // Nothing is read again while nothing changes; a turn ending reads its checkout.
    s.frame();
    s.receiveSnapshot(state(1));
    s.frame();
    await settle();
    expect(reads.slice(4)).toEqual(["/w/2"]);
  } finally {
    setSystemTime();
  }
});
