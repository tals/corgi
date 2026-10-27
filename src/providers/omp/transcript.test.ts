import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Path, Text } from "../../agents";
import { Tail, Worker, Result, type Request } from "../../usage/worker";
import { transcript } from "./transcript";
import { Registry } from "../../conversations";
import type { Item } from "../../activity/checklist";
import { adapter } from "./index";

const lines = (...records: unknown[]) => records.map(record => JSON.stringify(record) + "\n").join("");
function request(file = ""): Request {
  const agent = new Agent({ provider: "omp" });
  agent.session = new Text("session");
  agent.transcript = new Path(file);
  return { actor: 1, workspace: 1, since: 0, agent, child: false, tracked_since: 0 };
}

test("OMP transcripts retain flat tool and token accounting without double-counting repeated messages", () => {
  const tail = new Tail(),
    req = request(),
    reader = transcript.reader(() => []);
  reader.open(tail, req, null, false);
  const response = {
    type: "message",
    id: "response",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "read", name: "read", arguments: { path: "file" } },
        { type: "toolCall", id: "edit", name: "edit", arguments: { path: "file" } },
      ],
      usage: { input: 20, output: 5, cacheRead: 10 },
    },
  };
  const first = reader.record(tail, req, response, true, 1);
  expect(first.tools).toBe(2n);
  expect(tail.live.meter.value.tokens).toMatchObject({ input: 30n, cached_input: 10n, output: 5n });
  expect(reader.record(tail, req, response, true, 1).any()).toBe(false);
  expect(tail.live.meter.value.tokens.total()).toBe(35n);
});

test.each([false, true])(
  "OMP child transcripts preserve runner metadata while counting work, catch_up=%s",
  async catch_up => {
    const root = mkdtempSync(join(tmpdir(), "corgi-omp-child-metadata-"));
    try {
      const file = join(root, "child.jsonl");
      const registry = new Registry();
      const parent = registry.get("omp", "parent");
      registry.observeHook(
        parent,
        adapter.hook({
          event: "SubagentStart",
          session: "parent",
          subagent: "session",
          subagent_name: "UsagePersistenceAudit",
          subagent_type: "reviewer",
          description: "Audit usage persistence",
          child_transcript: file,
        })!,
        1n,
        false,
        1,
      );
      const child = registry.find("omp", "session")!;
      const req: Request = { ...request(file), actor: child.id, agent: child.state, child: true };
      const worker = new Worker();
      const header = lines({ type: "title", title: "Transcript title" }, { type: "session", id: "session" });
      const response = lines(
        { type: "session_info", name: "Transcript session name" },
        { type: "title_change", title: "Later transcript title" },
        {
          type: "message",
          id: "response",
          timestamp: "2026-10-27T03:37:42.318Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "**F3 clarification: yes, the missing state is specifically the saved timeline.**",
              },
              { type: "toolCall", id: "read", name: "read", arguments: { path: "src/usage/worker.ts" } },
            ],
            usage: { input: 20, output: 5, cacheRead: 10 },
          },
        },
      );
      writeFileSync(file, header + (catch_up ? response : ""));
      worker.requests = [req];
      await worker.run();
      for (const result of worker.take()) result.fallback(child.state, 2);
      expect(child.state.name.text()).toBe("UsagePersistenceAudit");
      if (!catch_up) {
        appendFileSync(file, response);
        await worker.run();
      }
      for (const result of worker.take()) result.fallback(child.state, 3);
      expect(child.state.name.text()).toBe("UsagePersistenceAudit");
      expect(child.state.activity.text()).toBe("Audit usage persistence");
      const usage = worker.watchers.get(child.id)!.live.meter.value;
      expect(usage.tokens).toMatchObject({ input: 30n, cached_input: 10n, output: 5n });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([false, true])("OMP native transcript intents reach child activities, catch_up=%s", async catch_up => {
  const root = mkdtempSync(join(tmpdir(), "corgi-omp-child-native-"));
  try {
    const file = join(root, "child.jsonl"),
      req = { ...request(file), child: true },
      worker = new Worker();
    req.agent.state = "working";
    req.agent.setTurn("child-turn");
    req.agent.setName("NativeChild");
    req.agent.setActivity("Runner task description");
    const header = lines({ type: "title", title: "Not the runner name" }, { type: "session", id: "session" }),
      response = lines({
        type: "message",
        id: "response",
        timestamp: "2026-10-27T03:37:42.318Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "This commentary must not become a native activity." },
            {
              type: "toolCall",
              id: "write",
              name: "write",
              arguments: { i: "Writing child native labels.", path: "file" },
            },
          ],
          usage: { input: 20, output: 5, cacheRead: 10 },
        },
      });
    writeFileSync(file, header + (catch_up ? response : ""));
    worker.requests = [req];
    await worker.run();
    for (const result of worker.take()) result.fallback(req.agent, Date.now() * 1000);
    if (!catch_up) {
      appendFileSync(file, response);
      await worker.run();
      for (const result of worker.take()) result.fallback(req.agent, Date.now() * 1000);
    }
    expect(req.agent.activity.text()).toBe("Writing child native labels");
    expect(req.agent.activity_at).toBe(Date.parse("2026-10-27T03:37:42.318Z") * 1000);
    expect(req.agent.name.text()).toBe("NativeChild");
    expect(worker.watchers.get(req.actor)!.live.meter.value.tokens).toMatchObject({
      input: 30n,
      cached_input: 10n,
      output: 5n,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OMP persisted native intent replaces inference without falling back to assistant commentary", () => {
  const tail = new Tail(),
    req = request(),
    reader = transcript.reader(() => []);
  reader.open(tail, req, null, false);
  req.agent.state = "working";
  req.agent.activity_inferred = true;
  req.agent.setActivity("An old inferred label");
  reader.record(
    tail,
    req,
    {
      type: "message",
      id: "native",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "earlier", arguments: { i: "Earlier intent" } },
          { type: "toolCall", id: "latest", intent: "Inspecting persisted native intent.", arguments: {} },
        ],
      },
    },
    true,
    1000,
  );
  reader.record(
    tail,
    req,
    {
      type: "message",
      id: "commentary",
      message: { role: "assistant", content: [{ type: "text", text: "Unrelated assistant commentary" }] },
    },
    true,
    2000,
  );
  const result = Object.assign(new Result(), { update: tail.update, update_at: tail.update_at });
  expect(result.fallback(req.agent, 3000000)).toBe(true);
  expect(req.agent.activity.text()).toBe("Inspecting persisted native intent");
  expect(req.agent.activity_at).toBe(1000000);
  expect(req.agent.activity_inferred).toBe(false);
  expect(result.fallback(req.agent, 3000001)).toBe(false);
});

