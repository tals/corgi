import { expect, test } from "bun:test";
import * as plan from "./plan";
import * as protocol from "./plan_protocol";
import type { Input } from "./roadmap";

const event = (id: number): plan.Event => ({ id, turn: 1, line: id, at: "", kind: "tool", text: "Verify downloads" });
const raw = (...ops: unknown[]) => JSON.stringify({ ops });
const seed = (): Input => {
  const input = { state: plan.empty(), support: [], events: [event(1)] };
  const state = protocol.apply(
    input,
    raw(
      ["+", "e", null, "Repair offsets", "Retain the downloaded bytes", "a", 1],
      ["+", "s", "e", "Test resume", "Check retry offsets", "a", 1],
      ["@", 1, "s", 1],
    ),
  ).state;
  return { state, support: [event(1)], events: [event(2), event(3)] };
};

test("compact operations preserve the canonical tree, coverage and failed attempt", () => {
  const input = seed(),
    before = structuredClone(input);
  const failed = protocol.apply(
    input,
    raw(
      ["!", "s", "verification", "Retry duplicated bytes", 2],
      ["+", "retry", "e", "Retry resume", "Verify repaired offsets", "a", 3],
      ["@", 2, "s", 1],
      ["@", 3, "retry", 1],
    ),
  );
  expect(input).toEqual(before);
  expect(plan.apply(input.state, JSON.stringify(failed.patch), input.events).state).toEqual(failed.state);
  const next = { ...input, state: failed.state, events: [event(4)] };
  const fixed = protocol.apply(next, raw(["v", "s", 4], ["=", "retry", "d", 4], ["@", 4, "retry", 1]));
  expect(fixed.state.nodes.find(n => n.id === "s")).toMatchObject({
    state: "failed",
    bump: { kind: "verification", state: "resolved", detail: "Retry duplicated bytes", evidence: [2, 4] },
  });
  expect(fixed.patch.nodes.every(n => n.kind && n.subtitle && n.parent)).toBe(true);
  expect(protocol.apply(input, raw(["@", 3, "s", 1])).patch.nodes).toEqual([]);
  // A failed attempt stays failed without rejecting the batch.
  const kept = protocol.apply(next, raw(["=", "s", "d", 4], ["@", 4, "s", 1]));
  expect(kept.state.nodes.find(n => n.id === "s")?.state).toBe("failed");
  expect(kept.repairs).toContain("kept failed attempt: s");
  expect(
    protocol
      .apply(input, raw(["!", "s", "verification", "Failed check", 2], ["=", "s", "d", 3], ["@", 3, "s", 1]))
      .state.nodes.find(n => n.id === "s")?.state,
  ).toBe("failed");
});

test("compact operations reject invalid references and mutations atomically", () => {
  const input = seed(),
    before = structuredClone(input);
  for (const ops of [
    [["~", "s", { parent: "other" }, 2]],
    [["~", "s", { s: "Future finding" }, 4]],
    [["+", "s", "e", "Replace history", "Must not replace", "d", 2]],
    [["+", "bad", "missing", "New child", "No parent exists", "a", 2]],
    [["=", "missing", "d", 2]],
    [["v", "s", 2]],
    [["!", "e", "verification", "Ancestor bump", 2]],
    [["@", 2, "s", 1]],
    [["@", 4, "s", 1]],
    [["@", 3, "e", 1]],
    [["@", 3, "missing", 1]],
    [["~", "s", { s: "Invalid\nsubtitle" }, 2]],
  ]) {
    const all = ops.some(op => op[0] === "@") ? ops : [...ops, ["@", 3, "s", 1]];
    expect(() => protocol.apply(input, raw(...all))).toThrow();
    expect(input).toEqual(before);
  }
});

test("compact evidence preserves text and carries no token estimates", () => {
  const input = seed(),
    packed = JSON.parse(protocol.content(input));
  expect(packed.tree).toHaveLength(2);
  expect(packed.support[0]).toEqual([1, 1, "tool", "Verify downloads"]);
  expect(packed.events.map((e: unknown[]) => e[3])).toEqual(input.events.map(e => e.text));
  expect(packed.range).toEqual([2, 3]);
  expect(packed.focus).toBe("s");
  expect(JSON.parse(protocol.content({ ...input, focus: null })).focus).toBeNull();
});

test("one bounded observation can report both a new setback and its recovery", () => {
  const input = seed();
  input.events = [event(2)];
  input.events[0].text = "Rebase encountered an import conflict; resolved it and rebase completed successfully";
  const fixed = protocol.apply(
    input,
    raw(["!", "s", "conflict", "Import conflict", 2], ["v", "s", 2], ["@", 2, "s", 1]),
  );
  expect(fixed.state.nodes.find(n => n.id === "s")?.bump).toEqual({
    kind: "conflict",
    state: "resolved",
    detail: "Import conflict",
    evidence: [2],
  });
  const open = protocol.apply(input, raw(["!", "s", "conflict", "Import conflict", 2], ["@", 2, "s", 1])).state;
  expect(() =>
    protocol.apply({ ...input, state: open, events: [event(3)] }, raw(["v", "s", 2], ["@", 3, "s", 1])),
  ).toThrow("MissingRecoveryEvidence");
});
