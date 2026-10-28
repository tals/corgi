import * as protocol from "./protocol";
import { transport } from "./fixtures/transport";
import { expect, setSystemTime, spyOn, test } from "bun:test";
import { Controller, agentMessage, cardEffect, pasteKey, forkName, breadcrumbs, double_click_ms } from "./controller";
import * as sim from "./providers/sim";
import { byProvider } from "./providers";
import * as preferences from "./preferences";
import { TabMenu, type Row } from "./commands";
import { Dialog } from "./name_dialog";
import * as newWorkspace from "./new_workspace";
import * as agentLauncher from "./agent_launcher";
import * as launcherResume from "./launcher_resume";
import * as clock from "./clock";
import { Menu as LauncherMenu } from "./agent_launcher";
import * as agentManager from "./agent_manager";
import * as agentModels from "./agent_models";
import * as accounts from "./accounts";
import * as signin from "./signin";
import * as signinExit from "./signin_exit";
import { Terminal as NativeTerminal } from "./pane/terminal";
import { Writer } from "./text";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Menu as SetupMenu, items as setupItems } from "./corgi_setup";
import * as hostClipboard from "./host_clipboard";
import * as keyboard from "./keyboard";
import * as keymap from "./keymap";
import * as bindings from "./bindings";
import * as viewer from "./viewer";
import { agent, type Pane } from "./mirror";
import * as summaries from "./review/summaries";
import * as sidebar from "./sidebar";
import * as render from "./render";

/** A controller with no daemon: these tests send no requests. */
function controller(): any {
  const s: any = new Controller({
    socket: "",
    request: transport(async () => {
      throw Error("UnexpectedRequest");
    }).request,
  });
  s.model_cache = new agentModels.Cache(
    () => {},
    async () => [],
  );
  return s;
}
const bytes = (text: string) => new TextEncoder().encode(text);

test("notices keep Unicode while stripping controls and truncating at UTF-8 boundaries", () => {
  const s = controller();
  s.notice("设置 日本語 한국어 Русский\n\x1b\u009b");
  expect(s.message).toBe("设置 日本語 한국어 Русский   ");
  s.notice("界".repeat(200));
  expect(s.message).toBe("界".repeat(170));
  expect(Buffer.byteLength(s.message)).toBeLessThanOrEqual(512);
});

test.each(["typing", "kitty key", "click", "resize", "flourishes off"])(
  "%s finishes the sign-in exit without swallowing input",
  async cause => {
    const s = controller(),
      terminal = new NativeTerminal(s.width, s.height);
    s.receiveSnapshot(folders("/a"));
    s.input_state.attached = true;
    try {
      setSystemTime(new Date(1000));
      s.signin_exit = new signinExit.State(signinExit.capture(terminal.surface(0).surface), 1000);
      await s.input(bytes("\x1b[<35;70;10M"));
      expect(s.signin_exit).not.toBeNull();
      switch (cause) {
        case "typing":
          await s.input(bytes("x"));
          break;
        case "kitty key":
          await s.input(bytes("\x1b[120u"));
          break;
        case "click":
          await s.input(bytes("\x1b[<0;70;10M"));
          break;
        case "resize":
          s.width++;
          break;
        case "flourishes off":
          s.prefs.corgi_intensity = 0;
          break;
      }
      await s.expireInput();
      expect(s.signin_exit).toBeNull();
    } finally {
      terminal.destroy();
      setSystemTime();
      viewer.close(s);
    }
  },
);

test("a sign-in takes the prefix only to detach or to type it", async () => {
  const s = controller(),
    open = spyOn(signin.Signin.prototype, "open").mockResolvedValue(undefined),
    prefix = String.fromCharCode(keymap.prefixByte(s.prefs.prefix)),
    detach = String.fromCharCode(bindings.find(s.prefs.preset, { name: "detach" })!.key),
    close = String.fromCharCode(bindings.find(s.prefs.preset, { name: "close" })!.key);
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  let flow: signin.Signin | null = null;
  try {
    s.openSignin((host: signin.Host) => (flow = new signin.Signin(true, false, host)));
    const typed = spyOn(flow!, "input").mockResolvedValue(undefined);
    await s.input(Buffer.from(prefix + close));
    expect(s.signin).toBe(flow);
    expect(s.prefix).toBe(false);
    expect(typed).not.toHaveBeenCalled();
    await s.input(Buffer.from(prefix + prefix));
    expect(typed).toHaveBeenCalledWith(Uint8Array.of(prefix.charCodeAt(0)));
    // The prefix as a Kitty keyboard terminal sends it.
    await s.input(Buffer.from(`\x1b[${prefix.charCodeAt(0) + 96};5u` + detach));
    expect(s.input_state.attached).toBe(false);
  } finally {
    s.signin?.close(1);
    open.mockRestore();
    viewer.close(s);
  }
});

test.each([
  ["prefix+alt+d", "\x1bd"],
  ["prefix+ctrl+d", "\x1b[100;5u"],
  ["prefix+ctrl+d", "\x04"],
  ["prefix+f3", "\x1bOR"],
  ["prefix+é", "é"],
  ["prefix+alt+é", "\x1bé"],
])("Setup recognizes %s as one decoded detach chord", async (chord, input) => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  s.prefs.keys = { detach: chord, sidebar: "prefix+alt+y" };
  s.corgi_setup = SetupMenu.open();
  try {
    await s.input(bytes("\x02\x1by"));
    expect(s.input_state.attached).toBe(true);
    expect(s.corgi_setup).not.toBeNull();
    await s.input(bytes("\x02" + input));
    expect(s.input_state.attached).toBe(false);
  } finally {
    viewer.close(s);
  }
});

test.each([
  ["prefix+ø", "ø"],
  ["prefix+alt+d", "\x1bd"],
  ["prefix+f3", "\x1bOR"],
])("sign-in restricts Unicode and modified prefix shortcuts to detach (%s)", async (chord, input) => {
  const s = controller(),
    open = spyOn(signin.Signin.prototype, "open").mockResolvedValue(undefined);
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  s.prefs.keys = { sidebar: ["prefix+é", "prefix+alt+é", "prefix+f2"], detach: chord };
  let flow: signin.Signin | null = null;
  try {
    s.openSignin((host: signin.Host) => (flow = new signin.Signin(true, false, host)));
    const typed = spyOn(flow!, "input").mockResolvedValue(undefined),
      perform = spyOn(s, "perform");
    for (const key of ["é", "\x1b[233u", "\x1bé", "\x1bOQ"]) await s.input(bytes("\x02" + key));
    expect(s.prefix).toBe(false);
    expect(s.signin).toBe(flow);
    expect(typed).not.toHaveBeenCalled();
    expect(perform).not.toHaveBeenCalled();
    await s.input(bytes("\x02" + input));
    expect(s.input_state.attached).toBe(false);
    expect(perform).toHaveBeenCalledWith({ name: "detach" });
  } finally {
    s.signin?.close(1);
    open.mockRestore();
    viewer.close(s);
  }
});

test.each([0, 50])(
  "account completion holds the old frame and starts immediately at flourish intensity %i",
  async intensity => {
    const s = controller(),
      open = spyOn(signin.Signin.prototype, "open").mockResolvedValue(undefined),
      launch = spyOn(s, "launchAgent").mockResolvedValue(undefined);
    s.receiveSnapshot(folders("/a"));
    s.prefs.corgi_intensity = intensity;
    let flow: signin.Signin | null = null;
    try {
      setSystemTime(new Date(1000));
      s.openSignin((host: signin.Host) => {
        flow = new signin.Signin(true, false, host);
        flow.provider = "claude";
        flow.name = "work";
        flow.account = "/accounts/work";
        return flow;
      });
      const current = flow!;
      current.resize(s.width, s.height);
      const body = current.body();
      current.child = new NativeTerminal(body.cols, body.rows);
      current.child.feed("Sign-in screen to keep");
      const before = new Writer();
      s.drawSignin(before, null);
      current.work("Signed in. Setting up Claude Code…");
      await current.stopChild();
      const held = new Writer();
      s.drawSignin(held, null);
      expect(held.buffered()).toContain("Sign-in screen to keep");
      expect(held.buffered()).toContain("Setting up Claude Code");
      current.close(0, true, "Account added");
      expect(launch).toHaveBeenCalledWith("claude", "/accounts/work", "Account added");
      expect(s.signin).toBeNull();
      expect(s.signin_frame).toBeNull();
      expect(s.added_feedback.label).toBe("Claude Code · work");
      expect(s.signin_exit !== null).toBe(intensity > 0);
      if (intensity > 0) {
        expect(
          s.signin_exit.source.rows
            .flat()
            .map((c: { ch: string }) => c.ch)
            .join(""),
        ).toContain("Sign-in screen to keep");
        setSystemTime(new Date(1000 + signinExit.duration_ms));
        await s.expireInput();
        expect(s.signin_exit).toBeNull();
        expect(s.added_feedback).not.toBeNull();
      }
    } finally {
      s.signin?.close(1);
      open.mockRestore();
      launch.mockRestore();
      setSystemTime();
      viewer.close(s);
    }
  },
);

test.each([
  ["New", 20, "agent_launcher"],
  ["workspace scope", 10, "scope_menu"],
] as const)("%s opens after 150 ms of continuous hover", async (_, x, field) => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.width = 100;
  s.height = 30;
  s.input_state.attached = true;
  const motion = (x: number, y = 14) => `\x1b[<35;${x + 1};${y + 1}M`;
  try {
    setSystemTime(new Date(1000));
    await s.input(bytes(motion(x)));
    await s.expireInput();
    expect(s[field]).toBeNull();
    setSystemTime(new Date(1149));
    await s.input(bytes(motion(x + 1)));
    await s.expireInput();
    expect(s[field]).toBeNull();
    setSystemTime(new Date(1150));
    await s.expireInput();
    expect(s[field]?.pinned).toBe(false);

    await s.input(bytes(motion(90, 1)));
    await s.expireInput();
    expect(s[field]).toBeNull();
    setSystemTime(new Date(2000));
    await s.input(bytes(motion(x)));
    setSystemTime(new Date(2050));
    // Leaving and returning in one input batch still starts a fresh wait.
    await s.input(bytes(motion(90, 1) + motion(x)));
    setSystemTime(new Date(2150));
    await s.expireInput();
    expect(s[field]).toBeNull();
    setSystemTime(new Date(2200));
    await s.expireInput();
    expect(s[field]?.pinned).toBe(false);

    s.closeMenu();
    setSystemTime(new Date(2500));
    await s.expireInput();
    expect(s[field]).toBeNull();
    // An explicit click still opens immediately after dismissal.
    const click = field === "agent_launcher" ? 26 : x + 1;
    await s.input(bytes(`\x1b[<0;${click};15M\x1b[<0;${click};15m`));
    expect(s[field]?.pinned).toBe(true);
  } finally {
    setSystemTime();
    viewer.close(s);
  }
});

