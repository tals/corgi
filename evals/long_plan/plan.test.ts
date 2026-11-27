import { expect, test } from "bun:test";
import * as history from "./history";
import * as plan from "./plan";
import * as score from "./score";
import type { Event } from "./history";

const jsonl = (...rows: unknown[]) => rows.map(v => JSON.stringify(v)).join("\n");
const events: Event[] = [
  { id: 1, line: 1, at: "2026-10-21T00:00:00Z", turn: 1, kind: "user", text: "Repair branch history" },
  { id: 2, line: 2, at: "2026-10-21T00:00:01Z", turn: 1, kind: "tool", text: "git rebase origin/main" },
];
const nodes: plan.Node[] = [
  {
    id: "e",
    parent: null,
    kind: "episode",
    title: "Repair branch history",
    subtitle: "Keep only CI changes above main",
    state: "active",
    evidence: [2],
  },
  {
    id: "s",
    parent: "e",
    kind: "step",
    title: "Rebase CI branch",
    subtitle: "Replay the branch onto upstream main",
    state: "active",
    evidence: [2],
  },
];
const patch = { nodes, spans: [{ from: 1, to: 2, node: "s" }] };
const state = () => plan.apply(plan.empty(), JSON.stringify(patch), events).state;

test("late-result attribution leaves foreground work and visit accounting intact", () => {
  const initial = state();
  const next = plan.apply(initial, JSON.stringify({ nodes: [], spans: [{ from: 3, to: 3, node: "s", focus: true }] }), [
    { ...events[1], id: 3, line: 3, kind: "result", text: "background command finished" },
  ]);
  expect(next.patch.spans[0].focus).toBe(false);
  expect(next.repairs).toEqual(["ignored passive focus: 3-3"]);
});

test("a mixed span cannot move focus on a notification before its foreground command", () => {
  const normalized = plan.foreground(
    [
      { from: 1, to: 2, node: "current", focus: true },
      { from: 3, to: 5, node: "older", focus: true },
    ],
    [
      { ...events[1], id: 3, kind: "lifecycle", text: "Background tests completed" },
      { ...events[1], id: 4, kind: "tool", text: "Inspect completed test results" },
      { ...events[1], id: 5, kind: "result", text: "46 suites passed" },
    ],
  );
  expect(normalized).toEqual([
    { from: 1, to: 2, node: "current", focus: true },
    { from: 3, to: 3, node: "older", focus: false },
    { from: 4, to: 4, node: "older", focus: true },
    { from: 5, to: 5, node: "older", focus: false },
  ]);
});

test("fork imports exclude inherited history and foreign receipts, not the owned response usage", () => {
  const data = history.decode(
    jsonl(
      {
        timestamp: "2026-11-08T01:00:00Z",
        type: "session_meta",
        payload: {
          id: "fork",
          forked_from_id: "parent",
          timestamp: "2026-11-08T01:00:00Z",
        },
      },
      {
        timestamp: "2026-11-07T00:00:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ text: "Inherited work" }],
        },
      },
      {
        timestamp: "2026-11-08T01:00:01Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ text: "Build the compression benchmark" }],
        },
      },
      ...["parent", "fork"].map(session_id => ({
        timestamp: "2026-11-08T01:00:02Z",
        type: "token_usage_record",
        payload: {
          session_id,
          response_id: session_id,
          usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
          thread_token_usage: { input_tokens: 97000000, output_tokens: 600000 },
        },
      })),
    ),
    "codex",
  );
  expect(data.events.map(e => e.text)).toEqual(["Build the compression benchmark"]);
  expect(data.receipts).toHaveLength(1);
  expect(history.total(data.receipts[0].tokens)).toBe(110n);
  expect(data.warnings[0]).toStartWith("Fork suffix only");
});

