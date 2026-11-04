import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Claude, sessionArgs } from "./headless";
import type { Stdio } from "../stdio";
/** A Claude client reading `lines` as its output, recording what it writes. */
function client(lines: unknown[], summary: { schema: boolean } | null = null) {
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
  return { claude: new Claude(io, summary, !summary), written };
}
const usage = { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 5 };
test("Claude's stream names its session, turns, tools, usage and messages", () => {
  const { claude } = client([
    { type: "system", subtype: "init", session_id: "a" },
    {
      type: "assistant",
      session_id: "a",
      message: { id: "m1", usage, content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] },
    },
    { type: "user", session_id: "a", message: { content: [{ type: "tool_result", tool_use_id: "x" }] } },
    { type: "assistant", session_id: "a", message: { id: "m2", content: [{ type: "text", text: "done" }] } },
    { type: "result", session_id: "a", subtype: "success" },
    { type: "result", session_id: "a", subtype: "error_during_execution", is_error: true },
  ]);
  const events = claude.take();
  expect(events.map(e => e.kind)).toEqual(["conversation", "turn", "usage", "tool", "tool", "message", "turn", "turn"]);
  expect(events[2]).toMatchObject({ kind: "usage", part: { id: "m1", tokens: { input: 60n, cached_input: 30n } } });
  expect(events[5]).toEqual({ kind: "message", session: "a", text: "done" });
  expect(events[6]).toEqual({ kind: "turn", session: "a", turn: "", phase: "ended", outcome: "completed" });
  expect(events[7]).toMatchObject({ outcome: "failed" });
});
test("Claude's tool requests are answered with the input they asked about", () => {
  const input = { command: "rm -rf build" };
  const { claude, written } = client([
    { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input } },
    { type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Edit", input: {} } },
  ]);
  expect(claude.take()).toEqual([
    { kind: "request", session: "", id: "r1", ask: { tool: true, name: "Bash", summary: "rm -rf build" } },
    { kind: "request", session: "", id: "r2", ask: { tool: true, name: "Edit", summary: "" } },
  ]);
  claude.send({ kind: "answer", request: "r1", allow: true });
  claude.send({ kind: "answer", request: "r2", allow: false });
  expect(written).toEqual([
    {
      type: "control_response",
      response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: input } },
    },
    {
      type: "control_response",
      response: { subtype: "success", request_id: "r2", response: { behavior: "deny", message: "Denied" } },
    },
  ]);
});
test("a summary waits for its handshake and answers with its result", () => {
  const { claude, written } = client(
    [
      { type: "control_response", response: { subtype: "success", request_id: "corgi-initialize" } },
      { type: "assistant", message: { id: "m", usage, content: [{ type: "text", text: "thinking" }] } },
      { type: "result", subtype: "success", result: "plain", structured_output: { label: "x" }, usage },
    ],
    { schema: true },
  );
  expect(claude.ready).toBe(false);
  const events = claude.take();
  expect(claude.ready).toBe(true);
  expect(events.filter(e => e.kind === "message")).toEqual([{ kind: "message", session: "", text: '{"label":"x"}' }]);
  expect(events.filter(e => e.kind === "usage")).toHaveLength(1);
  claude.send({ kind: "prompt", text: "go" });
  expect(written).toEqual([{ type: "user", message: { role: "user", content: "go" } }]);
  // Images follow the text as base64 blocks.
  const image = join(mkdtempSync(join(tmpdir(), "corgi-image-")), "a.png");
  writeFileSync(image, "png bytes");
  claude.send({ kind: "prompt", text: "what's this?", images: [{ path: image, mime: "image/png" }] });
  expect(written[1]).toEqual({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "what's this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: btoa("png bytes") } },
      ],
    },
  });
});
test("a session starts with the model, effort and instructions it asks for", () => {
  const at = { cwd: "/repo", account: "", executable: "claude" };
  expect(sessionArgs(at, "")).not.toContain("--model");
  expect(sessionArgs(at, "")).not.toContain("--no-session-persistence");
  expect(sessionArgs(at, "")).not.toContain("--append-system-prompt-file");
  expect(sessionArgs(at, "")).toContain("--include-partial-messages");
  const args = sessionArgs({ ...at, model: "opus", effort: "high", instructions: "Be brief.", persist: false }, "/f");
  const after = (flag: string) => args.slice(args.indexOf(flag), args.indexOf(flag) + 2);
  expect(after("--model")).toEqual(["--model", "opus"]);
  expect(after("--effort")).toEqual(["--effort", "high"]);
  expect(after("--append-system-prompt-file")).toEqual(["--append-system-prompt-file", "/f"]);
  expect(args).not.toContain("Be brief.");
  expect(args).toContain("--no-session-persistence");
});
test("a session's instructions reach Claude in a private file that goes with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-claude-")),
    program = join(dir, "claude"),
    report = join(dir, "report.json");
  writeFileSync(
    program,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), file = args[args.indexOf("--append-system-prompt-file") + 1];
