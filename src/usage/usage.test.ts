import { test, expect } from "bun:test";
import { Counts, Window as ActivityWindow, Tracker } from "./tokens";
import { Tokens, Codex, Meter, View } from "./live";
import { Reading, Points, View as ContextView } from "./context_window";
import { lookup, equivalent } from "./prices";
import { limits, Window, claudeAccount, codexAccount } from "./account";
import { State as History } from "./limits";
import { Timeline } from "../activity/timeline";
import { Text } from "../providers/common";
test("usage windows discard work observed before a visit", () => {
  const w = new ActivityWindow();
  expect(w.record(0, new Counts({ tools: 3n, input: 100n }))).toBe(true);
  expect(w.visit(10)).toBe(true);
  expect(w.record(0, new Counts({ tools: 9n }))).toBe(false);
  expect(w.record(10, new Counts({ tools: 1n }))).toBe(true);
  expect(w.counts.tools).toBe(1n);
  expect(w.counts.input).toBe(0n);
});
test("cumulative usage establishes a baseline and duplicate samples add nothing", () => {
  const t = new Tracker();
  expect(t.codexTokens("a", { input_tokens: 100, output_tokens: 10 }, false).any()).toBe(false);
  const d = t.codexTokens("a", { input_tokens: 150, output_tokens: 20 }, false);
  expect(d.input).toBe(50n);
  expect(d.output).toBe(10n);
  expect(t.codexTokens("a", { input_tokens: 150, output_tokens: 20 }, false).any()).toBe(false);
});
test("Claude repeated message blocks count tools once and include cached input", () => {
  const t = new Tracker(),
    v = {
      id: "m1",
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 20,
        output_tokens: 3,
      },
      content: [{ type: "tool_use", id: "tool1" }],
    };
  const d = t.claudeMessage(v);
  expect(d.input).toBe(35n);
  expect(d.cached_input).toBe(10n);
  expect(d.tools).toBe(1n);
  expect(t.claudeMessage(v).any()).toBe(false);
});
test("owned first request is counted once and recent buckets expire", () => {
  const c = new Codex(),
    total = new Tokens({ input: 1100n, cached_input: 800n, output: 120n }),
    last = new Tokens({ input: 100n, cached_input: 50n, output: 20n });
  c.sample(total, last, true, 60000);
  c.sample(total, last, true, 60100);
  expect(c.meter.view(60200).tokens.total()).toBe(120n);
  expect(c.meter.view(60200).recent_tokens).toBe(120n);
  expect(c.meter.view(360000).recent_tokens).toBe(0n);
  expect(c.meter.value.tokens.cached_input).toBe(50n);
});
test("counter regressions and inherited jumps cannot inflate live spend", () => {
  const c = new Codex();
  c.sample(new Tokens({ input: 1000n, output: 100n }), null, false, 1);
  c.sample(new Tokens({ input: 10n, output: 1n }), null, true, 2);
  c.sample(new Tokens({ input: 1000n, output: 100n }), null, true, 3);
  expect(c.meter.value.tokens.total()).toBe(0n);
  c.sample(new Tokens({ input: 9000n, output: 900n }), new Tokens({ input: 30n, output: 5n }), true, 4);
  expect(c.meter.value.tokens.total()).toBe(35n);
  expect(c.meter.value.partial).toBe(true);
});
test("context readings include input caches and provider windows", () => {
  const r = new Reading();
  r.claude({
    type: "assistant",
    timestamp: "2026-09-24T10:00:00.000Z",
    message: {
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
      },
    },
  });
  expect(r.used).toBe(60n);
  expect(r.window).toBe(200000n);
  r.claude({
    type: "system",
    subtype: "compact_boundary",
    timestamp: "2026-09-24T10:00:01.000Z",
    compactMetadata: { trigger: "auto", preTokens: 160000, postTokens: 5000 },
  });
  expect(r.auto_compaction).toBe(160000n);
  expect(r.used).toBe(5000n);
  const points = new Points();
  points.learn("claude-opus-4-5", 160000n);
  expect(r.view(points).compacts_at).toBe(160000n);
  expect(new ContextView({ used: 70n, window: 100n, at: 1 }).band()).toBe("near");
  expect(new ContextView({ used: 85n, window: 100n, at: 1 }).band()).toBe("high");
});
test("model prices use longest bounded prefix and rescale each token kind", () => {
  expect(lookup("claude-opus-5-5[1m]")?.input).toBe(4000n);
  expect(lookup("claude-opus-55")).toBeNull();
  expect(lookup("codex-auto-review")).toBeNull();
  expect(equivalent(lookup("claude-haiku-4-5")!, lookup("claude-opus-5")!, 5000n, 1000n)).toBe(1200n);
});
test("account usage distinguishes missing windows from zero and preserves durations", () => {
  const c = limits(
    {
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 63, windowDurationMins: 10080 },
    },
    "codex",
  ) as any;
  expect(c.windows[0].used).toBe(0);
  expect(c.windows[0].label()).toBe("5h");
  expect(c.windows[1].label()).toBe("7d");
  expect(limits(null, "claude")).toBe("none");
  expect(
    claudeAccount({
      loggedIn: false,
      email: "old",
      subscriptionType: "max",
    }).account.text(),
  ).toBe("Not signed in");
  expect(codexAccount({ type: "apiKey", planType: "pro", email: "old" }).plan.text()).toBe("API");
});
test("readings fill their slot and leave unread slots as gaps", () => {
  const s = new History(),
    w = new Window({ minutes: 300, used: 12, reset_at: 18000 });
  s.record([w, null], 60);
  w.used = 40;
  const sparks = s.record([w, null], 9000);
  expect(sparks[0][0]).toBe(12);
  expect(sparks[0][1]).toBeNull();
  expect(sparks[0][5]).toBe(40);
  expect(sparks[1][0]).toBeNull();
});
test("checkpoints partition usage and coalesce repeated labels", () => {
  const t = new Timeline(),
    reading = new Text("Reading source"),
    testing = new Text("Running tests"),
    current = new View({
      known: true,
      tokens: new Tokens({ input: 100n, cached_input: 60n, output: 20n }),
    });
  t.checkpoint("a", reading, current, 1000);
  current.tokens.add(new Tokens({ input: 30n, cached_input: 10n, output: 5n }));
  t.checkpoint("a", reading, current, 2000);
  expect(t.len).toBe(1);
  expect(t.points[0].usage.tokens.total()).toBe(155n);
  current.tokens.add(new Tokens({ input: 40n, output: 10n }));
  t.checkpoint("a", testing, current, 3000);
  expect(t.points[0].usage.tokens.total()).toBe(205n);
  expect(t.points[1].usage.tokens.total()).toBe(0n);
  current.tokens.add(new Tokens({ input: 7n, output: 3n }));
  expect(t.pending(current).tokens.total()).toBe(10n);
});
