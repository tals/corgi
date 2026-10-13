import { test, expect } from "bun:test";
import { Agent, Text, toolActivity } from "./agents";
import { State } from "./observation";
import { Hooks } from "./providers/common";
import { Tail, completion } from "./transcript";
import * as worktrees from "./worktrees";
test("late receipts cannot read newer completions", () => {
  const s = new State();
  s.finish("completed", "transcript");
  const shown = s.completed;
  s.finish("completed", "protocol");
  s.acknowledge(shown);
  expect(s.unread()).toBe(true);
  s.acknowledge(s.completed);
  expect(s.unread()).toBe(false);
});
test("marking unread moves the receipt back one completion, and only once", () => {
  const a = new Agent();
  expect(a.markUnread()).toBe(false);
  a.beginTurn("a");
  a.endTurn("a", "completed", "protocol", 1);
  a.beginTurn("b");
  a.endTurn("b", "completed", "protocol", 2);
  a.acknowledge();
  expect(a.markUnread()).toBe(true);
  expect([a.observation.read, a.attention]).toEqual([1n, "finished"]);
  expect(a.markUnread()).toBe(false);
  expect(a.observation.read).toBe(1n);
});
test("starting work preserves unread receipt and stale stop cannot finish newer turn", () => {
  const a = new Agent();
  a.beginTurn("a");
  expect(a.endTurn("a", "completed", "protocol", 1)).toBe(true);
  a.beginTurn("b");
  expect(a.attention).toBe("finished");
  expect(a.endTurn("a", "completed", "protocol", 2)).toBe(false);
  expect(a.state).toBe("working");
});
test("Codex automatic review only blocks after visible permission confirmation", () => {
  const a = new Agent();
  const hook = new Hooks().decode({
    hook_event_name: "PermissionRequest",
    session_id: "s",
    tool_name: "Bash",
  });
  expect(a.observeHook("codex", hook, 1n, false, 1)).toBe(false);
  expect(a.state).toBe("working");
  expect(a.observePermissionPrompt(true, false, 2)).toBe(false);
  expect(a.observePermissionPrompt(true, false, 3)).toBe(true);
  expect(a.attention).toBe("needs_input");
  a.observePermissionPrompt(false, false, 4);
  expect(a.state).toBe("working");
});
test("tool descriptions and targets produce readable activity", () => {
  expect(toolActivity("Read", "", "/a/b.ts")).toBe("Reading b.ts");
  expect(toolActivity("Bash", "", "echo a")).toBe("");
  expect(toolActivity("WebFetch", "", "https://example.com/a")).toBe("Fetching example.com");
});
test("completion requires matching turn, fresh timestamp and complete JSONL record", () => {
  const a = new Agent({ provider: "codex", last_seq: 1000000n });
  a.setTurn("current");
  const good = JSON.stringify({
    type: "event_msg",
    timestamp: "1970-01-01T00:00:02.000Z",
    payload: { type: "task_complete", turn_id: "current" },
  });
  const t = new Tail();
  expect(t.ingest(a, good)).toBeNull();
  expect(t.ingest(a, "\n")).toBe("completed");
  a.setTurn("new");
  expect(completion(a, good)).toBeNull();
  a.setTurn("current");
  a.last_seq = 3000000n;
  expect(completion(a, good)).toBeNull();
});
test("Claude Stop hooks cancelled by Esc end the turn as interrupted", () => {
  const a = new Agent({ provider: "claude", last_seq: 1000000n });
  a.session.value = "s";
  const v = {
    type: "attachment",
    sessionId: "s",
    timestamp: "1970-01-01T00:00:02.000Z",
    attachment: { type: "hook_cancelled", hookEvent: "Stop", timedOut: false },
  };
  expect(completion(a, JSON.stringify(v))).toBe("interrupted");
  v.attachment.timedOut = true;
  expect(completion(a, JSON.stringify(v))).toBeNull();
});

