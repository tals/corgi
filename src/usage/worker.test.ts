import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { View as ToolView } from "../activity/tools";
import { test, expect } from "bun:test";
import { Tail, Result as UsageResult, type Request } from "./worker";
import { Agent, Text, Path } from "../agents";
import { Result as ActivityResult, Request as ActivityRequest, Slot } from "../activity/worker";
import { Actor } from "../conversations";
import { hash } from "../activity/summary";
function request(provider: "codex" | "claude"): Request {
  const agent = new Agent({ provider });
  agent.session = new Text("session");
  return {
    actor: 1,
    workspace: 1,
    since: 1000,
    agent,
    child: false,
    tracked_since: 0,
  };
}
test("usage tail frames records, ignores history and advances baselines while watched", () => {
  const t = new Tail(),
    r = request("codex");
  const line = (at: string, input: number, output: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: at,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: input, output_tokens: output },
        },
      },
    }) + "\n";
  const baseline = line("1970-01-01T00:00:00.000Z", 100, 10);
  expect(t.ingest(r, baseline, 0).any()).toBe(false);
  const call = JSON.stringify({
    type: "response_item",
    timestamp: "1970-01-01T00:00:02.000Z",
    payload: { type: "function_call", call_id: "c1" },
  });
  expect(t.ingest(r, call, baseline.length).any()).toBe(false);
  expect(t.ingest(r, "\n", baseline.length + call.length).tools).toBe(1n);
  expect(t.ingest(r, call + "\n", 0).any()).toBe(false);
  r.since = 3000;
  expect(t.ingest(r, line("1970-01-01T00:00:02.500Z", 150, 20), 0).any()).toBe(false);
  const delta = t.ingest(r, line("1970-01-01T00:00:04.000Z", 180, 25), 0);
  expect(delta.input).toBe(30n);
  expect(delta.output).toBe(5n);
});
test("Claude chosen names outrank generated names and continued session clears on resumed speech", () => {
  const t = new Tail();
  t.claudeRecord("s", {
    type: "ai-title",
    sessionId: "s",
    aiTitle: "Generated",
  });
  expect(t.name.text()).toBe("Generated");
  t.claudeRecord("s", {
    type: "custom-title",
    sessionId: "s",
    customTitle: "Chosen",
  });
  t.claudeRecord("s", { type: "ai-title", sessionId: "s", aiTitle: "Later" });
  expect(t.name.text()).toBe("Chosen");
  t.claudeRecord("s", {
    type: "continued-in",
    sessionId: "s",
    continuedInSessionId: "new",
  });
  expect(t.continued.text()).toBe("new");
  t.claudeRecord("s", {
    type: "assistant",
    sessionId: "s",
    timestamp: "1970-01-01T00:00:02.000Z",
    message: { content: [{ type: "text", text: "# Reading source\nMore" }] },
  });
  expect(t.continued.len).toBe(0);
  expect(t.update.text()).toBe("Reading source");
  expect(t.update_at).toBe(2000000);
});
test("late activity results cannot overwrite another turn or changed evidence", () => {
  const actor = new Actor({
    id: 1,
    state: new Agent({
      provider: "codex",
      state: "working",
      session: new Text("s"),
    }),
  });
  actor.state.setTurn("t");
  const evidence = new Text("Checking input");
  actor.state.activity_generation = hash(evidence);
  const req = Object.assign(new ActivityRequest(), {
      actor: 1,
      provider: "codex",
      session: actor.state.session,
      turn: actor.state.turn,
      turn_epoch: actor.state.turn_epoch,
      evidence,
      generation: hash(evidence),
    }),
    result = new ActivityResult(req, new Text("Checking input"));
  expect(result.apply(actor)).toBe(true);
  actor.state.setTurn("next");
  expect(result.apply(actor)).toBe(false);
});
test("unchanged evidence does not schedule paid summaries and tool changes wait for quiet", () => {
  const req = new ActivityRequest();
  req.evidence = new Text("Inspecting source");
  const slot = new Slot(req);
  slot.commentary = req.evidence;
  expect(slot.ready(1, false)).toBe(true);
  slot.attempt(1);
  expect(slot.ready(10000, false)).toBe(false);
  slot.updateTools(new Text("Running tests\n"), 10000);
  expect(slot.ready(14000, false)).toBe(false);
  expect(slot.ready(15000, false)).toBe(true);
});

function ingestLine(tail: Tail, req: Request, value: any) {
  return tail.ingest(req, JSON.stringify(value) + "\n", 0);
}

test("usage tail retains the latest reported model across unrelated records", () => {
  const tail = new Tail();
  const req = request("codex");
  ingestLine(tail, req, { type: "turn_context", payload: { model: "gpt-6" } });
  ingestLine(tail, req, { type: "event_msg", payload: {} });
  expect(tail.model.id.text()).toBe("gpt-6");
  req.agent.provider = "claude";
  ingestLine(tail, req, {
    type: "assistant",
    message: { model: "claude-opus-4-6" },
  });
  expect(tail.model.id.text()).toBe("claude-opus-4-6");
});

