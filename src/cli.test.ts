import { test, expect } from "bun:test";
import { realpathSync } from "node:fs";
import {
  asksHelp,
  handles,
  help,
  helpFor,
  idle,
  launcher,
  launcherText,
  layout,
  list,
  parse,
  read,
  usage,
  words,
} from "./cli";
import { Provider, adapter } from "./providers";

test("help is asked for only before --", () => {
  expect(asksHelp(["move", "3", "--help"])).toBe(true);
  expect(asksHelp(["read", "-h"])).toBe(true);
  expect(asksHelp(["send", "3", "--", "--help"])).toBe(false);
  expect(asksHelp(["send", "3", "help"])).toBe(false);
  expect(asksHelp(["launcher", "edit", "codex", "--flags", "--help"])).toBe(false);
  expect(asksHelp(["account", "add", "--dir", "--help"])).toBe(false);
  expect(asksHelp(["launcher", "edit", "codex", "--flags", "--help", "-h"])).toBe(true);
});
test("help only skips values consumed by the command's parser", () => {
  for (const args of [
    ["shutdown", "--name", "--help"],
    ["shutdown", "--cwd", "-h"],
    ["action", "rename", "--name", "--help"],
    ["reload", "--flags", "--help"],
    ["account", "remove", "--name", "--help"],
    ["account", "remove", "--dir", "--help"],
    ["integration", "uninstall", "--dir", "--help"],
    ["headless", "list", "--workspace", "--help"],
    ["headless", "start", "codex", "--workspace", "--help"],
  ])
    expect(asksHelp(args)).toBe(true);
  for (const args of [
    ["tab", "new", "--name", "--help"],
    ["tab", "new", "--command", "--help"],
    ["launcher", "edit", "codex", "--flags", "--help"],
    ["account", "add", "codex", "work", "--dir", "--help"],
    ["integration", "status", "--account", "--help"],
    ["headless", "start", "codex", "prompt", "--workspace", "--help"],
    ["pane", "send", "current", "--", "--help"],
  ])
    expect(asksHelp(args)).toBe(false);
});
test("usage finds the lines for the longest command a line names", () => {
  expect(usage(help, ["pane", "split", "3", "--righ"]).map(line => line.trim())).toEqual([
    "corgi pane split ID|current --right|--left|--up|--down [--cwd DIR] [--command SHELL_COMMAND]",
  ]);
  expect(usage(help, ["pane", "move"])).toHaveLength(2);
  expect(usage(help, ["workspace", "new", "X"]).every(line => line.includes("corgi workspace"))).toBe(true);
  expect(usage(help, ["tab", "bogus"]).every(line => line.trim().startsWith("corgi tab "))).toBe(true);
  expect(usage(help, ["bogus"])).toEqual([]);
  expect(usage(help, ["claim", "--clear"]).map(line => line.trim())).toEqual([
    "corgi claim PROVIDER [--pane ID|current] [--owner PID]",
    "corgi claim --clear [--pane ID|current] [--owner PID]",
  ]);
  expect(usage(help, ["workspace", "new"])).toEqual(["  corgi workspace new NAME [--cwd DIR]"]);
  expect(usage(help, ["launcher", "show"])).toEqual([
    "  corgi launcher show AGENT... [--workspace ID]  in one workspace only",
  ]);
  expect(helpFor(help, ["launcher", "edit"])).toContain("[--flags FLAGS] [--env JSON_OBJECT]");
  expect(helpFor(help, ["launcher", "clone"])).toContain("[--flags FLAGS] [--env JSON_OBJECT]");
  expect(helpFor(help, ["pane", "read"])).not.toContain("corgi tab");
  expect(helpFor(help, ["tab", "new"])).toContain("[--command SHELL_COMMAND]");
  expect(helpFor(help, ["pane", "split"])).toContain("[--command SHELL_COMMAND]");
  expect(helpFor(help, [])).toBe(help);
});

