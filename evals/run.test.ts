import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("runner exits nonzero for failures/missing results and saves a reproducible scorecard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-eval-test-"));
  try {
    const driver = join(dir, "fixture.ts");
    await writeFile(
      driver,
      `#!/usr/bin/env bun
const plan = await Bun.file(process.argv.at(-1)).json();
for (const scenario of plan) for (const step of scenario.steps) {
  if (process.env.EVAL_TEST_MISSING) continue;
  console.log(JSON.stringify({id:step.id,status:"abstained",label:null,raw:'{"label":null}',elapsed_ms:1}));
}
`,
    );
    await chmod(driver, 0o700);
    for (const [index, name, missing, code] of [
      [0, "make-alone", false, 0],
      [1, "running-tests", false, 1],
      [2, "make-alone", true, 1],
    ] as const) {
      const out = join(dir, String(index));
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "run.ts"),
          "--driver",
          driver,
          "--model",
          "codex:fixture",
          "--case",
          name,
          "--out",
          out,
        ],
        { env: { ...process.env, EVAL_TEST_MISSING: missing ? "1" : "" }, stdout: "ignore", stderr: "pipe" },
      );
      const error = new Response(proc.stderr).text();
      expect(await proc.exited, await error).toBe(code);
      const report = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
      expect(report.metadata.fixture).toBe(true);
      expect(report.metadata.hashes["src/activity/prompt.ts"]).toHaveLength(64);
      expect(report.results).toHaveLength(1);
      expect(report.results[0].failures.length === 0).toBe(code === 0);
      expect(await readFile(join(out, "latest.md"), "utf8")).toContain(code === 0 ? "1/1" : "0/1");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
