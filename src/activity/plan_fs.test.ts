import { expect, test } from "bun:test";
import * as plan from "./plan";
import * as filesystem from "./plan_fs";
import * as protocol from "./plan_protocol";
import { Context, priceBudget } from "./plan_context";
import type { Input } from "./roadmap";

const event = (id: number): plan.Event => ({ id, turn: 1, line: id, at: "", kind: "tool", text: "Verify downloads" });
const seed = `BEGIN_PLAN
mkdir /e active Repair offsets
set /e subtitle Retain downloaded bytes
cd /e
mkdir s active Test resume
set s subtitle Check retry offsets
work /s`;
const empty = (): Input => ({ state: plan.empty(), support: [], events: [event(1)] });
const input = (): Input => ({
  state: filesystem.apply(empty(), seed).state,
  support: [event(1)],
  events: [event(2), event(3)],
});

test("absolute, anchored and relative paths select the same stable node", () => {
  const source = input(),
    before = structuredClone(source);
  const expected = filesystem.apply(source, "set /e/s done\nwork /s").state;
  for (const raw of [
    "set /s done\nwork /s",
    "cd /e\nset s done # verified\nwork /s",
    "cd /e\ncd ..\nset e/s done\nwork /s",
  ])
    expect(filesystem.apply(source, raw).state).toEqual(expected);
  expect(source).toEqual(before);
  expect(() => filesystem.apply(source, "set /e2/s done\nwork /s")).toThrow("InvalidPath");
  expect(() => filesystem.apply(source, "cd /s\nwork /s")).toThrow("NotDirectory");
});

test("relative paths use cwd, which resets on every response", () => {
  const source = input();
  const result = filesystem.apply(source, "cd /e\nset s done\nwork s");
  expect(result.state.nodes.find(n => n.id === "s")?.state).toBe("done");
  const later = { ...source, state: result.state, events: [event(4)] };
  expect(() => filesystem.apply(later, "work s")).toThrow("InvalidPath");
  expect(() => filesystem.apply(later, "work _")).toThrow("InvalidPath");
  expect(filesystem.apply(later, "cd /e\nwork s").state.through).toBe(4);
  expect(
    filesystem.apply(later, "set /s title Verify saved offsets\nwork /s").state.nodes.find(n => n.id === "s")?.title,
  ).toBe("Verify saved offsets");
});

test("skipped status abandons a task while ignore covers unassigned events", () => {
  const result = filesystem.apply(input(), "set /e/s skipped\nignore");
  expect(result.state.nodes.find(n => n.id === "s")?.state).toBe("abandoned");
  expect(result.state.spans.at(-1)).toEqual({ from: 2, to: 3, node: null, focus: false });
  expect(() => filesystem.apply(input(), "set /s skipped")).toThrow("IncompleteCoverage");
  expect(() => filesystem.apply(input(), "set 3 skipped")).toThrow("InvalidPath");
  const canceled = filesystem.apply(input(), "set /s skipped\nset /e skipped\nignore");
  expect(canceled.state.nodes.filter(n => n.state === "abandoned").map(n => n.id)).toEqual(["e", "s"]);
});

test("mixed event ownership and default endpoints preserve token attribution and focus", () => {
  const source = input();
  source.events = [event(2), event(3), event(4)];
  const result = filesystem.apply(source, "ignore through 2\nnote /s through 3\nwork /e/s");
  expect(result.patch.spans).toEqual([
    { from: 2, to: 2, node: null, focus: false },
    { from: 3, to: 3, node: "s", focus: false },
    { from: 4, to: 4, node: "s", focus: true },
  ]);
  expect(filesystem.apply(source, "ignore 2\nnote /s 3\nwork /s 4").state).toEqual(result.state);
  for (const invalid of [
    "work /s\nnote /s",
    "work /s through 5",
    "work /s through 2",
    "work /e",
    "work /s through 4 4",
  ])
    expect(() => filesystem.apply(source, invalid)).toThrow();
});

test("empty trailing ignore cannot change ownership or focus", () => {
  const source = input(),
    expected = filesystem.apply(source, "work /s");
  for (const raw of ["work /s\nignore", "work /s\nignore through 3"]) {
    const actual = filesystem.apply(source, raw);
    expect(actual.state).toEqual(expected.state);
    expect(actual.repairs).toEqual(["ignored empty trailing attribution"]);
  }
  for (const raw of ["work /s\nnote /s", "work /s\nignore through 2"])
    expect(() => filesystem.apply(source, raw)).toThrow("InvalidCoverage");
});

test("duplicate attribution is idempotent but cannot switch owners or focus", () => {
  const source = input(),
    expected = filesystem.apply(source, "set /s subtitle Offsets verified\nwork /s");
  const actual = filesystem.apply(source, "work /s 3\nset /s subtitle Offsets verified\nwork /s through 3");
  expect(actual.state).toEqual(expected.state);
  expect(actual.repairs).toEqual(["ignored duplicate attribution"]);
  expect(() => filesystem.apply(source, "work /s 3\nnote /s 3")).toThrow("InvalidCoverage");
  expect(() =>
    filesystem.apply(source, "mkdir /e/new active New test\nset /new subtitle Separate test\nwork /s 3\nwork /new 3"),
  ).toThrow("InvalidCoverage");
});

test("explicit ranges normalize only when the start matches the coverage cursor", () => {
  const source = input();
  source.events = [event(2), event(3), event(4)];
  const result = filesystem.apply(source, "ignore 2 2\nnote /s 3 3\nwork /s through 4 4");
  expect(result.state).toEqual(filesystem.apply(source, "ignore 2\nnote /s 3\nwork /s 4").state);
  expect(result.repairs).toEqual(Array(3).fill("removed explicit range start"));
  for (const raw of ["work /s 1 4", "work /s 3 4", "ignore 2 3\nwork /s 3 4", "note /s 2 3 4"])
    expect(() => filesystem.apply(source, raw)).toThrow();
});