function observe(agent: Agent, provider: "codex" | "claude", hook: any, seq: bigint, watched: boolean, now: number) {
  return agent.observeHook(
    provider,
    {
      turn: "",
      prompt: "",
      transcript: "",
      cwd: "",
      tool: "",
      description: "",
      target: "",
      model: "",
      asking: false,
      permission_notification: false,
      ...hook,
    },
    seq,
    watched,
    now,
  );
}
test("an answered Claude prompt ends its block without a hook", () => {
  const agent = new Agent();
  observe(agent, "claude", { kind: "tool_start", session: "a", tool: "Bash" }, 1n, false, 1);
  expect(observe(agent, "claude", { kind: "permission", session: "a", tool: "Bash" }, 2n, false, 2)).toBe(true);
  agent.observeAnswer("working", 3);
  expect(agent.state).toBe("working");
  expect(agent.attention).toBe("none");
  expect(agent.tool_active).toBe(true);
  agent.observeAnswer("idle", 4);
  expect(agent.state).toBe("working");
  observe(agent, "claude", { kind: "notification", session: "a", permission_notification: true }, 5n, false, 5);
  agent.observeAnswer("idle", 6);
  expect(agent.state).toBe("idle");
  expect(agent.tool_active).toBe(false);
  expect(agent.changed_at).toBe(6);
});
test("attention is edge triggered, sticky, ordered, and separate from activity", () => {
  const agent = new Agent(),
    working = { kind: "prompt", session: "a" },
    blocked = { kind: "permission", session: "a" },
    stopped = { kind: "stop", session: "a" };
  expect(observe(agent, "claude", working, 1n, false, 1)).toBe(false);
  expect(observe(agent, "claude", blocked, 2n, false, 2)).toBe(true);
  expect(observe(agent, "claude", blocked, 3n, false, 3)).toBe(false);
  expect(observe(agent, "claude", working, 2n, false, 4)).toBeNull();
  expect(agent.attention).toBe("needs_input");
  agent.acknowledge();
  expect(agent.state).toBe("blocked");
  observe(agent, "claude", working, 4n, false, 5);
  expect(observe(agent, "claude", stopped, 5n, false, 6)).toBe(false);
  expect(agent.state).toBe("working");
  expect(agent.confirmStop(5n, "completed", 7)).toBe(true);
  expect(agent.attention).toBe("finished");
  observe(agent, "claude", working, 6n, false, 8);
  expect(observe(agent, "claude", stopped, 7n, true, 9)).toBe(false);
});
test("stale-session hooks cannot corrupt parent state", () => {
  const agent = new Agent();
  agent.session = Text.ascii("parent");
  expect(observe(agent, "codex", { kind: "stop", session: "child" }, 10n, false, 10)).toBeNull();
  expect(agent.state).toBe("unknown");
});
test("working hooks leave activity empty for the viewer animation", () => {
  const agent = new Agent();
  observe(agent, "codex", { kind: "prompt", session: "parent" }, 1n, false, 1);
  expect(agent.state).toBe("working");
  expect(agent.activity.len).toBe(0);
  observe(agent, "codex", { kind: "tool_start", session: "parent", tool: "Bash" }, 2n, false, 2);
  expect(agent.tool_active).toBe(true);
  expect(agent.activity.len).toBe(0);
  observe(agent, "codex", { kind: "tool_finish", session: "parent", tool: "Bash" }, 3n, false, 3);
  expect(agent.state).toBe("working");
  agent.activity = Text.ascii("Tracing pane focus");
  observe(
    agent,
    "codex",
    {
      kind: "tool_start",
      session: "parent",
      tool: "Bash",
      description: "Run command",
    },
    4n,
    false,
    4,
  );
  expect(agent.activity.text()).toBe("Tracing pane focus");
  observe(agent, "codex", { kind: "tool_finish", session: "parent", tool: "Bash" }, 5n, false, 5);
  expect(agent.activity.text()).toBe("Tracing pane focus");
  observe(agent, "codex", { kind: "prompt", session: "parent" }, 6n, false, 6);
  expect(agent.activity.len).toBe(0);
});
test("compaction remains set until a subsequent lifecycle hook", () => {
  const agent = new Agent();
  let seq = 1;
  for (const kind of ["compact_end", "tool_start", "interrupt", "stop", "session_end"]) {
    observe(agent, "codex", { kind: "compact_start", session: "parent" }, BigInt(seq), false, seq);
    agent.subagents.waiting = true;
    agent.activity = Text.ascii("Old summary");
    expect(agent.compacting).toBe(true);
    observe(agent, "codex", { kind, session: "parent" }, BigInt(seq + 1), false, seq + 1);
    expect(agent.compacting).toBe(false);
    seq += 2;
  }
});
test("conversation state rejects identity replacement and uses a controlled clock", () => {
  const agent = new Agent(),
    working = { kind: "prompt", session: "a", turn: "turn-a" },
    stop = { kind: "stop", session: "a", turn: "turn-a" };
  observe(agent, "claude", working, 10n, false, 500);
  expect(agent.changed_at).toBe(500);
  expect(observe(agent, "claude", { kind: "session_start", session: "b" }, 11n, false, 600)).toBeNull();
  expect(agent.sessionId()).toBe("a");
  expect(agent.state).toBe("working");
  expect(agent.last_seq).toBe(10n);
  expect(observe(agent, "codex", stop, 12n, false, 650)).toBeNull();
  observe(agent, "claude", stop, 13n, false, 700);
  expect(agent.confirmStop(13n, "completed", 800)).toBe(true);
  expect(agent.changed_at).toBe(800);
  expect(agent.observation.completed).toBe(1n);
  expect(agent.confirmStop(13n, "completed", 900)).toBe(false);
  expect(agent.observation.completed).toBe(1n);
});
test("the turn epoch moves only when the turn changes", () => {
  const agent = new Agent();
  agent.setTurn("t1");
  const first = agent.turn_epoch;
  agent.setTurn("t1");
  observe(agent, "codex", { kind: "tool_start", session: "s", turn: "t1" }, 1n, false, 1);
  expect(agent.turn_epoch).toBe(first);
  agent.beginTurn("t2");
  expect(agent.turn_epoch).toBe(first + 1);
  agent.setTurn("t1");
  expect(agent.turn_epoch).toBe(first + 2);
  agent.reset();
  expect(agent.turn_epoch).toBe(first + 3);
  expect(agent.turnId()).toBe("");
});
test("Claude prompt ids key inferred labels without gating Stop", () => {
  const agent = new Agent();
  observe(agent, "claude", { kind: "prompt", session: "s", prompt: "p1" }, 1n, false, 10);
  expect(agent.turnId()).toBe("p1");
  observe(
    agent,
    "claude",
    {
      kind: "tool_start",
      session: "s",
      prompt: "p1",
      tool: "Read",
      target: "/a/b.zig",
    },
    2n,
    false,
    20,
  );
  expect(agent.activity.text()).toBe("Reading b.zig");
  agent.setActivity("Tracing hook routing");
  agent.activity_inferred = true;
  observe(
    agent,
    "claude",
    {
      kind: "tool_start",
      session: "s",
      prompt: "p1",
      tool: "Read",
      target: "/a/c.zig",
    },
    3n,
    false,
    30,
  );
  expect(agent.activity.text()).toBe("Tracing hook routing");
  observe(
    agent,
    "claude",
    {
      kind: "tool_start",
      session: "s",
      prompt: "p2",
      tool: "Read",
      target: "/a/d.zig",
    },
    4n,
    false,
    40,
  );
  expect(agent.turnId()).toBe("p2");
  expect(agent.activity.text()).toBe("Reading d.zig");
  expect(observe(agent, "claude", { kind: "stop", session: "s", prompt: "p1" }, 5n, false, 50)).not.toBeNull();
  expect(agent.observation.pending_stop).toBe(true);
});
test("a reopened agent sleeps, and its old process's late ending is dropped", () => {
  const agent = new Agent();
  agent.provider = "claude";
  agent.session = Text.ascii("s");
  observe(agent, "claude", { kind: "prompt", session: "s" }, 10n, false, 10);
  agent.reopened(100);
  expect(agent.state).toBe("idle");
  expect(observe(agent, "claude", { kind: "session_end", session: "s" }, 50n, false, 120)).toBeNull();
  expect(agent.state).toBe("idle");
  observe(agent, "claude", { kind: "session_start", session: "s" }, 150n, false, 150);
  expect(agent.state).toBe("idle");
  observe(agent, "claude", { kind: "prompt", session: "s" }, 160n, false, 160);
  expect(agent.state).toBe("working");
});

