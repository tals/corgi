import { test, expect } from "bun:test";
import { Session, PendingRequest, RequestId } from "./native";
import { Snapshot } from "./providers/codex/observer";
import { Text } from "./providers/common";
import { Registry } from "./conversations";
function session(provider: "codex" | "claude" = "codex") {
  const transport = new Session(1, provider, "/tmp");
  transport.ready = true;
  transport.agent().state = "idle";
  return transport;
}
function ingest(transport: Session, registry: Registry, value: any) {
  return transport.ingest(registry, JSON.stringify(value));
}
function start(transport: Session, registry: Registry, thread: string, turn: string) {
  return ingest(transport, registry, {
    method: "turn/started",
    params: { threadId: thread, turn: { id: turn } },
  });
}
function finish(transport: Session, registry: Registry, thread: string, turn: string) {
  return ingest(transport, registry, {
    method: "turn/completed",
    params: { threadId: thread, turn: { id: turn, status: "completed" } },
  });
}
test("native conversations retain independent turns and receipts across selection", () => {
  const registry = new Registry(),
    transport = session();
  ingest(transport, registry, { id: 1, result: { thread: { id: "a" } } });
  start(transport, registry, "a", "a1");
  ingest(transport, registry, { id: 2, result: { thread: { id: "b" } } });
  start(transport, registry, "b", "b1");
  const first = registry.find("codex", "a")!,
    second = registry.find("codex", "b")!;
  expect(transport.attachment.actor).toBe(second);
  expect(finish(transport, registry, "a", "a1")).toBe(true);
  expect(transport.attachment.actor).toBe(second);
  expect(second.state.state).toBe("working");
  expect(first.state.observation.completed).toBe(1n);
  expect(transport.status()).toBe("working");
  expect(finish(transport, registry, "a", "a1")).toBe(false);
  expect(transport.observation().completed).toBe(1n);
  transport.acknowledge();
  expect(first.state.observation.unread()).toBe(false);
});
test("native approval replies target their original conversation and duplicates stay singular", () => {
  const registry = new Registry(),
    transport = session();
  const request = {
    id: 9,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "a" },
  };
  ingest(transport, registry, request);
  ingest(transport, registry, request);
  expect(transport.approvals.length).toBe(1);
  ingest(transport, registry, { id: 2, result: { thread: { id: "b" } } });
  ingest(transport, registry, {
    id: 10,
    method: "item/tool/requestUserInput",
    params: { threadId: "b" },
  });
  transport.send(registry, { id: 9, result: { decision: "accept" } });
  expect(registry.find("codex", "a")!.state.state).toBe("working");
  expect(registry.find("codex", "b")!.state.state).toBe("blocked");
  expect(transport.attention()).toBe("needs_input");
  expect(transport.approvals.length).toBe(1);
});
test("restored requests decode their id and tool once", () => {
  const claude = PendingRequest.init(
    "claude",
    '{"type":"control_request","request_id":"9","request":{"subtype":"can_use_tool"}}',
    null,
  );
  expect(claude.tool).toBe(true);
  expect(claude.id!.eql(RequestId.init("9"))).toBe(true);
  expect(claude.id!.eql(RequestId.init(9))).toBe(false);
});
test("requests on two transports retain actor attention until both are resolved or disconnected", () => {
  const registry = new Registry(),
    first = session(),
    second = session();
  ingest(first, registry, {
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "a" },
  });
  ingest(second, registry, {
    id: 2,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "a" },
  });
  const actor = registry.find("codex", "a")!;
  expect(actor.pending_native_requests).toBe(2);
  first.send(registry, { id: 1, result: { decision: "accept" } });
  expect(actor.pending_native_requests).toBe(1);
  expect(actor.state.attention).toBe("needs_input");
  second.markExited();
  expect(actor.pending_native_requests).toBe(0);
  expect(actor.state.attention).toBe("none");
});
test("native duplicate sources share receipts and stale completions preserve the newer turn", () => {
  const registry = new Registry(),
    first = session(),
    second = session();
  start(first, registry, "a", "a1");
  start(second, registry, "a", "a1");
  expect(finish(first, registry, "a", "a1")).toBe(true);
  expect(finish(second, registry, "a", "a1")).toBe(false);
  start(first, registry, "a", "a2");
  expect(finish(second, registry, "a", "a1")).toBe(false);
  expect(registry.find("codex", "a")!.state.turnId()).toBe("a2");
  expect(registry.find("codex", "a")!.state.state).toBe("working");
});
test("Claude results without turn IDs deduplicate until the next activity", () => {
  const registry = new Registry(),
    transport = session("claude");
  ingest(transport, registry, {
    type: "assistant",
    session_id: "a",
    message: { content: [{ type: "text", text: "working" }] },
  });
  const result = { type: "result", session_id: "a", subtype: "success" };
  expect(ingest(transport, registry, result)).toBe(true);
  expect(ingest(transport, registry, result)).toBe(false);
  expect(transport.observation().completed).toBe(1n);
});
test("native children retain parent selection and own usage across duplicate sources", () => {
  const registry = new Registry(),
    transport = session();
  ingest(transport, registry, {
    method: "thread/started",
    params: { thread: { id: "parent" } },
  });
  ingest(transport, registry, {
    method: "thread/started",
    params: {
      thread: { id: "child", parentThreadId: "parent", agentRole: "Explorer" },
    },
  });
  const parent = registry.find("codex", "parent")!,
    child = registry.find("codex", "child")!;
  expect(transport.attachment.actor).toBe(parent);
  expect(child.parent).toBe(parent.id);
  expect(child.role.text()).toBe("Explorer");
  start(transport, registry, "child", "work");
  const usage = {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "child",
      tokenUsage: {
        total: { inputTokens: 1200, cachedInputTokens: 850, outputTokens: 120 },
        last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 },
      },
    },
  };
  ingest(transport, registry, usage);
  ingest(transport, registry, usage);
  expect(child.native_meter.meter.value.tokens.total()).toBe(120n);
  expect(child.native_meter.meter.value.tokens.cached_input).toBe(50n);
  expect(parent.native_meter.meter.value.tokens.total()).toBe(0n);
  expect(finish(transport, registry, "child", "work")).toBe(false);
  expect(child.state.observation.completed).toBe(1n);
});
test("native raw pipe transport initializes and retains bounded journal", async () => {
  const registry = new Registry();
  const transport = await Session.startWithOptions(1, "codex", "/tmp", {
    executable: process.execPath,
    args: [
      "-e",
      'for await (const line of console) { const v=JSON.parse(line); if(v.id==="__corgi_init") console.log(JSON.stringify({id:v.id,result:{}})); else if(v.id) console.log(JSON.stringify({id:v.id,result:{thread:{id:"raw"}}})); }',
    ],
    inference: true,
  });
  try {
    transport.send(registry, { id: 1, method: "thread/start", params: {} });
    const deadline = Date.now() + 3000;
    while (!transport.attachment.actor && Date.now() < deadline) {
      transport.poll(registry);
      await Bun.sleep(5);
    }
    expect(transport.ready).toBe(true);
    expect(transport.agent().sessionId()).toBe("raw");
    for (let i = 0; i < 140; i++) transport.ingest(registry, "{}");
    expect(transport.events.length).toBe(128);
    expect(transport.next_seq).toBeGreaterThan(128n);
  } finally {
    transport.destroy();
  }
});