test("command lines are rejected before connecting", async () => {
  const cases: [string[], string?, number?][] = [
    [["pane", "split"]],
    [["pane", "idle", "3"]],
    [["pane", "idle", "--workspace", "0"]],
    [["pane", "split", "0", "--right"]],
    [["pane", "split", "x", "--right"], "InvalidCharacter"],
    [["pane", "split", "current", "--right"], "NoCallerPane"],
    [["pane", "split", "3"]],
    [["pane", "split", "3", "--right", "--up"]],
    [["pane", "split", "3", "--right", "--unknown"]],
    [["pane", "split", "3", "--right", "--unknown", "value"]],
    [["pane", "split", "3", "--right", "--right"]],
    [["pane", "split", "3", "--righ"]],
    [["tab", "new", "--workspace", "1", "--name"]],
    [["pane", "move", "3"]],
    [["pane", "move", "3", "--new-tab", "--below", "3"]],
    [["pane", "move", "3", "--right-of", "0"]],
    [["pane", "swap", "3"]],
    [["pane", "resize", "3", "--width", "50%", "--height", "50%"]],
    [["pane", "resize", "3", "--width", "50"]],
    [["pane", "resize", "3", "--width", "95%"]],
    [["pane", "close", "3", "--cwd", "/tmp"]],
    [["pane", "read", "3", "--lines", "0"]],
    [["pane", "send", "3"]],
    [["pane", "keys", "3"]],
    [["pane", "keys", "3", "enter", "invalid-key"], "InvalidKey"],
    [["pane", "bogus", "3"]],
    [["tab", "new"], "MissingWorkspace"],
    [["tab", "new", "--workspace", "1", "--name", "one", "--name", "two"]],
    [["tab", "rename", "4", "--clear", "oops"]],
    [["tab", "move", "4", "--before", "6", "--workspace", "1"]],
    [["tab", "merge", "4"]],
    [["workspace", "edit", "2", "--name", "Oops", "--clear"]],
    [["workspace", "close", "2", "--cwd", "/tmp"]],
    [["workspace", "close", "current"], "Usage", 3],
    [["focus", "3"]],
    [["current"], "NoCallerPane"],
    [["list", "extra"]],
    [["list", "--json", "--json"]],
    [["list", "--text"]],
    [["launcher"]],
    [["launcher", "bogus"]],
    [["launcher", "list", "codex"]],
    [["launcher", "hide"]],
    [["launcher", "show", "--workspace", "1"]],
    [["launcher", "hide", "codex", "--workspace", "0"]],
    [["launcher", "hide", "codex"], "MissingWorkspace"],
  ];
  for (const [words, error = "Usage", caller = 0] of cases) await expect(parse(words, caller)).rejects.toThrow(error);
});
test("command lines parse to the request the daemon receives", async () => {
  const cases: [string[], any, number?][] = [
    [["list", "--json"], { action: "list", json: true }],
    [["workspace", "list"], { action: "list" }],
    [["current"], { action: "current" }, 5],
    [["focus", "3", "--viewer", "9"], { action: "focus", target: 3, viewer: 9 }],
    [["workspace", "switch", "2"], { action: "workspace.switch", target: 2 }],
    [
      ["tab", "new", "--workspace", "2", "--name", "Build", "--command", "make"],
      { action: "tab.new", command: { "pane.create": { workspace: 2, title: "Build", cwd: "", command: "make" } } },
    ],
    [
      ["tab", "new"],
      { action: "tab.new", command: { "pane.create": { workspace: 0, title: "", cwd: "", command: null } } },
      5,
    ],
    [
      ["tab", "rename", "4", "Backend"],
      { action: "tab.rename", target: 4, command: { "tab.rename": { target: 4, name: "Backend" } } },
    ],
    [
      ["tab", "rename", "4", "--clear"],
      { action: "tab.rename", target: 4, command: { "tab.rename": { target: 4, name: "" } } },
    ],
    [
      ["tab", "move", "4", "--after", "6"],
      { action: "tab.move", target: 4, command: { "tab.move": { target: 4, destination: { after: 6 } } } },
    ],
    [
      ["tab", "move", "4", "--workspace", "2"],
      { action: "tab.move", target: 4, command: { "tab.move": { target: 4, destination: { workspace: 2 } } } },
    ],
    [
      ["tab", "merge", "4", "--below", "7"],
      { action: "tab.merge", target: 4, command: { "tab.merge": { target: 4, other: 7, direction: "down" } } },
    ],
    [["tab", "close", "4"], { action: "tab.close", target: 4, command: { "tab.close": { target: 4 } } }],
    [
      ["pane", "split", "3", "--left", "--command", "make"],
      {
        action: "pane.split",
        target: 3,
        command: { "pane.split": { target: 3, direction: "left", cwd: "", command: "make" } },
      },
    ],
    [
      ["pane", "move", "3", "--left-of", "7"],
      {
        action: "pane.move",
        target: 3,
        command: { "pane.move": { target: 3, destination: { beside: { other: 7, direction: "left" } } } },
      },
    ],
    [
      ["pane", "move", "3", "--new-tab", "--name", "Logs"],
      { action: "pane.move", target: 3, command: { "pane.move": { target: 3, destination: { new_tab: "Logs" } } } },
    ],
    [["pane", "swap", "3", "7"], { action: "pane.swap", target: 3, command: { "pane.swap": { target: 3, other: 7 } } }],
    [
      ["pane", "resize", "3", "--height", "60%"],
      { action: "pane.resize", target: 3, command: { "pane.resize": { target: 3, axis: "vertical", ratio: 600 } } },
    ],
    [["pane", "close", "3"], { action: "pane.close", target: 3, command: { "pane.close": { target: 3 } } }],
    [
      ["pane", "send", "3", "--enter", "--", "--literal"],
      { action: "pane.send", target: 3, command: { "pane.send": { target: 3, text: "--literal", enter: true } } },
    ],
    [
      ["pane", "keys", "3", "ctrl+c", "enter"],
      { action: "pane.keys", target: 3, command: { "pane.keys": { target: 3, text: "ctrl+c enter" } } },
    ],
    [
      ["workspace", "new", "Project", "--cwd", "/tmp"],
      { action: "workspace.new", command: { "workspace.create": { name: "Project", cwd: realpathSync("/tmp") } } },
    ],
    [
      ["workspace", "edit", "2", "--clear", "--cwd", "/tmp"],
      {
        action: "workspace.edit",
        target: 2,
        command: { "workspace.edit": { target: 2, name: "", cwd: realpathSync("/tmp") } },
      },
    ],
    [
      ["workspace", "close", "2"],
      { action: "workspace.close", target: 2, command: { "workspace.close": { target: 2 } } },
    ],
    [["pane", "idle"], { action: "pane.idle", idle: { workspace: 0, cwd: "", first: false } }],
    [
      ["pane", "idle", "--workspace", "2", "--cwd", "/tmp", "--first"],
      { action: "pane.idle", idle: { workspace: 2, cwd: realpathSync("/tmp"), first: true } },
    ],
    [["launcher", "list"], { action: "launcher.list", launcher: { workspace: 0, agents: [] } }],
    [
      ["launcher", "hide", "codex", "claude/work", "--workspace", "2"],
      { action: "launcher.hide", launcher: { workspace: 2, agents: ["codex", "claude/work"] } },
    ],
    [
      ["launcher", "show", "review-bot"],
      { action: "launcher.show", launcher: { workspace: 0, agents: ["review-bot"] } },
      5,
    ],
  ];
  for (const [words, want, caller = 0] of cases)
    expect(await parse(words, caller)).toEqual({
      target: 0,
      current: false,
      json: false,
      viewer: null,
      command: null,
      idle: null,
      launcher: null,
      ...want,
    });
  expect(await parse(["pane", "read", "current", "--lines", "10", "--json"], 5)).toEqual({
    action: "pane.read",
    target: 5,
    current: true,
    json: true,
    viewer: null,
    command: { "pane.read": { target: 5, lines: 10 } },
    idle: null,
    launcher: null,
  });
});
test("external agent claims default to the caller pane and parent owner", async () => {
  expect(handles(["claim", "claude"])).toBe(true);
  expect(await parse(["claim", "claude"], 7)).toMatchObject({
    action: "claim",
    claim: { pane: 7, provider: "claude", owner: process.ppid },
  });
  expect(await parse(["claim", "codex", "--pane", "9", "--owner", "123", "--json"])).toMatchObject({
    json: true,
    claim: { pane: 9, provider: "codex", owner: 123 },
  });
  expect(await parse(["claim", "--clear", "--owner", "123"], 7)).toMatchObject({
    claim: { pane: 7, provider: null, owner: 123 },
  });
  expect(await parse(["claim", "--clear", "--pane", "9", "--owner", "123"])).toMatchObject({
    claim: { pane: 9, provider: null, owner: 123 },
  });
  await expect(parse(["claim", "claude"])).rejects.toThrow("NoCallerPane");
  await expect(parse(["claim", "--clear"])).rejects.toThrow("NoCallerPane");
  for (const args of [
    ["claim"],
    ["claim", "bogus"],
    ["claim", "--clear", "claude"],
    ["claim", "claude", "codex"],
    ["claim", "clear"],
    ["claim", "claude", "--owner", "1"],
    ["claim", "claude", "--owner", "2147483648"],
    ["claim", "claude", "--name", "remote"],
    ["pane", "agent", "claim", "claude"],
  ])
    await expect(parse(args, 7)).rejects.toThrow("Usage");
});