test("usage tail reads context from its own session, history included", () => {
  const tail = new Tail();
  const req = request("claude");
  req.agent.session = new Text("a");
  tail.initial_until = 1 << 20;
  ingestLine(tail, req, {
    type: "assistant",
    sessionId: "a",
    timestamp: "1970-01-01T00:00:02.000Z",
    message: {
      id: "m1",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 1000,
        output_tokens: 9,
      },
    },
  });
  ingestLine(tail, req, {
    type: "assistant",
    sessionId: "b",
    timestamp: "1970-01-01T00:00:03.000Z",
    message: { id: "m2", model: "claude-opus-5-5", usage: { input_tokens: 7 } },
  });
  expect(tail.context.used).toBe(41002n);
  expect(tail.context.window).toBe(1000000n);
});

test("Claude transcripts report when the conversation last went on", () => {
  const tail = new Tail();
  const req = request("claude");
  req.agent.session = new Text("a");
  ingestLine(tail, req, {
    type: "assistant",
    sessionId: "a",
    timestamp: "1970-01-01T00:00:02.000Z",
    message: {},
  });
  expect(tail.spoke_at).toBe(2000);
  for (const value of [
    {
      type: "system",
      subtype: "turn_duration",
      sessionId: "a",
      timestamp: "1970-01-01T00:00:03.000Z",
    },
    {
      type: "ai-title",
      aiTitle: "Title",
      sessionId: "a",
      timestamp: "1970-01-01T00:00:04.000Z",
    },
    {
      type: "user",
      sessionId: "a",
      isSidechain: true,
      timestamp: "1970-01-01T00:00:05.000Z",
      message: {},
    },
    {
      type: "user",
      sessionId: "b",
      timestamp: "1970-01-01T00:00:06.000Z",
      message: {},
    },
  ])
    ingestLine(tail, req, value);
  expect(tail.spoke_at).toBe(2000);
  ingestLine(tail, req, {
    type: "user",
    sessionId: "a",
    timestamp: "1970-01-01T00:00:07.000Z",
    message: { content: "<task-notification>" },
  });
  expect(tail.spoke_at).toBe(7000);
});

test("Claude transcripts report the tasks whose queued notice says they ended", () => {
  const tail = new Tail();
  const req = request("claude");
  req.agent.session = new Text("a");
  for (const value of [
    {
      type: "queue-operation",
      operation: "enqueue",
      sessionId: "a",
      content:
        '<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: "ci"</summary>\n<event>pass</event>\n</task-notification>',
    },
    {
      type: "queue-operation",
      operation: "enqueue",
      sessionId: "a",
      content:
        '<task-notification>\n<task-id>m2</task-id>\n<status>killed</status>\n<summary>Task "ci" was stopped by the user</summary>\n</task-notification>',
    },
    { type: "queue-operation", operation: "dequeue", sessionId: "a" },
    {
      type: "queue-operation",
      operation: "enqueue",
      sessionId: "b",
      content: "<task-notification>\n<task-id>m3</task-id>\n<status>completed</status>\n</task-notification>",
    },
    {
      type: "queue-operation",
      operation: "enqueue",
      sessionId: "a",
      content: "check CI again",
    },
  ])
    ingestLine(tail, req, value);
  expect(tail.ended.len).toBe(1);
  expect(tail.ended.listed("m2")).toBe(true);
  expect(tail.ended.listed("m1")).toBe(false);
  expect(tail.ended.listed("m3")).toBe(false);
});

test("a Claude subagent's own transcript counts its usage from when it was tracked", () => {
  const tail = new Tail();
  tail.initial_until = 1 << 20;
  tail.catch_up = true;
  const req = request("claude");
  req.child = true;
  req.tracked_since = 2000;
  req.agent.session = new Text("a1");
  function message(agentId: string, id: string, seconds: number, input: number, output: number) {
    return {
      type: "assistant",
      sessionId: "s",
      isSidechain: true,
      agentId,
      timestamp: `1970-01-01T00:00:0${seconds}.000Z`,
      message: { id, usage: { input_tokens: input, output_tokens: output } },
    };
  }
  ingestLine(tail, req, message("a1", "m1", 1, 7, 1));
  ingestLine(tail, req, message("a1", "m2", 3, 10, 2));
  ingestLine(tail, req, message("a2", "m3", 4, 100, 5));
  expect(tail.live.meter.value.tokens.input).toBe(10n);
  expect(tail.live.meter.value.tokens.output).toBe(2n);
  const parent = new Tail();
  const parentReq = request("claude");
  parentReq.agent.session = new Text("s");
  ingestLine(parent, parentReq, message("a1", "m2", 3, 10, 2));
  expect(parent.live.meter.value.tokens.input).toBe(0n);
});