test("replay visits preserve returns and charge late receipts to the generating visit", () => {
  const steps = [...nodes, { ...nodes[1], id: "other", title: "Inspect test output" }];
  const replay: plan.State = {
    nodes: steps,
    through: 5,
    spans: [
      { from: 1, to: 1, node: null },
      { from: 2, to: 2, node: "s" },
      { from: 3, to: 3, node: "other" },
      { from: 4, to: 5, node: "s" },
    ],
  };
  const data: history.History = {
    provider: "codex",
    source: "synthetic",
    sha256: "synthetic",
    warnings: [],
    events: Array.from({ length: 5 }, (_, i) => ({ ...events[i === 0 ? 0 : 1], id: i + 1, line: i + 1 })),
    receipts: [
      { id: "a", event: 2, line: 2, tokens: { input: "100", cached: "50", output: "10" } },
      { id: "b", event: 3, line: 3, tokens: { input: "200", cached: "100", output: "20" } },
      { id: "c", event: 4, line: 4, tokens: { input: "300", cached: "150", output: "30" } },
      { id: "late-a", event: 2, line: 5, tokens: { input: "50", cached: "25", output: "0" } },
      { id: "unassigned", event: null, line: 5, tokens: { input: "80", cached: "40", output: "0" } },
    ],
  };
  const before = plan.snapshot(replay, data, 4),
    after = plan.snapshot(replay, data, 5);
  expect(after.visits.map(v => [v.step, v.counts.input, v.counts.tools])).toEqual([
    ["s", "150", "1"],
    ["other", "200", "1"],
    ["s", "300", "2"],
  ]);
  expect(before.visits[0].counts.input).toBe("100");
  expect(after.visits[2].counts.input).toBe(before.visits[2].counts.input);
  expect(after.counts.s.input).toBe("450");
  expect(after.unassigned.input).toBe("80");
  expect(after.visits.reduce((sum, v) => sum + BigInt(v.counts.input), 0n)).toBe(BigInt(after.counts.e.input));
});

test("replay activity follows provider turns through compaction without adding model evidence", () => {
  const data = history.decode(
    jsonl(
      { type: "event_msg", payload: { type: "task_started", turn_id: "first" } },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished the merge" }] },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "first" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "next" } },
      { type: "event_msg", payload: { type: "turn_aborted", turn_id: "first" } },
      { type: "compacted", payload: {} },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue with integration" }],
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "next" } },
    ),
    "codex",
  );
  expect(data.events.map(e => e.kind)).toEqual([
    "assistant",
    "lifecycle",
    "lifecycle",
    "lifecycle",
    "user",
    "lifecycle",
  ]);
  expect(history.runningAt(data.activity!, 3)).toBe(false);
  expect(history.runningAt(data.activity!, 5)).toBe(true);
  expect(history.runningAt(data.activity!, 6)).toBe(true);
  expect(history.runningAt(data.activity!, 8)).toBe(false);
  expect(history.runningAt([], 8)).toBeNull();
});

test("Claude end-turn and duration signals stop play without marking tool waits idle", () => {
  const data = history.decode(
    jsonl(
      { type: "user", uuid: "u", message: { content: "Fix the tests" } },
      {
        type: "assistant",
        message: {
          id: "a",
          content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "bun test" } }],
          stop_reason: "tool_use",
        },
      },
      {
        type: "assistant",
        message: { id: "b", content: [{ type: "text", text: "The tests pass" }], stop_reason: "end_turn" },
      },
      { type: "user", uuid: "v", message: { content: "Continue" } },
      { type: "system", subtype: "turn_duration" },
    ),
    "claude",
  );
  expect([1, 2, 3, 4, 5].map(line => history.runningAt(data.activity!, line))).toEqual([
    true,
    true,
    false,
    true,
    false,
  ]);
});

test("Claude repeated message blocks and streaming usage count once; cache creation belongs to input", () => {
  const row = (output: number) => ({
    type: "assistant",
    uuid: "u",
    message: {
      id: "m",
      content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "git status" } }],
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 7,
        output_tokens: output,
        output_tokens_details: { thinking_tokens: 4 },
      },
    },
  });
  const data = history.decode(jsonl(row(5), row(9), row(9)), "claude");
  expect(data.events).toHaveLength(1);
  expect(data.receipts.reduce((n, r) => history.add(n, r.tokens), history.zero())).toEqual({
    input: "30",
    cached: "20",
    output: "9",
  });
});

test("Codex response receipts exclude the duplicate token_count transport and reasoning subtotal", () => {
  const usage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 10 };
  const data = history.decode(
    jsonl(
      {
        type: "response_item",
        payload: { type: "function_call", call_id: "t", name: "exec", arguments: "git rebase" },
      },
      { type: "token_usage_record", payload: { response_id: "r", usage } },
      { type: "token_usage_record", payload: { response_id: "r", usage } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } },
    ),
    "codex",
  );
  expect(data.receipts).toHaveLength(1);
  expect(history.total(data.receipts[0].tokens)).toBe(120n);
});

test("usage before a generating action remains unassigned", () => {
  const data = history.decode(
    jsonl({ type: "token_usage_record", payload: { response_id: "r", usage: { input_tokens: 10, output_tokens: 5 } } }),
    "codex",
  );
  expect(data.receipts[0].event).toBeNull();
  expect(plan.ledger(plan.empty(), data, 0).known).toBe(false);
  expect(plan.ledger(plan.empty(), data, 1).known).toBe(true);
});

