import { test, expect } from "bun:test";
import { System, Tracker } from "./usage";

test("system usage counts fresh Codex threads once and each Claude result once", () => {
  const tracker = new Tracker();
  const system = new System();
  const event = {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "owned",
      tokenUsage: {
        total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20 },
      },
    },
  };
  tracker.ingest(event, system, 1);
  expect(system.meter.value.tokens.total()).toBe(0n);
  tracker.begin("owned");
  tracker.ingest(event, system, 2);
  tracker.ingest(event, system, 3);
  expect(system.meter.value.tokens.total()).toBe(120n);
  const result = {
    type: "result",
    is_error: true,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 20,
      output_tokens: 5,
    },
  };
  tracker.ingest(result, system, 4);
  tracker.ingest(result, system, 5);
  expect(system.meter.value.tokens.total()).toBe(250n);
  expect(system.meter.value.tokens.cached_input).toBe(120n);
});