test("error resolution retains the failed attempt and original error description", () => {
  const source = input(),
    failed = filesystem.apply(source, "error /s verification Retry duplicated bytes\nwork /s").state;
  const recovered = filesystem.apply(
    { state: failed, support: source.events, events: [event(4)] },
    `cd /e
mkdir retry done Retry download tests
set retry subtitle Repaired offsets pass the suite
work retry
error s resolved Retry passes after retaining the saved offset`,
  );
  expect(recovered.state.nodes.find(n => n.id === "s")).toMatchObject({
    state: "failed",
    subtitle: "Retry passes after retaining the saved offset",
    bump: { state: "resolved", kind: "verification", detail: "Retry duplicated bytes", evidence: [2, 4] },
  });
  expect(recovered.patch.spans[0].node).toBe("retry");
  expect(
    filesystem
      .apply({ state: failed, support: [], events: [event(4)] }, "error /s resolved Retry passes\nset /s done\nnote /s")
      .state.nodes.find(n => n.id === "s")?.state,
  ).toBe("failed");
  expect(() => filesystem.apply(source, "error /s resolved\nwork /s")).toThrow("InvalidOperation");
  const together = filesystem.apply(
    source,
    "error /s verification Retry fails\nerror /s resolved Repair verified later in this batch\nwork /s",
  );
  expect(together.state.nodes.find(n => n.id === "s")?.bump?.state).toBe("resolved");
});

test("mv regroups new nodes without moving accepted history or changing identities", () => {
  const source = input(),
    before = structuredClone(source);
  const result = filesystem.apply(
    source,
    `mkdir /e/new planned Check export shape
mkdir /e2 active Inspect export shape
set /e2 subtitle Preserve the existing export format
mv /new /e2/
set /new subtitle Compare fields against existing fixtures
ignore`,
  );
  expect(result.state.nodes.find(n => n.id === "new")).toMatchObject({ parent: "e2", kind: "step" });
  expect(result.state.nodes.find(n => n.id === "s")?.parent).toBe("e");
  expect(source).toEqual(before);
  for (const invalid of [
    "mv /s /e/\nignore",
    "mkdir /e/new planned Verify export\nset /new subtitle Verify export shape\nmv /new /\nignore",
    "mkdir /e3 active Different outcome\nset /e3 subtitle Separate requested outcome\nmv /e3 /e/\nignore",
  ]) {
    expect(() => filesystem.apply(source, invalid)).toThrow();
    expect(source).toEqual(before);
  }
});

test("text remains literal and invalid programs reject atomically", () => {
  const source = input(),
    before = structuredClone(source);
  const text = String.raw`Keep C:\tmp\file; $(commands) and "quotes" # are literal text`;
  expect(
    filesystem.apply(source, `set /s subtitle ${text}\nwork /s`).state.nodes.find(n => n.id === "s")?.subtitle,
  ).toBe(text);
  for (const invalid of [
    "",
    "BEGIN_PLAN",
    "Here is prose\nwork /s",
    "mkdir /e active Duplicate episode\nignore",
    "mkdir /s/child active Too deep\nset _ subtitle Invalid child\nignore",
    "mkdir /e/_ active Reserved alias\nignore",
    "set /s complete\nwork /s",
    "error /e verification Not a step\nignore",
    "error /s unknown Problem\nwork /s",
    "mkdir /e/new active Missing subtitle\nwork /s",
    "work /s\nAll done.",
    "rm /s\nignore",
    "skip /s\nignore",
    "describe /s New subtitle\nwork /s",
    "title /s New title\nwork /s",
    "error_set /s verification Failed check\nwork /s",
    "error_resolve /s Retry passed\nwork /s",
  ]) {
    expect(() => filesystem.apply(source, invalid)).toThrow();
    expect(source).toEqual(before);
  }
  expect(filesystem.apply(source, "A preamble\nBEGIN_PLAN\nwork /s").state).toEqual(
    filesystem.apply(source, "work /s").state,
  );
});

test("cached input and repair seeds use the same path layout and reset navigation state", () => {
  const source = input(),
    context = new Context(filesystem, priceBudget),
    request = context.prepare(source);
  const data = JSON.parse(request.content.split("\n")[0]);
  expect(data).toMatchObject({ cwd: "/" });
  expect(data.tree.map((row: unknown[]) => row[0])).toEqual(["/e", "/e/s"]);
  expect(data.tree[1]).toEqual(["/e/s", "step", "Test resume", "Check retry offsets", "active"]);
  expect(request.content).toContain("@2 1 tool\n Verify downloads");
  const retry = context.retry(source, "set _ done", "InvalidPath", { input: 10000n, output: 100n });
  expect(retry.conversation).toBe(request.conversation);
  expect(JSON.parse(retry.content.split("\n")[0]).accepted).toEqual(data.tree);
  expect(JSON.parse(retry.fresh_content!.split("\n")[0]).tree).toEqual(data.tree);
  expect(retry.content).toContain("_ is not a node selector");
  const next = filesystem.apply(source, "work /s").state;
  context.accept(source, next, { input: 10000n, output: 100n });
  const delta = context.prepare({ state: next, events: [event(4)], support: source.events });
  expect(JSON.parse(delta.content.split("\n")[0])).toMatchObject({ cwd: "/", focus: "/s" });
  expect(JSON.parse(delta.content.split("\n")[0]).tree_updates).toHaveLength(1);
  expect(filesystem.encode(protocol.envelope(source))).toBe(request.content);
});
