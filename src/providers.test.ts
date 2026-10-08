import { test, expect } from "bun:test";
import { Provider, Backend, Each } from "./providers";
import { Model } from "./providers/model";
import { Claude } from "./providers/claude";
import { Codex } from "./providers/codex";
import { Hooks, timestampMs } from "./providers/common";
test("per-provider values are keyed by name and a missing provider takes the default", () => {
  const f = new Each(false, { claude: true });
  expect(JSON.stringify(f)).toBe('{"codex":false,"claude":true}');
  expect(f.get("codex")).toBe(false);
  expect(() => new Each(false, { other: true } as any)).toThrow("UnknownField");
});
test("native adapters keep provider envelopes separate and identify concrete conversations", () => {
  const v = {
    method: "turn/completed",
    params: { threadId: "a", turn: { id: "t", status: "interrupted" } },
  };
  expect(Backend.init("codex").nativeEvent(v)).toMatchObject({
    session: "a",
    turn: "t",
    phase: "completed",
    outcome: "interrupted",
  });
  expect(Backend.init("claude").nativeEvent(v).phase).toBe("none");
});
test("native request matching preserves string and integer identifiers", () => {
  expect(Backend.init("codex").nativeEvent({ id: 42, method: "future/method" }).request_id).toBe(42);
  expect(
    Backend.init("claude").responseId({
      type: "control_response",
      response: { request_id: "a" },
    }),
  ).toBe("a");
  expect(Backend.init("codex").responseId({ type: "control_response" })).toBeNull();
});
test("resume plans are typed argv and reject invalid or unsupported session references", () => {
  expect(Provider.info("claude").resumeArgs({ id: "id'with quote" })).toEqual(["claude", "--resume", "id'with quote"]);
  expect(() => Provider.info("claude").resumeArgs({ path: "/tmp/s" })).toThrow("InvalidSessionRef");
  expect(() => Provider.info("codex").resumeArgs({ id: "a\nb" })).toThrow("InvalidSessionRef");
});
test("shared hook codec preserves permission context and rejects child observations", () => {
  for (const provider of Provider.all) {
    const backend = Backend.init(provider);
    const hook = backend.hook({
      hook_event_name: "PreToolUse",
      session_id: "a",
      tool_name: "AskUserQuestion",
      tool_input: { description: "Pick a branch" },
    })!;
    expect(hook.asking).toBe(true);
    expect(hook.description).toBe("Pick a branch");
    expect(
      backend.hook({
        hook_event_name: "Stop",
        session_id: "a",
        agent_id: "child",
      }),
    ).toBeNull();
    expect(backend.hook(null)).toBeNull();
  }
  expect(
    new Hooks().decode({
      hook_event_name: "PreToolUse",
      session_id: "a",
      tool_name: "AskUserQuestion",
      tool_input: { description: "Pick" },
    }),
  ).toMatchObject({ asking: true, description: "Pick" });
  expect(new Hooks().decode({ hook_event_name: "Stop", agent_id: "child" })).toBeNull();
  expect(
    new Hooks().decode({
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
    }),
  ).toBeNull();
});
test("background Agent and Monitor calls name the jobs they launched", () => {
  expect(
    new Hooks().decode({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore" },
      tool_response: { status: "async_launched", agentId: "a1" },
    }),
  ).toMatchObject({ subagent: "a1", subagent_type: "Explore" });
});
test("UTC timestamps and plan labels", () => {
  expect(timestampMs("1970-01-01T00:00:00.000Z")).toBe(0);
  expect(timestampMs("2026-09-24T10:00:00.123Z")).toBe(1790244000123);
  expect(timestampMs("2026-09-24T10:00:00+02:00")).toBeNull();
  expect(Codex.plan("prolite").text()).toBe("Pro 100");
  expect(Claude.plan("claude_max", "default_claude_max_20x").text()).toBe("Max 20x");
});
test("transcript ownership and task notices", () => {
  expect(Claude.Line.decode({ isSidechain: true })).toBeNull();
  expect(Claude.Line.of({ isSidechain: true, agentId: "a1", sessionId: "s" }, "a1")).not.toBeNull();
  expect(
    Claude.TaskNotice.decode(
      "<task-notification><task-id>x</task-id><summary>abc</summary><event><status>killed</status></event>",
    ),
  ).toEqual({ id: "x", status: null });
});
test("models canonicalize Bedrock, Vertex, aliases, and native million windows", () => {
  for (const [id, canonical, label, window] of [
    ["claude-opus-5-5", "claude-opus-5-5", "Opus 5.5", 1000000n],
    ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5-20251001", "Haiku 4.5", 200000n],
    ["claude-3-5-sonnet-v2@20241022", "claude-3-5-sonnet-20241022", "Sonnet 3.5", 200000n],
    ["sonnet[1m]", "sonnet[1m]", "Sonnet (1M context)", 0n],
    ["gpt-6.1-sol", "gpt-6.1-sol", "GPT-6.1 Sol", 0n],
  ] as const) {
    const m = Model.resolve(id);
    expect(m.id.text()).toBe(canonical);
    expect(m.label()).toBe(label);
    expect(m.window).toBe(window);
  }
});

test("a background Agent call names the subagent it launched", () => {
  const backend = Backend.init("claude");
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