test("moving between hover menus starts a new wait and keyboard opening bypasses it", async () => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.width = 100;
  s.height = 30;
  s.input_state.attached = true;
  try {
    setSystemTime(new Date(1000));
    await s.input(bytes("\x1b[<35;21;15M"));
    setSystemTime(new Date(1140));
    await s.input(bytes("\x1b[<35;11;15M"));
    setSystemTime(new Date(1150));
    await s.expireInput();
    expect(s.agent_launcher).toBeNull();
    expect(s.scope_menu).toBeNull();
    setSystemTime(new Date(1290));
    await s.expireInput();
    expect(s.scope_menu?.pinned).toBe(false);
    await s.input(bytes("\x02A"));
    expect(s.scope_menu).toBeNull();
    expect(s.agent_launcher?.pinned).toBe(true);
  } finally {
    setSystemTime();
    viewer.close(s);
  }
});

test.each(setupItems.filter(item => item !== "flourishes"))("Escape closes setup from %s", async item => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  const menu = SetupMenu.open();
  menu.item = item;
  menu.openOptions(s.runtime.inference, s.prefs);
  s.corgi_setup = menu;
  try {
    await s.input(bytes("\x1b[27u"));
    expect(s.corgi_setup).toBeNull();
  } finally {
    viewer.close(s);
  }
});

test("Left returns to setup's list while Escape closes an open dropdown", async () => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  const menu = SetupMenu.open();
  menu.openOptions(s.runtime.inference, s.prefs);
  s.corgi_setup = menu;
  try {
    await s.input(bytes("\x1b[D"));
    expect(s.corgi_setup).toBe(menu);
    expect(menu.focus).toBe("list");
    await s.input(bytes("\x1b[C\r"));
    expect(menu.focus).toBe("options");
    await s.input(bytes("\x1b[27u"));
    expect(s.corgi_setup).toBeNull();
  } finally {
    viewer.close(s);
  }
});

test("Clever Corgi's model search takes typing and bracketed paste without changing the selected model", async () => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  const menu = SetupMenu.open();
  menu.openOptions(s.runtime.inference, s.prefs);
  menu.enter(s.runtime.inference, s.prefs);
  s.corgi_setup = menu;
  try {
    await s.input(bytes("luna"));
    await s.input(bytes("\x1b[200~ work\x1b[201~"));
    expect(menu.modelSearch()?.name()).toBe("luna work");
    expect(s.corgi_setup).toBe(menu);
    await s.input(bytes("\x1b[A"));
    expect(menu.modelSearch()?.name()).toBe("luna work");
    await s.input(bytes("\x1b[27u"));
    expect(menu.modelSearch()?.name()).toBe("");
    expect(s.corgi_setup).toBe(menu);
    await s.input(bytes("\x1b[27u"));
    expect(s.corgi_setup).toBeNull();
  } finally {
    viewer.close(s);
  }
});

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
    await s.input(bytes("\x1b[27u"));
    expect(s.corgi_setup).toBe(menu);
    expect(menu.focus).toBe("list");
    await s.input(bytes("\x1b[27u"));
    expect(s.corgi_setup).toBeNull();
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
    headless_sessions: [],
  };
}

test("last tab follows keyboard, mouse and tab menu selection, including shell tabs", async () => {
  const s = controller(),
    snapshot = folders("/a", "/b", "/c");
  snapshot.workspaces[0].model = {
    nodes: [{ pane: 1 }, { pane: 2 }, { pane: 3 }],
    tabs: [1, 2, 3].map((id, root) => ({ id, root, title: "" })),
    revision: 0,
  };
  snapshot.workspaces.splice(1);
  for (const pane of snapshot.panes) pane.workspace = 1;
  s.receiveSnapshot(snapshot);
  s.prefs.preset = "tmux";
  s.input_state.attached = true;
  s.sidebar_open = false;
  try {
    await s.perform({ name: "last-tab" });
    expect(s.message).toBe(" No previous tab in this workspace");
    await s.perform({ name: "tab", value: 3 });
    await s.input(bytes("\x02l"));
    expect(s.focused().id).toBe(1);
    await s.input(bytes("\x02l"));
    expect(s.focused().id).toBe(3);
    const start = s.sidebarView([]).tabX(),
      x = Array.from({ length: s.width - start }, (_, x) => x + start).find(
        x => render.tabAt(s.layoutView(), s.width - start, x - start) === 1,
      )!;
    await s.input(bytes(`\x1b[<0;${x + 1};1M\x1b[<0;${x + 1};1m`));
    expect(s.focused().id).toBe(2);
    await s.perform({ name: "last-tab" });
    expect(s.focused().id).toBe(3);
    s.tab_menu = new TabMenu({ tab: 1, anchor_x: 0 });
    await s.tabMenuAction("rename");
    expect(s.focused().id).toBe(1);
    await s.perform({ name: "last-tab" });
    expect(s.focused().id).toBe(3);
    const model = s.current().model;
    model.close(1);
    s.receiveSnapshot({
      ...snapshot,
      workspaces: [{ ...snapshot.workspaces[0], model: model.toJSON() }],
      panes: snapshot.panes.filter(p => p.id !== 1),
    });
    await s.perform({ name: "last-tab" });
    expect(s.focused().id).toBe(3);
    expect(s.message).toBe(" No previous tab in this workspace");
  } finally {
    viewer.close(s);
  }
});

test("last workspace records pane jumps and notices closed or missing history", async () => {
  const s = controller(),
    snapshot = folders("/a", "/b", "/c");
  s.receiveSnapshot(snapshot);
  s.prefs.preset = "tmux";
  s.input_state.attached = true;
  try {
    await s.perform({ name: "last-workspace" });
    expect(s.message).toBe(" No previous workspace");
    s.focusPane(3);
    await s.input(bytes("\x02L"));
    expect(s.current().id).toBe(1);
    await s.input(bytes("\x02L"));
    expect(s.current().id).toBe(3);
    snapshot.workspaces.splice(0, 1);
    s.receiveSnapshot(snapshot);
    await s.perform({ name: "last-workspace" });
    expect(s.current().id).toBe(3);
    expect(s.message).toBe(" No previous workspace");
  } finally {
    viewer.close(s);
  }
});

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
  s.agent_launcher = new LauncherMenu({ workspace: 1, last: "codex", pinned: true });
  s.agent_launcher.manage();
  expect(s.pasteTarget()).toBe("discard");
  s.agent_launcher.manager.key(47, s.agent_launcher.manageModel());
  expect(s.pasteTarget()).toBe("launcher");
  s.agent_launcher.managing = false;
  expect(s.pasteTarget()).toBe("discard");
  s.agent_launcher = null;
  s.name_dialog = null;
  s.beginPrefix();
  expect(s.pasteTarget()).toBe("discard");
});

