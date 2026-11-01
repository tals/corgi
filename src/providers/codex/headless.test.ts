import { test, expect } from "bun:test";
import { Codex, bareCommand, sessionThread, tool } from "./headless";
import type { Stdio } from "../stdio";
/** A Codex client reading `lines` as its app server's output, recording what it writes. */
function client(lines: unknown[], summary = false, options: Codex["options"] = {}) {
  const written: unknown[] = [];
  const io = {
    exited: false,
    pid: -1,
    read: () => lines.splice(0),
    write: (value: unknown) => written.push(value),
    wait: async () => {},
    close() {},
    adopt() {},
    save: () => ({ state: {}, handles: [] }),
  } as unknown as Stdio;
  const codex = new Codex(io, "/repo", summary ? { instructions: "x", model: null, schema: null } : null, options);
  codex.ready = true;
  return { codex, written };
}
test("Codex turns name their thread, turn and outcome", () => {
  const { codex } = client([
    { method: "turn/started", params: { threadId: "a", turn: { id: "t" } } },
    { method: "turn/completed", params: { threadId: "a", turn: { id: "t", status: "interrupted" } } },
  ]);
  expect(codex.take()).toEqual([
    { kind: "turn", session: "a", turn: "t", phase: "started" },
    { kind: "turn", session: "a", turn: "t", phase: "ended", outcome: "interrupted" },
  ]);
  expect(codex.active.size).toBe(0);
});
test("Codex requests keep their ID for the answer", () => {
  const { codex, written } = client([
    { id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "a", command: "ls" } },
    { id: 43, method: "future/method", params: { threadId: "a" } },
  ]);
  expect(codex.take()).toEqual([
    {
      kind: "request",
      session: "a",
      id: "42",
      ask: { tool: true, name: "item/commandExecution/requestApproval", summary: "ls" },
    },
    { kind: "request", session: "a", id: "43", ask: { tool: false, name: "future/method", summary: "" } },
  ]);
  codex.send({ kind: "answer", request: "42", allow: true });
  codex.send({ kind: "answer", request: "43", allow: false, message: "no" });
  expect(written).toEqual([
    { id: 42, result: { decision: "accept" } },
    { id: 43, error: { code: -32000, message: "no" } },
  ]);
  expect(() => codex.send({ kind: "answer", request: "42", allow: true })).toThrow("NoRequest");
});
test("Codex children, tools, writes, answers and usage come through as events", () => {
  const { codex } = client([
    { method: "thread/started", params: { thread: { id: "child", parentThreadId: "parent", agentRole: "Explorer" } } },
    { method: "item/started", params: { threadId: "child", turnId: "t", item: { id: "c", type: "commandExecution" } } },
    {
      method: "item/completed",
      params: {
        threadId: "child",
        turnId: "t",
        item: { id: "f", type: "fileChange", status: "completed", changes: [{ path: "a.ts" }] },
      },
    },
    {
      method: "item/completed",
      params: { threadId: "child", turnId: "t", item: { id: "m", type: "agentMessage", text: "done" } },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "child",
        turnId: "t",
        tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 }, last: null },
      },
    },
  ]);
  const events = codex.take();
  expect(events[0]).toEqual({
    kind: "conversation",
    session: "child",
    parent: "parent",
    role: "Explorer",
    shown: false,
  });
  expect(events[1]).toEqual({
    kind: "tool",
    session: "child",
    turn: "t",
    id: "c",
    done: false,
    wrote: [],
    name: "Run",
    summary: "",
  });
  expect(events[2]).toEqual({
    kind: "tool",
    session: "child",
    turn: "t",
    id: "f",
    done: true,
    wrote: ["/repo/a.ts"],
    name: "Edit",
    summary: "a.ts",
  });
  expect(events[4]).toEqual({ kind: "message", session: "child", text: "done" });
  expect(events[5]).toMatchObject({ kind: "usage", session: "child", turn: "t", total: { last: null } });
  expect((events[5] as any).total.total).toMatchObject({ input: 10n, cached_input: 5n, output: 2n });
});
test("a summary hears only its own thread", () => {
  const { codex } = client(
    [
      { method: "item/completed", params: { threadId: "other", item: { type: "agentMessage", text: "stale" } } },
      { method: "item/completed", params: { threadId: "mine", item: { type: "agentMessage", text: "fresh" } } },
    ],
    true,
  );
  codex.thread = "mine";
  expect(codex.take().filter(e => e.kind === "message")).toEqual([{ kind: "message", session: "mine", text: "fresh" }]);
});
test("a prompt starts a thread in the session's folder, then its turn", () => {
  const lines: unknown[] = [];
  const { codex, written } = client(lines);
  codex.send({ kind: "prompt", text: "hi" });
  expect(written).toEqual([{ id: 1n, method: "thread/start", params: { cwd: "/repo" } }]);
  lines.push({ id: 1, result: { thread: { id: "t" } } });
  expect(codex.take()).toEqual([{ kind: "conversation", session: "t", parent: null, role: null, shown: true }]);
  expect(written[1]).toEqual({
    id: 2n,
    method: "turn/start",
    params: { threadId: "t", input: [{ type: "text", text: "hi" }] },
  });
});
test("a prompt during a turn steers it, once the turn has an ID, and a refused one starts the next", () => {
  const lines: unknown[] = [];
  const { codex, written } = client(lines);
  codex.thread = "a";
  codex.send({ kind: "prompt", text: "first" });
  // Sent before turn/start names the turn: it waits for the ID.
  codex.send({ kind: "prompt", text: "also" });
  expect(written.map((w: any) => w.method)).toEqual(["turn/start"]);
  lines.push(
    { id: 1, result: { turn: { id: "t1" } } },
    { method: "turn/started", params: { threadId: "a", turn: { id: "t1" } } },
  );
  codex.take();
  codex.send({ kind: "prompt", text: "more" });
  expect(written.slice(1)).toEqual([
    {
      id: 2n,
      method: "turn/steer",
      params: { threadId: "a", input: [{ type: "text", text: "also" }], expectedTurnId: "t1" },
    },
    {
      id: 3n,
      method: "turn/steer",
      params: { threadId: "a", input: [{ type: "text", text: "more" }], expectedTurnId: "t1" },
    },
  ]);
  // A turn that won't be steered takes it as the next turn once it ends.
  lines.push({ id: 3, error: { code: -32600, message: "not steerable" } });
  codex.take();
  expect(written).toHaveLength(3);
  lines.push({ method: "turn/completed", params: { threadId: "a", turn: { id: "t1", status: "completed" } } });
  codex.take();
  expect(written[3]).toMatchObject({ method: "turn/start", params: { input: [{ type: "text", text: "more" }] } });
});
test("images go to Codex by path, on a new thread's first turn and on a steer", () => {
  const lines: unknown[] = [];
  const { codex, written } = client(lines);
  const image = { path: "/tmp/a.png", mime: "image/png" };
  codex.send({ kind: "prompt", text: "see", images: [image] });
  lines.push({ id: 1, result: { thread: { id: "t" } } });
  codex.take();
  expect((written[1] as any).params.input).toEqual([
    { type: "text", text: "see" },
    { type: "localImage", path: "/tmp/a.png" },
  ]);
  lines.push({ method: "turn/started", params: { threadId: "t", turn: { id: "t1" } } });
  codex.take();
  // An image alone goes without an empty text.
  codex.send({ kind: "prompt", text: "", images: [image] });
  expect((written[2] as any).method).toBe("turn/steer");
  expect((written[2] as any).params.input).toEqual([{ type: "localImage", path: "/tmp/a.png" }]);
});
test("a stop sent while the turn starts reaches it once it has an ID, and drops what waited", () => {
  const lines: unknown[] = [];
  const { codex, written } = client(lines);
  codex.thread = "a";
  codex.send({ kind: "prompt", text: "first" });
  codex.send({ kind: "prompt", text: "also" });
  codex.send({ kind: "interrupt" });
  lines.push({ method: "turn/started", params: { threadId: "a", turn: { id: "t1" } } });
  codex.take();
  expect(written.slice(1)).toEqual([{ id: 2n, method: "turn/interrupt", params: { threadId: "a", turnId: "t1" } }]);
});
test("a command approval asks with the command, out of the login shell it may come in", () => {
  expect(bareCommand("corgi memory search bun")).toBe("corgi memory search bun");
  expect(bareCommand(`/bin/zsh -lc 'corgi memory add --long "Prefers bun"'`)).toBe(
    'corgi memory add --long "Prefers bun"',
  );
  expect(bareCommand(`bash -c "corgi list"`)).toBe("corgi list");
  // Anything it can't read plainly stays wrapped, and so asks.
  expect(bareCommand(`zsh -lc "corgi list $(id)"`)).toBe(`zsh -lc "corgi list $(id)"`);
  const { codex } = client([
    {
      id: 5,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t", reason: "writes outside the workspace", command: "/bin/zsh -lc 'corgi memory add x'" },
    },
    { id: 6, method: "item/fileChange/requestApproval", params: { threadId: "t", reason: "edits a.ts" } },
  ]);
  expect(codex.take().map(e => (e.kind === "request" ? e.ask.summary : ""))).toEqual([
    "corgi memory add x",
    "edits a.ts",
  ]);
});
test("prompts wait for the handshake, which a handoff can carry over", () => {
  const lines: unknown[] = [];
  const { codex, written } = client(lines);
  codex.ready = false;
  codex.steps.set("7", { kind: "initialize" });
  codex.send({ kind: "prompt", text: "early", session: "t" });
  expect(written).toEqual([]);
  const restored = Codex.restore(
    JSON.parse(JSON.stringify(codex.save(true), (_, v) => (typeof v === "bigint" ? Number(v) : v))),
    true,
  );
  expect(restored.deferred).toEqual([{ kind: "prompt", text: "early", session: "t" }]);
  expect(restored.steps.get("7")).toEqual({ kind: "initialize" });
});
test("a session's thread starts with the model, effort and instructions it asks for", () => {
  expect(sessionThread("/repo", {})).toEqual({ cwd: "/repo" });
  expect(
    sessionThread("/repo", { model: "gpt-6", effort: "xhigh", instructions: "Be brief.", persist: false }),
  ).toEqual({
    cwd: "/repo",
    model: "gpt-6",
    config: { model_reasoning_effort: "xhigh" },
    developerInstructions: "Be brief.",
    ephemeral: true,
  });
  const { codex, written } = client([], false, { model: "gpt-6", persist: false });
  codex.send({ kind: "prompt", text: "hi" });
  expect(written).toEqual([
    { id: 1n, method: "thread/start", params: { cwd: "/repo", model: "gpt-6", ephemeral: true } },
  ]);
  const restored = Codex.restore(
    JSON.parse(JSON.stringify(codex.save(true), (_, v) => (typeof v === "bigint" ? Number(v) : v))),
    true,
  );
  expect(restored.options).toEqual({ model: "gpt-6", persist: false });
});
test("a checkpoint keeps no instructions, which the thread already has", () => {
  const { codex } = client([], false, { model: "gpt-6", instructions: "Remember corgis." });
  const saved = JSON.stringify(codex.save(true), (_, v) => (typeof v === "bigint" ? Number(v) : v));
  expect(saved).not.toContain("corgis");
  expect(Codex.restore(JSON.parse(saved), true).options).toEqual({ model: "gpt-6" });
});
test("Codex tools say what they are", () => {
  const run = (actions: unknown[]) =>
    tool({ type: "commandExecution", command: "/bin/zsh -lc 'x'", commandActions: actions });
  expect(run([{ type: "read", command: "cat a.ts", name: "a.ts", path: "/repo/a.ts" }])).toEqual({
    name: "Read",
    summary: "/repo/a.ts",
  });
  expect(run([{ type: "search", command: "rg foo", query: "foo", path: null }])).toEqual({
    name: "Search",
    summary: "foo",
  });
  expect(run([{ type: "unknown", command: "bun test" }])).toEqual({ name: "Run", summary: "bun test" });
  expect(
    run([
      { type: "unknown", command: "cd src" },
      { type: "listFiles", command: "ls", path: null },
    ]),
  ).toEqual({ name: "Run", summary: "cd src && ls" });
  expect(run([])).toEqual({ name: "Run", summary: "/bin/zsh -lc 'x'" });
  expect(tool({ type: "fileChange", changes: [{ path: "a.ts" }, { path: "b.ts" }] })).toEqual({
    name: "Edit",
    summary: "a.ts, b.ts",
  });
  expect(tool({ type: "mcpToolCall", server: "github", tool: "search_issues" })).toEqual({
    name: "search_issues",
    summary: "github",
  });
  expect(tool({ type: "webSearch", query: "bun ffi" })).toEqual({ name: "Search", summary: "bun ffi" });
});
const message = (id: string, phase: string | null) => ({ id, type: "agentMessage", text: "", phase });
const delta = (itemId: string, text: string) => ({
  method: "item/agentMessage/delta",
  params: { threadId: "a", turnId: "t", itemId, delta: text },
});
test("Codex streams its answer as it's written, then sends it whole", () => {
  const { codex } = client([
    { method: "item/started", params: { threadId: "a", turnId: "t", item: message("c", "commentary") } },
    delta("c", "Looking"),
    { method: "item/started", params: { threadId: "a", turnId: "t", item: message("m", null) } },
    delta("m", "Do"),
    delta("m", "ne"),
    {
      method: "item/completed",
      params: {
        threadId: "a",
        turnId: "t",
        item: { id: "m", type: "agentMessage", text: "Done", phase: "final_answer" },
      },
    },
  ]);
  expect(codex.take().filter(e => e.kind === "partial" || e.kind === "message")).toEqual([
    { kind: "partial", session: "a", text: "Do" },
    { kind: "partial", session: "a", text: "Done" },
    { kind: "message", session: "a", text: "Done" },
  ]);
  expect(codex.streaming.size).toBe(0);
});
test("a streamed answer that turns out to be commentary, or is cut off, still ends in a message", () => {
  const { codex } = client([
    { method: "item/started", params: { threadId: "a", turnId: "t", item: message("m", null) } },
    delta("m", "Let me look"),
    {
      method: "item/completed",
      params: {
        threadId: "a",
        turnId: "t",
        item: { id: "m", type: "agentMessage", text: "Let me look", phase: "commentary" },
      },
    },
    { method: "item/started", params: { threadId: "a", turnId: "t", item: message("n", null) } },
    delta("n", "Half"),
    { method: "turn/completed", params: { threadId: "a", turn: { id: "t", status: "interrupted" } } },
  ]);
  expect(codex.take().filter(e => e.kind === "partial" || e.kind === "message")).toEqual([
    { kind: "partial", session: "a", text: "Let me look" },
    { kind: "message", session: "a", text: "Let me look" },
    { kind: "partial", session: "a", text: "Half" },
    { kind: "message", session: "a", text: "Half" },
  ]);
});
test("a summary doesn't stream", () => {
  const { codex } = client(
    [
      { method: "item/started", params: { threadId: "mine", turnId: "t", item: message("m", null) } },
      { ...delta("m", "x"), params: { ...delta("m", "x").params, threadId: "mine" } },
    ],
    true,
  );
  codex.thread = "mine";
  expect(codex.take().some(e => e.kind === "partial")).toBe(false);
});
