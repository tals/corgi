import { expect, test } from "bun:test";
import * as plan from "./plan";
import * as protocol from "./plan_protocol";
import * as lines from "./plan_lines";
import * as owner from "./plan_owner";
import { Context, priceBudget } from "./plan_context";
import type { Input } from "./roadmap";

const event = (id: number): plan.Event => ({
  id,
  line: id,
  turn: 1,
  kind: "tool",
  at: "",
  text: "Test the repaired offsets",
});
const input = (): Input => ({ state: plan.empty(), events: [event(1)], support: [] });

test("focused cached updates retain current constraints, open errors and complete parent paths", () => {
  const state = plan.empty();
  for (let i = 1; i <= 3; i++) {
    const common = { title: "Repair saved links", subtitle: "Keep saved links valid", evidence: [1] };
    state.nodes.push(
      { ...common, id: `e${i}`, parent: null, kind: "episode", state: "active" },
      { ...common, id: `s${i}`, parent: `e${i}`, kind: "step", state: "active" },
    );
  }
  state.nodes[5].bump = { kind: "environment", state: "open", detail: "Renderer is missing", evidence: [1] };
  const session = new Context(owner.variant("focused")),
    first: Input = { state, events: [event(1)], support: [], focus: "s1" },
    request = session.prepare(first),
    accepted = { ...state, through: 1 },
    next: Input = { ...first, state: accepted, events: [event(2)], support: [event(1)] };
  session.accept(first, accepted);
  const delta = session.prepare(next),
    metadata = JSON.parse(delta.content.split("\n", 1)[0]);
  expect(delta.conversation).toBe(request.conversation);
  expect(metadata.tree_updates.map((row: string[]) => row[0])).toEqual(["/e1", "/e1/s1", "/e3", "/e3/s3"]);
  expect(metadata.tree_updates[1][3]).toBe("Keep saved links valid");
  const changed = structuredClone(accepted);
  changed.through = 2;
  changed.nodes[3].subtitle = "A late result established the saved-link format";
  session.accept(next, changed);
  const update = session.prepare({ ...next, state: changed, events: [event(3)] });
  expect(JSON.parse(update.content.split("\n", 1)[0]).tree_updates.map((row: string[]) => row[0])).toEqual([
    "/e1",
    "/e1/s1",
    "/e2",
    "/e2/s2",
    "/e3",
    "/e3/s3",
  ]);
  session.invalidate();
  const fresh = session.prepare({ ...next, state: changed, events: [event(3)] });
  expect(fresh.content).toBe(fresh.fresh_content!);
  expect(JSON.parse(fresh.content.split("\n", 1)[0]).tree).toHaveLength(6);
  expect(fresh.conversation).not.toBe(request.conversation);
});

test("bounded support keeps branch and failure evidence and sends newly relevant old evidence on return", () => {
  const state = plan.empty(),
    common = { title: "Repair saved links", subtitle: "Keep saved links valid", state: "active" as const };
  state.through = 30;
  state.nodes = [
    { ...common, id: "e", parent: null, kind: "episode", evidence: [1, 3] },
    { ...common, id: "s", parent: "e", kind: "step", evidence: [2] },
    { ...common, id: "other", parent: "e", kind: "step", evidence: [10] },
    {
      ...common,
      id: "failed",
      parent: "e",
      kind: "step",
      state: "failed",
      evidence: [5],
      bump: { kind: "environment", state: "open", detail: "Renderer unavailable", evidence: [5] },
    },
  ];
  const session = new Context(owner.variant("direct-bounded")),
    first: Input = {
      state,
      events: [event(31)],
      support: Array.from({ length: 30 }, (_, i) => event(i + 1)),
      focus: "s",
    },
    before = structuredClone(first),
    supportIds = (content: string) => [...content.split("\nevents\n")[0].matchAll(/^@(\d+) /gm)].map(m => Number(m[1])),
    request = session.prepare(first);
  expect(supportIds(request.content)).toEqual([1, 2, 3, 5, 23, 24, 25, 26, 27, 28, 29, 30]);
  expect(JSON.parse(request.content.split("\n", 1)[0]).tree).toHaveLength(4);
  expect(request.content).toContain("@31 1 tool\n Test the repaired offsets");
  expect(first).toEqual(before);
  const accepted = { ...state, through: 31 };
  session.accept(first, accepted);
  const returned = session.prepare({ ...first, state: accepted, events: [event(32)], focus: "other" });
  expect(returned.conversation).toBe(request.conversation);
  expect(supportIds(returned.content)).toEqual([10]);
  expect(supportIds(returned.fresh_content!)).toContain(10);
  expect(supportIds(returned.fresh_content!)).toContain(5);
  const correction = session.retry(first, "invalid program", "InvalidSetback", { input: 10n, output: 10n });
  expect(supportIds(correction.fresh_content!)).toEqual(supportIds(request.content));
  expect(JSON.parse(correction.content.split("\n", 1)[0]).accepted).toHaveLength(4);
});

