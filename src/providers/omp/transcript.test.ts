import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Path, Text } from "../../agents";
import * as todos from "../../activity/todos";
import * as json from "../../json";
import { Tail, Worker, type Request } from "../../usage/worker";
import { transcript } from "./transcript";
import { transcript as pi } from "../pi/transcript";

const phases: todos.Phase[] = [
  {
    name: "Implement",
    tasks: [
      { content: "Inspect", status: "completed" },
      { content: "Transport", status: "in_progress" },
      { content: "Wait", status: "blocked", blocker: "Credentials" },
      { content: "Old approach", status: "abandoned" },
      { content: "Review", status: "pending" },
    ],
  },
];
const committed = (phases: unknown) => ({
  type: "message",
  message: { role: "toolResult", toolName: "todo", details: { op: "update", phases } },
});
const lines = (...records: unknown[]) => records.map(record => JSON.stringify(record) + "\n").join("");
function request(file = ""): Request {
  const agent = new Agent({ provider: "omp" });
  agent.session = new Text("session");
  agent.transcript = new Path(file);
  return { actor: 1, workspace: 1, since: 0, agent, child: false, tracked_since: 0 };
}

test.each(["omp", "pi"] as const)("%s counts each response and parallel tool independently of tokens", provider => {
  const tail = new Tail(),
    req = request(),
    reader = (provider === "omp" ? transcript : pi).reader(() => []);
  req.agent.provider = provider;
  reader.open(tail, req, null, false);
  expect(tail.live.meter.value.counts_known).toBe(true);
  const response = (id: string, tools: string[]) => ({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: tools.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: "file" } })),
    },
  });
  reader.record(tail, req, response("inherited", ["old"]), false, 1);
  req.agent.setTurn("one-user-turn");
  const first = response("response-1", ["a", "b"]);
  reader.record(tail, req, first, true, 2);
  reader.record(tail, req, first, true, 2);
  reader.record(tail, req, response("response-2", ["c"]), true, 3);
  reader.record(tail, req, { type: "message", message: { role: "toolResult", toolCallId: "a" } }, true, 4);
  expect(tail.live.meter.value.turns).toBe(2n);
  expect(tail.live.meter.value.tools).toBe(3n);
  expect(tail.live.meter.value.known).toBe(false);
  reader.record(tail, req, { ...first, message: { ...first.message, usage: { input: 10, output: 2 } } }, true, 5);
  expect(tail.live.meter.value.turns).toBe(2n);
  expect(tail.live.meter.value.tools).toBe(3n);
  expect(tail.live.meter.value.tokens.total()).toBe(12n);
});

test("OMP replays full committed todo snapshots, not requested tool arguments or view output", () => {
  const tail = new Tail(),
    req = request(),
    reader = transcript.reader(() => []);
  tail.initial_until = 1 << 20;
  tail.ingest(req, reader, lines(committed(phases)), 0);
  expect(tail.todo_phases).toEqual(phases);
  expect(tail.todos_dirty).toBe(true);
  const retained = tail.todo_phases;
  for (const record of [
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "todo", arguments: { phases: [] } }] },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "todo", isError: true, details: { op: "update", phases: [] } },
    },
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { op: "view", phases: [] } } },
    { type: "message", message: { role: "toolResult", toolName: "other", details: { op: "update", phases: [] } } },
    { type: "custom", customType: "other", data: { phases: [] } },
    committed(null),
    committed([{ name: "Bad", tasks: [{ content: "Bad status", status: "done" }] }]),
    committed([{ name: "Bad", tasks: [{ status: "pending" }] }]),
    committed([{ name: "Bad", tasks: "not tasks" }]),
    { type: "custom", customType: "user_todo_edit", data: { phases: [{}] } },
  ]) {
    tail.todos_dirty = false;
    tail.ingest(req, reader, lines(record), 0);
    expect(tail.todo_phases).toBe(retained);
    expect(tail.todos_dirty).toBe(false);
  }
  tail.ingest(req, reader, "{broken json}\n", 0);
  expect(tail.todo_phases).toBe(retained);
});

test("OMP user edits and successful results replace the whole plan, and empty snapshots clear it", () => {
  const tail = new Tail(),
    req = request(),
    reader = transcript.reader(() => []),
    edited: todos.Phase[] = [{ name: "User plan", tasks: [{ content: "Changed", status: "pending" }] }];
  reader.record(tail, req, committed(phases), false, null);
  reader.record(tail, req, { type: "custom", customType: "user_todo_edit", data: { phases: edited } }, false, null);
  expect(tail.todo_phases).toEqual(edited);
  edited[0].tasks[0].content = "Changed outside the reader";
  expect(tail.todo_phases![0].tasks[0].content).toBe("Changed");
  reader.record(tail, req, committed([]), true, null);
  expect(tail.todo_phases).toEqual([]);
  reader.record(tail, req, committed({}), true, null);
  expect(tail.todo_phases).toEqual([]);
  reader.record(tail, req, committed(phases), true, null);
  expect(tail.todo_phases).toEqual(phases);
  reader.record(tail, req, { type: "custom", customType: "user_todo_edit", data: { phases: [] } }, true, null);
  expect(tail.todo_phases).toEqual([]);
  const other = new Tail();
  pi.reader(() => []).record(other, req, committed(phases), true, null);
  expect(other.todo_phases).toBeNull();
});

