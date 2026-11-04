import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pi, sessionArgs, summaryArgs, toolName } from "./headless";
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
  const c = new Pi(io, "/tmp");
  lines.push({ type: "response", id: "corgi-state", success: true, data: { sessionId: "s" } });
  c.take();
  return { c, lines, written, io };
}
test("Pi waits through retries and queued runs until settlement", () => {
  const { c, lines } = client();
  lines.push(
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error" } },
    { type: "agent_end", willRetry: true },
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
    { type: "agent_end" },
  );
  const events = c.take();
  expect(events).toContainEqual({ kind: "message", session: "s", text: "done" });
  expect(events.find(e => e.kind === "usage")).toMatchObject({
    part: { tokens: { input: 14n, cached_input: 5n, output: 3n } },
  });
  expect(events.some(e => e.kind === "turn")).toBe(false);
  lines.push({ type: "agent_settled" }, { type: "agent_settled" });
  expect(c.take()).toEqual([{ kind: "turn", session: "s", turn, phase: "ended", outcome: "completed" }]);
});
test("Pi stops queued work and reports interruptions on 1.0 and later", () => {
  for (const settled of [{ type: "agent_settled" }, { type: "agent_settled", aborted: true }]) {
    const { c, lines, written } = client();
    lines.push({ type: "agent_start" });
    c.take();
    c.send({ kind: "interrupt", session: "s" });
    expect(written.map((v: any) => v.type)).toEqual(["clear_queue"]);
    lines.push({ type: "response", id: (written[0] as any).id, success: true });
    c.take();
    expect(written.map((v: any) => v.type)).toEqual(["clear_queue", "abort"]);
    lines.push(settled);
    expect(c.take()[0]).toMatchObject({ outcome: "interrupted" });
  }
});
test("Pi's error and truncated final answers fail at settlement", () => {
  for (const stopReason of ["error", "length", "aborted"]) {
    const { c, lines } = client();
    lines.push(
      { type: "agent_start" },
      { type: "message_end", message: { role: "assistant", stopReason } },
      { type: "agent_settled" },
    );
    expect(c.take().at(-1)).toMatchObject({ outcome: stopReason === "aborted" ? "interrupted" : "failed" });
  }
});
test("Pi dialogs validate answers and ignore notifications", () => {
  const { c, lines, written } = client();
  lines.push(
    { type: "extension_ui_request", id: "a", method: "notify" },
    { type: "extension_ui_request", id: "b", method: "confirm", title: "Continue?" },
    { type: "extension_ui_request", id: "c", method: "select", options: ["one", "two"] },
  );
  expect(c.take().map(e => e.kind)).toEqual(["request", "request"]);
  c.send({ kind: "answer", request: "b", allow: false });
  expect(written[0]).toEqual({ type: "extension_ui_response", id: "b", confirmed: false });
  expect(() => c.send({ kind: "answer", request: "c", allow: true })).toThrow("AnswerRequired");
  expect(() => c.send({ kind: "answer", request: "c", allow: true, message: "wrong" })).toThrow("InvalidAnswer");
  c.send({ kind: "answer", request: "c", allow: true, message: "two" });
  expect(written[1]).toEqual({ type: "extension_ui_response", id: "c", value: "two" });
  expect(() => c.send({ kind: "answer", request: "c", allow: true, message: "two" })).toThrow("NoRequest");
});
test("Pi rejects wrong sessions and RPC failures", () => {
  const { c, lines } = client();
  expect(() => c.send({ kind: "prompt", session: "other", text: "x" })).toThrow("WrongSession");
  lines.push({ type: "response", success: false, error: "no model" });
  expect(() => c.take()).toThrow("PiRejected");
});
test("Pi tool writes survive a handoff state and failed writes stay unreported", () => {
  const { c, lines } = client();
  lines.push(
    { type: "agent_start" },
    { type: "tool_execution_start", toolCallId: "w", toolName: "write", args: { path: "out" } },
  );
  c.take();
  const restored = Pi.restore(c.save(false), false);
  expect(restored.writes.get("w")).toEqual(["/tmp/out"]);
  lines.push({ type: "tool_execution_end", toolCallId: "w", isError: true });
  expect(c.take()[0]).toMatchObject({ wrote: [] });
});
test("Pi summaries disable discovered code, context and tools", () => {
  const args = summaryArgs({ instructions: "hello", model: "openai-codex/gpt-6-luna", schema: '{"type":"object"}' });
  for (const flag of [
    "--no-session",
    "--no-extensions",
    "--no-tools",
    "--no-context-files",
    "--no-skills",
    "--no-approve",
  ])
    expect(args).toContain(flag);
});
test("a prompt steers a run under way, and carries its images inline", () => {
  const { c, written } = client(),
    image = join(mkdtempSync(join(tmpdir(), "corgi-image-")), "a.png");
  writeFileSync(image, "png bytes");
  c.send({ kind: "prompt", text: "look", images: [{ path: image, mime: "image/png" }] });
  expect(written[0]).toMatchObject({
    type: "prompt",
    message: "look",
    streamingBehavior: "steer",
    images: [{ type: "image", data: btoa("png bytes"), mimeType: "image/png" }],
  });
});
test("Pi serializes prompt acceptance before clearing its queue", () => {
  const { c, lines, written } = client();
  c.send({ kind: "prompt", text: "queued" });
  c.send({ kind: "interrupt" });
  expect(written.map((v: any) => v.type)).toEqual(["prompt"]);
  lines.push({
    type: "response",
    id: (written[0] as any).id,
    command: "prompt",
    success: true,
    data: { disposition: "queued" },
  });
  c.take();
  expect(written.map((v: any) => v.type)).toEqual(["prompt", "clear_queue"]);
  lines.push({ type: "response", id: (written[1] as any).id, success: true });
  c.take();
  expect(written.map((v: any) => v.type)).toEqual(["prompt", "clear_queue", "abort"]);
});
test("Pi closes expired dialogs and cancels a dialog before interrupting its command", () => {
  const { c, lines, written } = client();
  lines.push({ type: "extension_ui_request", id: "expired", method: "confirm", timeout: 0 });
  expect(c.take().map(e => e.kind)).toEqual(["request", "request_closed"]);
  lines.push({ type: "extension_ui_request", id: "open", method: "input" });
  c.take();
  c.send({ kind: "interrupt" });
  expect(written[0]).toEqual({ type: "extension_ui_response", id: "open", cancelled: true });
  expect(c.take()).toContainEqual({ kind: "request_closed", id: "open", session: "s", running: false });
});
test("a Pi session starts with the model, thinking and instructions it asks for", () => {
  const at = { cwd: "/repo", account: "", executable: "pi" };
  expect(sessionArgs(at, "")).toEqual([]);
  expect(
    sessionArgs({ ...at, model: "anthropic/opus", effort: "high", instructions: "Be brief.", persist: false }, "/f"),
  ).toEqual(["--model", "anthropic/opus", "--thinking", "high", "--append-system-prompt", "/f", "--no-session"]);
});
test("a Pi session's instructions arrive in a private file that goes when the process does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-pi-")),
    program = join(dir, "pi"),
    report = join(dir, "report.json");
  writeFileSync(
    program,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), file = args[args.indexOf("--append-system-prompt") + 1];