test("the line experiment and default JSON protocol receive identical evidence", () => {
  const source = input(),
    request = new Context(lines).prepare(source),
    control = new Context().prepare(source);
  expect(request.instructions).toBe(lines.instructions);
  expect(request.schema).toBeNull();
  expect(control.instructions).toBe(protocol.instructions);
  expect(control.schema).toBe(protocol.schema);
  expect(JSON.parse(request.content.split("\n")[0])).toEqual({ tree: [], focus: null, range: [1, 1] });
  expect(request.content).toContain("@1 1 tool\n Test the repaired offsets");
  expect(JSON.parse(control.content).events).toEqual([[1, 1, "tool", "Test the repaired offsets"]]);
  expect(request.fresh_content).toBe(request.content);
});

test("cached compact updates retain constraints and setbacks, with full fallback on eviction", () => {
  const session = new Context(),
    first = input(),
    request = session.prepare(first);
  const { state } = protocol.apply(
    first,
    JSON.stringify({
      ops: [
        ["+", "e", null, "Repair offsets", "Offsets must match bytes already saved", "a", 1],
        ["+", "s", "e", "Test retry", "Check resuming after an interruption", "f", 1],
        ["!", "s", "verification", "Offsets repeated bytes", 1],
        ["@", 1, "s", 1],
      ],
    }),
  );
  session.accept(first, state);
  const next = { state, events: [event(2)], support: [event(1)] };
  const continuation = session.prepare(next);
  expect(continuation.conversation).toBe(request.conversation);
  expect(continuation.fresh_content).toBe(protocol.content(next));
  expect(JSON.parse(continuation.content).tree_updates).toEqual(state.nodes.map(protocol.node));
  expect(JSON.parse(continuation.content).support).toEqual([]);
  session.accept(next, { ...state, through: 2 });
  const stable = session.prepare({ ...next, state: { ...state, through: 2 }, events: [event(3)] });
  // Constraints and the unresolved problem remain explicit even when unchanged.
  expect(JSON.parse(stable.content).tree_updates).toEqual(state.nodes.map(protocol.node));
  const diverged = session.prepare(first);
  expect(diverged.conversation).not.toBe(request.conversation);
  expect(diverged.content).toBe(diverged.fresh_content!);
});

test("fresh plan seeds name the conversation and cached updates rely on the seed", () => {
  const session = new Context(owner.variant(), priceBudget),
    named = { ...input(), conversation: "Design long-term plan eval" },
    metadata = (content: string) => JSON.parse(content.split("\n", 1)[0]);
  const seed = session.prepare(named);
  expect(metadata(seed.content).conversation).toBe("Design long-term plan eval");
  const state = { ...named.state, through: 1 };
  session.accept(named, state);
  const update = session.prepare({ ...named, state, events: [event(2)] });
  expect(update.conversation).toBe(seed.conversation);
  expect(metadata(update.content).conversation).toBeUndefined();
  expect(metadata(update.fresh_content!).conversation).toBe("Design long-term plan eval");
  expect(metadata(new Context(owner.variant()).prepare(input()).content).conversation).toBeUndefined();
});