test("Claude transcripts supply chosen names over generated titles and report continuations", () => {
  const tail = new Tail();
  const req = request("claude");
  req.agent.session = new Text("a");
  ingestLine(tail, req, {
    type: "ai-title",
    aiTitle: "Other session",
    sessionId: "b",
  });
  expect(tail.name.len).toBe(0);
  ingestLine(tail, req, {
    type: "ai-title",
    aiTitle: "Generated",
    sessionId: "a",
  });
  expect(tail.name.text()).toBe("Generated");
  ingestLine(tail, req, {
    type: "agent-name",
    agentName: "Chosen",
    sessionId: "a",
  });
  ingestLine(tail, req, {
    type: "ai-title",
    aiTitle: "Regenerated",
    sessionId: "a",
  });
  expect(tail.name.text()).toBe("Chosen");
  ingestLine(tail, req, {
    type: "continued-in",
    sessionId: "a",
    continuedInSessionId: "c",
  });
  expect(tail.continued.text()).toBe("c");
  ingestLine(tail, req, {
    type: "user",
    sessionId: "a",
    isSidechain: true,
    message: {},
  });
  expect(tail.continued.text()).toBe("c");
  ingestLine(tail, req, { type: "user", sessionId: "a", message: {} });
  expect(tail.continued.len).toBe(0);
  const result = new UsageResult();
  result.name = tail.name;
  expect(result.fallback(req.agent, 0)).toBe(false);
  expect(req.agent.displayName()).toBe("Chosen");
});

test("Claude text updates apply only when newer than the latest hook", () => {
  const tail = new Tail();
  const req = request("claude");
  req.agent.session = new Text("a");
  ingestLine(tail, req, {
    type: "assistant",
    sessionId: "a",
    timestamp: "1970-01-01T00:00:02.000Z",
    message: {
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "\n## Checking the parser\nmore" },
      ],
    },
  });
  expect(tail.update.text()).toBe("Checking the parser");
  ingestLine(tail, req, {
    type: "assistant",
    sessionId: "a",
    isSidechain: true,
    timestamp: "1970-01-01T00:00:03.000Z",
    message: { content: [{ type: "text", text: "Subagent text" }] },
  });
  expect(tail.update.text()).toBe("Checking the parser");
  const agent = new Agent({
    provider: "claude",
    state: "working",
    activity_at: 3000000,
  });
  agent.session = new Text("a");
  const result = new UsageResult();
  result.update = tail.update;
  result.update_at = tail.update_at;
  result.fallback(agent, 0);
  expect(agent.activity.len).toBe(0);
  agent.activity_at = 1000000;
  result.fallback(agent, 0);
  expect(agent.activity.text()).toBe("Checking the parser");
  agent.activity = new Text();
  agent.activity_at = 0;
  agent.state = "idle";
  result.fallback(agent, 0);
  expect(agent.activity.len).toBe(0);
});

test("file metadata prefers fresh protocol and rejects other turns", () => {
  const agent = new Agent({
    provider: "codex",
    state: "working",
    last_seq: 10n,
  });
  agent.session = new Text("session");
  agent.turn = new Text("current");
  const progress = new ToolView();
  progress.turn = new Text("current");
  progress.commentary = new Text("Tracing pane focus");
  const result = new UsageResult();
  result.progress = progress;
  result.seq = 10n;
  result.name = new Text("File title");
  agent.setName("Protocol title");
  agent.metadata_at = 100;
  expect(result.fallback(agent, 101)).toBe(false);
  expect(agent.displayName()).toBe("Protocol title");
  agent.last_seq = 6000000n;
  expect(result.fallback(agent, 6000000)).toBe(true);
  expect(agent.displayName()).toBe("File title");
  expect(agent.state).toBe("working");
  expect(agent.observation.completed).toBe(0n);
  progress.turn = new Text("old");
  expect(result.fallback(agent, 6000000)).toBe(false);
  agent.turn = new Text();
  expect(result.fallback(agent, 6000000)).toBe(false);
  result.seq = agent.last_seq;
  progress.ended = true;
  expect(result.fallback(agent, 6000000)).toBe(false);
});

test("real file usage reader accepts large Codex metadata and counts later activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-usage-"));
  try {
    const file = join(root, "usage.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "session_meta",
        payload: { id: "large-session", instructions: "x".repeat(24 * 1024) },
      }) + "\n",
    );
    const req = request("codex");
    req.agent.session = new Text("large-session");
    req.agent.transcript = new Path(file);
    const tail = new Tail();
    expect((await tail.poll(req)).any()).toBe(false);
    const offset = tail.offset;
    appendFileSync(
      file,
      JSON.stringify({
        type: "response_item",
        timestamp: "1970-01-01T00:00:02.000Z",
        payload: { type: "function_call", call_id: "call1" },
      }) + "\n",
    );
    appendFileSync(
      file,
      JSON.stringify({
        type: "event_msg",
        timestamp: "1970-01-01T00:00:02.000Z",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } },
        },
      }) + "\n",
    );
    const delta = await tail.poll(req);
    expect(tail.offset).toBeGreaterThan(offset);
    expect(delta.tools).toBe(1n);
    expect(delta.input).toBe(100n);
    expect(delta.output).toBe(20n);
    expect((await tail.poll(req)).any()).toBe(false);
    req.agent.session = new Text("other-session");
    await expect(new Tail().poll(req)).rejects.toThrow("WrongSession");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
