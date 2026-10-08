import { test, expect } from "bun:test";
import { Timeline } from "./timeline";
import { parseLabel } from "./summary";
import { Tokens, View } from "../usage/live";

function view(input = 0n, cached_input = 0n, output = 0n) {
  return new View({
    known: true,
    tokens: new Tokens({ input, cached_input, output }),
  });
}
const reading = parseLabel("Reading source")!;
const testing = parseLabel("Running tests")!;

test("checkpoints partition own usage, coalesce repeated labels, and remain bounded", () => {
  const timeline = new Timeline();
  const current = view(100n, 60n, 20n);
  timeline.checkpoint("a", reading, current, 1000);
  current.tokens.add(new Tokens({ input: 30n, cached_input: 10n, output: 5n }));
  timeline.checkpoint("a", reading, current, 2000);
  expect(timeline.len).toBe(1);
  expect(timeline.points[0].usage.tokens.total()).toBe(155n);
  expect(timeline.points[0].at).toBe(1000);
  current.tokens.add(new Tokens({ input: 40n, output: 10n }));
  timeline.checkpoint("a", testing, current, 3000);
  expect(timeline.points[0].usage.tokens.total()).toBe(205n);
  expect(timeline.points[1].usage.tokens.total()).toBe(0n);
  current.tokens.add(new Tokens({ input: 7n, output: 3n }));
  expect(timeline.pending(current).tokens.total()).toBe(10n);
  expect(timeline.pending(current).tokens.total()).toBe(10n);
  timeline.checkpoint("b", testing, current, 4000);
  expect(timeline.len).toBe(3);
  for (let i = 0; i < 16; i++)
    timeline.checkpoint(
      "b",
      i % 2 === 0 ? reading : testing,
      current,
      5000 + i,
    );
  expect(timeline.len).toBe(16);
  expect(timeline.pending(current).tokens.total()).toBe(0n);
});

test("only intervals containing a loss or regression are partial", () => {
  const timeline = new Timeline();
  timeline.checkpoint("a", reading, new View(), 1);
  timeline.checkpoint("a", reading, view(100n), 2);
  expect(timeline.points[0].usage.partial).toBe(false);
  expect(timeline.points[0].usage.tokens.total()).toBe(100n);
  timeline.checkpoint("b", testing, view(50n), 3);
  expect(timeline.points[1].usage.tokens.total()).toBe(0n);
  expect(timeline.points[0].usage.partial).toBe(true);
  expect(timeline.points[1].usage.partial).toBe(false);
  const clean = timeline.pending(view(110n));
  expect(clean.tokens.total()).toBe(10n);
  expect(clean.partial).toBe(false);
  const lost = view(130n);
  lost.partial = true;
  lost.losses = 1;
  expect(timeline.pending(lost).partial).toBe(true);
  timeline.checkpoint("b", reading, lost, 4);
  expect(timeline.points[1].usage.partial).toBe(true);
  expect(timeline.points[2].usage.partial).toBe(false);
  lost.tokens.input = 150n;
  expect(timeline.pending(lost).partial).toBe(false);
  timeline.checkpoint("b", testing, lost, 5);
  expect(timeline.points[3].usage.partial).toBe(false);
});

test("activity transitions charge the previous phase and pending retains repeated summaries", () => {
  const timeline = new Timeline();
  const reviewing = parseLabel("Reviewing pending changes")!;
  const inspecting = parseLabel("Inspecting repository changes")!;
  timeline.checkpoint("turn", reviewing, new View(), 1000);
  const current = view(21500n, 12800n);
  timeline.checkpoint("turn", inspecting, current, 2000);
  const previous = timeline.points[0].usage.tokens;
  expect(previous.input - previous.cached_input).toBe(8700n);
  expect(previous.cached_input).toBe(12800n);
  current.tokens.add(new Tokens({ input: 99600n, cached_input: 78700n }));
  timeline.checkpoint("turn", inspecting, current, 3000);
  const live = timeline.pending(current).tokens;
  expect(timeline.len).toBe(2);
  expect(live.input - live.cached_input).toBe(20900n);
  expect(live.cached_input).toBe(78700n);
  expect(timeline.points[1].at).toBe(2000);
  timeline.checkpoint("turn", reviewing, current, 4000);
  expect(timeline.points[1].usage.tokens).toEqual(live);
  expect(timeline.pending(current).tokens.total()).toBe(0n);
});

test("usage after a finished compaction belongs to the next named phase", () => {
  const timeline = new Timeline();
  timeline.checkpoint(
    "turn",
    parseLabel("Compacting context")!,
    new View(),
    1000,
  );
  const current = view(10n);
  timeline.finish(current);
  current.tokens.input = 20n;
  expect(timeline.pending(current).tokens.input).toBe(10n);
  timeline.checkpoint("turn", testing, current, 2000);
  expect(timeline.points[0].usage.tokens.input).toBe(10n);
  expect(timeline.pending(current).tokens.input).toBe(10n);
  current.tokens.input = 30n;
  expect(timeline.pending(current).tokens.input).toBe(20n);
});