test("OMP publishes only the latest plan and context on discovery and handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-omp-todos-"));
  try {
    const file = join(root, "session.jsonl"),
      padding = lines({ type: "custom", customType: "padding", data: "x".repeat(16000) }),
      current: todos.Phase[] = [{ name: "Current", tasks: [{ content: "Finish", status: "in_progress" }] }],
      context = (used: number) => ({
        type: "custom",
        customType: "corgi-context",
        timestamp: "2026-10-25T01:34:46.322Z",
        data: { model: "gpt-6-astra", window: 272000, used },
      }),
      contents =
        lines({ type: "title", title: "Retained title" }, { type: "session", id: "session" }, committed(phases), {
          type: "message",
          id: "old",
          timestamp: "1970-01-01T00:00:01.000Z",
          message: { role: "assistant", usage: { input: 99, output: 7 } },
        }) +
        padding.repeat(24) +
        lines(context(10), committed(phases)) +
        padding.repeat(6) +
        lines(context(200), committed(current)),
      req = request(file),
      worker = new Worker();
    writeFileSync(file, contents);
    worker.requests = [req];
    await worker.run();
    const tail = worker.watchers.get(1)!,
      first = worker.take()[0];
    expect(first.todo_phases).toEqual(current);
    expect(first.context.used).toBe(200n);
    expect(first.name.text()).toBe("Retained title");
    expect(tail.live.meter.value.tokens.total()).toBe(0n);
    appendFileSync(file, lines({ type: "custom", customType: "user_todo_edit", data: { phases: [] } }));
    await worker.run();
    expect(worker.take()[0].todo_phases).toEqual([]);
    const saved = json.clone(worker.capture());
    const restored = Worker.restore(saved);
    restored.requests = [req];
    await restored.run();
    const recovered = restored.take()[0];
    expect(recovered.todo_phases).toEqual([]);
    expect(recovered.context.used).toBe(200n);
    appendFileSync(file, lines(committed(phases)));
    await restored.run();
    expect(restored.take()[0].todo_phases).toEqual(phases);
    appendFileSync(file, lines({ ...committed([]), message: { ...committed([]).message, isError: true } }));
    await restored.run();
    expect(restored.watchers.get(1)!.todo_phases).toEqual(phases);
    appendFileSync(file, lines(committed([])));
    await restored.run();
    expect(restored.take()[0].todo_phases).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("OMP finds a snapshot before the tail window, cleared=%s", async cleared => {
  const root = mkdtempSync(join(tmpdir(), "corgi-omp-todo-backwards-"));
  try {
    const file = join(root, "session.jsonl"),
      expected: todos.Phase[] = cleared
        ? []
        : [{ name: "跨块", tasks: [{ content: "Review 跨块 ".repeat(9000), status: "blocked", blocker: "Input" }] }],
      padding = lines({ type: "custom", customType: "padding", data: "x".repeat(16000) }),
      worker = new Worker();
    writeFileSync(
      file,
      lines({ type: "session", id: "session" }, committed(phases), {
        type: "custom",
        customType: "user_todo_edit",
        data: { phases: expected },
      }) +
        padding.repeat(24) +
        lines(
          committed({ malformed: true }),
          { ...committed(phases), message: { ...committed(phases).message, isError: true } },
          { ...committed(phases), message: { ...committed(phases).message, details: { op: "view", phases } } },
          {
            ...committed(phases),
            padding: "x".repeat(1024 * 1024),
          },
        ) +
        "{broken json}\n" +
        JSON.stringify(committed(phases)),
    );
    worker.requests = [request(file)];
    await worker.run();
    expect(worker.take()[0].todo_phases).toEqual(expected);
    appendFileSync(file, "\n");
    await worker.run();
    expect(worker.take()[0].todo_phases).toEqual(phases);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OMP discards stale todo state when a transcript is replaced, truncated, or rewritten in place", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-omp-todo-rewrite-"));
  try {
    const file = join(root, "session.jsonl"),
      replacement = join(root, "replacement.jsonl"),
      header = lines({ type: "session", id: "session" }),
      first: todos.Phase[] = [{ name: "First", tasks: [{ content: "Task", status: "pending" }] }],
      other: todos.Phase[] = [{ name: "Other", tasks: [{ content: "Task", status: "pending" }] }],
      req = request(file),
      worker = new Worker();
    worker.requests = [req];
    writeFileSync(file, header + lines(committed(first)));
    await worker.run();
    expect(worker.take()[0].todo_phases).toEqual(first);
    writeFileSync(file, header + lines(committed(other)));
    utimesSync(file, 10, 10);
    await worker.run();
    expect(worker.take()[0].todo_phases).toEqual(other);
    writeFileSync(file, header);
    await worker.run();
    expect(worker.take()[0].todo_phases).toEqual([]);
    appendFileSync(file, lines(committed(phases)));
    await worker.run();
    expect(worker.take()[0].todo_phases).toEqual(phases);
    writeFileSync(replacement, header + lines(committed({ malformed: true })));
    renameSync(replacement, file);
    await worker.run();
    expect(worker.take()[0].todo_phases).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