test("Codex permission review only rings for a confirmed human prompt", () => {
  const agent = new Agent();
  expect(observe(agent, "codex", { kind: "permission", session: "a", tool: "Bash" }, 1n, false, 1)).toBe(false);
  expect(agent.state).toBe("working");
  expect(agent.attention).toBe("none");
  expect(agent.tool_active).toBe(true);
  for (let i = 0; i < 4; i++) expect(agent.observePermissionPrompt(false, false, 2)).toBe(false);
  expect(agent.observePermissionPrompt(true, false, 3)).toBe(false);
  expect(agent.observePermissionPrompt(true, false, 4)).toBe(true);
  expect(agent.state).toBe("blocked");
  expect(agent.attention).toBe("needs_input");
  expect(agent.observePermissionPrompt(true, false, 5)).toBe(false);
  expect(agent.observePermissionPrompt(false, false, 6)).toBe(false);
  expect(agent.state).toBe("working");
  expect(agent.attention).toBe("none");
  expect(observe(agent, "codex", { kind: "tool_finish", session: "a", tool: "Bash" }, 7n, false, 7)).toBe(false);
  expect(agent.permission_review).toBeNull();
  expect(agent.observePermissionPrompt(true, false, 8)).toBe(false);
  expect(agent.observePermissionPrompt(true, false, 9)).toBe(false);
  expect(observe(agent, "codex", { kind: "tool_start", session: "a", asking: true }, 10n, false, 10)).toBe(true);
  expect(agent.state).toBe("blocked");
});
test("Claude tool hooks label activity from descriptions or main arguments", () => {
  for (const [tool, description, target, label] of [
    ["Bash", "Run unit tests", "zig build test", "Run unit tests"],
    ["Bash", " ", "zig build test", ""],
    ["Read", "", "/repo/src/server.zig", "Reading server.zig"],
    ["WebFetch", "", "https://docs.example.com/a/b", "Fetching docs.example.com"],
    ["TodoWrite", "", "", "Updating todos"],
    ["mcp__github__search_issues", "", "bug", "search_issues bug"],
  ])
    expect(toolActivity(tool, description, target)).toBe(label);
  expect(toolActivity("Grep", "", "x".repeat(300)).length).toBe(160);
  const agent = new Agent();
  observe(agent, "claude", { kind: "prompt", session: "s" }, 1n, false, 10);
  expect(agent.activity.len).toBe(0);
  observe(agent, "claude", { kind: "tool_start", session: "s", tool: "Grep", target: "routeHook" }, 2n, false, 20);
  expect(agent.activity.text()).toBe("Searching for routeHook");
  expect(agent.activity_at).toBe(20);
  observe(agent, "claude", { kind: "tool_finish", session: "s", tool: "Grep" }, 3n, false, 30);
  expect(agent.activity.text()).toBe("Searching for routeHook");
  observe(
    agent,
    "claude",
    {
      kind: "tool_start",
      session: "s",
      tool: "Bash",
      target: "zig build test --summary all",
    },
    4n,
    false,
    40,
  );
  expect(agent.activity.len).toBe(0);
  expect(agent.tool_active).toBe(true);
  const codex = new Agent();
  observe(
    codex,
    "codex",
    {
      kind: "tool_start",
      session: "c",
      tool: "Bash",
      description: "Run tests",
    },
    1n,
    false,
    10,
  );
  expect(codex.activity.len).toBe(0);
  agent.setActivity("First line\x1b[2J\nsecond");
  expect(agent.activity.text()).toBe("First line [2J");
});

