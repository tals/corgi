import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Text } from "../common";
import { Snapshot } from "../snapshot";
import { Stdio } from "../stdio";
import { Antigravity } from "./headless";
import { customizations, directory } from "./config";
import { decode, integration } from "./hooks";
import { catalog } from "./launcher";
import { entries } from "./history";
import { database } from "./summaries";
import { metadata } from "./observer";
import { selected } from "./presence";
import { path, transcript } from "./transcript";
import { Tail } from "../../usage/worker";
import { Agent } from "../../agents";
import { Registry } from "../../conversations";
import * as json from "../../json";
import { conversations } from "./search";
import { Watcher } from "./screen";

const session = "a53504fb-0568-49bf-af86-c5844676936b",
  child = "2e83ed1b-33d2-4b63-8b28-6ab52910e832";

test("Antigravity hooks distinguish turn boundaries, tool attempts and successful writes", () => {
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    decode({ conversationId: session, hookEventName: event, ...fields });
  expect(hook("PreInvocation", { initialNumSteps: 0, lastUserInput: "fix tests" })).toMatchObject({
    kind: "prompt",
    prompt: "step-0",
    initial_request: "fix tests",
  });
  expect(hook("PreInvocation", { invocationNum: 2 })).toBeNull();
  expect(hook("Stop", { terminationReason: "USER_CANCELED" })?.outcome).toBe("interrupted");
  expect(hook("Stop", { terminationReason: "MAX_INVOCATIONS" })?.outcome).toBe("failed");
  const toolCall = { name: "write_to_file", args: { TargetFile: "/tmp/file" } };
  expect(hook("PreToolUse", { toolCall })).toMatchObject({ kind: "tool_start", confirm: "screen", writes: [] });
  expect(hook("PostToolUse", { toolCall })?.writes).toEqual(["/tmp/file"]);
  expect(hook("PostToolUse", { toolCall, error: "write failed" })).toMatchObject({ kind: "tool_failure", writes: [] });
  expect(decode({ conversationId: "../../file", hookEventName: "SessionStart" })).toBeNull();
});

