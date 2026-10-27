import { test, expect } from "bun:test";
import { Omp, summaryArgs } from "./headless";
import { Pi } from "../pi/headless";
import type { Stdio } from "../stdio";
function client(ready = true) {
  const lines: unknown[] = [],
    written: unknown[] = [];
  const io = {
    exited: false,
    pid: -1,
    read: () => lines.splice(0),
    write: (v: unknown) => written.push(v),
    save: () => ({ state: {}, handles: [] }),
  } as unknown as Stdio;
  const c = new Omp(io, "/tmp");
  if (ready) {
    lines.push(
      { type: "ready", protocolVersion: 1 },
      { type: "response", id: "corgi-state", command: "get_state", success: true, data: { sessionId: "s" } },
    );
    c.take();
  }
  return { c, lines, written, io };
}
test("omp's run ends when the session settles, not when one agent loop yields", () => {
  const { c, lines } = client();
  lines.push(
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: "queued next" } },
    { type: "agent_end", messages: [], willContinue: true },
    { type: "agent_start" },
  );
  expect(c.take().filter(e => e.kind === "turn")).toHaveLength(1);
  const turn = c.turn;
  lines.push(
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
        usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7 },
      },
    },
    { type: "agent_end", messages: [] },
    { type: "prompt_result", id: "corgi-prompt-1", agentInvoked: true, status: "completed", sessionSettled: true },
  );
  const events = c.take();
  expect(events).toContainEqual({ kind: "message", session: "s", text: "done" });
  expect(events.some(e => e.kind === "turn")).toBe(false);
  lines.push({ type: "session_settled" }, { type: "session_settled" });
  expect(c.take()).toEqual([{ kind: "turn", session: "s", turn, phase: "ended", outcome: "completed" }]);
});
test("omp withdraws queued prompts as it interrupts", () => {
  const { c, lines, written } = client();
  lines.push({ type: "agent_start" });
  c.take();
  c.send({ kind: "interrupt", session: "s" });
  expect(written.map((v: any) => v.type)).toEqual(["abort_and_restore_queue"]);
  lines.push(
    { type: "response", id: (written[0] as any).id, command: "abort_and_restore_queue", success: true, data: {} },
    { type: "message_end", message: { role: "assistant", stopReason: "aborted" } },
    { type: "agent_end", messages: [] },
    { type: "session_settled" },
  );
  expect(c.take()).toContainEqual(expect.objectContaining({ kind: "turn", phase: "ended", outcome: "interrupted" }));
});
test("omp ends a prompt that never reached the model", () => {
  const { c, lines } = client();
  c.send({ kind: "prompt", text: "/help" });
  lines.push({
    type: "response",
    id: "corgi-prompt-1",
    command: "prompt",
    success: true,
    data: { agentInvoked: false },
  });
  expect(c.take()).toEqual([{ kind: "turn", session: "s", turn: "", phase: "ended", outcome: "completed" }]);
  c.send({ kind: "prompt", text: "hello" });
  lines.push(
    { type: "response", id: "corgi-prompt-2", command: "prompt", success: true },
    { type: "prompt_result", id: "corgi-prompt-2", agentInvoked: false, status: "error", sessionSettled: true },
  );
  expect(c.take()).toEqual([{ kind: "turn", session: "s", turn: "", phase: "ended", outcome: "failed" }]);
});
test("omp keeps its kind across a handoff", () => {
  const { c } = client();
  expect(Omp.restore(c.save(false), false)).toBeInstanceOf(Omp);
});
test("omp's summaries use only flags omp knows", () => {
  const args = summaryArgs({ instructions: "Summarize", model: "openai-codex/gpt-6-luna", schema: null });
  expect(args).not.toContain("--no-context-files");
  expect(args).not.toContain("--no-approve");
  expect(args.slice(-2)).toEqual(["--model", "openai-codex/gpt-6-luna"]);
});

function streaming(id: string, intent: unknown, content = "") {
  return {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "write", arguments: { i: intent, path: "file", content } }],
    },
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: content },
  };
}

test("OMP publishes native write intent while arguments stream and amends only the same tool", () => {
  const { c, lines } = client();
  lines.push({ type: "agent_start" }, streaming("write-1", "Writing"));
  const started = c.take(),
    turn = c.turn;
  expect(started).toContainEqual({
    kind: "activity",
    session: "s",
    turn,
    text: "Writing",
    amend: false,
  });
  expect(started.some(e => e.kind === "tool")).toBe(false);
  lines.push(
    streaming("write-1", "Writing native labels."),
    streaming("write-1", "Writing native labels.", "long file payload"),
    {
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "file", content: "long file payload" },
      intent: "Writing native labels",
    },
  );
  const executing = c.take();
  expect(executing.filter(e => e.kind === "activity")).toEqual([
    { kind: "activity", session: "s", turn, text: "Writing native labels", amend: true },
  ]);
  expect(executing).toContainEqual({ kind: "tool", session: "s", turn, id: "write-1", done: false, wrote: [] });
  lines.push(
    { type: "tool_execution_end", toolCallId: "write-1", isError: false },
    streaming("write-2", "Writing native labels"),
  );
  const next = c.take();
  expect(next).toContainEqual({
    kind: "tool",
    session: "s",
    turn,
    id: "write-1",
    done: true,
    wrote: ["/tmp/file"],
  });
  expect(next).toContainEqual({
    kind: "activity",
    session: "s",
    turn,
    text: "Writing native labels",
    amend: false,
  });
});