test("Claude's worktree tools move its location past earlier writes", () => {
  const hooks = new Hooks(),
    agent = new Agent(),
    finish = (tool: string, cwd: string, tool_input: object, tool_response: object) =>
      hooks.decode({
        hook_event_name: "PostToolUse",
        session_id: "s",
        tool_name: tool,
        cwd,
        tool_input,
        tool_response,
      });
  observe(agent, "claude", { kind: "prompt", session: "s", cwd: "/repo" }, 1n, false, 1);
  observe(agent, "claude", finish("Write", "/repo", { file_path: "/tmp/scratch/page.html" }, {}), 2n, false, 2);
  expect(worktrees.writtenPaths(agent)).toEqual(["/tmp/scratch/page.html"]);
  const review = "/repo/.claude/worktrees/review";
  observe(agent, "claude", finish("EnterWorktree", review, { name: "review" }, { worktreePath: review }), 3n, false, 3);
  expect(worktrees.observedDirectory(agent)).toBe(review);
  expect(worktrees.writtenPaths(agent)).toEqual([]);
  observe(agent, "claude", finish("Edit", review, { file_path: "src/a.ts" }, {}), 4n, false, 4);
  expect(worktrees.observed(agent)).toEqual({
    cwd: review,
    writes: [`${review}/src/a.ts`],
    ran: [review],
    basis: "moved",
  });
  observe(agent, "claude", finish("ExitWorktree", "/repo", { action: "keep" }, { restoredCwd: "/repo" }), 5n, false, 5);
  expect(worktrees.observedDirectory(agent)).toBe("/repo");
  expect(worktrees.writtenPaths(agent)).toEqual([]);
});
test("hook sequences preserve distinct integers beyond number precision", () => {
  const agent = new Agent();
  const seq = 9007199254740992n;
  const working = { kind: "prompt_submit", session: "a" };
  const stopped = { kind: "stop", session: "a" };
  expect(observe(agent, "claude", working, seq, false, 1)).toBe(false);
  expect(observe(agent, "claude", stopped, seq + 1n, false, 2)).toBe(false);
  expect(agent.last_seq).toBe(seq + 1n);
  expect(agent.confirmStop(seq, "completed", 3)).toBe(false);
  expect(agent.confirmStop(seq + 1n, "completed", 3)).toBe(true);
  agent.reopened(4);
  expect(agent.last_seq).toBe(seq + 1n);
});

test("the work clock starts on working, holds while blocked and clears at rest", () => {
  const a = new Agent({ state: "working" });
  expect(a.trackWorking(100)).toBe(true);
  expect(a.working_since).toBe(100);
  a.state = "blocked";
  expect(a.trackWorking(200)).toBe(false);
  expect(a.working_since).toBe(100);
  a.state = "idle";
  expect(a.trackWorking(300)).toBe(true);
  expect(a.working_since).toBe(0);
  a.state = "working";
  a.trackWorking(400);
  expect(a.working_since).toBe(400);
});

test("reopening a small hook sequence retains bigint ordering", () => {
  const agent = new Agent({ last_seq: 1n });
  agent.reopened(10);
  expect(agent.last_seq).toBe(10n);
  expect(observe(agent, "claude", { kind: "prompt", session: "a" }, 10n, false, 11)).toBeNull();
  expect(observe(agent, "claude", { kind: "prompt", session: "a" }, 11n, false, 12)).toBe(false);
  expect(agent.last_seq).toBe(11n);
});