test("a tab's layout names each split's sides", () => {
  const nodes = [
    { split: { axis: "horizontal", first: 1, second: 2, ratio: 500 } },
    { pane: 9 },
    { split: { axis: "vertical", first: 3, second: 4, ratio: 500 } },
    { pane: 12 },
    { pane: 13 },
    null,
  ];
  expect(layout(nodes, 0)).toBe("9 left of (12 above 13)");
  expect(layout(nodes, 2)).toBe("12 above 13");
  expect(layout(nodes, 5)).toBe("");
});
test("list outlines workspaces, tabs, panes and viewers", () => {
  const idle = { provider: null, state: "unknown", attention: "none", name: "", activity: "", recent_activity: "" };
  const reply = {
    ok: true,
    result: {
      conversations: [{ id: 1 }],
      workspaces: [
        {
          id: 2,
          name: "Corgi",
          cwd: "/src",
          model: {
            nodes: [{ split: { axis: "horizontal", first: 1, second: 2 } }, { pane: 9 }, { pane: 10 }, { pane: 15 }],
            tabs: [
              { id: 20, root: 0, title: "" },
              { id: 21, root: 3, title: "Logs" },
            ],
          },
        },
      ],
      panes: [
        { id: 9, name: "", cwd: "/src", exited: false, agent: idle },
        { id: 10, name: "", cwd: "/tmp", exited: false, agent: idle },
        {
          id: 15,
          name: "tail",
          cwd: "/src",
          exited: true,
          agent: {
            ...idle,
            provider: "claude",
            state: "blocked",
            attention: "needs_input",
            recent_activity: "used: Bash",
          },
        },
      ],
    },
    viewers: [{ id: 1, workspace: 2, pane: 9, watched: true }],
  };
  expect(list(reply)).toBe(
    [
      'workspace 2 "Corgi" /src',
      "  tab 20: 9 left of 10",
      "    pane 9",
      "    pane 10 /tmp",
      '  tab 21 "Logs"',
      '    pane 15 "tail" exited claude blocked, needs input (used: Bash)',
      "viewer 1: workspace 2, pane 9",
      "",
    ].join("\n"),
  );
});
test("launcher names each agent and says where it shows", () => {
  const snapshot = {
    agent_hidden: { codex: false, claude: false },
    account_hidden: ["/accounts/side"],
    accounts: [
      { provider: "claude", account: "/accounts/work", name: "work", managed: true },
      { provider: "claude", account: "/accounts/side", name: "codex", managed: false },
    ],
    agent_commands: [
      { command: "", name: "", hidden: false },
      { command: "claude --model opus", name: "review-bot", hidden: false },
      { command: "codex --yolo", name: "", hidden: true },
    ],
    workspaces: [
      { id: 1, name: "corgi", launcher_hidden: ["claude:/accounts/work", "custom1"] },
      { id: 4, name: "", launcher_hidden: [] },
    ],
  };
  const text = launcherText(launcher(snapshot)),
    lines = text.trimEnd().split("\n"),
    rest = Provider.all.slice(3).map(p => [p, adapter(p).label, "shown"]);
  expect(lines.map(line => line.trim().split(/ {2,}/))).toEqual([
    ['workspace 1 "corgi"'],
    ["codex", "Codex", "shown"],
    ["claude", "Claude Code", "shown"],
    ["claude/work", "Claude Code · work", "hidden"],
    ["claude/codex", "Claude Code · codex", "not in the launcher"],
    ["pi", "Pi", "shown"],
    ...rest,
    ["command/2", "review-bot", "hidden"],
    ["command/3", "Codex command", "not in the launcher"],
    ["workspace 4"],
    ["codex", "Codex", "shown"],
    ["claude", "Claude Code", "shown"],
    ["claude/work", "Claude Code · work", "shown"],
    ["claude/codex", "Claude Code · codex", "not in the launcher"],
    ["pi", "Pi", "shown"],
    ...rest,
    ["command/2", "review-bot", "shown"],
    ["command/3", "Codex command", "not in the launcher"],
  ]);
  // Labels and places line up in columns.
  const agents = lines.filter(line => line.startsWith("  "));
  for (const column of [1, 2])
    expect(new Set(agents.map(line => line.indexOf(line.trim().split(/ {2,}/)[column]))).size).toBe(1);
  // Every spelling must fit one agent, including aliases of canonical names.
  const named = (...names: string[]) => launcher(snapshot, 1, names)[0].agents.map(a => a.agent);
  expect(named("codex/default", "work", "review-bot", "command/3", "claude/default", "work")).toEqual([
    "codex",
    "claude/work",
    "command/2",
    "command/3",
    "claude",
  ]);
  expect(() => named("codex")).toThrow("AmbiguousAgent");
  const colliding = {
    ...snapshot,
    accounts: [...snapshot.accounts, { provider: "claude", account: "/literal", name: "claude/work" }],
  };
  expect(() => launcher(colliding, 1, ["claude/work"])).toThrow("AmbiguousAgent");
  expect(launcher(colliding, 1, ["claude/claude/work"])[0].agents[0].agent).toBe("claude/claude/work");
  expect(() => named("default")).toThrow("UnknownAgent");
  expect(() => named("terminal")).toThrow("UnknownAgent");
  expect(() => launcher(snapshot, 2)).toThrow("NoWorkspace");
  expect(
    launcher({ ...snapshot, accounts: [...snapshot.accounts, { provider: "codex", account: "/w", name: "work" }] }, 4, [
      "codex/work",
    ])[0].agents,
  ).toEqual([{ agent: "codex/work", label: "Codex · work", launcher: true, hidden: false }]);
  expect(() =>
    launcher({ ...snapshot, accounts: [...snapshot.accounts, { provider: "codex", account: "/w", name: "work" }] }, 4, [
      "work",
    ]),
  ).toThrow("AmbiguousAgent");
});
test("other replies say what changed", () => {
  const result = { pane: 0, tab: 0, workspace: 0, text: null, closed_panes: [] };
  expect(words({ ok: true, result: { ...result, pane: 31, tab: 12, workspace: 2 } })).toBe(
    "pane 31 (tab 12, workspace 2)\n",
  );
  expect(words({ ok: true, result: { ...result, closed_panes: [3, 4] } })).toBe("closed pane 3, 4\n");
  expect(words({ ok: true, result })).toBe("ok\n");
  expect(words({ ok: true, viewer: 1, queued: true })).toBe("queued for viewer 1\n");
});
test("pane idle lists each waiting shell with its folder", () => {
  expect(
    idle({
      ok: true,
      panes: [
        { pane: 3, tab: 2, workspace: 1, cwd: "/repo" },
        { pane: 9, tab: 5, workspace: 1, cwd: "/repo" },
      ],
    }),
  ).toBe("pane 3 (tab 2, workspace 1) /repo\npane 9 (tab 5, workspace 1) /repo\n");
  expect(idle({ ok: true, panes: [] })).toBe("no idle shells\n");
});
test("pane read says when earlier lines exist", () => {
  expect(read("a\nb\nc", 2)).toBe("[corgi: last 2 lines shown; --lines N reads more]\nb\nc\n");
  expect(read("b\nc", 2)).toBe("b\nc\n");
  expect(read("", 2)).toBe("");
});
test("agent mode trims a read's line ends, rules and blank runs", () => {
  const rule = "─".repeat(80);
  expect(read(`${rule}\n❯ hi   \n\n\n\n${rule}`, 10)).toBe(`${rule}\n❯ hi   \n\n\n\n${rule}\n`);
  expect(read(`${rule}\n❯ hi   \n\n\n\n${rule}`, 10, true)).toBe("───\n❯ hi\n\n───\n");
});