test("OMP old completed messages and delayed tool-start persistence cannot clobber newer live child intent", () => {
  const tail = new Tail(),
    req = { ...request(), child: true },
    reader = transcript.reader(() => []);
  reader.open(tail, req, null, false);
  req.agent.state = "working";
  req.agent.setActivity("Writing a newer live file");
  req.agent.activity_at = 2500000;
  reader.record(
    tail,
    req,
    {
      type: "message",
      id: "completed",
      message: {
        role: "assistant",
        timestamp: 1000,
        content: [{ type: "toolCall", id: "old", intent: "Old completed native intent", arguments: {} }],
      },
    },
    true,
    3000,
  );
  const completed = Object.assign(new Result(), { update: tail.update, update_at: tail.update_at });
  expect(completed.update_at).toBe(1000000);
  expect(completed.fallback(req.agent, 4000000)).toBe(false);
  reader.record(
    tail,
    req,
    {
      type: "custom",
      customType: "tool_execution_start",
      data: {
        toolCallId: "old",
        toolName: "write",
        intent: "Older persisted execution",
        startedAt: "1970-01-01T00:00:02.000Z",
      },
    },
    true,
    4000,
  );
  const delayed = Object.assign(new Result(), { update: tail.update, update_at: tail.update_at });
  expect(delayed.update_at).toBe(2000000);
  expect(delayed.fallback(req.agent, 5000000)).toBe(false);
  expect(req.agent.activity.text()).toBe("Writing a newer live file");
  reader.record(
    tail,
    req,
    {
      type: "custom",
      customType: "tool_execution_start",
      data: {
        toolCallId: "next",
        toolName: "write",
        intent: "Writing current child output...",
        startedAt: "1970-01-01T00:00:03.000Z",
      },
    },
    true,
    5000,
  );
  const latest = Object.assign(new Result(), { update: tail.update, update_at: tail.update_at });
  expect(latest.fallback(req.agent, 6000000)).toBe(true);
  expect(req.agent.activity.text()).toBe("Writing current child output");
  expect(req.agent.activity_at).toBe(3000000);
  req.agent.state = "idle";
  latest.update_at = 7000000;
  expect(latest.fallback(req.agent, 8000000)).toBe(false);
  expect(req.agent.state).toBe("idle");
});

