import { test, expect, spyOn } from "bun:test";
import { actionNames, failure, providerAlias, paneId, run } from "./main";
import { specs } from "./action";
import * as rpc from "./rpc";
import { readFileSync, existsSync, realpathSync } from "node:fs";
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
  try {
    for (const args of [["shutdown", "--help"], ["reload", "-h"], ["-h"], ["agent", "--help"]]) {
      output.mockClear();
      await run(args);
      expect(String(output.mock.calls[0]?.[0])).toContain("corgi shutdown");
    }
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
    output.mockRestore();
  }
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
  for (const file of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
    if (file.endsWith(".d.ts")) continue;
    expect(() => parser.transformSync(readFileSync(resolve(import.meta.dir, file), "utf8"))).not.toThrow();
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
      "fork_motion",
      "frame_diff",
      "ghostty_integration",
      "host_clipboard",
      "host_probe",
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
