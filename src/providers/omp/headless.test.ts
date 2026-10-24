import { test, expect } from "bun:test";
import { Omp, summaryArgs } from "./headless";
import type { Stdio } from "../stdio";
function client() {
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
  lines.push(
    { type: "ready", protocolVersion: 1 },
    { type: "response", id: "corgi-state", command: "get_state", success: true, data: { sessionId: "s" } },
  );
  c.take();
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
