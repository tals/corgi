/** Caps fixed waits in the suites; see "Waiting" in README.md. */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Lower this when you remove a sleep.
const budget = 75;

test("the suites sleep no more than the budget", () => {
  let count = 0;
  for (const file of readdirSync(import.meta.dir))
    if (file.endsWith(".ts"))
      count += readFileSync(join(import.meta.dir, file), "utf8").match(/\bsleep\(/g)?.length ?? 0;
  expect(count).toBeLessThanOrEqual(budget);
});
