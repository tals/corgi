import { test, expect, spyOn } from "bun:test";
import { actionNames, failure, providerAlias, paneId, run, say } from "./main";
import { specs } from "./action";
import * as rpc from "./rpc";
import * as crash from "./crash";
import * as updates from "./updates";
import * as integration from "./integration";
import * as accountCommand from "./account_command";
import * as protocol from "./protocol";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
test("provider named launchers use their original argv0", () => {
  expect(providerAlias("/tmp/codex")).toBe("codex");
  expect(providerAlias("/tmp/claude")).toBe("claude");
  for (const name of ["bun", "/tmp/corgi", "/tmp/codex-screen", "/tmp/my-claude"])
    expect(providerAlias(name)).toBeNull();
});
test("pane environment IDs use the source unsigned integer boundary", () => {
  expect(paneId("7")).toBe(7);
  expect(paneId("0007")).toBe(7);
  for (const value of ["", "1e2", "-1", " 7", "7.0"]) expect(() => paneId(value)).toThrow("InvalidCharacter");
  expect(() => paneId("4294967296")).toThrow("Overflow");
});
test("runtime protocol errors are distinct from viewer incompatibility", () => {
  const runtime = failure(["dev"], Error("UnsupportedProtocol"));
  expect(runtime).toContain(`runtime protocol ${protocol.version}`);
  expect(runtime).not.toContain("viewer protocol");
  expect(failure(["dev"], Error("UnsupportedViewerProtocol"))).toContain(`viewer protocol ${protocol.viewer_version}`);
  expect(failure(["reload"], Error("UnsupportedManagementProtocol"))).toContain(
    `management protocol ${protocol.management_version}`,
  );
});
test("help names every action on lines of at most 80 columns", () => {
  for (const line of actionNames.split("\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(80);
  expect(
    actionNames
      .slice("Actions:".length)
      .split(/[ ,.\n]+/)
      .filter(Boolean),
  ).toEqual(Object.keys(specs).filter(name => name !== "relaunch"));
});
test("open inside a pane quietly sends its viewer the folder's real path", async () => {
  const previous = process.env.CORGI_PANE;
  process.env.CORGI_PANE = "7";
  const request = spyOn(rpc, "request").mockResolvedValue({ ok: true });
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await run(["open", import.meta.dir + "/.."]);
    expect(request.mock.calls[0]?.slice(1)).toEqual([
      "action",
      { name: "open", value: realpathSync(resolve(import.meta.dir, "..")), pane: 7 },
    ]);
    expect(output).not.toHaveBeenCalled();
    await expect(run(["open", import.meta.filename])).rejects.toThrow("NotDir");
    await expect(run(["open"])).rejects.toThrow("Usage");
  } finally {
    request.mockRestore();
    output.mockRestore();
    if (previous === undefined) delete process.env.CORGI_PANE;
    else process.env.CORGI_PANE = previous;
  }
});
test("--help prints help instead of running the command", async () => {
  const request = spyOn(rpc, "request").mockResolvedValue({ ok: true });
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  const init = spyOn(crash, "init").mockImplementation(() => {});
  const update = spyOn(updates, "internal").mockResolvedValue(false);
  try {
    for (const [args, expected] of [
      [["shutdown", "--help"], "corgi shutdown"],
      [["reload", "-h"], "corgi reload"],
      [["--no-agent", "-h"], "corgi shutdown"],
      [["agent", "--help"], "corgi agent"],
      [["serve", "--help"], "corgi shutdown"],
      [["--skill", "--help"], "corgi --skill"],
      [["pane", "send", "--stdin", "--help"], "corgi pane send"],
      [["help", "pane", "read"], "corgi pane read"],
      [["--help", "pane", "read"], "corgi pane read"],
      [["help", "tab", "new"], "[--command SHELL_COMMAND]"],
      [["pane", "split", "--help"], "[--command SHELL_COMMAND]"],
      [["help", "account"], "Usage: corgi account"],
      [["help", "integration"], "Usage: corgi integration"],
    ] as const) {
      output.mockClear();
      await run([...args]);
      expect(String(output.mock.calls[0]?.[0])).toContain(expected);
    }
    expect(request).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
    output.mockRestore();
    init.mockRestore();
    update.mockRestore();
  }
});
test("help after an unrelated option never reaches the daemon", async () => {
  const request = spyOn(rpc, "request").mockRejectedValue(Error("UnexpectedRequest"));
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    for (const args of [
      ["shutdown", "--name", "--help"],
      ["shutdown", "--cwd", "-h"],
      ["action", "rename", "--name", "--help"],
      ["reload", "--flags", "--help"],
    ]) {
      output.mockClear();
      await run(args);
      expect(String(output.mock.calls[0]?.[0])).toContain(`corgi ${args[0]}`);
    }
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
    output.mockRestore();
  }
});
test("account and integration help routes distinguish human and agent output", async () => {
  const request = spyOn(rpc, "request").mockRejectedValue(Error("UnexpectedRequest")),
    output = spyOn(process.stdout, "write").mockReturnValue(true),
    update = spyOn(updates, "internal").mockResolvedValue(false),
    accountHelp = spyOn(accountCommand, "localizedHelp").mockReturnValue("account translated\n"),
    integrationHelp = spyOn(integration, "localizedHelp").mockReturnValue("integration translated\n"),
    previousExit = process.exitCode;
  try {
    for (const [topic, reference] of [
      ["account", accountCommand.help],
      ["integration", integration.help],
    ]) {
      const forms = [
        [topic, "--help"],
        ["help", topic],
        [topic, "help"],
      ];
      if (topic === "integration") forms.push([topic]);
      for (const args of forms) {
        output.mockClear();
        await run(["--no-agent", ...args]);
        expect(output.mock.calls.map(call => String(call[0])).join("")).toBe(`${topic} translated\n`);
        output.mockClear();
        accountHelp.mockClear();
        integrationHelp.mockClear();
        await run(["--agent", ...args]);
        expect(output.mock.calls.map(call => String(call[0])).join("")).toBe(reference);
        expect(accountHelp).not.toHaveBeenCalled();
        expect(integrationHelp).not.toHaveBeenCalled();
      }
    }
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
    output.mockRestore();
    update.mockRestore();
    accountHelp.mockRestore();
    integrationHelp.mockRestore();
    process.exitCode = previousExit;
  }
});
test("provider help remains the provider's argument", async () => {
  const launch = spyOn(integration, "launch").mockRejectedValue(Error("ProviderHelp"));
  try {
    await expect(run(["agent", "codex", "--help"])).rejects.toThrow("ProviderHelp");
    expect(launch.mock.calls[0]?.slice(0, 2)).toEqual(["codex", ["--help"]]);
  } finally {
    launch.mockRestore();
  }
});
test("action values preserve agent mode flags", async () => {
  const request = spyOn(rpc, "request").mockResolvedValue({ ok: true, viewer: 3, queued: true });
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    for (const value of ["--agent", "--no-agent"]) {
      request.mockClear();
      await run(["action", "rename", value]);
      expect(request.mock.calls[0]?.slice(1)).toEqual(["action", { name: "rename", value }]);
    }
  } finally {
    request.mockRestore();
    output.mockRestore();
  }
});
test("account command values preserve agent mode flags", async () => {
  const account = spyOn(accountCommand, "command").mockResolvedValue(0),
    hooks = spyOn(integration, "command").mockResolvedValue(true),
    update = spyOn(updates, "internal").mockResolvedValue(false),
    previousExit = process.exitCode;
  try {
    for (const value of ["--agent", "--no-agent"]) {
      account.mockClear();
      await run(["account", "rename", "work", value]);
      expect(account.mock.calls[0]?.[0]).toEqual(["rename", "work", value]);
      hooks.mockClear();
      await run(["integration", "status", "--account", value]);
      expect(hooks.mock.calls[0]).toEqual(["status", null, value]);
    }
  } finally {
    account.mockRestore();
    hooks.mockRestore();
    update.mockRestore();
    process.exitCode = previousExit;
  }
});
test("agent mode does not hide commands from root help", async () => {
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    for (const args of [["--help"], ["--agent", "--help"], ["--no-agent", "--help"]]) {
      output.mockClear();
      await run(args);
      const text = String(output.mock.calls[0]?.[0]);
      expect(text).toContain("corgi pane read");
      expect(text).toContain("corgi shutdown");
    }
  } finally {
    output.mockRestore();
  }
});
test("daemon replies print in words", () => {
  expect(say("ping", { ok: true, pid: 42 })).toBe("running, pid 42\n");
  expect(say("recovery.save", { ok: true, path: "/state/r1" })).toBe("saved /state/r1\n");
  expect(say("action", { ok: true, viewer: 3, queued: true })).toBe("queued for viewer 3\n");
  expect(say("headless.list", { ok: true, sessions: [] })).toBe("no headless sessions\n");
  expect(
    say("headless.list", {
      ok: true,
      sessions: [
        {
          session: "thread-abc",
          pid: 9,
          provider: "codex",
          state: "blocked",
          attention: "needs_input",
          pending_requests: 1,
        },
      ],
    }),
  ).toBe("codex thread-abc blocked, needs input, 1 pending request\n");
  expect(
    say("headless.events", {
      ok: true,
      events: [{ seq: 4, event: { kind: "message", session: "a", text: "done" } }],
      pending_requests: [{ id: "9", session: "a", ask: { tool: true, name: "Bash", summary: "rm -rf build" } }],
      next_seq: 5,
    }),
  ).toBe('4 message {"session":"a","text":"done"}\npending 9 Bash: rm -rf build\nnext 5\n');
  expect(say("headless.stop", { ok: true })).toBe("ok\n");
});
test("--json prints a daemon reply as it came", async () => {
  const request = spyOn(rpc, "request").mockResolvedValue({ ok: true, pid: 42 });
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await run(["ping"]);
    await run(["ping", "--json"]);
    expect(output.mock.calls.map(call => String(call[0]))).toEqual(["running, pid 42\n", '{"ok":true,"pid":42}\n']);
  } finally {
    request.mockRestore();
    output.mockRestore();
  }
  expect(failure(["ping", "--json"], Error("ConnectionRefused"))).toBe('{"ok":false,"err":"ConnectionRefused"}\n');
  expect(failure(["ping"], Error("ConnectionRefused"))).toBe("corgi: ConnectionRefused\n");
});
test("usage errors show the command's help lines", () => {
  expect(failure(["open"], Error("Usage"))).toBe(
    "corgi: usage:\n  corgi open DIR                show DIR's workspace; add one if none\n",
  );
  expect(failure(["which", "gemini"], Error("Usage"))).toContain("corgi which claude|codex");
  expect(failure(["update", "status", "x"], Error("Usage"))).not.toContain("corgi update auto on|off");
  expect(failure(["update", "bogus"], Error("Usage"))).toContain("corgi update auto on|off");
  expect(failure(["action"], Error("Usage"))).toEndWith(actionNames + "\n");
  expect(failure(["ping", "x"], Error("Usage"))).toBe("corgi: usage: see corgi --help\n");
  expect(failure(["shutdwon"], Error("UnknownCommand"))).toBe("corgi: unknown command shutdwon; see corgi --help\n");
  expect(failure(["open"], Error("NotDir"))).toBe("corgi: NotDir\n");
});
test("every source file is in the test root", () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dir, "../tsconfig.json"), "utf8"));
  expect(config.include).toContain("src/**/*.ts");
  const parser = new Bun.Transpiler({ loader: "ts" });
  const cwd = process.cwd();
  try {
    for (const file of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
      if (file.endsWith(".d.ts")) continue;
      const path = resolve(import.meta.dir, file);
      // The transpiler finds a file's macros from the working directory.
      process.chdir(dirname(path));
      expect(() => parser.transformSync(readFileSync(path, "utf8"))).not.toThrow();
    }
  } finally {
    process.chdir(cwd);
  }
});
test("the daemon and the viewer never import each other", () => {
  // Files that run only in `corgi attach`.
  const viewer = new Set(
    [
      "agent_drag",
      "agent_launcher",
      "agent_navigation",
      "bindings",
      "client",
      "commands",
      "controller",
      "corgi_animation",
      "corgi_badge",
      "corgi_frames",
      "corgi_setup",
      "fork_hero",
      "frame_diff",
      "ghostty_integration",
      "host_clipboard",
      "inline_rename",
      "keymap",
      "launch_preview_stream",
      "launcher_resume",
      "launcher_usage",
      "review/panel",
      "link_tooltip",
      "mirror",
      "name_dialog",
      "navigation",
      "new_workspace",
      "onboarding",
      "paste_card",
      "preferences",
      "render",
      "resource_tooltip",
      "shortcut_help",
      "sidebar",
      "sidebar_rows",
      "sound",
      "subagent_tooltip",
      "terminal_info",
      "url_opener",
      "viewer",
      "viewer_test",
      "workspace_drag",
    ].map(name => name + ".ts"),
  );
  // Files that own daemon state, the daemon's workers and updater.
  const core = new Set(
    [
      "activity/worker",
      "import/onboarding",
      "peer",
      "persist/checkpoint",
      "persist/handoff",
      "persist/migrations",
      "persist/recovery",
      "runtime",
      "server",
      "session",
      "updates",
      "viewer_protocol",
      "observer_service",
      "launch_service",
      "inference_service",
      "import_service",
    ].map(name => name + ".ts"),
  );
  const parser = new Bun.Transpiler({ loader: "ts" }),
    crossed: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
    if (file === "main.ts" || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
    for (const imported of parser.scanImports(readFileSync(resolve(import.meta.dir, file), "utf8"))) {
      if (!imported.path.startsWith(".")) continue;
      const target =
        relative(import.meta.dir, resolve(dirname(resolve(import.meta.dir, file)), imported.path)).replace(
          /\.ts$/,
          "",
        ) + ".ts";
      if ((core.has(file) && viewer.has(target)) || (viewer.has(file) && core.has(target)) || target === "main.ts")
        crossed.push(`${file} -> ${target}`);
    }
  }
  expect(crossed).toEqual([]);
});

