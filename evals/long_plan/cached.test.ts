import { expect, test } from "bun:test";
import * as plan from "../../src/activity/plan";
import type { Input } from "../../src/activity/roadmap";
import { Conversation } from "./cached";
import { Backend } from "../../src/summary_backend";
import { Response, type Request } from "../../src/inference/harness";
import * as lines from "../../src/activity/plan_lines";
import * as protocol from "../../src/activity/plan_protocol";

const event = (id: number): plan.Event => ({ id, line: id, at: "", turn: 1, kind: "tool", text: "Run unit tests" });
const nodes: plan.Node[] = [
  {
    id: "e",
    parent: null,
    kind: "episode",
    title: "Repair resume",
    subtitle: "Correct retry offsets",
    state: "active",
    evidence: [1],
  },
  {
    id: "s",
    parent: "e",
    kind: "step",
    title: "Check offsets",
    subtitle: "Verify the repaired offset",
    state: "active",
    evidence: [1],
  },
];
const input = (): Input => ({
  state: { nodes: structuredClone(nodes), through: 1, spans: [] },
  events: [event(2)],
  support: [event(1)],
});

test("sparse updates retain identity, subtitles and bumps, with full validation", () => {
  const source = input();
  source.state.nodes[1].state = "failed";
  source.state.nodes[1].bump = { kind: "verification", state: "open", detail: "Offset repeats bytes", evidence: [1] };
  const before = structuredClone(source);
  const spans = [{ from: 2, to: 2, node: "s", focus: true }];
  const raw = JSON.stringify({
    nodes: [
      {
        id: "s",
        evidence: [2],
        bump: { kind: "verification", state: "resolved", detail: "Retry passed", evidence: [1, 2] },
      },
    ],
    spans,
  });
  const applied = plan.apply(source.state, raw, source.events);
  expect(applied.state.nodes[1]).toEqual({
    ...before.state.nodes[1],
    evidence: [2],
    bump: { kind: "verification", state: "resolved", detail: "Retry passed", evidence: [1, 2] },
  });
  expect(source).toEqual(before);
  for (const update of [
    { id: "new", state: "active", evidence: [2] },
    { id: "s", parent: null, evidence: [2] },
    { id: "s", state: "done", evidence: [2] },
    { id: "s", title: "Future claim", evidence: [3] },
    { id: "s", extra: true, evidence: [2] },
    { id: "s", title: "Missing evidence" },
    {
      id: "s",
      evidence: [2],
      bump: { kind: "verification", state: "resolved", detail: "Not observed", evidence: [1] },
    },
  ])
    expect(() => plan.apply(source.state, JSON.stringify({ nodes: [update], spans }), source.events)).toThrow();
});

test("cached requests echo accepted changes and keep a complete seed for eviction", () => {
  const conversation = new Conversation(),
    first = input(),
    request = conversation.prepare(first);
  expect(request.content).toBe(request.fresh_content!);
  const nextState = plan.apply(
    first.state,
    JSON.stringify({ nodes: [{ id: "s", state: "done", evidence: [2] }], spans: [{ from: 2, to: 2, node: "s" }] }),
    first.events,
  ).state;
  conversation.accept(first, nextState);
  const next = { state: nextState, events: [event(3)], support: [event(1), event(2)] },
    continuation = conversation.prepare(next);
  expect(continuation.conversation).toBe(request.conversation);
  expect(continuation.schema).toBe(request.schema);
  expect(JSON.parse(continuation.content)).toMatchObject({
    tree_updates: [nextState.nodes[1]],
    support: [event(2)],
    assign_from: 3,
    assign_through: 3,
  });
  expect(JSON.parse(continuation.fresh_content!)).toMatchObject({
    tree: nextState.nodes,
    support: next.support,
    events: next.events,
  });
  expect(JSON.parse(continuation.content).tree).toBeUndefined();
  // The caller might reject an in-flight result or restore an older checkpoint.
  expect(conversation.prepare(first).conversation).not.toBe(request.conversation);
});

test("rejected proposals and bounded conversation rollover reseed from authoritative state", () => {
  const conversation = new Conversation();
  let current = input(),
    key = "";
  for (let i = 0; i < 5; i++) {
    const request = conversation.prepare(current);
    if (i === 0) key = request.conversation!;
    else if (i < 4) expect(request.conversation).toBe(key);
    else {
      expect(request.conversation).not.toBe(key);
      expect(request.content).toBe(request.fresh_content!);
    }
    const state = { ...current.state, through: current.events[0].id };
    conversation.accept(current, state);
    current = { ...current, state, events: [event(state.through + 1)] };
  }
  key = conversation.prepare(current).conversation!;
  conversation.invalidate();
  const retry = conversation.prepare(current);
  expect(retry.conversation).not.toBe(key);
  expect(retry.content).toBe(retry.fresh_content!);
});