const seen = { args, text: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode & 0o777 };
fs.writeFileSync(${JSON.stringify(report + ".tmp")}, JSON.stringify(seen));
fs.renameSync(${JSON.stringify(report + ".tmp")}, ${JSON.stringify(report)});
`,
  );
  chmodSync(program, 0o755);
  const pi = Pi.start({ cwd: dir, account: "", executable: program, instructions: "Remember corgis." });
  const file = pi.file;
  try {
    const deadline = Date.now() + 5000;
    while ((!existsSync(report) || existsSync(file)) && Date.now() < deadline) {
      pi.take();
      await Bun.sleep(10);
    }
    const seen = JSON.parse(readFileSync(report, "utf8"));
    expect(seen).toMatchObject({ text: "Remember corgis.", mode: 0o600 });
    expect(seen.args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(seen.args.join(" ")).not.toContain("corgis");
    expect(existsSync(file)).toBe(false);
    expect(pi.file).toBe("");
  } finally {
    pi.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a Pi session with the host's tools loads them as an extension of its own, gone when it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-pi-")),
    program = join(dir, "pi"),
    report = join(dir, "report.json");
  writeFileSync(
    program,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), file = args[args.indexOf("--extension") + 1];
fs.writeFileSync(${JSON.stringify(report + ".tmp")}, JSON.stringify({ args, text: fs.readFileSync(file, "utf8") }));
fs.renameSync(${JSON.stringify(report + ".tmp")}, ${JSON.stringify(report)});
`,
  );
  chmodSync(program, 0o755);
  const tool = { name: "corgi", description: "Runs Corgi", input: {} },
    pi = Pi.start({
      cwd: dir,
      account: "",
      executable: program,
      host: { tools: [tool], call: async () => ({ text: "", failed: false }) },
    }),
    file = pi.tools_file;
  try {
    const deadline = Date.now() + 5000;
    while ((!existsSync(report) || existsSync(file)) && Date.now() < deadline) {
      pi.take();
      await Bun.sleep(10);
    }
    const seen = JSON.parse(readFileSync(report, "utf8"));
    expect(seen.text).toContain('[{"name":"corgi","description":"Runs Corgi"}]');
    expect(seen.text).toContain("process.env.CORGI_BIN");
    expect(existsSync(file)).toBe(false);
  } finally {
    pi.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // A session without them loads none.
  expect(sessionArgs({ cwd: "/repo", account: "", executable: "pi" }, "")).not.toContain("--extension");
});
test("a call to the host's tool says what it runs", () => {
  const { c, lines } = client();
  c.tools = ["corgi"];
  lines.push({ type: "tool_execution_start", toolCallId: "t", toolName: "corgi", args: { args: ["grep", "flicker"] } });
  expect(c.take().find(e => e.kind === "tool")).toMatchObject({ name: "corgi", summary: "grep flicker" });
});
const textDelta = (contentIndex: number, delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex, delta },
});
test("Pi streams its answer from text deltas, then sends it whole", () => {
  const { c, lines } = client();
  lines.push(
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    textDelta(0, "Hel"),
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" } },
    textDelta(0, "lo"),
    textDelta(2, "Again"),
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "Again" },
        ],
      },
    },
    { type: "message_start", message: { role: "assistant", content: [] } },
    textDelta(0, "Next"),
  );
  expect(c.take().filter(e => e.kind === "partial" || e.kind === "message")).toEqual([
    { kind: "partial", session: "s", text: "Hel" },
    { kind: "partial", session: "s", text: "Hello" },
    { kind: "partial", session: "s", text: "Hello\nAgain" },
    { kind: "message", session: "s", text: "Hello\nAgain" },
    { kind: "partial", session: "s", text: "Next" },
  ]);
  expect(Pi.restore(c.save(true), true).streamed).toEqual(["Next"]);
});
test("Pi streams the whole message an older version sends with each update", () => {
  const { c, lines } = client();
  const update = (text: string) => ({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text }] },
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{" },
  });
  lines.push(update("Hi"), update("Hi"), update("Hi there"));
  expect(c.take()).toEqual([
    { kind: "partial", session: "s", text: "Hi" },
    { kind: "partial", session: "s", text: "Hi there" },
  ]);
});
test("Pi's tools say what they are", () => {
  const { c, lines } = client();
  lines.push(
    { type: "agent_start" },
    { type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "src/x.ts" } },
    { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "bun test" } },
    { type: "tool_execution_start", toolCallId: "m", toolName: "mcp_search", args: {} },
  );
  expect(
    c
      .take()
      .filter(e => e.kind === "tool")
      .map(e => e.kind === "tool" && [e.name, e.summary]),
  ).toEqual([
    ["Read", "src/x.ts"],
    ["Bash", "bun test"],
    ["mcp_search", ""],
  ]);
  expect(toolName("web_search")).toBe("web_search");
});