test("OMP accepts execution-provided intents and preserves native wording without inference rules", () => {
  const { c, lines } = client();
  lines.push(
    { type: "agent_start" },
    {
      type: "tool_execution_start",
      toolCallId: "native",
      toolName: "custom",
      args: {},
      intent: "  \x1b[31mInspecting\x1b[0m\nall\tseven words without any inference rewriting...  ",
    },
  );
  expect(c.take().filter(e => e.kind === "activity")).toEqual([
    {
      kind: "activity",
      session: "s",
      turn: c.turn,
      text: "Inspecting all seven words without any inference rewriting",
      amend: false,
    },
  ]);
  lines.push(streaming("wide", "界".repeat(100)));
  const activity = c.take().find(e => e.kind === "activity")!;
  expect(activity.kind === "activity" && activity.text).toBe("界".repeat(53));
});

test("OMP native activities require a ready session and active turn and reset after settlement", () => {
  const { c, lines } = client(false);
  lines.push(streaming("write", "Too early"));
  expect(c.take()).toEqual([]);
  lines.push(
    {
      type: "response",
      id: "corgi-state",
      command: "get_state",
      success: true,
      data: { sessionId: "s" },
    },
    streaming("write", "Still idle"),
  );
  expect(c.take().some(e => e.kind === "activity")).toBe(false);
  lines.push({ type: "agent_start" }, streaming("write", "Writing labels"));
  c.take();
  const previousTurn = c.turn;
  lines.push({ type: "session_settled" }, streaming("write", "Late activity"));
  expect(c.take()).toEqual([
    {
      kind: "turn",
      session: "s",
      turn: previousTurn,
      phase: "ended",
      outcome: "completed",
    },
  ]);
  lines.push({ type: "agent_start" }, streaming("write", "Writing labels"));
  const events = c.take();
  expect(c.turn).not.toBe(previousTurn);
  expect(events).toContainEqual({
    kind: "activity",
    session: "s",
    turn: c.turn,
    text: "Writing labels",
    amend: false,
  });
});

test("OMP selects the last native tool intent and ignores non-native prose and invalid labels", () => {
  const { c, lines } = client();
  lines.push(
    { type: "agent_start" },
    {
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "first", arguments: { i: "Reading earlier data" } },
          { type: "toolCall", id: "last", intent: "Reading latest data", arguments: {} },
          { type: "text", text: "Do not use assistant commentary as activity" },
          { type: "toolCall", id: "empty", arguments: { i: 42 } },
        ],
      },
    },
    streaming("invalid", false),
    streaming("blank", "...\n\t"),
    {
      type: "message_update",
      message: {
        role: "user",
        content: [{ type: "toolCall", id: "user", arguments: { i: "Not an assistant intent" } }],
      },
    },
  );
  expect(c.take().filter(e => e.kind === "activity")).toEqual([
    {
      kind: "activity",
      session: "s",
      turn: c.turn,
      text: "Reading latest data",
      amend: false,
    },
  ]);
});

test("Pi continues to ignore OMP-native intent fields", () => {
  const { io } = client(),
    pi = new Pi(io, "/tmp");
  pi.decode({ type: "response", id: "corgi-state", success: true, data: { sessionId: "pi" } });
  pi.decode({ type: "agent_start" });
  pi.decode(streaming("write", "OMP intent"));
  pi.decode({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: {}, intent: "OMP intent" });
  expect(pi.take().some(e => e.kind === "activity")).toBe(false);
});

test("OMP execution without intent preserves the last semantic activity until a native intent arrives", () => {
  const { c, lines } = client();
  lines.push({ type: "agent_start" }, streaming("write", "Writing useful labels"));
  c.take();
  lines.push({
    type: "tool_execution_start",
    toolCallId: "write",
    toolName: "write",
    args: { path: "/repo/src/file.ts" },
  });
  expect(c.take().some(e => e.kind === "activity")).toBe(false);
  lines.push({
    type: "tool_execution_start",
    toolCallId: "read",
    toolName: "read",
    args: { path: "/repo/src/file.ts" },
  });
  expect(c.take().some(e => e.kind === "activity")).toBe(false);
  lines.push({
    type: "tool_execution_start",
    toolCallId: "read",
    toolName: "read",
    args: { path: "/repo/src/file.ts" },
    intent: "Reading native execution metadata",
  });
  expect(c.take().filter(e => e.kind === "activity")).toEqual([
    {
      kind: "activity",
      session: "s",
      turn: c.turn,
      text: "Reading native execution metadata",
      amend: false,
    },
  ]);
});

test("OMP execution without a prior intent emits tool lifecycle but no generic activity", () => {
  const { c, lines } = client();
  lines.push({ type: "agent_start" }, streaming("read", undefined), {
    type: "tool_execution_start",
    toolCallId: "read",
    toolName: "read",
    args: { path: "xd://lsp" },
  });
  const events = c.take();
  expect(events.filter(e => e.kind === "activity")).toEqual([]);
  expect(events).toContainEqual({ kind: "tool", session: "s", turn: c.turn, id: "read", done: false, wrote: [] });
  lines.push({
    type: "tool_execution_start",
    toolCallId: "native-read",
    toolName: "read",
    args: { path: "xd://lsp", i: "Reading code intelligence interface" },
  });
  expect(c.take().filter(e => e.kind === "activity")).toEqual([
    { kind: "activity", session: "s", turn: c.turn, text: "Reading code intelligence interface", amend: false },
  ]);
});
