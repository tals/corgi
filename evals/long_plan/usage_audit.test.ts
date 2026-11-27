import { expect, test } from "bun:test";
import { combine } from "./usage_audit";

test("retry accounting includes each receipt once and thinking only within output", () => {
  const first = {
      uncached_input: 102n,
      regular_input: 2n,
      cache_write_input: 100n,
      cache_read_input: 1000n,
      output: 200n,
      thinking: 150n,
      receipts: [{ attempt: 1 }],
    },
    retry = { ...first, output: 100n, thinking: 50n, receipts: [{ attempt: 2 }] };
  expect(combine([first, retry])).toEqual({
    uncached_input: 204n,
    regular_input: 4n,
    cache_write_input: 200n,
    cache_read_input: 2000n,
    output: 300n,
    thinking: 200n,
    receipts: [{ attempt: 1 }, { attempt: 2 }],
  });
  expect(combine([first, { ...retry, thinking: null }]).thinking).toBeNull();
});