test("compact conversations reseed after rejection and sixteen accepted updates", () => {
  const session = new Context();
  let road = input(),
    key = "";
  for (let i = 0; i < 17; i++) {
    const request = session.prepare(road);
    if (i === 0) key = request.conversation!;
    else if (i < 16) expect(request.conversation).toBe(key);
    else expect(request.conversation).not.toBe(key);
    const state = { ...road.state, through: i + 1 };
    session.accept(road, state);
    road = { ...road, state, events: [event(i + 2)] };
  }
  key = session.prepare(road).conversation!;
  session.invalidate();
  const fresh = session.prepare(road);
  expect(fresh.conversation).not.toBe(key);
  expect(fresh.content).toBe(fresh.fresh_content!);
});

test("priced conversations reuse small histories through the provider turn limit", () => {
  const session = new Context(lines, { ...priceBudget, turns: 32 });
  let road = input(),
    key = "";
  for (let i = 0; i < 33; i++) {
    const request = session.prepare(road);
    if (i === 0) key = request.conversation!;
    else if (i < 32) expect(request.conversation).toBe(key);
    else expect(request.conversation).not.toBe(key);
    const state = { ...road.state, through: i + 1 };
    session.accept(road, state, { input: 10_000n, output: 100n });
    road = { ...road, state, events: [event(i + 2)] };
  }
});

test("priced conversations reseed before the next delta crosses the budget", () => {
  const session = new Context(lines, priceBudget),
    first = input(),
    request = session.prepare(first);
  const state = { ...first.state, through: 1 };
  // Input includes cached tokens; output becomes part of the next input too.
  session.accept(first, state, { input: 89_000n, output: 900n });
  const next = { state, events: [{ ...event(2), text: "x".repeat(300) }], support: [] };
  const refreshed = session.prepare(next);
  expect(refreshed.conversation).not.toBe(request.conversation);
  expect(refreshed.content).toBe(lines.encode(protocol.envelope(next)));
  session.accept(next, { ...state, through: 2 }, { input: 10_000n, output: 100n });
  const continued = session.prepare({ ...next, state: { ...state, through: 2 }, events: [event(3)] });
  expect(continued.conversation).toBe(refreshed.conversation);
  session.invalidate();
  expect(session.prepare(next).content).toBe(lines.encode(protocol.envelope(next)));
});

test("repair reuses cached evidence and retains an authoritative seed for eviction", () => {
  const session = new Context(lines, priceBudget),
    first = input(),
    request = session.prepare(first);
  const retry = session.retry(first, "BEGIN_PLAN\nskip 3", "InvalidCoverage", { input: 10_000n, output: 100n });
  expect(retry.conversation).toBe(request.conversation);
  expect(retry.content.length).toBeLessThan(retry.fresh_content!.length);
  expect(JSON.parse(retry.fresh_content!.split("\n")[0])).toMatchObject({
    tree: [],
    focus: null,
    range: [1, 1],
    rejected: "BEGIN_PLAN\nskip 3",
  });
  const accepted = lines.apply(first, "BEGIN_PLAN\nskip 1").state;
  session.accept(first, accepted, { input: 11_000n, output: 100n });
  expect(session.prepare({ ...first, state: accepted, events: [event(2)] }).conversation).toBe(request.conversation);
  const refreshed = session.retry(first, "bad", "InvalidOperation", { input: 91_000n, output: 100n });
  expect(refreshed.conversation).not.toBe(request.conversation);
  expect(refreshed.content).toBe(refreshed.fresh_content!);
});
