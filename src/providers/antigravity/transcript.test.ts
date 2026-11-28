import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result as ActivityResult, Worker as SummaryWorker } from "../../activity/worker";
import { Agent, Text } from "../../agents";
import { Actor } from "../../conversations";
import { Terminal } from "../../pane/terminal";
import { Launch, Pane, Runtime } from "../../runtime";
import { Result, Tail, Worker, type Request } from "../../usage/worker";
import { Workspace } from "../../workspace";
import { directory } from "./config";
import { decode } from "./hooks";
import { database } from "./summaries";
import { transcript } from "./transcript";

test("Antigravity reads titles only for followed sessions in their owning account", async () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-agy-titles-")),
    runtime = new Runtime(),
    worker = new Worker(),
    pane = new Pane(1, Terminal.create(20, 4), home),
    parent = runtime.conversations.get("antigravity", "11111111-1111-4111-8111-111111111111"),
    child = runtime.conversations.get("antigravity", "22222222-2222-4222-8222-222222222222"),
    writers: Database[] = [];
  runtime.workspaces.items.push(new Workspace(1, home));
  runtime.panes.push(pane);
  parent.workspace = child.workspace = 1;
  child.parent = parent.id;
  pane.attachment.select(parent);
  const names = async () => {
    worker.reconcile(runtime);
    await worker.run();
    return worker.take().map(r => r.name.text());
  };
  try {
    for (const name of ["First", "Second"]) {
      const account = join(home, name);
      mkdirSync(directory(account), { recursive: true });
      const db = new Database(database(directory(account)));
      writers.push(db);
      // Reading the unrelated title fails the query, so a history-wide refresh loses the followed titles.
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE titles (conversation_id TEXT PRIMARY KEY, name TEXT);
        CREATE VIEW conversation_summaries AS SELECT conversation_id,
          CASE WHEN name IS NULL THEN json_extract('invalid', '$') ELSE name END AS title FROM titles;
        INSERT INTO titles VALUES ('unrelated', NULL);
      `);
      const insert = db.query("INSERT INTO titles VALUES (?,?)");
      insert.run(parent.state.sessionId(), name);
      insert.run(child.state.sessionId(), name + " child");
      pane.launch = new Launch({ provider: "antigravity", env: [["HOME", account]] });
      expect(await names()).toEqual([name, name + " child"]);
      db.query("UPDATE titles SET name=? WHERE conversation_id=?").run(name + " renamed", parent.state.sessionId());
      expect(await names()).toEqual([name + " renamed", name + " child"]);
    }
    child.parent = null;
    expect(await names()).toEqual(["Second renamed"]);
    expect(worker.reader("antigravity")?.name?.(child.state.sessionId(), join(home, "Second")).len).toBe(0);
    pane.attachment.deselect();
    expect(await names()).toEqual([]);
    expect(worker.reader("antigravity")?.name?.(parent.state.sessionId(), join(home, "Second")).len).toBe(0);
  } finally {
    worker.stop();
    runtime.destroy();
    for (const db of writers) db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

const session = "11111111-1111-4111-8111-111111111111";

test("Antigravity tool-only planner steps build evidence, finish on result steps, and populate the timeline", () => {
  const actor = new Actor({ id: 1, state: new Agent({ provider: "antigravity", session: new Text(session) }) }),
    summaries = new SummaryWorker(),
    tail = new Tail(),
    reader = transcript.reader(() => []),
    req: Request = { actor: actor.id, workspace: 1, since: 0, agent: actor.state, child: false, tracked_since: 0 };
  let seq = 0n;
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    actor.observeHook(
      decode({ conversationId: session, hookEventName: event, ...fields })!,
      ++seq,
      true,
      Number(seq) * 1000,
    );
  const append = (record: object) => tail.ingest(req, reader, JSON.stringify(record) + "\n", tail.initial_until + 1);
  try {
    hook("PreInvocation", { initialNumSteps: 1, invocationNum: 0 });
    append({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      created_at: "2026-11-28T17:00:00Z",
      tool_calls: [
        { name: "run_command", args: { CommandLine: "bun test", toolSummary: "Run unit tests" } },
        { name: "read_file", args: { Path: "/repo/src/providers/antigravity/transcript.ts" } },
      ],
    });
    expect(tail.progress.view().evidence.text()).toBe(
      "Currently running tools (not yet completed):\nrun_command: Run unit tests\nread_file: antigravity/transcript.ts\n",
    );
    // Replaying the same step does not flush its own pending calls.
    append({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      created_at: "2026-11-28T17:00:00Z",
      tool_calls: [
        { name: "run_command", args: { CommandLine: "bun test", toolSummary: "Run unit tests" } },
        { name: "read_file", args: { Path: "/repo/src/providers/antigravity/transcript.ts" } },
      ],
    });
    expect(tail.progress.view().running).toBe(2);
    // System messages do not complete pending tools.
    append({ step_index: 2, type: "SYSTEM_MESSAGE", source: "SYSTEM", content: "reminder" });
    expect(tail.progress.view().running).toBe(2);
    // Step 2 completes the first tool call while the second stays running.
    append({ step_index: 2, type: "GENERIC", source: "MODEL", status: "DONE", content: "ok" });
    expect(tail.progress.view().evidence.text()).toBe(
      "Currently running tools (not yet completed):\nread_file: antigravity/transcript.ts\nRecent completed tools (oldest to newest):\nrun_command: Run unit tests\n",
    );
    // A subsequent planner step flushes any earlier pending call whose result was missed,
    // and unwraps JSON-encoded string values from compact transcripts.
    append({
      step_index: 4,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      created_at: "2026-11-28T17:00:05Z",
      tool_calls: [{ name: "edit_file", args: { Path: '"/repo/src/providers/antigravity/transcript.ts"' } }],
    });
    expect(tail.progress.view().evidence.text()).toBe(
      "Currently running tools (not yet completed):\nedit_file: antigravity/transcript.ts\nRecent completed tools (oldest to newest):\nrun_command: Run unit tests\nread_file: antigravity/transcript.ts\n",
    );
    hook("PreToolUse", {
      toolCall: { name: "edit_file", args: { Path: "/repo/src/providers/antigravity/transcript.ts" } },
    });
    const usage = new Result();
    usage.progress = tail.progress.view();
    expect(usage.progress.commentary.len).toBe(0);
    expect(usage.fallback(actor.state, 10000)).toBe(true);
    summaries.submit(actor, usage.progress.commentary, usage.progress, []);
    const slot = summaries.slots.find(s => s?.request.actor === actor.id)!;
    expect(slot.ready(10000, false)).toBe(true);
    expect(slot.request.evidence.text()).toContain("edit_file: antigravity/transcript.ts");
    expect(new ActivityResult(slot.request, new Text("Fixing transcript progress")).apply(actor)).toBe(true);
    expect(actor.state.activity.text()).toBe("Fixing transcript progress");
    expect(actor.activity_timeline.points.map(p => p.label.text())).toEqual(["Fixing transcript progress"]);

    // A later turn starts a new timeline point.
    hook("Stop", { terminationReason: "NO_TOOL_CALL" });
    expect(actor.state.state).toBe("idle");
    hook("PreInvocation", { initialNumSteps: 6, invocationNum: 0 });
    summaries.reconcile([actor]);
    append({
      step_index: 6,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      created_at: "2026-11-28T17:01:00Z",
      tool_calls: [{ name: "run_command", args: { CommandLine: "bun test" } }],
    });
    const next = new Result();
    next.progress = tail.progress.view();
    expect(next.fallback(actor.state, 20000)).toBe(true);
    summaries.submit(actor, next.progress.commentary, next.progress, []);
    const second = summaries.slots.find(s => s?.request.actor === actor.id)!;
    expect(new ActivityResult(second.request, new Text("Running unit tests")).apply(actor)).toBe(true);
    expect(actor.activity_timeline.points.map(p => p.label.text())).toEqual([
      "Fixing transcript progress",
      "Running unit tests",
    ]);
  } finally {
    summaries.stop();
  }
});

test("Antigravity promotes tools opened mid-flight and handles commentary fallback rules", () => {
  const agent = new Agent({ provider: "antigravity", state: "working", session: new Text(session), activity_at: 1000 }),
    tail = new Tail(),
    reader = transcript.reader(() => []),
    req: Request = { actor: 1, workspace: 1, since: 0, agent, child: false, tracked_since: 0 };
  agent.setTurn("step-1");
  tail.initial_until = 500;
  // Tool call seen before initial_until stays silent until its result is appended.
  tail.ingest(
    req,
    reader,
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      tool_calls: [{ name: "search_web", args: { query: "antigravity hooks" } }],
    }) + "\n",
    0,
  );
  expect(tail.progress.view().evidence.len).toBe(0);
  tail.ingest(
    req,
    reader,
    JSON.stringify({ step_index: 2, type: "GENERIC", source: "MODEL", status: "DONE" }) + "\n",
    501,
  );
  expect(tail.progress.view().evidence.text()).toBe(
    "Recent completed tools (oldest to newest):\nsearch_web: antigravity hooks\n",
  );

  // Assistant text supplies prefixed commentary and yields to newer hooks or inferred labels.
  tail.ingest(
    req,
    reader,
    JSON.stringify({
      step_index: 3,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      created_at: "1970-01-01T00:00:02Z",
      content: "## Checking hooks\nMore detail",
    }) + "\n",
    600,
  );
  expect(tail.progress.view().commentary.text()).toBe("Latest agent update: ## Checking hooks\nMore detail");
  const result = new Result();
  result.progress = tail.progress.view();
  result.update = tail.update;
  result.update_at = tail.update_at;
  expect(result.fallback(agent, 3000000)).toBe(true);
  expect(agent.activity.text()).toBe("Checking hooks");
  agent.activity_inferred = true;
  agent.setActivity("Inferred label");
  result.update = new Text("Later text");
  result.update_at = 4000000;
  expect(result.fallback(agent, 5000000)).toBe(true);
  expect(agent.activity.text()).toBe("Inferred label");

  for (const mutate of [
    (a: Agent) => (a.state = "idle"),
    (_: Agent, r: Result) => (r.progress!.ended = true),
    (_: Agent, r: Result) => (r.progress!.turn = new Text("step-other")),
    (_: Agent, r: Result) => (r.progress!.turn = new Text()),
    (_: Agent, r: Result) => {
      r.progress!.commentary = new Text();
      r.progress!.evidence = new Text();
    },
    (_: Agent, r: Result) => (r.progress = null),
  ]) {
    const checkAgent = agent.snapshot(),
      checkResult = Object.assign(new Result(), { progress: tail.progress.view() });
    checkAgent.state = "working";
    mutate(checkAgent, checkResult);
    expect(checkResult.fallback(checkAgent, 5000000)).toBe(false);
  }
});