test("headless CLI passes provider IDs intact and includes the first prompt", async () => {
  const request = spyOn(rpc, "request").mockResolvedValue({ ok: true, provider: "codex", session: "thread-abc" });
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await run(["headless", "start", "codex", "hello", "--workspace", "7"]);
    await run(["headless", "send", "codex", "thread-abc", '{"kind":"prompt","text":"again"}']);
    await run(["headless", "stop", "claude", "12345678901234567890"]);
    const calls = request.mock.calls.map(call => call.slice(1));
    expect(calls).toContainEqual([
      "headless.start",
      { provider: "codex", prompt: "hello", cwd: process.cwd(), workspace: 7 },
    ]);
    expect(calls).toContainEqual([
      "headless.send",
      { provider: "codex", session: "thread-abc", input: { kind: "prompt", text: "again" } },
    ]);
    expect(calls).toContainEqual(["headless.stop", { provider: "claude", session: "12345678901234567890" }]);
    expect(output.mock.calls[0][0]).toBe("headless session thread-abc (codex)\n");
    await expect(run(["headless", "start", "codex"])).rejects.toThrow("Usage");
    await expect(run(["headless", "stop", "1"])).rejects.toThrow("Usage");
  } finally {
    request.mockRestore();
    output.mockRestore();
  }
});
