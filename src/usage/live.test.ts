import { test, expect } from "bun:test";
import { Tokens, Counter } from "./live";
test("owned first request is counted once and recent buckets expire", () => {
  const c = new Counter(),
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
  const c = new Counter();
  c.sample(new Tokens({ input: 1000n, output: 100n }), null, false, 1);
  c.sample(new Tokens({ input: 10n, output: 1n }), null, true, 2);
  c.sample(new Tokens({ input: 1000n, output: 100n }), null, true, 3);
  expect(c.meter.value.tokens.total()).toBe(0n);
  c.sample(new Tokens({ input: 9000n, output: 900n }), new Tokens({ input: 30n, output: 5n }), true, 4);
  expect(c.meter.value.tokens.total()).toBe(35n);
  expect(c.meter.value.partial).toBe(true);
});