test("a later Codex compaction does not add usage to the completed action", () => {
  const data = history.decode(
    jsonl(
      { type: "event_msg", payload: { type: "task_started", turn_id: "commit" } },
      {
        type: "response_item",
        payload: { type: "function_call", call_id: "t", name: "exec", arguments: "git commit" },
      },
      {
        type: "token_usage_record",
        payload: { response_id: "commit-response", turn_id: "commit", usage: { input_tokens: 100, output_tokens: 20 } },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "commit" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "next" } },
      {
        type: "token_usage_record",
        payload: { response_id: "compact-response", turn_id: "next", usage: { input_tokens: 200, output_tokens: 30 } },
      },
      { type: "compacted", payload: { compaction_response_id: "compact-response" } },
      {
        type: "token_usage_record",
        payload: {
          response_id: "commit-response",
          turn_id: "commit",
          usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 },
        },
      },
    ),
    "codex",
  );
  expect(data.receipts.map(r => r.event)).toEqual([1, null, 1]);
  const ledger = plan.ledger({ nodes, spans: [{ from: 1, to: 3, node: "s" }], through: 3 }, data);
  expect(ledger.counts.s).toEqual({ input: "100", cached: "80", output: "20" });
  expect(history.total(ledger.unattributed)).toBe(230n);
  expect(history.total(ledger.observed)).toBe(350n);
});

test("in-turn compaction receipts are unassigned and later work establishes a fresh anchor", () => {
  const usage = { input_tokens: 100, output_tokens: 20 };
  const tool = (id: string) => ({
    type: "response_item",
    payload: { type: "function_call", call_id: id, name: "exec", arguments: "run tests" },
  });
  const data = history.decode(
    jsonl(
      tool("before"),
      { type: "token_usage_record", payload: { response_id: "work", usage } },
      { type: "token_usage_record", payload: { response_id: "compact", usage } },
      { type: "compacted", payload: { compaction_response_id: "compact" } },
      { type: "token_usage_record", payload: { response_id: "unobserved", usage } },
      tool("after"),
      { type: "token_usage_record", payload: { response_id: "more-work", usage } },
    ),
    "codex",
  );
  expect(data.receipts.map(r => r.event)).toEqual([1, null, null, 3]);
  expect(data.receipts.reduce((sum, r) => sum + history.total(r.tokens), 0n)).toBe(480n);
});

test("large counters use decimal bigint strings and unsafe JSON numbers fail", () => {
  const row = (input: string | number) => ({
    type: "token_usage_record",
    payload: { response_id: "r", usage: { input_tokens: input, output_tokens: "1" } },
  });
  expect(history.decode(jsonl(row("9007199254740993")), "codex").receipts[0].tokens.input).toBe("9007199254740993");
  expect(() => history.decode(jsonl(row(9007199254740993)), "codex")).toThrow("InvalidTokenCount");
});

test("legacy Codex counters exclude pre-existing history and repeated totals", () => {
  const record = (input: number, last: number) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input, output_tokens: 0 },
        last_token_usage: { input_tokens: last, output_tokens: 0 },
      },
    },
  });
  const data = history.decode(jsonl(record(1000, 100), record(1000, 100), record(1200, 200)), "codex");
  expect(data.receipts.reduce((n, r) => n + history.total(r.tokens), 0n)).toBe(300n);
  expect(data.warnings.some(w => w.startsWith("Partial opening"))).toBe(true);
});

test("Claude usage arriving before a tool attaches to that response once observed", () => {
  const usage = { input_tokens: 100, output_tokens: 5 };
  const data = history.decode(
    jsonl(
      { type: "assistant", message: { id: "m", content: [{ type: "thinking" }], usage } },
      {
        type: "assistant",
        message: {
          id: "m",
          content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "git rebase" } }],
          usage,
        },
      },
    ),
    "claude",
  );
  expect(data.receipts).toHaveLength(1);
  expect(data.receipts[0].event).toBe(1);
  expect(history.total(plan.ledger(plan.empty(), data, 1).unattributed)).toBe(105n);
});

test("source line numbers survive blank JSONL lines", () => {
  const data = history.decode(
    "\n" + jsonl({ type: "user", uuid: "u", message: { content: "Fix the tests" } }),
    "claude",
  );
  expect(data.events[0].line).toBe(2);
});

test("a delayed cached-input subtotal is retained without charging extra tokens", () => {
  const receipt = (cached: number) => ({
    type: "token_usage_record",
    payload: { response_id: "r", usage: { input_tokens: 100, cached_input_tokens: cached, output_tokens: 20 } },
  });
  const data = history.decode(jsonl(receipt(0), receipt(80)), "codex");
  const sum = data.receipts.reduce((n, r) => history.add(n, r.tokens), history.zero());
  expect(sum).toEqual({ input: "100", cached: "80", output: "20" });
  expect(history.total(sum)).toBe(120n);
});