test.each([
  ["JSON", protocol],
  ["lines", lines],
] as const)("the summary backend uses a stable %s contract and persists full validated nodes", async (_, wire) => {
  const backend = new Backend(wire),
    requests: Request[] = [];
  let invalid = false;
  backend.pool.infer = async request => {
    requests.push(request);
    const content = JSON.parse(request.content.split("\n")[0]).correction
        ? JSON.parse(request.fresh_content!.split("\n")[0])
        : JSON.parse(request.content.split("\n")[0]),
      response = new Response();
    response.set(
      wire === lines
        ? `BEGIN_PLAN
state s done
work ${content.range[1]} ${invalid ? "missing" : "s"}`
        : JSON.stringify({
            ops: [
              ["=", "s", "d", content.range[1]],
              ["@", content.range[1], invalid ? "missing" : "s", 1],
            ],
          }),
    );
    return response;
  };
  const flat = { provider: "claude", turn: "one", phase: null, earlier: [], evidence: "Run tests" },
    source = { actor: 1, panes: [], agent_name: "Agent", session: "session", tools_since_last: 1n };
  let road = input();
  try {
    const first = await backend.infer(flat, "one", "activity:1", source, false, road);
    expect(first.decision?.label?.text()).toBe("Check offsets");
    expect(JSON.parse(first.patch!).nodes[0]).toMatchObject({
      id: "s",
      parent: "e",
      kind: "step",
      title: "Check offsets",
      state: "done",
    });
    road = { ...road, state: plan.apply(road.state, first.patch!, road.events).state, events: [event(3)] };
    invalid = true;
    expect((await backend.infer(flat, "one", "activity:1", source, false, road)).decision).toBeNull();
    expect(requests[0].schema).toBe(wire.schema);
    expect(requests[1].schema).toBe(wire.schema);
    expect(requests[1].conversation).toBe(requests[0].conversation);
    invalid = false;
    expect((await backend.infer(flat, "one", "activity:1", source, false, road)).patch).toBeTruthy();
    const afterRejection = requests[wire === lines ? 3 : 2];
    expect(afterRejection.conversation).not.toBe(requests[1].conversation);
    expect(JSON.parse(afterRejection.content.split("\n")[0]).tree).toEqual(
      road.state.nodes.map(protocol.node).map(row => (wire === lines ? row.slice(0, 6) : row)),
    );
  } finally {
    backend.close();
  }
});

test("line corrections reuse cached evidence and apply only the valid replacement", async () => {
  const backend = new Backend(lines),
    requests: Request[] = [],
    road = input(),
    before = structuredClone(road);
  backend.pool.infer = async request => {
    requests.push(request);
    const response = new Response();
    response.set(
      requests.length === 1 ? "BEGIN_PLAN\nstate s done\nwork 2 missing" : "BEGIN_PLAN\nstate s done\nwork 2 s",
    );
    return response;
  };
  try {
    const result = await backend.infer(
      { provider: "claude", turn: "one", phase: null, earlier: [], evidence: "Run tests" },
      "one",
      "activity:1",
      { actor: 1, panes: [], agent_name: "Agent", session: "session", tools_since_last: 1n },
      false,
      road,
    );
    expect(requests).toHaveLength(2);
    expect(requests[1].conversation).toBe(requests[0].conversation);
    expect(JSON.parse(requests[1].content.split("\n")[0]).correction).toContain("NONE");
    expect(JSON.parse(requests[1].fresh_content!.split("\n")[0]).tree).toEqual(
      road.state.nodes.map(protocol.node).map(row => row.slice(0, 6)),
    );
    expect(JSON.parse(requests[1].content.split("\n")[0]).accepted).toEqual(
      road.state.nodes.map(protocol.node).map(row => row.slice(0, 6)),
    );
    expect(result.decision?.label?.text()).toBe("Check offsets");
    expect(plan.apply(road.state, result.patch!, road.events).state.through).toBe(2);
    expect(road).toEqual(before);
  } finally {
    backend.close();
  }
});