test("keys stay on the name while the folder field doesn't fit", async () => {
  const s = controller();
  s.input_state.attached = true;
  const d = new newWorkspace.Dialog(newWorkspace.Browser.init("/a", "/home", () => ["b"]));
  s.name_dialog = d;
  s.height = 12;
  await s.input(bytes("\tx"));
  expect(d.browser.focused).toBe(false);
  expect(d.name()).toBe("ax");
  s.height = 30;
  await s.input(bytes("\ty"));
  expect(d.browser.field.raw()).toBe("/a/y");
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

test.each([false, true])("a failed fallback terminal keeps the empty launcher attached (search: %s)", async search => {
  const commands: unknown[] = [];
  const s = new Controller(
    transport(async (op, fields) => {
      if (op === "session.command") {
        commands.push(fields);
        throw Error("ShellNotFound");
      }
      if (op === "viewer.sync") return { viewer_protocol: protocol.viewer_version, detach: true };
      throw Error("UnexpectedRequest");
    }),
  );
  s.receiveSnapshot({
    workspaces: [{ id: 1, name: "one", cwd: "/workspace", model: { nodes: [], tabs: [], revision: 0 } }],
    panes: [],
    conversations: [],
    headless_sessions: [],
  });
  s.input_state.attached = true;
  s.agent_launcher = new LauncherMenu({ workspace: 1, cwd: "/other-checkout", pinned: true });
  try {
    if (search) {
      Object.assign(s.agent_launcher.resume_view, {
        focused: true,
        searching: true,
        query: Dialog.init({ pane: 0 }, "ab"),
      });
      await s.input(bytes("\x1b[27u"));
      expect(s.agent_launcher.resume_view.query.name()).toBe("");
      expect(commands).toEqual([]);
    }
    await s.input(bytes("\x1b[27u"));
    expect(commands).toEqual([
      { command: { "pane.create": { workspace: 1, cwd: "/workspace", command: null, title: "" } } },
    ]);
    expect(s.agent_launcher?.pinned).toBe(true);
    expect(s.message).toBe("ShellNotFound");
    expect(await viewer.sync(s, { seq: 0n }, false)).toBe(true);
  } finally {
    viewer.close(s);
  }
});

test.each([false, true])("empty viewers ignore the legacy detach flag (%s)", async detach => {
  const s = new Controller(transport(async () => ({ viewer_protocol: protocol.viewer_version, detach })));
  s.receiveSnapshot({
    workspaces: [{ id: 1, name: "one", cwd: "/workspace", model: { nodes: [], tabs: [], revision: 0 } }],
    panes: [],
    conversations: [],
    headless_sessions: [],
  });
  s.input_state.attached = true;
  try {
    expect(await viewer.sync(s, { seq: 0n }, false)).toBe(true);
    await s.perform({ name: "detach" });
    expect(await viewer.sync(s, { seq: 0n }, false)).toBe(false);
  } finally {
    viewer.close(s);
  }
});

test("the launcher reopens on the row from before a terminal", async () => {
  const snapshot = folders("/src/app");
  const s: any = new Controller({
    socket: "",
    request: transport(async op => (op === "session.command" ? { result: { pane: 1 } } : snapshot)).request,
  });
  s.receiveSnapshot(snapshot);
  s.input_state.attached = true;
  s.openLauncher(true);
  s.agent_launcher.selected = "claude";
  s.closeLauncher();
  s.openLauncher(true);
  await s.key("t".charCodeAt(0));
  expect(s.agent_launcher).toBeNull();
  s.openLauncher(true);
  expect(s.agent_launcher.selected).toBe("claude");
  // Leaving it on the terminal row doesn't stick either.
  s.agent_launcher.selected = "terminal";
  s.closeLauncher();
  s.openLauncher(true);
  expect(s.agent_launcher.selected).toBe("claude");
});

test("a fork's name is its title marked as a fork, cut to fit", () => {
  expect(forkName("refactor")).toBe("refactor (fork)");
  const long = forkName("x".repeat(72) + "⑂⑂");
  expect(long).toBe("x".repeat(72) + " (fork)");
  expect(Buffer.from(long).toString()).toBe(long);
});

test("a busy agent's rename names its provider", () => {
  const remove = sim.register();
  try {
    expect(agentMessage("AgentBusy", "", agent({ provider: sim.sim }))).toBe(
      " Sim is busy: rename it once its input box is empty",
    );
    expect(agentMessage("AgentBusy", "", undefined)).toBe(" This agent is busy: rename it once its input box is empty");
    expect(agentMessage("Timeout", " Could not rename this agent", undefined)).toBe(" Could not rename this agent");
  } finally {
    remove();
  }
});

test("Copy details names the harness, session, id and paths, leaving out what isn't known", () => {
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

test("Copy details stays available before the session is identified", async () => {
  const s = controller();
  s.receiveSnapshot(pair());
  s.review_summaries.ask = () => {};
  try {
    expect(s.pane(1).agent.session).toBe("");
    await s.openAgentMenu(1, 0, 0);
    expect(s.tab_menu.off.has("copy-details")).toBe(false);
    expect(breadcrumbs(s.pane(1))).toBe("harness: Claude Code\nsession: agent 1");
  } finally {
    viewer.close(s);
  }
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

test("edit workspace opens the current workspace's menu centered in its row, and r renames it", async () => {
  const s = controller();
  s.receiveSnapshot(folders("/a", "/b"));
  try {
    s.sidebar_open = false;
    await s.perform({ name: "edit-workspace" });
    expect([s.tab_menu?.anchor_x, s.tab_menu?.anchor_y]).toEqual([40, 1]);
    s.sidebar_open = true;
    s.navigation.workspace_id = 2;
    await s.perform({ name: "edit-workspace" });
    expect(s.tab_menu?.workspace).toBe(true);
    expect(s.tab_menu?.tab).toBe(2);
    expect(s.tab_menu?.entries().map((e: Row) => e.label)).toEqual(["Rename", "Close"]);
    expect([s.tab_menu?.anchor_x, s.tab_menu?.anchor_y]).toEqual([4, 6]);
    await s.key(114);
    expect(s.tab_menu).toBeNull();
    expect(s.name_dialog?.target).toEqual({ workspace_name: 2 });
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
    headless_sessions: [],
  };
}
test("an agent the daemon holds as starting shows dimmed in working until it lets go", () => {
  const s = controller(),
    snapshot: any = pair();
  snapshot.workspaces[0].starting_agents = [{ pane: 1 }];
  s.prefs.agent_sort = "activity";
  s.folded_sections.clear();
  try {
    s.receiveSnapshot(snapshot);
    const row = (pane: number) =>
      (s.agentEntries() as sidebar.Entry[]).find(e => sidebar.sameTarget(e.target, { pane }));
    expect(row(1)).toMatchObject({ section: "working", state: "idle", starting: true });
    expect(row(2)).toMatchObject({ section: "idle", starting: false });
    snapshot.workspaces[0].starting_agents = [];
    s.receiveSnapshot(snapshot);
    expect(row(1)).toMatchObject({ section: "idle", starting: false });
  } finally {
    viewer.close(s);
  }
});

test("dropping an opened ready agent keeps its new position", async () => {
  const snapshot: any = pair();
  snapshot.workspaces[0].activity_order = [{ pane: 1 }, { pane: 2 }];
  for (const pane of snapshot.panes.slice(0, 2)) {
    pane.agent.attention = "finished";
    pane.agent.observation.completed = 1;
  }
  const { s, sent } = recording(snapshot),
    ready = () => (s.agentEntries() as sidebar.Entry[]).filter(e => e.section === "ready").map(e => e.target),
    mouse = (button: number, y: number, release = false) => `\x1b[<${button};6;${y + 1}${release ? "m" : "M"}`;
  s.prefs.agent_sort = "activity";
  s.width = 100;
  s.height = 30;
  try {
    expect(ready()).toEqual([{ pane: 1 }, { pane: 2 }]);
    s.focusPane(2);
    snapshot.panes[1].agent.attention = "none";
    snapshot.panes[1].agent.observation.read = 1;
    snapshot.workspaces[0].activity_order = [{ pane: 2 }, { pane: 1 }];
    s.receiveSnapshot(snapshot);
    expect(ready()).toEqual([{ pane: 1 }, { pane: 2 }]);
    const entries: sidebar.Entry[] = s.sidebarEntries(),
      side: sidebar.View = s.sidebarView(entries),
      ys = Array.from({ length: s.height }, (_, y) => y),
      from = ys.find(y => {
        const hit = side.hit(5, y);
        return hit.tag === "entry" && sidebar.sameTarget(entries[hit.entry].target, { pane: 2 });
      })!,
      to = ys.find(y => side.agentDrop(5, y)?.index === 1)!;
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    await s.input(bytes(mouse(0, from) + mouse(32, to) + mouse(0, to, true)));
    expect(sent).toContainEqual({ "agent.place": { workspace: 1, target: { pane: 2 }, before: { pane: 1 } } });
    expect(ready()).toEqual([{ pane: 2 }, { pane: 1 }]);
    expect(s.focused().id).toBe(2);
  } finally {
    viewer.close(s);
  }
});

test("agent entries keep tab order and pane order within splits after a new snapshot", () => {
  const s = controller(),
    snapshot = pair();
  snapshot.workspaces[0].model.nodes.push({ pane: 4 });
  snapshot.workspaces[0].model.tabs.unshift({ id: 3, root: 3, title: "first" });
  snapshot.panes.push({ ...snapshot.panes[0], id: 4, tab: 3 });
  snapshot.panes.reverse();
  const targets = () => (s.agentEntries(1) as sidebar.Entry[]).map(e => e.target);
  try {
    s.receiveSnapshot(snapshot);
    expect(targets()).toEqual([{ pane: 4 }, { pane: 2 }, { pane: 1 }]);
    snapshot.workspaces[0].model.tabs.reverse();
    snapshot.workspaces[0].model.revision++;
    s.receiveSnapshot(snapshot);
    expect(targets()).toEqual([{ pane: 2 }, { pane: 1 }, { pane: 4 }]);
  } finally {
    viewer.close(s);
  }
});
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
    s.prefs.agent_sort = "activity";
    s.focusPane(2);
    await s.input(bytes("\x02\x1b[D"));
    expect(s.focused().id).toBe(1);
    // Inside the repeat window, the next arrow needs no prefix.
    await s.input(bytes("\x1b[D"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 1 } });
    expect(s.frame()).toContain("SIDEBAR");
    // Plain arrows stay in the agent list and wrap, past its section's
    // header, inside the repeat window too.
    await s.input(bytes("\x1b[B"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 2 } });
    await s.input(bytes("\x1b[B"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { section: "idle" } });
    await s.input(bytes("\x1b[B"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 1 } });
    // A prefixed arrow crosses to the workspaces, and back to the agent it left.
    await s.input(bytes("\x02\x1b[A"));
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 1 });
    await s.input(bytes("\x02\x1b[B\x1b[A\x1b[A"));
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

test("search finds agents in folded sections and opening one unfolds its section", () => {
  const { s } = steering();
  try {
    s.prefs.agent_sort = "activity";
    s.focusPane(1);
    s.folded_sections.add("idle");
    expect((s.agentEntries() as sidebar.Entry[]).some(e => sidebar.isAgent(e.target))).toBe(false);
    s.openAgentPicker();
    s.agent_picker.query = Dialog.init({ pane: 0 }, "agent 2");
    expect(s.pickerEntries().map((e: sidebar.Entry) => e.target)).toEqual([{ pane: 2 }]);
    s.acceptAgentPicker();
    expect(s.focused().id).toBe(2);
    expect(s.folded_sections.has("idle")).toBe(false);
  } finally {
    viewer.close(s);
  }
});

test("/ searches the focused agent list and Esc comes back to it; letters and the workspace list don't search", async () => {
  const { s, sent } = steering();
  try {
    s.focusPane(1);
    await s.input(bytes("\x02\x1b[D"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 1 } });
    expect(s.frame()).toContain("↵ open  / search  Esc back");
    await s.input(bytes("x"));
    expect(s.agent_picker).toBeNull();
    await s.input(bytes("\x1b[B"));
    await s.input(bytes("/zz"));
    expect(s.agent_picker.query.raw()).toBe("zz");
    expect(s.sidebar_focus).toBeNull();
    await s.key(27);
    expect(s.agent_picker).toBeNull();
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 2 } });
    await s.input(bytes("\x02\x1b[A"));
    await s.input(bytes("/"));
    expect(s.agent_picker).toBeNull();
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 1 });
    expect(s.frame()).not.toContain("/ search");
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
    s.prefs.agent_sort = "activity";
    s.prefs.agents = "all";
    s.focusPane(1);
    await s.input(bytes("\x02\x1b[D\x1b[B"));
    // Pane 2 is on screen, so nothing is ghosted.
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 2 } });
    expect(s.sidebarGhost()).toBeNull();
    await s.input(bytes("\x1b[B"));
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
    // Up passes the section's header, then wraps.
    await s.input(bytes("\x02a\x1b[A\x1b[A"));
    expect(s.sidebar_focus.cursor).toEqual({ entry: { pane: 3 } });
    expect(s.sidebarGhost().area.x).toBe(0);
    await s.expireInput();
    expect(s.pane(3).dormant).toBe(true);
  } finally {
    viewer.close(s);
  }
});

test("the sidebar's cursor previews a workspace it isn't on, as switching to it shows it", async () => {
  const { s } = steering();
  try {
    s.focusPane(1);
    await s.input(bytes("\x02w"));
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 1 });
    expect(s.sidebarWorkspaceGhost()).toBeNull();
    expect(s.frame()).not.toContain("┄┄ ");
    await s.input(bytes("\x1b[B"));
    const ghost = s.sidebarWorkspaceGhost();
    expect(ghost.name).toBe("/b");
    expect(s.frame()).toContain("┄┄ ");
    await s.key(13);
    expect(s.current().id).toBe(2);
    expect(s.layoutView().placements(s.area())).toEqual(ghost.view.placements(s.area()));
    expect(s.frame()).not.toContain("┄┄ ");
  } finally {
    viewer.close(s);
  }
});

test("prefixed arrows walk past the last pane into the review panel, and left goes back to the focused pane", async () => {
  const { s, sent } = steering();
  try {
    s.focusPane(1);
    await s.input(bytes("\x02e"));
    expect(s.keyboard).toBe("review");
    await s.input(bytes("\x02\x1b[D"));
    expect(s.keyboard).toBe("pane");
    expect(s.focused().id).toBe(1);
    await s.input(bytes("\x02\x1b[C\x02\x1b[C"));
    expect(s.focused().id).toBe(2);
    expect(s.keyboard).toBe("review");
    // Inside the repeat window, the panel takes plain arrows itself.
    await s.input(bytes("\x1b[D\x1b[B"));
    expect(s.keyboard).toBe("review");
    // Prefixed, up and down move between its file list and the diff under it,
    // as between the sidebar's lists; past either, and right, focus stays.
    s.frame();
    expect(s.review.pane).toBe(2);
    await s.input(bytes("\x02\x1b[B"));
    expect(s.review.review(2).part).toBe("diff");
    await s.input(bytes("\x02\x1b[B\x02\x1b[C"));
    expect(s.keyboard).toBe("review");
    expect(s.review.review(2).part).toBe("diff");
    await s.input(bytes("\x02\x1b[A"));
    expect(s.review.review(2).part).toBe("tree");
    await s.input(bytes("\x02\x1b[A"));
    expect(s.keyboard).toBe("review");
    await s.input(bytes("\x02\x1b[D"));
    expect(s.keyboard).toBe("pane");
    expect(s.focused().id).toBe(2);
    // A closed panel takes nothing.
    await s.input(bytes("\x02\x1b[C\x02e\x02\x1b[C"));
    expect(s.review.open).toBe(false);
    expect(s.keyboard).toBe("pane");
    expect(sent).toEqual([]);
  } finally {
    s.review.hide();
    viewer.close(s);
  }
});