test("explicit plans are signals, and encrypted reasoning is not fabricated", () => {
  const data = history.decode(
    jsonl(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "p",
          name: "update_plan",
          arguments: '{"plan":[{"step":"Run tests","status":"pending"}]}',
        },
      },
      { type: "response_item", payload: { type: "reasoning", encrypted_content: "opaque" } },
    ),
    "codex",
  );
  expect(data.events.map(e => e.kind)).toEqual(["plan"]);
});

test("task notices and compaction summaries do not become user goals", () => {
  const data = history.decode(
    jsonl(
      { type: "user", uuid: "a", message: { content: "<task-notification>build failed</task-notification>" } },
      { type: "user", uuid: "b", message: { content: "This session is being continued from a previous conversation" } },
      { type: "user", uuid: "c", message: { content: "Fix the CI build" } },
    ),
    "claude",
  );
  expect(data.events.map(e => [e.kind, e.turn])).toEqual([
    ["lifecycle", 0],
    ["lifecycle", 0],
    ["user", 1],
  ]);
});

test("a patch cannot cite future evidence, move history, skip coverage or assign planned work", () => {
  const before = state(),
    saved = structuredClone(before),
    next = [{ ...events[1], id: 3, line: 3 }];
  const change = (node: plan.Node, spans = [{ from: 3, to: 3, node: "s" }]) =>
    plan.apply(before, JSON.stringify({ nodes: [node], spans }), next);
  expect(() => change({ ...nodes[1], evidence: [4] })).toThrow("InvalidEvidence");
  expect(() => change({ ...nodes[1], parent: null })).toThrow("MovedHistory");
  expect(() => change({ ...nodes[1], state: "planned" })).toThrow("InvalidAssignment");
  expect(() => change(nodes[1], [{ from: 4, to: 4, node: "s" }])).toThrow("InvalidCoverage");
  expect(before).toEqual(saved);
});

test("hierarchy cannot contain cycles, top-level steps or nested steps", () => {
  for (const invalid of [
    [{ ...nodes[0], parent: "s" }, nodes[1]],
    [nodes[0], { ...nodes[1], parent: null }],
    [...nodes, { ...nodes[1], id: "s2", parent: "s" }],
    [...nodes, { ...nodes[0], id: "e2", parent: "e" }],
  ])
    expect(() => plan.apply(plan.empty(), JSON.stringify({ ...patch, nodes: invalid }), events)).toThrow(
      "InvalidHierarchy",
    );
});

test("tokens roll up without adding cache reads twice, and respect observation time", () => {
  const data: history.History = {
    source: "test",
    provider: "codex",
    sha256: "test",
    warnings: [],
    events,
    receipts: [
      { id: "r", event: 2, line: 2, tokens: { input: "100", cached: "80", output: "20" } },
      { id: "missing", event: null, line: 3, tokens: { input: "50", cached: "0", output: "5" } },
    ],
  };
  const s = state(),
    all = plan.ledger(s, data),
    prefix = plan.ledger(s, data, 2);
  expect(history.total(all.counts.e)).toBe(120n);
  expect(history.total(all.counts.s)).toBe(120n);
  expect(history.total(all.observed)).toBe(175n);
  expect(history.total(all.unattributed)).toBe(55n);
  expect(history.total(prefix.observed)).toBe(120n);
  expect(score.score(data, [s], []).every(c => c.pass)).toBe(true);
});

test("scorer requires both anchors; two unassigned events never pass same episode", () => {
  const data: history.History = {
    source: "test",
    provider: "codex",
    sha256: "test",
    warnings: [],
    events,
    receipts: [],
  };
  const results = score.score(data, [], [{ name: "same", kind: "same_episode", a: 1, b: 2 }]);
  expect(results.find(r => r.name === "same")?.pass).toBe(false);
});

test("an ordinary result may share a step with an earlier real setback", () => {
  const data: history.History = {
    source: "test",
    provider: "codex",
    sha256: "test",
    warnings: [],
    events,
    receipts: [],
  };
  const current = state();
  current.nodes[1].bump = { kind: "conflict", state: "resolved", detail: "Earlier import conflict", evidence: [1, 2] };
  const check: score.Check = { name: "normal output", kind: "no_bump_started", from: 2, to: 2 };
  expect(score.score(data, [current], [check]).find(c => c.name === check.name)?.pass).toBe(true);
  current.nodes[1].bump = {
    kind: "verification",
    state: "open",
    detail: "Invented failure from empty grep",
    evidence: [2],
  };
  expect(score.score(data, [current], [check]).find(c => c.name === check.name)?.pass).toBe(false);
});

