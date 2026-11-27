import { test, expect } from "bun:test";
import { Provider, byProvider, adapter } from "./providers";
import * as claude from "./providers/claude";
import * as codex from "./providers/codex";
import * as claudeHeadless from "./providers/claude/headless";
import * as sim from "./providers/sim";
import type { Settings } from "./providers/adapter";
test("per-provider values are keyed by name, in the registry's order", () => {
  const value = byProvider(p => p === "claude");
  expect(Object.keys(value)).toEqual(Provider.all);
  expect(Object.entries(value).filter(([, on]) => on)).toEqual([["claude", true]]);
  expect(Provider.all.slice(0, 3)).toEqual(["codex", "claude", "pi"]);
  expect(Provider.parse("claude")).toBe("claude");
  expect(Provider.parse("other")).toBeNull();
  expect(Provider.owning("/opt/bin/claude-code")).toBe("claude");
});
test("the landing page's stand-in registry lists every provider", async () => {
  const site = await import("../site/browser/providers");
  expect(site.Provider.all).toEqual(Provider.all);
  // Each provider's own command is among the programs that mark it.
  for (const p of Provider.all) expect(site.adapter(p).programs.names).toContain(adapter(p).command);
});
test("every provider id is one corgi-hook forwards", () => {
  for (const p of Provider.all) expect(Provider.wellFormed(p)).toBe(true);
  for (const id of ["", "Claude", "gemini_cli", "open-code", "a".repeat(33)])
    expect(Provider.wellFormed(id)).toBe(false);
  expect(() => Provider.register({ ...sim.adapter, id: "Sim" })).toThrow("InvalidProvider");
});
test.each(Provider.all)("the %s adapter can initialize before the registry", async provider => {
  const module = new URL(`./providers/${provider}/index.ts`, import.meta.url).href;
  const registry = new URL("./providers.ts", import.meta.url).href;
  // Separate processes and sequential imports exercise initialization order; static imports cannot isolate it.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const direct = await import(${JSON.stringify(module)});
const registry = await import(${JSON.stringify(registry)});
if (direct.adapter !== registry.adapter(${JSON.stringify(provider)})) throw Error("WrongAdapter");
if (registry.Provider.owning(direct.adapter.command) !== ${JSON.stringify(provider)}) throw Error("WrongOwner");`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  expect(await child.exited, await stderr).toBe(0);
});
test("a registered provider is listed, parsed and found until it is removed", () => {
  const builtIn = [...Provider.all];
  const remove = sim.register();
  try {
    expect<string[]>(Provider.all).toEqual([...builtIn, "sim"]);
    expect(Provider.parse("sim")).toBe(sim.sim);
    expect(Provider.owning("sim")).toBe(sim.sim);
    expect(adapter(sim.sim).name).toBe("Sim");
    expect(adapter(sim.sim)).toBe(sim.adapter);
    expect(Object.keys(byProvider(p => p))).toEqual([...builtIn, "sim"]);
    expect(() => sim.register()).toThrow("ProviderExists");
  } finally {
    remove();
  }
  expect(Provider.all).toEqual(builtIn);
  expect(Provider.parse("sim")).toBeNull();
  expect(() => adapter(sim.sim)).toThrow("UnknownProvider");
});
test("each provider resumes and forks a session with its own arguments", () => {
  expect(claude.adapter.launch.resume("id'with quote")).toEqual(["--resume", "id'with quote"]);
  expect(codex.adapter.launch.resume("id")).toEqual(["resume", "id"]);
  const old = "01901234-1234-1234-1234-123456789abc",
    from = { session: old, transcript: "", cwd: "/tmp/worktree" },
    fork = claude.adapter.launch.fork?.(from, "Name"),
    id = fork?.session ?? "";
  expect(fork?.args).toEqual(["--resume", old, "--fork-session", "--session-id", id, "--name", "Name"]);
  expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  expect(claude.adapter.launch.fork?.(from, null)?.args).not.toContain("--name");
  expect(codex.adapter.launch.fork?.(from, "Name")).toEqual({
    args: ["fork", old, "--cd", from.cwd],
    session: null,
    named: false,
  });
});
test("a conversation can be forked once it has a session and, for Claude, a transcript", () => {
  for (const p of [claude.adapter, codex.adapter])
    expect(p.launch.fork?.({ session: "short", transcript: "", cwd: "/tmp" }, null)).toBeNull();
  const session = "01901234-1234-1234-1234-123456789abc";
  expect(
    claude.adapter.launch.fork?.({ session, transcript: "/nonexistent/transcript.jsonl", cwd: "/tmp" }, null),
  ).toBeNull();
  expect(claude.adapter.launch.fork?.({ session, transcript: import.meta.path, cwd: "/tmp" }, null)).not.toBeNull();
});
test("a bypassing launch skips each provider's permission checks", () => {
  const bypass: Settings = { permissions: "bypass", model: null, args: [] };
  expect(claude.adapter.launch.start(bypass)).toEqual(["--dangerously-skip-permissions"]);
  expect(codex.adapter.launch.start(bypass)).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  for (const p of Provider.all)
    expect(adapter(p).launch.start({ permissions: "default", model: null, args: [] })).toEqual([]);
  // Codex reports a sandboxed run that never asks as bypassing too.
  expect(codex.adapter.launch.start({ ...bypass, args: ["-a", "never", "-s", "read-only"] })).toEqual([
    "-a",
    "never",
    "-s",
    "read-only",
  ]);
  expect(claude.adapter.launch.start({ permissions: "default", model: "opus", args: ["--verbose"] })).toEqual([
    "--model",
    "opus",
    "--verbose",
  ]);
});
test("a typed command keeps its account and options, not its session, prompt, model or permissions", () => {
  const line = (args: string[], env: [string, string][] = []) => ({ env, args, flagged: false, cwd: "/" });
  expect(
    claude.adapter.launch.keep!(
      line(
        [
          "claude",
          "--dangerously-skip-permissions",
          "--model",
          "opus",
          "--mcp-config",
          "a.json",
          "--verbose",
          "--resume",
          "s1",
          "Fix the tabs",
        ],
        [
          ["CLAUDE_CONFIG_DIR", "/work/.claude"],
          ["ANTHROPIC_MODEL", "sonnet"],
          ["CLAUDE_CODE_ENTRYPOINT", "cli"],
          ["EDITOR", "vim"],
        ],
      ),
    ),
  ).toEqual({ args: ["--mcp-config", "a.json", "--verbose"], env: [["CLAUDE_CONFIG_DIR", "/work/.claude"]] });
  expect(
    codex.adapter.launch.keep!(
      line(
        ["codex", "--yolo", "-m", "gpt", "-c", "features.x=true", "--search", "resume", "t1"],
        [["OPENAI_API_KEY", "k"]],
      ),
    ),
  ).toEqual({ args: ["-c", "features.x=true", "--search"], env: [["OPENAI_API_KEY", "k"]] });
});
test("inference asks Claude for the request's prompt, model and schema on its command line", () => {
  const asked = claudeHeadless.summaryArgs({ instructions: "Sum up", model: "m", schema: "{}" });
  expect(asked.slice(-6)).toEqual(["--system-prompt", "Sum up", "--model", "m", "--json-schema", "{}"]);
  expect(claudeHeadless.summaryArgs({ instructions: "x", model: null, schema: null })).not.toContain("--model");
});
test("shared hook codec preserves permission context and rejects child observations", () => {
  for (const provider of ["codex", "claude"] as const) {
    const backend = adapter(provider);
    const hook = backend.hook({
      hook_event_name: "PreToolUse",
      session_id: "a",
      tool_name: "AskUserQuestion",
      tool_input: { description: "Pick a branch" },
    })!;
    expect(hook.asking).toBe(true);
    expect(hook.description).toBe("Pick a branch");
    expect(hook.permissions).toBeNull();
    for (const [mode, permissions] of [
      ["bypassPermissions", "bypass"],
      ["acceptEdits", "default"],
    ])
      expect(
        backend.hook({ hook_event_name: "Stop", session_id: "a", permission_mode: mode, model: "m" }),
      ).toMatchObject({ permissions, model: "m" });
    expect(
      backend.hook({
        hook_event_name: "Stop",
        session_id: "a",
        agent_id: "child",
      }),
    ).toBeNull();
    expect(backend.hook(null)).toBeNull();
  }
});
test("a background Agent call names the subagent it launched", () => {
  const backend = claude.adapter;
  const launched = backend.hook({
    hook_event_name: "PostToolUse",
    session_id: "a",
    tool_name: "Agent",
    tool_input: {
      description: "Lane A",
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    tool_response: {
      isAsync: true,
      status: "async_launched",
      agentId: "a1",
      description: "Lane A",
    },
  })!;
  expect(launched.subagent).toBe("a1");
  expect(launched.subagent_type).toBe("general-purpose");
  expect(launched.description).toBe("Lane A");
  const finished = backend.hook({
    hook_event_name: "PostToolUse",
    session_id: "a",
    tool_name: "Agent",
    tool_input: { description: "Lane B", subagent_type: "Explore" },
    tool_response: { status: "completed", agentId: "a2" },
  })!;
  expect(finished.subagent).toBe("");
});