const seen = { args, text: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode & 0o777 };
fs.writeFileSync(${JSON.stringify(report + ".tmp")}, JSON.stringify(seen));
fs.renameSync(${JSON.stringify(report + ".tmp")}, ${JSON.stringify(report)});
for await (const _ of console) {}
`,
  );
  chmodSync(program, 0o755);
  const claude = Claude.session({ cwd: dir, account: "", executable: program, instructions: "Remember corgis." });
  const file = claude.file;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(report) && Date.now() < deadline) await Bun.sleep(10);
    const seen = JSON.parse(readFileSync(report, "utf8"));
    expect(seen.text).toBe("Remember corgis.");
    expect(seen.mode).toBe(0o600);
    expect(seen.args.join(" ")).not.toContain("corgis");
    expect(JSON.stringify(claude.save(true))).not.toContain("corgis");
    expect(Claude.restore(claude.save(false), false).file).toBe(file);
  } finally {
    claude.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(existsSync(file)).toBe(false);
});
const delta = (text: string, parent: string | null = null) => ({
  type: "stream_event",
  session_id: "a",
  parent_tool_use_id: parent,
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});
test("Claude streams each text block as it's written, then sends it whole", () => {
  const { claude } = client([
    { type: "stream_event", session_id: "a", event: { type: "message_start", message: {} } },
    { type: "stream_event", session_id: "a", event: { type: "content_block_start", content_block: { type: "text" } } },
    delta("Hel"),
    delta("lo"),
    delta("sub", "toolu_1"),
    // A subagent's own message stays out of the conversation's.
    {
      type: "assistant",
      session_id: "a",
      parent_tool_use_id: "toolu_1",
      message: { id: "s", content: [{ type: "text", text: "Searching the repo" }] },
    },
    { type: "assistant", session_id: "a", message: { id: "m", content: [{ type: "text", text: "Hello" }] } },
    { type: "stream_event", session_id: "a", event: { type: "content_block_start", content_block: { type: "text" } } },
    delta("Next"),
  ]);
  const events = claude.take();
  expect(events.filter(e => e.kind !== "conversation")).toEqual([
    { kind: "turn", session: "a", turn: "", phase: "started" },
    { kind: "partial", session: "a", text: "Hel" },
    { kind: "partial", session: "a", text: "Hello" },
    { kind: "message", session: "a", text: "Hello" },
    { kind: "partial", session: "a", text: "Next" },
  ]);
  expect(claude.streamed).toBe("Next");
});
test("an interrupted stream ends in the message it showed", () => {
  const { claude } = client([delta("Half"), { type: "result", session_id: "a", subtype: "error_during_execution" }]);
  expect(claude.take().filter(e => e.kind === "partial" || e.kind === "message")).toEqual([
    { kind: "partial", session: "a", text: "Half" },
    { kind: "message", session: "a", text: "Half" },
  ]);
  expect(claude.streamed).toBe("");
});
test("a summary doesn't stream", () => {
  const { claude } = client([delta("x")], { schema: false });
  expect(claude.take()).toEqual([{ kind: "conversation", session: "a", parent: null, role: null, shown: true }]);
});
test("Claude's tools say what they are", () => {
  const { claude } = client([
    {
      type: "assistant",
      session_id: "a",
      message: {
        id: "m",
        content: [
          { type: "tool_use", id: "r", name: "Read", input: { file_path: "/repo/src/x.ts" } },
          { type: "tool_use", id: "s", name: "WebSearch", input: { query: "bun ffi" } },
        ],
      },
    },
  ]);
  expect(claude.take().filter(e => e.kind === "tool")).toEqual([
    { kind: "tool", session: "a", turn: "", id: "r", done: false, wrote: [], name: "Read", summary: "/repo/src/x.ts" },
    { kind: "tool", session: "a", turn: "", id: "s", done: false, wrote: [], name: "WebSearch", summary: "bun ffi" },
  ]);
});
test("a stream half-way through survives a handoff", () => {
  const { claude } = client([delta("Half")]);
  claude.take();
  expect(Claude.restore(claude.save(true), true).streamed).toBe("Half");
});
test("an unattended session runs in auto mode, and skips its checks where auto mode is off", () => {
  const at = { cwd: "/repo", account: "", executable: "claude" };
  expect(sessionArgs(at, "")).not.toContain("--permission-mode");
  const args = sessionArgs({ ...at, unattended: true }, "");
  expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
    "--permission-mode",
    "auto",
  ]);
  expect(args).toContain("--allow-dangerously-skip-permissions");
  const asked = (mode: string, unattended = true) => {
    const { claude, written } = client([{ type: "system", subtype: "init", session_id: "a", permissionMode: mode }]);
    claude.unattended = unattended;
    claude.take();
    return written;
  };
  expect(asked("auto")).toEqual([]);
  expect(asked("bypassPermissions")).toEqual([]);
  expect(asked("default", false)).toEqual([]);
  expect(asked("default")).toEqual([
    {
      type: "control_request",
      request_id: "corgi-mode-1",
      request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
    },
  ]);
  const { claude } = client([]);
  claude.unattended = true;
  expect(Claude.restore(claude.save(true), true).unattended).toBe(true);
});
