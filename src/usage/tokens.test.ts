import { test, expect } from "bun:test";
import { Tracker, Window, Counts } from "./tokens";

test("usage windows discard work observed before a visit", () => {
  const window = new Window();
  expect(window.record(0, new Counts({ tools: 3n, input: 100n }))).toBe(true);
  expect(window.visit(10)).toBe(true);
  expect(window.record(0, new Counts({ tools: 9n }))).toBe(false);
  expect(window.record(10, new Counts({ tools: 1n }))).toBe(true);
  expect(window.counts.tools).toBe(1n);
  expect(window.counts.input).toBe(0n);
});

test("cumulative usage establishes a baseline and duplicate samples add nothing", () => {
  const tracker = new Tracker();
  const first = { input_tokens: 100, output_tokens: 10 };
  const next = { input_tokens: 150, output_tokens: 20 };
  expect(tracker.codexTokens("a", first, false).any()).toBe(false);
  const delta = tracker.codexTokens("a", next, false);
  expect(delta.input).toBe(50n);
  expect(delta.output).toBe(10n);
  expect(tracker.codexTokens("a", next, false).any()).toBe(false);
});

test("Claude repeated message blocks count tools once and include cached input", () => {
  const tracker = new Tracker();
  const message = {
    id: "msg1",
    usage: {
      input_tokens: 5,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 20,
      output_tokens: 3,
    },
    content: [{ type: "tool_use", id: "tool1" }],
  };
  const delta = tracker.claudeMessage(message);
  expect(delta.input).toBe(35n);
  expect(delta.cached_input).toBe(10n);
  expect(delta.output).toBe(3n);
  expect(delta.tools).toBe(1n);
  expect(tracker.claudeMessage(message).any()).toBe(false);
});

test("out-of-order samples cannot make a repeated total count twice", () => {
  const tracker = new Tracker();
  tracker.beginCodex("thread");
  tracker.tokens("thread", 200n, 20n, true);
  expect(tracker.tokens("thread", 100n, 10n, true).any()).toBe(false);
  expect(tracker.tokens("thread", 200n, 20n, true).any()).toBe(false);
});

test("new native turn reports last usage without charging older thread history", () => {
  const tracker = new Tracker();
  const usage = {
    total: { inputTokens: 1100, outputTokens: 110 },
    last: { inputTokens: 100, outputTokens: 10 },
  };
  const delta = tracker.codexNotification("thread", usage, true);
  expect(delta.input).toBe(100n);
  expect(delta.output).toBe(10n);
  expect(tracker.codexNotification("thread", usage, true).any()).toBe(false);
  expect(tracker.codexNotification("resumed", usage, false).any()).toBe(false);
});