test("OMP missing or invalid native intents never replace runner labels with prose", () => {
  const tail = new Tail(),
    req = request(),
    reader = transcript.reader(() => []);
  reader.open(tail, req, null, false);
  req.agent.state = "working";
  req.agent.setActivity("Runner label");
  reader.record(
    tail,
    req,
    {
      type: "message",
      id: "no-intent",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Do not infer from this." },
          { type: "toolCall", id: "invalid", arguments: { i: 123 } },
        ],
      },
    },
    true,
    1000,
  );
  reader.record(
    tail,
    req,
    {
      type: "message",
      id: "no-timestamp",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "untimed", arguments: { i: "Cannot order this activity" } }],
      },
    },
    true,
    null,
  );
  const result = Object.assign(new Result(), { update: tail.update, update_at: tail.update_at });
  expect(result.fallback(req.agent, 3000000)).toBe(false);
  expect(req.agent.activity.text()).toBe("Runner label");
});

test.each([false, true])(
  "OMP checklist transcript catchup preserves updates and ignores errors/views, child=%s",
  child => {
    const tail = new Tail(),
      req = { ...request(), child },
      reader = transcript.reader(() => []);
    reader.open(tail, req, null, true);
    const phases = [{ name: "Build", tasks: [{ content: "Implement", status: "in_progress" }] }];
    const implement: Item[] = [{ text: "Implement", status: "active", group: "Build" }];
    const delta = reader.record(
      tail,
      req,
      { type: "custom", customType: "user_todo_edit", data: { phases } },
      false,
      1000,
    );
    expect(delta.any()).toBe(false);
    expect(tail.checklist?.items).toEqual(implement);
    expect(tail.checklist?.at).toBe(1000000);
    const result = (op: string, isError: boolean, phases: unknown) => ({
      type: "message",
      message: { role: "toolResult", toolName: "todo", isError, details: { op, phases } },
    });
    reader.record(tail, req, result("view", false, []), true, 2000);
    reader.record(tail, req, result("update", true, []), true, 3000);
    reader.record(tail, req, result("update", false, "invalid"), true, 4000);
    expect(tail.checklist?.items).toEqual(implement);
    reader.record(tail, req, result("clear", false, []), true, 5000);
    expect(tail.checklist?.items).toEqual([]);
    expect(tail.checklist?.at).toBe(5000000);
    reader.record(tail, req, result("update", false, phases), true, 4500);
    expect(tail.checklist?.items).toEqual([]);
    expect(tail.live.meter.value.tokens.total()).toBe(0n);
    expect(tail.update.len).toBe(0);
    expect(new Tail().checklist).toBeNull();
  },
);

test("OMP usage worker emits checklist-only updates and clears through the existing reader", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-omp-todos-"));
  const worker = new Worker();
  try {
    const file = join(root, "session.jsonl"),
      req = request(file);
    const phases = [{ name: "Work", tasks: [{ content: "Review", status: "pending" }] }];
    writeFileSync(
      file,
      lines(
        { type: "session", id: "session" },
        { type: "custom", customType: "user_todo_edit", timestamp: "2026-10-27T12:00:00.000Z", data: { phases } },
      ),
    );
    worker.requests = [req];
    await worker.run();
    expect(worker.take()[0].checklist?.items).toEqual([{ text: "Review", status: "pending", group: "Work" }]);
    appendFileSync(
      file,
      lines({
        type: "message",
        timestamp: "2026-10-27T12:00:01.000Z",
        message: { role: "toolResult", toolName: "todo", isError: false, details: { op: "clear", phases: [] } },
      }),
    );
    worker.requests = [req];
    await worker.run();
    const result = worker.take()[0];
    expect(result.checklist?.items).toEqual([]);
    expect(result.checklist?.at).toBe(Date.parse("2026-10-27T12:00:01.000Z") * 1000);
    expect(result.delta.any()).toBe(false);
  } finally {
    worker.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