test("batching cuts before user steering and does not see the next prefix", () => {
  const more = [...events, { ...events[0], id: 3, line: 3, turn: 2 }];
  expect(plan.batches(more, 24).map(b => b.map(e => e.id))).toEqual([[1, 2], [3]]);
  expect(() => plan.batches(more, 0)).toThrow("InvalidBatchSize");
});

test("a correct final title cannot rescue a missed recognition deadline", () => {
  const before = state();
  before.nodes[0] = { ...before.nodes[0], title: "Inspect repository files" };
  const after = plan.apply(before, JSON.stringify({ nodes: [nodes[0]], spans: [{ from: 3, to: 3, node: "s" }] }), [
    { ...events[1], id: 3, line: 3 },
  ]).state;
  const data: history.History = {
    source: "test",
    provider: "codex",
    sha256: "test",
    warnings: [],
    events: [...events, { ...events[1], id: 3, line: 3 }],
    receipts: [],
  };
  const checks = score.score(
    data,
    [before, after],
    [
      { name: "early", kind: "topic", event: 2, at: 2, level: "episode", pattern: "branch" },
      { name: "final", kind: "topic", event: 2, level: "episode", pattern: "branch" },
    ],
  );
  expect(checks.find(c => c.name === "early")?.pass).toBe(false);
  expect(checks.find(c => c.name === "final")?.pass).toBe(true);
});

test("different-episode checks distinguish separate outcomes from steps in one episode", () => {
  const data = history.decode(
    jsonl(
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Repair queue" }] },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Change footer" }] },
      },
    ),
    "codex",
  );
  const current = state();
  current.nodes.push({ ...nodes[1], id: "s2" });
  current.spans = [
    { from: 1, to: 1, node: "s" },
    { from: 2, to: 2, node: "s2" },
  ];
  const check: score.Check = { name: "separate outcomes", kind: "different_episode", a: 1, b: 2 };
  expect(score.score(data, [current], [check]).find(c => c.name === check.name)?.pass).toBe(false);
  current.nodes.push({ ...nodes[0], id: "e2" });
  current.nodes.find(n => n.id === "s2")!.parent = "e2";
  expect(score.score(data, [current], [check]).find(c => c.name === check.name)?.pass).toBe(true);
});

test("a finished turn closes active work but keeps the latest open problem and planned steps open", () => {
  const at = (id: number, kind: Event["kind"], text: string): Event => ({ id, line: id, at: "", turn: 1, kind, text });
  const node = (id: string, parent: string | null, state: string, extra = {}) => ({
    id,
    parent,
    kind: parent ? "step" : "episode",
    title: `Work on ${id}`,
    subtitle: `Subtitle for ${id}`,
    state,
    evidence: [1],
    ...extra,
  });
  const patch = JSON.stringify({
    nodes: [
      node("e1", null, "active"),
      node("s1", "e1", "active"),
      node("e2", null, "active"),
      node("s2", "e2", "active", {
        bump: { kind: "verification", state: "open", detail: "Suite fails", evidence: [1] },
      }),
      node("e3", null, "active"),
      node("s3", "e3", "active"),
      node("s4", "e3", "planned"),
      // Work moved past this problem, so it no longer reads as stuck.
      node("e4", null, "active"),
      node("s5", "e4", "active", {
        bump: { kind: "environment", state: "open", detail: "Command refused", evidence: [1] },
      }),
    ],
    spans: [
      { from: 1, to: 1, node: "s5" },
      { from: 2, to: 2, node: "s2" },
    ],
  });
  const state = (last: Event) =>
    Object.fromEntries(
      plan.apply(plan.empty(), patch, [at(1, "tool", "run"), last]).state.nodes.map(n => [n.id, n.state]),
    );
  expect(state(at(2, "result", "ok"))).toMatchObject({ e1: "active", s1: "active" });
  const ended = {
    e1: "done",
    s1: "done",
    e2: "active",
    s2: "active",
    e3: "active",
    s3: "done",
    s4: "planned",
    e4: "done",
    s5: "done",
  };
  expect(state(at(2, "lifecycle", "turn_duration"))).toEqual(ended);
  expect(state(at(2, "assistant", "Turn 3; lifecycle: idle\nRecent completed tools"))).toEqual(ended);
  expect(state(at(2, "lifecycle", "turn_aborted"))).toMatchObject({ e1: "active", s1: "active" });
});