test("the keyboard has one holder: the sidebar, the review panel and a press hand it between them", async () => {
  const update = spyOn(preferences, "update").mockImplementation(() => {});
  const { s } = steering();
  try {
    s.focusPane(2);
    await s.input(bytes("\x02e\x02w"));
    expect(s.sidebar_focus.cursor).toEqual({ workspace: 1 });
    expect(s.reviewKeys()).toBe(false);
    await s.input(bytes("\x02e"));
    expect(s.keyboard).toBe("review");
    expect(s.sidebar_focus).toBeNull();
    // Moving to the review panel puts a drawer away.
    s.sidebar_open = false;
    await s.input(bytes("\x02a\x02e"));
    expect(s.keyboard).toBe("review");
    expect(s.sidebar_open).toBe(false);
    // A press on a pane gives the keyboard back; one in the panel takes it.
    await s.mouse("\x1b[<0;5;5M");
    await s.mouse("\x1b[<0;5;5m");
    expect(s.keyboard).toBe("pane");
    await s.mouse(`\x1b[<0;${s.width - 5};5M`);
    await s.mouse(`\x1b[<0;${s.width - 5};5m`);
    expect(s.keyboard).toBe("review");
    // Closing the panel gives the keyboard back too.
    await s.input(bytes("\x02e"));
    expect(s.review.open).toBe(false);
    expect(s.keyboard).toBe("pane");
  } finally {
    s.review.hide();
    update.mockRestore();
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
  const hold = async () => {
    await s.key(13);
    clock.advance(300);
    for (let i = 0; i < 70 && s.agent_launcher.worktree.mode === "open"; i++) {
      await s.key(13);
      clock.advance(50);
    }
  };
  try {
    await s.key("w".charCodeAt(0));
    expect([s.agent_launcher.worktree.mode, s.agent_launcher.worktree.focus]).toEqual(["open", "branch"]);
    // Browsing fills Branch while preserving the list and its caret.
    await s.input(bytes("\x1b[A"));
    expect([s.agent_launcher.worktree.focus, s.agent_launcher.worktree.field.name()]).toEqual(["branch", "topic"]);
    await s.input(bytes("\x1bOA"));
    expect(s.agent_launcher.worktree.field.name()).toBe("main");
    await s.key(13);
    expect(s.agent_launcher.cwd).toBe("/src/app");
    await s.key("w".charCodeAt(0));
    await s.input(bytes("\x1b[200~top\x1b[201~"));
    expect(s.agent_launcher.worktree.typed).toBe("top");
    const box = () => s.agent_launcher.worktreeBox(s.width, s.height, s.sidebarView([]));
    const mouse = (button: number, x: number, y: number, release = false) =>
      s.input(bytes(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`));
    await mouse(35, box().label_x, box().list);
    expect(s.agent_launcher.worktree.field.name()).toBe("top");
    await mouse(0, box().label_x, box().list);
    await mouse(0, box().label_x, box().list, true);
    expect(s.agent_launcher.worktree.field.name()).toBe("topic");
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
    expect(s.agent_launcher.worktree.planned).toBeNull();
    clock.advance(1200);
    await s.expireInput();
    expect(s.agent_launcher.worktree.create.progress).toBe(0);
    await hold();
    expect(s.agent_launcher.worktree.planned).toEqual({
      branch: "log-in",
      base: "refs/heads/topic",
      base_name: "topic",
      path: "/src/app/.worktrees/log-in",
    });
    expect(s.agent_launcher.place().label).toBe("log-in");
    // The tail of the held Enter must not launch the highlighted agent.
    for (let i = 0; i < 5; i++) {
      await s.key(13);
      clock.advance(50);
    }
    expect(sent.some(([op]) => op === "session.command" || op === "worktree.add")).toBe(false);
    // Git refuses: the form comes back with why, and nothing launches.
    await s.key("a".charCodeAt(0));
    expect([s.agent_launcher.worktree.mode, s.agent_launcher.worktree.focus]).toEqual(["open", "branch"]);
    expect(s.agent_launcher.worktree.error).toBe("A branch named log-in exists already");
    expect(sent.some(([op]) => op === "session.command")).toBe(false);
    refuse = null;
    clock.advance(300);
    const confirm = () => mouse(0, box().rect.x + box().rect.w - 5, box().footer);
    await confirm();
    clock.advance(400);
    await mouse(0, box().rect.x + box().rect.w - 5, box().footer, true);
    clock.advance(1000);
    await s.expireInput();
    expect(s.agent_launcher.worktree.mode).toBe("open");
    expect(s.agent_launcher.worktree.create.progress).toBe(0);
    await confirm();
    const button = box();
    clock.advance(3100);
    await s.expireInput();
    expect(s.agent_launcher.worktree.mode).toBe("closed");
    await mouse(0, button.rect.x + button.rect.w - 5, button.footer, true);
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
  } finally {
    clock.reset();
  }
});

/** An attached controller whose session commands land in `sent`, each making pane 1. */
function recording(snapshot: any) {
  const sent: any[] = [];
  const s: any = new Controller({
    socket: "",
    request: transport(async (op, fields: any) => {
      if (op !== "session.command") return snapshot;
      sent.push(fields.command);
      return { result: { pane: 1 } };
    }).request,
  });
  s.model_cache = new agentModels.Cache(
    () => {},
    async () => [],
  );
  s.receiveSnapshot(snapshot);
  s.input_state.attached = true;
  return { s, sent };
}

test("both launch screens list snapshot accounts before any preview arrives", () => {
  const { s } = recording({
    ...folders("/src/app"),
    accounts: [{ provider: "claude", account: "/accounts/work", name: "work", managed: true }],
  });
  s.openLauncher(true);
  const launch: agentLauncher.Menu = s.agent_launcher;
  const row = agentLauncher.Row.of("claude", "/accounts/work");
  expect(launch.rows()).toContain(row);
  expect(launch.shown(row)).toBe(true);
  expect(launch.cells(row)).toContain("Claude Code · work");
  launch.manage();
  expect(launch.manageModel().agents.map(a => a.label)).toContain("Claude Code · work");
  expect(launch.manageModel().agents.find(a => a.account === "/accounts/work")?.managed).toBe(true);
});

test("an account's row starts its agent there, and resuming keeps a conversation's account", async () => {
  const snapshot = {
    ...folders("/src/app"),
    accounts: [{ provider: "claude", account: "/accounts/work", name: "work", managed: true }],
  };
  const { s, sent } = recording(snapshot);
  Object.assign(s.launch_previews, {
    cwd: "/src/app",
    preview: agentLauncher.preview({ accounts: [{ provider: "claude", account: "/accounts/work", name: "work" }] }),
  });
  s.openLauncher(true);
  // Codex, Claude Code, then Claude Code · work.
  await s.key("2".charCodeAt(0));
  expect(sent.at(-1)["agent.create"]).toEqual({
    workspace: 1,
    cwd: "/src/app",
    provider: "claude",
    account: "/accounts/work",
  });
  s.openLauncher(true);
  expect(s.agent_launcher.selected).toBe(agentLauncher.Row.of("claude", "/accounts/work"));
  await s.key(13);
  expect(sent.at(-1)["agent.create"].account).toBe("/accounts/work");
  await s.resumeEntry(
    {
      provider: "claude",
      account: "/accounts/work",
      session: "s1",
      title: "",
      first: "",
      last: "",
      cwd: "/src/app",
      branch: "",
      updated_at: 1,
      interrupted: false,
    },
    1,
  );
  expect(sent.at(-1)["agent.resume"]).toEqual({
    workspace: 1,
    cwd: "/src/app",
    provider: "claude",
    session: "s1",
    account: "/accounts/work",
  });
});

test.each(["launcher", "settings"] as const)(
  "%s management saves names, flags and environment in the shared model",
  async source => {
    const saved = process.env.CORGI_ENV_BASE,
      base = realpathSync(mkdtempSync(join(tmpdir(), "corgi-manage-")));
    process.env.CORGI_ENV_BASE = base;
    process.env.CLAUDE_CONFIG_DIR = join(base, "default");
    accounts.reset();
    try {
      const { s, sent } = recording(folders("/src/app"));
      const launch = await openManagement(s, source);
      launch.manager.at = agentManager.agentKey("claude", "");
      await s.key(13);
      for (const ch of "home") await s.key(ch.charCodeAt(0));
      await s.key(9);
      await s.key(9);
      for (const ch of "--model sonnet") await s.key(ch.charCodeAt(0));
      await s.key(9);
      await s.key(13);
      for (const ch of "API_TIMEOUT_MS") await s.key(ch.charCodeAt(0));
      await s.key(9);
      for (const ch of "60000") await s.key(ch.charCodeAt(0));
      await s.key(13);
      expect(accounts.launchOptions("claude", "")).toEqual({ flags: "", env: [] });
      await s.input(bytes("\x1b[B"));
      await s.key(13);
      expect(sent).toEqual([
        {
          "agent.launcher.configure": {
            row: "claude",
            name: "home",
            model: "auto",
            effort: "default",
            flags: "--model sonnet",
            env: '{"API_TIMEOUT_MS":"60000"}',
          },
        },
      ]);
      // The viewer sends one save; only the daemon writes shared configuration.
      expect(accounts.launchOptions("claude", "")).toEqual({ flags: "", env: [] });
      expect(launch.label("claude")).toBe("Claude Code · home");
      expect(launch.manager.page).toBe("list");
    } finally {
      if (saved === undefined) delete process.env.CORGI_ENV_BASE;
      else process.env.CORGI_ENV_BASE = saved;
      accounts.reset();
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test.each(["launcher", "settings"] as const)(
  "cancelling sign-in returns to %s management with its search and selection",
  async source => {
    const saved = {
        CORGI_ENV_BASE: process.env.CORGI_ENV_BASE,
        CORGI_CLAUDE_BIN: process.env.CORGI_CLAUDE_BIN,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      },
      base = realpathSync(mkdtempSync(join(tmpdir(), "corgi-manage-")));
    // Its folder is staged at once, so in a state folder of its own, sharing
    // a default account's setup of its own.
    process.env.CORGI_ENV_BASE = base;
    process.env.CORGI_CLAUDE_BIN = "/usr/bin/true";
    process.env.CLAUDE_CONFIG_DIR = join(base, "claude");
    accounts.reset();
    let s: any = null;
    try {
      const recorded = recording(folders("/src/app")),
        sent = recorded.sent;
      s = recorded.s;
      await openManagement(s, source);
      await s.key(27);
      expect(s.agent_launcher).toBeNull();
      expect(s.corgi_setup).toBeNull();
      const launch = await openManagement(s, source),
        setup = s.corgi_setup;
      await s.key(47);
      for (const ch of "claude") await s.key(ch.charCodeAt(0));
      launch.manager.at = "add:claude";
      await s.key(9);
      const before = sent.length;
      await s.key(13);
      expect(s.agent_launcher).toBeNull();
      // It signs in straight away, with no agent or name to ask for.
      expect(s.signin).toMatchObject({ adding: true, provider: "claude", name: null, cwd: "/src/app" });
      expect(s.signin.staged.dir).toBe(join(base, "corgi", "accounts", "claude", "1"));
      expect(s.signin.stage.kind === "signin" || s.signin.stage.dialog.heading.includes("didn't start")).toBe(true);
      expect(sent.length).toBe(before);
      const staged = s.signin.staged;
      await s.input(bytes("\x03"));
      expect(s.signin).toBeNull();
      expect(s.agent_launcher).toBe(source === "launcher" ? launch : null);
      expect(s.corgi_setup).toBe(setup);
      expect(launch.managing).toBe(true);
      expect(launch.manager.query.name()).toBe("claude");
      expect(launch.manager.at).toBe("add:claude");
      expect(launch.manager.focus).toBe("list");
      expect(existsSync(staged.dir)).toBe(false);
      expect(existsSync(staged.temp)).toBe(false);
    } finally {
      s?.signin?.abandon();
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      accounts.reset();
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test("the launcher's history leaves out conversations from a provider the viewer doesn't know", () => {
  const { s } = recording(folders("/src/app")),
    entry = (provider: string, session: string) => ({
      provider,
      session,
      title: session,
      first: "",
      last: "",
      cwd: "/src/app",
      branch: "",
      updated_at: 1,
      interrupted: false,
    });
  s.launch_previews.history = { pending: false, entries: [entry("future", "a"), entry("codex", "b")] as any };
  s.openLauncher(true);
  expect(s.agent_launcher.history.entries.map((e: any) => [e.provider, e.session])).toEqual([["codex", "b"]]);
});
test("history stars follow the current workspace and refresh while the launcher stays open", () => {
  const base = folders("/a", "/b"),
    snapshot = {
      ...base,
      workspaces: base.workspaces.map(ws => ({
        ...ws,
        starred_sessions: [{ provider: "claude", session: ws.id === 1 ? "first" : "second" }],
      })),
    },
    { s } = recording(snapshot),
    stars = () => (s.agent_launcher.history.entries as launcherResume.Entry[]).map(e => [e.session, e.starred]);
  s.launch_previews.history = {
    pending: false,
    entries: ["first", "second"].map(session =>
      launcherResume.historyEntry({ provider: "claude", session, cwd: "/a", updated_at: 1 }),
    ),
  };
  try {
    s.openLauncher(true);
    expect(stars()).toEqual([
      ["first", true],
      ["second", false],
    ]);
    s.switchWorkspace(2);
    s.openLauncher(true);
    expect(stars()).toEqual([
      ["first", false],
      ["second", true],
    ]);
    snapshot.workspaces[0].starred_sessions.push({ provider: "claude", session: "second" });
    snapshot.workspaces[1].starred_sessions = [];
    s.receiveSnapshot(snapshot);
    expect(stars()).toEqual([
      ["first", false],
      ["second", false],
    ]);
    s.switchWorkspace(1);
    s.openLauncher(true);
    expect(stars()).toEqual([
      ["first", true],
      ["second", true],
    ]);
  } finally {
    viewer.close(s);
  }
});

/** The launcher over a preview that lists Claude Code's `work` account. */
function withWork(option: object = {}) {
  const recorded = recording(folders("/src/app"));
  Object.assign(recorded.s.launch_previews, {
    cwd: "/src/app",
    preview: agentLauncher.preview({
      pending: false,
      accounts: [{ provider: "claude", account: "/accounts/work", name: "work", option }],
    }),
  });
  recorded.s.openLauncher(true);
  return recorded;
}
const work = agentLauncher.Row.of("claude", "/accounts/work");

test.each([false, true])(
  "Manage deletes secondary accounts, guarding running agents and external folders (created: %s)",
  async created => {
    const previous = process.env.CORGI_ENV_BASE,
      previousClaude = process.env.CLAUDE_CONFIG_DIR,
      signOut = spyOn(signin, "signOut").mockResolvedValue(undefined),
      base = realpathSync(mkdtempSync(join(tmpdir(), "corgi-manage-remove-"))),
      dir = join(base, "imported");
    process.env.CORGI_ENV_BASE = base;
    accounts.reset();
    mkdirSync(dir);
    try {
      const account = created ? accounts.adopt(accounts.stage("claude", "work")) : accounts.add("claude", "work", dir);
      const accountFile = readFileSync(accounts.path(), "utf8");
      const credential = join(account.dir, "test-credential");
      writeFileSync(credential, "signed in");
      const { s, sent } = withWork();
      s.runtime.panes[0].agent.provider = "claude";
      s.runtime.panes[0].account = account.dir;
      s.agent_launcher.preview.accounts[0].account = account.dir;
      await s.input(bytes("\x1b[C"));
      const manager = s.agent_launcher.manager;
      manager.at = agentManager.agentKey("claude", account.dir);
      await s.key(47);
      for (const ch of "work") await s.key(ch.charCodeAt(0));
      for (let now = 1000; now <= 3000; now += 50) {
        setSystemTime(new Date(now));
        await s.key(127);
      }
      expect(manager.removal).toBeNull();
      expect(accounts.named("work")).not.toBeNull();
      expect(s.textField()).toBe(manager.query.area);
      await s.key(9);
      expect(manager.focus).toBe("list");
      expect(s.textField()).toBeNull();
      await s.input(bytes("\x1b[200~ignore me\x1b[201~"));
      expect(manager.query.name()).toBe("");
      for (let now = 4000; now <= 7000; now += 50) {
        setSystemTime(new Date(now));
        await s.key(127);
        if (manager.error) break;
      }
      expect(accounts.named("work")).not.toBeNull();
      expect(readFileSync(credential, "utf8")).toBe("signed in");
      expect(readFileSync(accounts.path(), "utf8")).toBe(accountFile);
      expect(sent).toEqual([]);
      expect(manager.error).toContain("Close the agent");
      expect(signOut).not.toHaveBeenCalled();
      s.runtime.panes[0].agent.provider = null;
      manager.open(agentManager.agentKey("claude", account.dir));
      for (let now = 9000; now <= 12000; now += 50) {
        setSystemTime(new Date(now));
        await s.key(127);
      }
      await Promise.all([...s.account_removals.values()].map((job: any) => job.task));
      await s.finishAccountRemovals();
      expect(accounts.named("work")).toBeNull();
      expect(s.agent_launcher.preview.accounts).toEqual([]);
      expect(manager.error).toBe("");
      expect(existsSync(account.dir)).toBe(!created);
      if (created) expect(signOut).toHaveBeenCalledWith(account);
      else {
        expect(signOut).not.toHaveBeenCalled();
        expect(readFileSync(credential, "utf8")).toBe("signed in");
      }
      accounts.reset();
      expect(accounts.named("work")).toBeNull();
    } finally {
      setSystemTime();
      signOut.mockRestore();
      if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaude;
      if (previous === undefined) delete process.env.CORGI_ENV_BASE;
      else process.env.CORGI_ENV_BASE = previous;
      accounts.reset();
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test("a signed-out account's row signs in to it over the panes instead of starting its agent", async () => {
  const saved = process.env.CORGI_CLAUDE_BIN;
  process.env.CORGI_CLAUDE_BIN = "/usr/bin/true";
  try {
    const { s, sent } = withWork({ signed_in: false });
    s.agent_launcher.selected = work;
    await s.key(13);
    expect(sent).toEqual([]);
    expect(s.agent_launcher).toBeNull();
    expect(s.signin).toMatchObject({ adding: false, provider: "claude", name: "work", dir: "/accounts/work" });
    s.signin.abandon();
  } finally {
    if (saved === undefined) delete process.env.CORGI_CLAUDE_BIN;
    else process.env.CORGI_CLAUDE_BIN = saved;
  }
});

test("space in Manage hides a row in the current workspace's picker only", async () => {
  const { s, sent } = withWork(),
    id = s.current().id;
  await s.input(bytes("\x1b[C"));
  s.agent_launcher.manager.at = agentManager.agentKey("claude", "/accounts/work");
  await s.key(32);
  expect(sent.at(-1)).toEqual({ "agent.workspace_visibility": { workspace: id, row: work, shown: false } });
  expect(s.agent_launcher.shown(work)).toBe(false);
  expect(s.agent_launcher.manageModel().agents.find((a: agentManager.Agent) => a.account)).toMatchObject({
    shown: true,
    here: false,
  });
  // The daemon's snapshot keeps it so.
  s.current().launcher_hidden = [work];
  await s.pollLauncher(false);
  expect(s.agent_launcher.shown(work)).toBe(false);
  expect(s.agent_launcher.manager.at).toBe(agentManager.agentKey("pi", ""));
  s.agent_launcher.manager.at = agentManager.agentKey("claude", "/accounts/work");
  await s.key(32);
  expect(sent.at(-1)).toEqual({ "agent.workspace_visibility": { workspace: id, row: work, shown: true } });
  expect(s.agent_launcher.shown(work)).toBe(true);
});

test("an account's row has a YOLO and launcher membership of its own, apart from its provider's", async () => {
  const { s, sent } = withWork();
  s.agent_launcher.selected = work;
  await s.key("y".charCodeAt(0));
  expect(sent.at(-1)).toEqual({ "agent.yolo": { provider: "claude", enabled: true, account: "/accounts/work" } });
  expect([s.agent_launcher.yoloOf(work), s.agent_launcher.yoloOf("claude")]).toEqual([true, false]);
  s.agent_launcher.selected = "claude";
  // An older daemon refuses an account, so the default's row sends none.
  await s.key("y".charCodeAt(0));
  expect(sent.at(-1)).toEqual({ "agent.yolo": { provider: "claude", enabled: true } });
  await s.input(bytes("\x1b[C"));
  s.agent_launcher.manager.at = agentManager.agentKey("claude", "/accounts/work");
  s.runtime.account_hidden = ["/accounts/work"];
  s.agent_launcher.account_hidden = ["/accounts/work"];
  await s.manageAction({
    kind: "show",
    agent: s.agent_launcher.manageModel().agents.find((a: agentManager.Agent) => a.account === "/accounts/work"),
  });
  expect(sent.at(-2)).toEqual({
    "agent.visibility": { hidden: byProvider(() => false), hidden_accounts: [] },
  });
  expect(sent.at(-1)).toEqual({ "agent.workspace_visibility": { workspace: s.current().id, row: work, shown: true } });
  expect([s.agent_launcher.hiddenOf(work), s.agent_launcher.hiddenOf("claude")]).toEqual([false, false]);
  s.agent_launcher.manager.at = agentManager.agentKey("claude", "");
  await s.manageAction({
    kind: "remove",
    agent: s.agent_launcher.manageModel().agents.find((a: agentManager.Agent) => a.provider === "claude" && !a.account),
  });
  expect(sent.at(-1)).toEqual({
    "agent.visibility": { hidden: byProvider(p => p === "claude") },
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
  s.closeLauncher();
  // Beside a terminal in a folder of main it starts at the workspace's root,
  // beside an agent in a folder of topic at topic's root.
  Object.assign(snapshot.panes[0], { cwd: "/src/app/lib", agent: { ...snapshot.panes[0].agent, provider: null } });
  (snapshot.workspaces[0] as any).worktrees.agents = [];
  s.receiveSnapshot(snapshot);
  s.openLauncher(true);
  expect(s.agent_launcher.cwd).toBe("/src/app");
  s.closeLauncher();
  Object.assign(snapshot.panes[0], {
    cwd: "/src/app-topic/lib",
    agent: { ...snapshot.panes[0].agent, provider: "codex" },
  });
  s.receiveSnapshot(snapshot);
  s.openLauncher(true);
  expect(s.agent_launcher.cwd).toBe("/src/app-topic");
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

test("a worktree's menu shows its diff line and opens its folder in a waiting shell or a new tab", async () => {
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
    cwd: "/src/app-topic",
    agent: { ...snapshot.panes[0].agent, provider: "codex", cwd: "/src/app-topic" },
  });
  Object.assign(snapshot.workspaces[0], {
    worktrees: {
      common_dir: "/src/app/.git",
      base: { ref: "refs/heads/main", name: "main", head: "4f1c2a9e0b" },
      entries: [checkout("/src/app", "main", true), checkout("/src/app-topic", "topic", false)],
      agents: [{ target: { pane: 1 }, path: "/src/app-topic", source: "write", stale: false }],
      stale: false,
    },
  });
  const sent: [string, any][] = [];
  let waiting: number[] = [];
  const s: any = new Controller({
    socket: "",
    request: transport(async (op, fields) => {
      sent.push([op, fields]);
      if (op === "pane.idle")
        return { panes: waiting.map(pane => ({ pane, tab: 1, workspace: 1, cwd: "/src/app-topic" })) };
      if (op === "session.command") return { result: { pane: 1 } };
      return snapshot;
    }).request,
  });
  const changed = s.review_summaries.changed;
  s.review_summaries = new summaries.Summaries(
    async root => [[`${root} changed`, "faint"]],
    async cwd => cwd,
  );
  s.review_summaries.changed = changed;
  s.width = 120;
  s.height = 40;
  s.receiveSnapshot(snapshot);
  // Its agent's section names the worktree in a subhead, which opens its menu.
  const heading = s.sidebarEntries().find((e: sidebar.Entry) => sidebar.isSubhead(e.target));
  expect(heading.target).toMatchObject({ workspace: 1, checkout: "/src/app-topic" });
  s.openWorktreeMenu(heading, 5, 5);
  expect(s.tab_menu.highlightedItem()).toBe("review");
  expect(s.tab_menu.details.get("review").runs).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(s.tab_menu.details.get("review").runs).toEqual([["/src/app-topic changed", "faint"]]);
  expect(s.tab_menu.details.get("copy-path").runs).toEqual([["../app-topic", "faint"]]);
  s.input_state.attached = true;
  await s.input(Buffer.from("c"));
  expect(s.tab_menu).toBeNull();
  expect(s.clipboard).toBe("/src/app-topic");
  expect(s.copy_feedback_until).toBeGreaterThan(0);
  s.openWorktreeMenu(heading, 5, 5);
  // No shell waits there, so it opens a tab in the folder.
  await s.tabMenuAction("open-folder");
  expect(sent.find(([op]) => op === "pane.idle")![1]).toEqual({ workspace: 1, cwd: "/src/app-topic", first: true });
  expect(sent.find(([op]) => op === "session.command")![1].command["pane.create"]).toMatchObject({
    workspace: 1,
    cwd: "/src/app-topic",
  });
  // One that waits is focused instead.
  sent.length = 0;
  waiting = [1];
  s.openWorktreeMenu(heading, 5, 5);
  await s.tabMenuAction("open-folder");
  expect(sent.some(([op]) => op === "session.command")).toBe(false);
  expect(s.focused().id).toBe(1);
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
      headless_sessions: [],
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

test("setup requests models as soon as Clever Corgi is visible without waiting for discovery", async () => {
  const requests: protocol.Op[] = [],
    s = new Controller({
      socket: "",
      request: transport(async op => {
        requests.push(op);
        if (op === "inference.configure") return new Promise(() => {});
        return { ok: true };
      }).request,
    }) as any;
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  s.width = 100;
  s.height = 30;
  try {
    s.openSetup();
    expect(s.frame()).toContain("Corgi setup");
    await s.corgi_setup.poll(s.rpc(), s.width, s.height);
    expect(requests.filter(op => op === "inference.configure")).toHaveLength(1);
    await s.key(13);
    await s.key(13);
    await s.corgi_setup.poll(s.rpc(), s.width, s.height);
    expect(requests.filter(op => op === "inference.configure")).toHaveLength(1);
    expect(s.frame()).toContain("Search models");
    await s.input(bytes("\x1b[D"));
    expect(s.corgi_setup.modelSearch()).toBeNull();
  } finally {
    viewer.close(s);
  }
});

test("About enters Moonlander without sending game input to panes and returns to the same spaceship", async () => {
  const s = controller();
  s.input_state.attached = true;
  s.receiveSnapshot(folders("/a"));
  s.width = 100;
  s.height = 30;
  const setup = SetupMenu.open();
  setup.item = "about";
  setup.openOptions(s.runtime.inference, s.prefs);
  setup.move(false, s.runtime.inference, s.prefs);
  s.corgi_setup = setup;
  await s.input(bytes("\r"));
  expect(s.moonlander).not.toBeNull();
  expect(s.coversPanes()).toBe(true);
  expect(s.overlayOpen()).toBe(true);
  expect(s.frame()).toContain("moonlander");
  await viewer.presented(s);
  await s.input(bytes(" \x1b[D "));
  expect(s.moonlander.engine.game.state).toBe("flying");
  expect(s.moonlander.engine.keys.up).toBe(true);
  expect(s.moonlander.engine.lander.a).toBe(-0.12);
  await s.input(bytes("\x1b[O"));
  expect(s.moonlander.engine.game.paused).toBe(true);
  expect(s.moonlander.engine.keys.up).toBe(false);
  await s.input(bytes("q"));
  expect(s.moonlander).toBeNull();
  expect(s.corgi_setup).toBe(setup);
  expect(setup.item).toBe("about");
  expect(setup.enter(s.runtime.inference, s.prefs)).toEqual({ kind: "moonlander" });
});

test("the About spaceship responds to a click and the game back button restores About", async () => {
  const s = controller();
  s.input_state.attached = true;
  s.receiveSnapshot(folders("/a"));
  s.width = 100;
  s.height = 30;
  const setup = SetupMenu.open();
  setup.item = "about";
  setup.openOptions(s.runtime.inference, s.prefs);
  setup.move(false, s.runtime.inference, s.prefs);
  s.corgi_setup = setup;
  let target: { x: number; y: number } | null = null;
  for (let y = 0; y < 30 && !target; y++)
    for (let x = 0; x < 100; x++) {
      const hit = setup.hit(100, 30, x, y, s.runtime.inference, s.prefs);
      if (hit && "option" in hit && hit.option === setup.cursor) {
        target = { x, y };
        break;
      }
    }
  expect(target).not.toBeNull();
  await s.input(bytes(`\x1b[<0;${target!.x + 1};${target!.y + 1}M\x1b[<0;${target!.x + 1};${target!.y + 1}m`));
  expect(s.moonlander).not.toBeNull();
  await s.input(bytes("\x1b[<0;4;1M\x1b[<0;4;1m"));
  expect(s.moonlander).toBeNull();
  expect(s.corgi_setup).toBe(setup);
});

/** Open either host through its ordinary navigation. */
async function openManagement(s: any, source: "launcher" | "settings"): Promise<LauncherMenu> {
  if (source === "launcher") {
    s.openLauncher(true);
    await s.input(bytes("\x1b[C"));
    return s.agent_launcher;
  }
  s.openSetup();
  while (s.corgi_setup.item !== "agents") await s.key(14);
  await s.key(13);
  return s.corgi_setup.agents;
}

test("settings routes manager paste, command saving, visibility and Back through the shared handlers", async () => {
  const { s, sent } = recording(folders("/src/app"));
  const launch = await openManagement(s, "settings"),
    setup = s.corgi_setup;
  expect(s.agent_launcher).toBeNull();
  launch.manager.at = agentManager.agentKey("claude", "");
  await s.manageAction({
    kind: "remove",
    agent: launch.manageModel().agents.find((a: agentManager.Agent) => a.provider === "claude"),
  });
  expect(sent.at(-1)["agent.visibility"].hidden.claude).toBe(true);
  await s.input(bytes("\x1b[D"));
  expect(setup.focus).toBe("list");
  expect(s.corgi_setup).toBe(setup);
  await s.key(13);
  await s.key(47);
  await s.input(bytes("\x1b[200~custom\x1b[201~"));
  expect(launch.manager.query.name()).toBe("custom");
  expect(s.textField()).toBe(launch.manager.query.area);
  await s.key(9);
  await s.key(13);
  await s.input(bytes("\x1b[200~claude --model opus\x1b[201~"));
  launch.manager.form.save_requested = true;
  await s.input(bytes("\x1b[27u"));
  expect(s.corgi_setup).toBe(setup);
  expect(launch.manager.page).toBe("list");
  expect(launch.manager.query.name()).toBe("custom");
  expect(launch.manager.form.save_requested).toBe(false);
  expect(sent.some((command: any) => "agent.command" in command)).toBe(false);
  await s.key(13);
  expect(launch.manager.form.editor.name()).toBe("");
  await s.input(bytes("\x1b[200~claude --model opus\x1b[201~"));
  const f = launch.manager.form;
  expect(f.editor.name()).toBe("claude --model opus");
  // The daemon has resolved this draft, so Enter saves that exact result.
  f.draft.set(f.editor.name());
  f.resolution = agentLauncher.resolution({
    pending: false,
    semantics: { provider: "claude", suggested_name: "Opus" },
  });
  f.resolution.command.set(f.editor.name());
  await s.key(13);
  expect(sent.at(-1)["agent.command"]).toMatchObject({
    index: 0,
    command: "claude --model opus",
    name: "Opus",
    resolve: false,
  });
  expect(launch.manager.page).toBe("list");
  await s.key(27);
  expect(s.corgi_setup).toBeNull();
  expect(sent.some((command: any) => "pane.create" in command)).toBe(false);
});

test.each([false, true])(
  "slow account deletion returns input immediately and ignores a reopened manager (reopen: %s)",
  async reopen => {
    const { s } = withWork(),
      known = { provider: "claude" as const, dir: "/accounts/work", name: "work", managed: true },
      gate = Promise.withResolvers<void>(),
      find = spyOn(accounts, "find").mockReturnValue(known),
      owns = spyOn(accounts, "owns").mockReturnValue(true),
      signOut = spyOn(signin, "signOut").mockReturnValue(gate.promise),
      remove = spyOn(accounts, "remove").mockResolvedValue(true);
    let pending: Promise<void> | null = null;
    try {
      await s.input(bytes("\x1b[C"));
      const launch = s.agent_launcher,
        manager = launch.manager;
      manager.at = agentManager.agentKey("claude", known.dir);
      manager.key(127, launch.manageModel(), 0);
      let returned = false;
      pending = s.manageAction({
        kind: "remove",
        agent: launch.manageModel().agents.find((a: agentManager.Agent) => a.account === known.dir),
      });
      void pending!.then(() => {
        returned = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(returned).toBe(true);
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
      await s.key(9);
      expect(manager.focus).toBe("search");
      if (reopen) {
        manager.open();
        manager.fail("New manager state");
        // A second request cannot start another logout for the same account.
        await s.manageAction({
          kind: "remove",
          agent: launch.manageModel().agents.find((a: agentManager.Agent) => a.account === known.dir),
        });
        expect(signOut).toHaveBeenCalledTimes(1);
        manager.at = agentManager.agentKey("claude", "");
        manager.focus = "list";
        manager.key(127, launch.manageModel(), 1000);
      }
      const newer = reopen ? manager.removal : null;
      gate.resolve();
      await Promise.all([...s.account_removals.values()].map((job: any) => job.task));
      await s.finishAccountRemovals();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(launch.preview.accounts).toEqual([]);
      if (reopen) {
        expect(manager.removal).toBe(newer);
        expect(manager.removal.phase).toBe("held");
      }
    } finally {
      gate.resolve();
      await pending?.catch(() => {});
      await Promise.all([...s.account_removals.values()].map((job: any) => job.task));
      for (const mock of [find, owns, signOut, remove]) mock.mockRestore();
    }
  },
);

test("a failed background logout restores the account row and reports the failure", async () => {
  const { s } = withWork(),
    known = { provider: "claude" as const, dir: "/accounts/work", name: "work", managed: true },
    find = spyOn(accounts, "find").mockReturnValue(known),
    owns = spyOn(accounts, "owns").mockReturnValue(true),
    signOut = spyOn(signin, "signOut").mockRejectedValue(Error("LogoutFailed")),
    remove = spyOn(accounts, "remove").mockResolvedValue(true);
  try {
    await s.input(bytes("\x1b[C"));
    const launch = s.agent_launcher,
      manager = launch.manager;
    manager.at = agentManager.agentKey("claude", known.dir);
    manager.focus = "list";
    manager.key(127, launch.manageModel(), 0);
    await s.manageAction({
      kind: "remove",
      agent: launch.manageModel().agents.find((a: agentManager.Agent) => a.account === known.dir),
    });
    await Promise.all([...s.account_removals.values()].map((job: any) => job.task));
    await s.finishAccountRemovals();
    expect(remove).not.toHaveBeenCalled();
    expect(manager.removal).toBeNull();
    expect(manager.error).toContain("LogoutFailed");
    expect(launch.preview.accounts).toHaveLength(1);
  } finally {
    await Promise.all([...s.account_removals.values()].map((job: any) => job.task));
    for (const mock of [find, owns, signOut, remove]) mock.mockRestore();
  }
});

test("Add agent adds a removed account back, its row there at once and shown in every workspace", async () => {
  const { s, sent } = withWork(),
    old = { provider: "claude" as const, dir: "/accounts/old", name: "old", managed: false },
    restore = spyOn(accounts, "restore").mockReturnValue(old),
    row = agentLauncher.Row.of("claude", old.dir);
  try {
    await s.input(bytes("\x1b[C"));
    const launch = s.agent_launcher,
      ws = s.runtime.workspaces.items[0];
    // `corgi account remove` left it hidden in a workspace.
    ws.launcher_hidden = [row];
    launch.workspace_hidden = [row];
    await s.manageAction({ kind: "restore", provider: "claude", account: old.dir });
    expect(restore).toHaveBeenCalledWith("claude", old.dir);
    expect(sent).toContainEqual({ "agent.workspace_visibility": { workspace: ws.id, row, shown: true } });
    expect(launch.workspace_hidden).toEqual([]);
    expect(launch.manageModel().agents.find((a: agentManager.Agent) => a.account === old.dir)).toMatchObject({
      label: "Claude Code · old",
      shown: true,
    });
    expect(s.added_feedback.label).toBe("Claude Code · old");
    restore.mockImplementation(() => {
      throw Error("AccountNotFound");
    });
    await s.manageAction({ kind: "restore", provider: "claude", account: old.dir });
    expect(launch.manager.error).toBe("Corgi doesn't list this account any more.");
  } finally {
    restore.mockRestore();
  }
});

test("custom keys resolve legacy, CSI-u, Alt and fragmented UTF-8 input", async () => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  s.prefs.keys = { sidebar: ["ctrl+y", "alt+é", "prefix+é", "ctrl+alt+k"] };
  const perform = spyOn(s, "perform").mockResolvedValue(undefined);
  try {
    for (const input of ["\x19", "\x1b[121;5u", "\x1bé", "\x1b[107;7u"]) {
      await s.input(bytes(input));
      expect(perform).toHaveBeenLastCalledWith({ name: "sidebar" });
    }
    expect(perform).toHaveBeenCalledTimes(4);
    await s.input(Uint8Array.of(2, 195));
    expect(perform).toHaveBeenCalledTimes(4);
    await s.input(Uint8Array.of(169));
    expect(perform).toHaveBeenCalledTimes(5);
    expect(s.prefix).toBe(false);
    await s.input(bytes("\x02b"));
    expect(perform).toHaveBeenCalledTimes(5);
  } finally {
    perform.mockRestore();
    viewer.close(s);
  }
});

test("the shortcut recorder owns direct commands and ignores bracketed paste", async () => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  try {
    await s.perform({ name: "keybindings" });
    s.frame();
    await s.input(bytes("\r\r"));
    expect(s.help.edit.listening).toBe(true);
    await s.input(bytes("\x1b[200~do not bind this\x1b[201~"));
    expect(s.help.edit.recorded).toHaveLength(0);
    await s.input(bytes("\x1b[116;5u"));
    expect(s.help.edit.recorded).toHaveLength(1);
    expect(s.agent_launcher).toBeNull();
    expect(s.help.edit.recorded[0].mods.ctrl).toBe(true);
  } finally {
    viewer.close(s);
  }
});

test("UTF-8 continuation bytes do not trigger character shortcuts", async () => {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.input_state.attached = true;
  s.prefs.keys = { sidebar: "Ã" };
  const perform = spyOn(s, "perform").mockResolvedValue(undefined);
  try {
    await s.input(bytes("é"));
    await s.input(bytes("\x02é"));
    expect(perform).not.toHaveBeenCalled();
    expect(s.prefix).toBe(false);
  } finally {
    perform.mockRestore();
    viewer.close(s);
  }
});

/** A one-pane controller whose `click` presses and releases a pane cell
 * and returns the click series count at the press. */
function clickSeries() {
  const s = controller();
  s.receiveSnapshot(folders("/a"));
  s.width = 100;
  s.height = 30;
  s.input_state.attached = true;
  // Only clock.advance moves time between presses.
  setSystemTime(new Date(1000));
  const rect = s.layoutView().placements(s.area())[0].rect;
  const at = { x: rect.x + 2, y: rect.y + 2 };
  const mouse = (button: number, x: number, y: number, release = false) =>
    s.mouse(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  const click = async (x = at.x, y = at.y, button = 0) => {
    await mouse(button, x, y);
    const count = s.click_series?.count ?? 0;
    await mouse(button, x, y, true);
    return count;
  };
  return { s, at, mouse, click };
}

test("presses on one pane cell within the double-click window count up to three", async () => {
  const { s, at, click } = clickSeries();
  try {
    expect(await click()).toBe(1);
    clock.advance(double_click_ms);
    expect(await click()).toBe(2);
    clock.advance(100);
    expect(await click()).toBe(3);
    clock.advance(100);
    expect(await click()).toBe(3);
    clock.advance(double_click_ms + 1);
    expect(await click()).toBe(1);
    clock.advance(50);
    // Shift still counts; Ctrl and Alt end the series.
    expect(await click(at.x, at.y, 4)).toBe(2);
    clock.advance(50);
    expect(await click(at.x, at.y, 16)).toBe(0);
    clock.advance(50);
    expect(await click()).toBe(1);
    clock.advance(50);
    expect(await click(at.x, at.y, 8)).toBe(0);
    clock.advance(50);
    expect(await click()).toBe(1);
    clock.advance(50);
    expect(await click(at.x + 1)).toBe(1);
  } finally {
    setSystemTime();
    clock.reset();
    viewer.close(s);
  }
});

test("scrolling, resizing or dragging off the cell ends a click series", async () => {
  const { s, at, mouse, click } = clickSeries();
  try {
    const term = s.pane(1).terminal;
    term.bottom = 10;
    expect(await click()).toBe(1);
    term.scrollViewport({ delta: -3 });
    clock.advance(50);
    expect(await click()).toBe(1);
    clock.advance(50);
    expect(await click()).toBe(2);
    clock.advance(50);
    await mouse(64, at.x, at.y);
    expect(s.click_series).toBeNull();
    clock.advance(50);
    expect(await click()).toBe(1);
    // Scrolling away and back leaves the same top row.
    s.scroll(-1);
    s.scroll(1);
    clock.advance(50);
    expect(await click()).toBe(1);
    s.width = 90;
    clock.advance(50);
    expect(await click()).toBe(1);
    clock.advance(50);
    await mouse(0, at.x, at.y);
    await mouse(32, at.x, at.y);
    expect(s.click_series?.count).toBe(2);
    await mouse(32, at.x + 1, at.y);
    expect(s.click_series).toBeNull();
    await mouse(32, at.x, at.y);
    await mouse(0, at.x, at.y, true);
    clock.advance(50);
    expect(await click()).toBe(1);
  } finally {
    setSystemTime();
    clock.reset();
    viewer.close(s);
  }
});

test("presses in copy mode don't count a click series", async () => {
  const { s, click } = clickSeries();
  try {
    expect(await click()).toBe(1);
    s.copy_mode = true;
    clock.advance(50);
    expect(await click()).toBe(0);
    expect(s.click_series).toBeNull();
  } finally {
    setSystemTime();
    clock.reset();
    viewer.close(s);
  }
});

/** A controller whose focused pane shows "  hello there", whose daemon answers every
 * pick with "hello" at its cells but the shown text in `reply.shown`. */
function picking() {
  const reply = { shown: "hello" };
  const s: any = new Controller({
    socket: "",
    request: transport(async op => {
      if (op !== "viewer.pick") throw Error("UnexpectedRequest");
      return { ok: true, match: { x: 2, y: 0, end_x: 6, end_y: 0 }, shown: reply.shown, copy: "hello", link: false };
    }).request,
  });
  s.receiveSnapshot(folders("/a", "/b"));
  s.width = 100;
  s.height = 30;
  s.input_state.attached = true;
  setSystemTime(new Date(1000));
  const rect = s.layoutView().placements(s.area())[0].rect;
  const native = NativeTerminal.create(rect.w, rect.h);
  const term = s.pane(1).terminal;
  native.feed("  hello there");
  term.receive(native.surface(1));
  const at = `${rect.x + 4};${rect.y + 1}`;
  const doubleClick = async () => {
    clock.advance(double_click_ms + 1);
    s.clearEffects();
    await s.input(bytes(`\x1b[<0;${at}M\x1b[<0;${at}m\x1b[<0;${at}M\x1b[<0;${at}m`));
  };
  const done = () => {
    native.destroy();
    setSystemTime();
    clock.reset();
    viewer.close(s);
  };
  return { s, term, rect, reply, doubleClick, done };
}

test("a pick whose text the pane no longer shows copies nothing", async () => {
  const { s, term, rect, reply, doubleClick, done } = picking();
  try {
    reply.shown = "world";
    await doubleClick();
    expect(s.effects).toEqual([]);
    expect(s.copy_feedback_until).toBe(0);
    expect(term.selection).toBeNull();
    expect(s.picked).toBeNull();
    // The same answer copies once it matches what the pane shows.
    reply.shown = "hello";
    await doubleClick();
    expect(s.effects).toEqual([{ write_terminal: `\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07` }]);
    expect(s.copy_feedback_until).not.toBe(0);
    expect(term.selection).toEqual({ x: 2, y: 0, end_x: 6, end_y: 0 });
    expect(term.holding_selection).toBe(false);
    expect(s.picked).toEqual({ pane: 1, w: rect.w, h: rect.h });
  } finally {
    done();
  }
});

test("a pick's highlight goes on a click, key, scroll, copy mode, resize or focus change", async () => {
  const { s, term, rect, doubleClick, done } = picking();
  const elsewhere = `${rect.x + 10};${rect.y + 1}`;
  const picked = async () => {
    await doubleClick();
    expect(term.pinned).toBe("hello");
    expect(s.picked).not.toBeNull();
  };
  const cleared = () => {
    expect(term.selection).toBeNull();
    expect(term.pinned).toBeNull();
    expect(s.picked).toBeNull();
  };
  try {
    await picked();
    // Frames and syncs alone keep it.
    s.sweepPicked();
    expect(s.picked).not.toBeNull();
    await s.input(bytes(`\x1b[<0;${elsewhere}M\x1b[<0;${elsewhere}m`));
    cleared();
    await picked();
    await s.input(bytes("x"));
    cleared();
    await picked();
    s.scroll(-1);
    cleared();
    await picked();
    await s.perform({ name: "copy-mode" });
    cleared();
    s.copy_mode = false;
    await picked();
    s.width = 90;
    s.sweepPicked();
    cleared();
    await picked();
    s.focusPane(2);
    s.sweepPicked();
    cleared();
  } finally {
    done();
  }
});

test("a held double-click ends on a scroll, a key or a focus change", async () => {
  const { s, term, rect, done } = picking();
  const at = `${rect.x + 4};${rect.y + 1}`;
  const hold = async () => {
    clock.advance(double_click_ms + 1);
    await s.input(bytes(`\x1b[<0;${at}M\x1b[<0;${at}m\x1b[<0;${at}M`));
    await s.gesture.pending;
    expect(term.holding_selection).toBe(true);
  };
  const ended = () => {
    expect(s.gesture).toBeNull();
    expect(term.selection).toBeNull();
    expect(term.holding_selection).toBe(false);
    expect(s.effects).toEqual([]);
  };
  try {
    await hold();
    s.scroll(-1);
    ended();
    await hold();
    await s.input(bytes("x"));
    ended();
    await hold();
    s.focusPane(2);
    s.sweepPicked();
    ended();
  } finally {
    done();
  }
});

test("a drag keeps one pick out and copies the answer for where it ended", async () => {
  const asks: { to_x: number | null; answer: (copy: string) => void }[] = [];
  const s: any = new Controller({
    socket: "",
    request: transport(async (op, fields: any) => {
      if (op !== "viewer.pick") throw Error("UnexpectedRequest");
      return new Promise(resolve =>
        asks.push({
          to_x: fields.to_x,
          answer: copy =>
            resolve({ ok: true, match: { x: 2, y: 0, end_x: 6, end_y: 0 }, shown: "hello", copy, link: false }),
        }),
      );
    }).request,
  });
  s.receiveSnapshot(folders("/a"));
  s.width = 100;
  s.height = 30;
  s.input_state.attached = true;
  setSystemTime(new Date(1000));
  const rect = s.layoutView().placements(s.area())[0].rect;
  const native = NativeTerminal.create(rect.w, rect.h);
  native.feed("  hello there");
  s.pane(1).terminal.receive(native.surface(1));
  const cell = (dx: number) => `${rect.x + 4 + dx};${rect.y + 1}`;
  try {
    await s.input(bytes(`\x1b[<0;${cell(0)}M\x1b[<0;${cell(0)}m\x1b[<0;${cell(0)}M`));
    await s.input(bytes(`\x1b[<32;${cell(1)}M\x1b[<32;${cell(2)}M\x1b[<32;${cell(3)}M`));
    // The first ask is still out, so the drag asks nothing more yet.
    expect(asks.map(ask => ask.to_x)).toEqual([null]);
    const released = s.input(bytes(`\x1b[<0;${cell(3)}m`));
    asks[0].answer("stale");
    while (asks.length < 2) await Bun.sleep(1);
    // One more ask, for where the drag ended.
    expect(asks.map(ask => ask.to_x)).toEqual([null, 6]);
    asks[1].answer("dragged");
    await released;
    expect(s.effects).toEqual([{ write_terminal: `\x1b]52;c;${Buffer.from("dragged").toString("base64")}\x07` }]);
    expect(asks.length).toBe(2);
  } finally {
    native.destroy();
    setSystemTime();
    clock.reset();
    viewer.close(s);
  }
});

/** A controller on two workspaces whose focused pane shows "  hello there",
 * "hello" a link to `url`, and whose daemon fails every request (an old
 * daemon has no viewer.pick). `click` presses and releases `dx` cells right
 * of the link's second cell. */
function linking() {
  const url = "https://example.com/hello";
  const s: any = new Controller({
    socket: "",
    request: transport(async op => {
      throw Error(op === "viewer.pick" ? "UnknownOperation" : "UnexpectedRequest");
    }).request,
  });
  s.receiveSnapshot(folders("/a", "/b"));
  s.width = 100;
  s.height = 30;
  s.input_state.attached = true;
  setSystemTime(new Date(1000));
  const rect = s.layoutView().placements(s.area())[0].rect;
  const native = NativeTerminal.create(rect.w, rect.h);
  const term = s.pane(1).terminal;
  native.feed(`  \x1b]8;;${url}\x1b\\hello\x1b]8;;\x1b\\ there`);
  term.receive(native.surface(1));
  const mouse = (button: number, dx = 0, release = false) =>
    s.mouse(`\x1b[<${button};${rect.x + 4 + dx};${rect.y + 1}${release ? "m" : "M"}`);
  const click = async (button = 0, dx = 0) => {
    await mouse(button, dx);
    await mouse(button, dx, true);
  };
  /** The links opened by the time the viewer's next tick runs. */
  const opened = async () => {
    await s.expireInput();
    const urls = s.effects.filter((effect: any) => "open_url" in effect).map((effect: any) => effect.open_url);
    s.clearEffects();
    return urls;
  };
  const done = () => {
    native.destroy();
    setSystemTime();
    clock.reset();
    viewer.close(s);
  };
  return { s, url, term, mouse, click, opened, done };
}

test("a plain click on a pane link opens it once the double-click window has passed", async () => {
  const { s, url, mouse, click, opened, done } = linking();
  try {
    expect(
      s
        .pane(1)
        .terminal.hyperlinks()
        .map((link: any) => link.uri),
    ).toEqual([url]);
    const at = clock.milliTimestamp();
    await click();
    expect(s.effects).toEqual([]);
    expect(s.pending_open).toEqual({ url, pane: 1, due: at + double_click_ms });
    expect(await opened()).toEqual([]);
    clock.advance(double_click_ms - 1);
    expect(await opened()).toEqual([]);
    clock.advance(1);
    expect(await opened()).toEqual([url]);
    expect(s.pending_open).toBeNull();
    clock.advance(double_click_ms);
    expect(await opened()).toEqual([]);
    // Held past the window, it opens at its release.
    await mouse(0);
    clock.advance(double_click_ms + 100);
    expect(await opened()).toEqual([]);
    await mouse(0, 0, true);
    expect(await opened()).toEqual([url]);
  } finally {
    done();
  }
});

test("another press in the window cancels a pane link's open; the wheel doesn't", async () => {
  const { url, mouse, click, opened, done } = linking();
  try {
    // The second press of a double-click.
    await click();
    clock.advance(100);
    await mouse(0);
    expect(await opened()).toEqual([]);
    await mouse(0, 0, true);
    clock.advance(double_click_ms);
    expect(await opened()).toEqual([]);
    // A press on another cell of the pane.
    clock.advance(double_click_ms);
    await click();
    clock.advance(50);
    await click(0, 20);
    clock.advance(double_click_ms);
    expect(await opened()).toEqual([]);
    // A wheel step isn't a press.
    clock.advance(double_click_ms);
    await click();
    clock.advance(50);
    await mouse(64);
    clock.advance(double_click_ms);
    expect(await opened()).toEqual([url]);
  } finally {
    done();
  }
});

test("a pane link's open is dropped once its pane loses focus or closes", async () => {
  const { s, click, opened, done } = linking();
  try {
    await click();
    s.focusPane(2);
    clock.advance(double_click_ms);
    expect(await opened()).toEqual([]);
    s.focusPane(1);
    clock.advance(double_click_ms);
    await click();
    expect(s.pending_open).not.toBeNull();
    const closed = folders("/a", "/b");
    closed.workspaces = closed.workspaces.slice(1);
    closed.panes = closed.panes.slice(1);
    s.receiveSnapshot(closed);
    clock.advance(double_click_ms);
    expect(await opened()).toEqual([]);
  } finally {
    done();
  }
});

test("a Ctrl+click opens a pane link at once", async () => {
  const { s, url, click, opened, done } = linking();
  try {
    await click(16);
    expect(s.effects).toEqual([{ open_url: url }]);
    expect(s.pending_open).toBeNull();
    s.clearEffects();
    clock.advance(double_click_ms);
    expect(await opened()).toEqual([]);
  } finally {
    done();
  }
});

test("a double-click the daemon can't pick leaves nothing selected, copied or opened", async () => {
  const { s, term, click, opened, done } = linking();
  try {
    const message = s.message;
    // On the link and on a word.
    for (const dx of [0, 7]) {
      clock.advance(double_click_ms + 1);
      await click(0, dx);
      await click(0, dx);
      expect(s.click_series?.count).toBe(2);
      expect(s.gesture).toBeNull();
      expect(s.effects).toEqual([]);
      expect(s.copy_feedback_until).toBe(0);
      expect(s.clipboard).not.toBe("hello");
      expect(term.selection).toBeNull();
      expect(term.holding_selection).toBe(false);
      expect(s.picked).toBeNull();
      expect(s.message).toBe(message);
      clock.advance(double_click_ms);
      expect(await opened()).toEqual([]);
    }
  } finally {
    done();
  }
});
