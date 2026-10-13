import { test, expect } from "bun:test";
import { Reading, Points, View } from "./context_window";
import { Model } from "../providers/model";
test("claude counts the latest main-chain call's input side against its model window", () => {
  const reading = new Reading();
  const value = {
    type: "assistant",
    timestamp: "2026-09-27T17:29:27.178Z",
    message: {
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1160,
        cache_read_input_tokens: 251596,
        output_tokens: 795,
      },
    },
  };
  reading.claude(value);
  expect(reading.used).toBe(252758n);
  expect(reading.window).toBe(1000000n);
  expect(reading.model.id.text()).toBe("claude-opus-5-5");
  reading.claude({
    ...value,
    isSidechain: true,
    message: { model: "claude-opus-5-5", usage: { input_tokens: 9 } },
  });
  reading.claude({
    type: "system",
    isSidechain: true,
    subtype: "compact_boundary",
    timestamp: value.timestamp,
    compactMetadata: { trigger: "auto", preTokens: 150000, postTokens: 9000 },
  });
  reading.claude({
    ...value,
    message: { model: "<synthetic>", usage: { input_tokens: 0 } },
  });
  expect(reading.used).toBe(252758n);
  expect(reading.auto_compaction).toBe(0n);
  reading.claude({
    ...value,
    message: {
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 40000 },
    },
  });
  expect(reading.window).toBe(200000n);
});
test("claude compactions reset the level and only automatic ones teach the compaction point", () => {
  const reading = new Reading();
  reading.claude({
    type: "system",
    subtype: "compact_boundary",
    timestamp: "2026-09-27T17:31:25.260Z",
    compactMetadata: { trigger: "manual", preTokens: 253553, postTokens: 6070 },
  });
  expect(reading.used).toBe(6070n);
  expect(reading.auto_compaction).toBe(0n);
  reading.claude({
    type: "user",
    timestamp: "2026-09-27T19:00:40.000Z",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  });
  reading.claude({
    type: "system",
    subtype: "compact_boundary",
    timestamp: "2026-09-27T19:02:00.000Z",
    compactMetadata: { trigger: "auto", preTokens: 412000, postTokens: 9100 },
  });
  expect(reading.used).toBe(9100n);
  expect(reading.auto_compaction).toBe(412000n);
});
test("claude compactions of an idle session don't teach the compaction point", () => {
  const reading = new Reading(),
    prompt = (content: any) =>
      reading.claude({ type: "user", timestamp: "2026-10-13T02:22:56.300Z", message: { content } });
  const compact = (preTokens: number) =>
    reading.claude({
      type: "system",
      subtype: "compact_boundary",
      timestamp: "2026-10-13T03:20:02.405Z",
      compactMetadata: { trigger: "auto", preTokens, postTokens: 9720 },
    });
  prompt("what about controller.ts being mega");
  reading.claude({ type: "system", subtype: "turn_duration", timestamp: "2026-10-13T02:25:38.500Z" });
  compact(218561);
  expect(reading.used).toBe(9720n);
  expect(reading.auto_compaction).toBe(0n);
  reading.claude({
    type: "user",
    isCompactSummary: true,
    timestamp: "2026-10-13T03:20:02.401Z",
    message: { content: "This session is being continued from a previous conversation" },
  });
  compact(9800);
  expect(reading.auto_compaction).toBe(0n);
  prompt("go on");
  prompt([{ type: "text", text: "[Request interrupted by user]" }]);
  compact(341002);
  expect(reading.auto_compaction).toBe(0n);
  prompt("<command-name>/model</command-name>");
  prompt("<local-command-stdout>Set model to Opus</local-command-stdout>");
  compact(396151);
  expect(reading.auto_compaction).toBe(0n);
  prompt("go on");
  compact(967717);
  expect(reading.auto_compaction).toBe(967717n);
});
test("codex reads the last call and the reported window, ignoring null info", () => {
  const reading = new Reading(),
    value = {
      timestamp: "2026-09-06T02:08:31.286Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 5730919,
            output_tokens: 26352,
            total_tokens: 5757271,
          },
          last_token_usage: {
            input_tokens: 93139,
            cached_input_tokens: 92032,
            output_tokens: 529,
            total_tokens: 93668,
          },
          model_context_window: 258400,
        },
      },
    };
  reading.codex(value);
  expect(reading.used).toBe(93668n);
  expect(reading.window).toBe(258400n);
  reading.codex({
    ...value,
    payload: { type: "token_count", info: null } as any,
  });
  expect(reading.used).toBe(93668n);
  expect(reading.view(new Points()).percent()).toBe(36n);
});
test("pressure follows a learned compaction point shared by model", () => {
  const points = new Points(),
    reading = new Reading();
  Object.assign(reading, {
    used: 300000n,
    window: 1000000n,
    at: 1,
    model: Model.resolve("claude-opus-5-5"),
  });
  expect(reading.view(points).pressure()).toBe(0.3);
  points.learn("claude-opus-5-5", 400000n);
  expect(reading.view(points).pressure()).toBe(0.75);
  expect(reading.view(points).percent()).toBe(30n);
  expect(new View().pressure()).toBeNull();
});