test("Antigravity hook installation preserves other hooks and explicit disables", () => {
  const account = mkdtempSync(join(tmpdir(), "corgi-agy-test-")),
    file = join(customizations(account), "hooks.json");
  try {
    expect(integration("install", account)[0].outcome).toBe("added");
    expect(integration("install", account)[0].outcome).toBe("present");
    const root = JSON.parse(readFileSync(file, "utf8")),
      group = root["Reporting to Corgi"];
    expect(group.PreToolUse[0].hooks[0].command).toEndWith("hook antigravity; fi");
    root.Example = { Stop: [] };
    group.enabled = false;
    writeFileSync(file, JSON.stringify(root));
    expect(integration("install", account)[0].outcome).toBe("partial");
    expect(integration("status", account)[0].outcome).toBe("partial");
    expect(integration("uninstall", account)[0].outcome).toBe("removed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ Example: { Stop: [] } });
    root["Reporting to Corgi"] = { Stop: [] };
    writeFileSync(file, JSON.stringify(root));
    expect(integration("install", account)[0].outcome).toBe("failed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(root);
  } finally {
    rmSync(account, { recursive: true, force: true });
  }
});

test("Antigravity installs a silent context reporter alongside the default status and respects user settings", () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-agy-status-")),
    file = join(directory(home), "settings.json"),
    run = (op: "install" | "status" | "uninstall") =>
      integration(op, home).find(s => s.item === "context meter")!.outcome;
  try {
    mkdirSync(directory(home), { recursive: true });
    writeFileSync(file, JSON.stringify({ editorMode: "vim" }));
    expect(run("install")).toBe("added");
    expect(run("install")).toBe("present");
    const ours = JSON.parse(readFileSync(file, "utf8"));
    expect(ours.statusLine.stack_with_default).toBe(true);
    expect(run("uninstall")).toBe("removed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ editorMode: "vim" });
    for (const statusLine of [{ command: "my-status" }, { enabled: false }]) {
      const original = JSON.stringify({ statusLine, editorMode: "vim" });
      writeFileSync(file, original);
      expect(run("install")).toBe("partial");
      expect(run("uninstall")).toBe("absent");
      expect(readFileSync(file, "utf8")).toBe(original);
    }
    ours.statusLine.enabled = false;
    writeFileSync(file, JSON.stringify(ours));
    expect(run("install")).toBe("partial");
    expect(run("uninstall")).toBe("removed");
    expect(JSON.parse(readFileSync(file, "utf8")).statusLine).toEqual({ enabled: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Antigravity recognizes compaction only at the live composer", () => {
  const watcher = new Watcher(),
    status = "⣻  Compacting conversation… (2s · esc to cancel)",
    composer = "────────────\n>\n────────────";
  expect(watcher.reading("", status + "\n" + composer + "\nesc to cancel")).toBe("compacting");
  expect(watcher.reading("", status + "\n" + composer + "\n? for shortcuts")).toBe("idle");
  expect(watcher.reading("", status + "\n" + composer + "\nOld turn\n" + composer + "\n? for shortcuts")).toBe("idle");
  expect(watcher.reading("", "Conversation compacted\n" + composer + "\n? for shortcuts")).toBe("idle");
});

test("Antigravity history, child metadata and transcript search use the same conversation IDs", async () => {
  const account = mkdtempSync(join(tmpdir(), "corgi-agy-test-")),
    root = directory(account);
  mkdirSync(root, { recursive: true });
  const db = new Database(database(root));
  try {
    db.exec(
      "CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, step_count INTEGER, agent_name TEXT, status TEXT, killed INTEGER)",
    );
    const row = db.query(
      "INSERT INTO conversation_summaries VALUES (?,?,?,?,'2025-01-01T00:00:00Z',?,3,'reviewer',?,0)",
    );
    row.run(session, "Review", "preview", '["file:///tmp/my%20project"]', "", "CASCADE_RUN_STATUS_IDLE");
    row.run(child, "Read tests", "details", '["file:///tmp/my%20project"]', session, "CASCADE_RUN_STATUS_RUNNING");
    expect(entries(root, account, () => false)).toMatchObject([
      { session, cwd: "/tmp/my project", title: "Review", updated_at: 1735689600 },
    ]);
    const snapshot = new Snapshot(
      { pane: 1, pid: 1, prefix: new Text(), actor: 0, generation: 1n, title_revision: 0n },
      session,
      "idle",
    );
    metadata(db, root, snapshot);
    expect(snapshot.children_complete).toBe(true);
    expect(snapshot.children.map(c => [c.session, c.state, c.role.text()])).toEqual([[child, "working", "reviewer"]]);
    expect(snapshot.subagents.running).toBe(1);
    const file = path(root, session);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        { type: "USER_INPUT", content: "<USER_REQUEST>Find penguins</USER_REQUEST>\nprivate metadata" },
        {
          type: "PLANNER_RESPONSE",
          content: "Two penguins",
          tool_calls: [{ id: "1", name: "view_file", args: { AbsolutePath: "/tmp/my project/penguins" } }],
        },
      ]
        .map(v => JSON.stringify(v))
        .join("\n") + "\n",
    );
    const found = await conversations.discover(root, {
      known: () => undefined,
      skipped: () => false,
      seen: () => null,
      exclude() {},
      warn() {},
      claim: () => true,
      checking() {},
      checked() {},
    });
    expect(found.map(f => f.session)).toEqual([session]);
    expect((await conversations.read(found[0], false)).messages.map(m => m.text)).toEqual([
      "Find penguins",
      "Two penguins",
    ]);
    expect((await conversations.read(found[0], true)).tools?.map(m => m.role)).toContain("tool");
  } finally {
    db.close();
    rmSync(account, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "Antigravity session selection follows open descriptors",
  async () => {
    const account = mkdtempSync(join(tmpdir(), "corgi-agy-test-")),
      dir = join(directory(account), "presence");
    mkdirSync(dir, { recursive: true });
    try {
      for (const id of [session, child]) {
        const fd = openSync(join(dir, id + ".lock"), "w");
        try {
          expect(await selected(process.pid, account)).toBe(id);
        } finally {
          closeSync(fd);
        }
      }
      expect(await selected(process.pid, account)).toBeNull();
    } finally {
      rmSync(account, { recursive: true, force: true });
    }
  },
);

test("Antigravity transcript usage counts cached input and deduplicates repeated steps", () => {
  const reader = transcript.reader(() => []),
    t = new Tail(),
    req = { actor: 1, workspace: 1, since: 0, agent: new Agent(), child: false, tracked_since: 0 };
  const record = {
    step_index: 8,
    type: "PLANNER_RESPONSE",
    model: "gemini-high",
    created_at: "2025-01-01T00:00:00Z",
    input_tokens: 35,
    cache_read_tokens: 15,
    output_tokens: 8,
    tool_calls: [{ name: "view_file" }],
  };
  const stamp = reader.timestamp!(record);
  expect(stamp).toBe(1735689600000);
  expect(reader.record(t, req, record, true, stamp)).toMatchObject({
    input: 50n,
    cached_input: 15n,
    output: 8n,
    tools: 1n,
  });
  expect(reader.record(t, req, record, true, stamp)).toMatchObject({
    input: 0n,
    cached_input: 0n,
    output: 0n,
    tools: 0n,
  });
  expect(t.live.meter.value.tokens.total()).toBe(58n);
});

test("Antigravity keeps a tool active between its start and finish hooks while the transcript advances", () => {
  const actor = new Registry().get("antigravity", session),
    tail = new Tail(),
    reader = transcript.reader(() => []),
    toolCall = { name: "run_command", args: { CommandLine: "bun test" } };
  const hook = (event: string, fields: Record<string, unknown>) =>
    decode({ conversationId: session, hookEventName: event, ...fields })!;
  actor.observeHook(hook("PreInvocation", { initialNumSteps: 0 }), 1n, false, 100);
  tail.progress.bind(actor.state.turnId());
  actor.observeHook(hook("PreToolUse", { toolCall }), 2n, false, 200);
  expect(actor.state.tool_active).toBe(true);
  const counts = reader.record(
    tail,
    { actor: 1, workspace: 1, since: 0, agent: actor.state, child: false, tracked_since: 0 },
    { type: "PLANNER_RESPONSE", step_index: 1, content: "Running tests", tool_calls: [toolCall] },
    true,
    300,
  );
  expect(counts.tools).toBe(1n);
  actor.observeTools(tail.progress.view());
  expect(actor.state.tool_active).toBe(true);
  actor.observeHook(hook("PostToolUse", { toolCall }), 3n, false, 400);
  expect(actor.state.tool_active).toBe(false);
});

test("Antigravity's model list preserves separate effort variants", () => {
  expect(catalog("gemini-low\tGemini (Low)\ngemini-high\tGemini (High)\ninvalid line").map(m => m.id)).toEqual([
    "gemini-low",
    "gemini-high",
  ]);
});

test("Antigravity ACP queues prompts through setup, scopes approvals, and closes a cancelled turn", () => {
  class Pipe extends Stdio {
    incoming: unknown[] = [];
    sent: unknown[] = [];
    override read() {
      return this.incoming.splice(0);
    }
    override write(v: unknown) {
      this.sent.push(v);
    }
  }
  const io = new Pipe(),
    client = new Antigravity(io, { cwd: "/tmp", instructions: "concise", model: "gemini-low", effort: "low" });
  const response = (id: string, result: unknown) => {
    io.incoming.push({ id, result });
    return client.take();
  };
  client.send({ kind: "prompt", text: "first" });
  client.send({ kind: "prompt", text: "second" });
  response("init", {});
  expect(io.sent.at(-1)).toMatchObject({
    method: "session/new",
    params: { cwd: "/tmp", _meta: { antigravity: { systemPrompt: { append: "concise" } } } },
  });
  response("new", { sessionId: session });
  expect(io.sent.at(-1)).toMatchObject({ method: "session/set_model", params: { modelId: "gemini-low" } });
  response("model", {});
  expect(io.sent.at(-1)).toMatchObject({ method: "session/set_config_option", params: { value: "low" } });
  expect(response("effort", {}).map(e => e.kind)).toEqual(["conversation", "ready", "turn"]);
  io.incoming.push({
    id: 7,
    method: "session/request_permission",
    params: {
      sessionId: session,
      toolCall: { title: "read file", kind: "read" },
      options: [
        { kind: "allow_always", optionId: "always" },
        { kind: "allow_once", optionId: "once" },
      ],
    },
  });
  expect(client.take()).toMatchObject([{ kind: "request", id: "7" }]);
  client.send({ kind: "answer", request: "7", allow: true });
  expect(io.sent.at(-1)).toMatchObject({ id: 7, result: { outcome: { optionId: "once" } } });
  expect(() => client.send({ kind: "answer", request: "7", allow: true })).toThrow("NoRequest");
  io.incoming.push({
    method: "session/update",
    params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { text: "hello" } } },
  });
  expect(
    response("turn-1", {
      stopReason: "end_turn",
      usage: { inputTokens: 11, cachedReadTokens: 15, outputTokens: 3 },
    }).map(e => e.kind),
  ).toEqual(["partial", "message", "usage", "turn", "turn"]);
  expect(io.sent.at(-1)).toMatchObject({ id: "turn-2", params: { prompt: [{ type: "text", text: "second" }] } });
  const restored = Antigravity.restore(json.clone(client.save(false)), false);
  expect(restored.save(false).state).toMatchObject({
    turn: "turn-2",
    tokens: { input: 26n, cached_input: 15n, output: 3n },
  });
  restored.close();
  client.send({ kind: "interrupt" });
  expect(io.sent.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: session } });
  expect(response("turn-2", { stopReason: "cancelled" })).toMatchObject([
    { kind: "turn", phase: "ended", outcome: "interrupted" },
  ]);
});