test("a restored candidate session does not signal its process until adopted", () => {
  const registry = new Registry(),
    transport = session();
  transport.owner = "handoff";
  transport.child.id = process.pid;
  transport.destroy();
  expect(transport.exited).toBe(false);
});
test("reap collects our own process and leaves an imported one to its parent", async () => {
  const transport = await Session.startWithOptions(1, "claude", "/tmp", {
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    inference: true,
  });
  try {
    const deadline = Date.now() + 1000;
    while (!transport.reap() && Date.now() < deadline) await Bun.sleep(5);
    expect(transport.exited).toBe(true);
    expect(transport.reap()).toBe(false);
    const imported = session();
    imported.imported = true;
    imported.child.id = process.pid;
    expect(imported.reap()).toBe(false);
  } finally {
    transport.destroy();
  }
});

test("native events snapshots and hooks share exactly one receipt regardless of arrival order", () => {
  const identity = "01901234-1234-1234-1234-123456789abc";
  for (const outcome of ["completed", "interrupted", "failed"] as const)
    for (const nativeFirst of [false, true]) {
      const registry = new Registry(),
        transport = session();
      start(transport, registry, identity, "t");
      const actor = transport.attachment.actor!;
      const completion = {
        method: "turn/completed",
        params: { threadId: identity, turn: { id: "t", status: outcome } },
      };
      if (nativeFirst) expect(ingest(transport, registry, completion)).toBe(outcome === "completed");
      const snapshot = new Snapshot(
        {
          pane: 0,
          pid: 0,
          prefix: new Text(),
          actor: 0,
          generation: 0n,
          title_revision: 0n,
        },
        identity,
        "idle",
      );
      snapshot.turn = new Text("t");
      snapshot.outcome = outcome;
      snapshot.observed_at = Number(actor.state.last_seq) + 1;
      expect(actor.observeSnapshot(snapshot, false, 0)).toBe(!nativeFirst && outcome === "completed");
      expect(ingest(transport, registry, completion)).toBe(false);
      expect(
        actor.observeHook(
          { kind: "stop", session: identity, turn: "t" },
          actor.state.last_seq + 1n,
          false,
          actor.observed_at + 1,
        ),
      ).toBe(false);
      expect(actor.state.observation.pending_stop).toBe(false);
      expect(actor.state.observation.completed).toBe(1n);
      expect(actor.state.observation.outcome).toBe(outcome);
      expect(actor.state.state).toBe("idle");
      expect(transport.active_threads.size).toBe(0);
    }
});
