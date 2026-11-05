import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as progress from "./progress";

function fixture() {
  const directory = mkdtempSync("/tmp/corgi-progress-test-");
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function execute(directory: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: directory,
    env: {
      ...process.env,
      GITHUB_TOKEN: undefined,
      GITHUB_STEP_SUMMARY: undefined,
      CORGI_TEST_PROGRESS_DIR: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

function runner(directory: string) {
  for (const file of ["tests/run.ts", "tests/progress.ts", "scripts/process_scope.ts"]) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), readFileSync(join(import.meta.dir, "..", file)));
  }
}

test("duration estimates use selected files, timing history, and worker count", () => {
  const { directory, cleanup } = fixture();
  try {
    const timings = [join(directory, "1.json"), join(directory, "2.json"), join(directory, "missing.json")];
    writeFileSync(timings[0], JSON.stringify({ version: 1, files: { "a.test.ts": 120_000, "b.test.ts": 90_000 } }));
    writeFileSync(
      timings[1],
      JSON.stringify({
        version: 1,
        files: { "c.test.ts": 60_000, "d.test.ts": 30_000, "unselected.test.ts": 999_999 },
      }),
    );
    const files = ["a", "b", "c", "d"].map(name => join(directory, `${name}.test.ts`));
    expect(progress.duration(files, timings, directory, 1)).toBe(300_000);
    expect(progress.duration(files, timings, directory, 2)).toBe(150_000);
    expect(progress.duration(files, timings, directory, 3)).toBe(120_000);
    expect(progress.duration(files.slice(0, 2), timings, directory, 2)).toBe(120_000);
    expect(progress.duration([...files, join(directory, "new.test.ts")], timings, directory, 2)).toBeNull();
    expect(progress.duration(files, [], directory, 2)).toBeNull();
    writeFileSync(timings[1], "invalid JSON");
    expect(progress.duration(files, timings, directory, 2)).toBeNull();
    writeFileSync(timings[1], JSON.stringify({ version: 1, files: { "c.test.ts": -1, "d.test.ts": "30000" } }));
    expect(progress.duration(files, timings, directory, 2)).toBeNull();
    expect(progress.eta(150_000)).toBe("~3m left");
    expect(progress.eta(30_000)).toBe("<1m left");
    expect(progress.eta(0)).toBe("past estimate");
    expect(progress.eta(-30_000)).toBe("past estimate");
  } finally {
    cleanup();
  }
});

test("preload counts individual attempts across parallel workers, including failures and timeouts", async () => {
  const { directory, cleanup } = fixture();
  try {
    const events = join(directory, "events");
    mkdirSync(events);
    writeFileSync(
      join(directory, "a.test.ts"),
      `import { test } from "bun:test";
test.concurrent("slow", async () => { await Bun.sleep(80); });
test.concurrent("failure", async () => { await Bun.sleep(20); throw Error("expected fixture failure"); });
test.skip("skipped", () => {});
test("timeout", async () => { await Bun.sleep(200); }, 10);
`,
    );
    writeFileSync(
      join(directory, "b.test.ts"),
      'import { test } from "bun:test"; import { existsSync } from "node:fs"; test("other worker", async () => { while (!existsSync("release")) await Bun.sleep(10); });',
    );
    let exited = false;
    const running = execute(
      directory,
      [
        "test",
        "--parallel=2",
        "--preload",
        join(import.meta.dir, "progress.ts"),
        "--reporter=junit",
        "--reporter-outfile=report.xml",
        "./a.test.ts",
        "./b.test.ts",
      ],
      { CORGI_TEST_PROGRESS_DIR: events },
    ).finally(() => {
      exited = true;
    });
    try {
      const deadline = Date.now() + 3000;
      while (progress.counts(events).finished === 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(progress.counts(events).finished).toBeGreaterThan(0);
      expect(exited).toBe(false);
    } finally {
      writeFileSync(join(directory, "release"), "");
    }
    const run = await running;
    expect(run.code).toBe(1);
    expect(progress.counts(events)).toEqual({ finished: 4, running: 0 });
    const results = progress.results(readFileSync(join(directory, "report.xml"), "utf8"), directory);
    expect(
      results.map(result => [result.file.split("/").at(-1), result.tests, result.failures, result.skipped]).sort(),
    ).toEqual([
      ["a.test.ts", 4, 2, 1],
      ["b.test.ts", 1, 0, 0],
    ]);
  } finally {
    cleanup();
  }
});

test("runner retries failed files alone and reports recovery without counting a nested describe twice", async () => {
  const { directory, cleanup } = fixture();
  try {
    runner(directory);
    writeFileSync(
      join(directory, "tests/a.test.ts"),
      `import { describe,test } from "bun:test";
import { existsSync,writeFileSync } from "node:fs";
describe("nested", () => test("flaky", () => { if (!existsSync("attempt")) { writeFileSync("attempt", "1"); throw Error("first attempt fails"); } }));
`,
    );
    writeFileSync(join(directory, "tests/b.test.ts"), 'import { test } from "bun:test"; test("passes", () => {});');
    const timings = join(directory, ".zig-cache/integration-timings");
    mkdirSync(timings, { recursive: true });
    writeFileSync(
      join(timings, "local.json"),
      JSON.stringify({ version: 1, files: { "tests/a.test.ts": 120_000, "tests/b.test.ts": 60_000 } }),
    );
    const summary = join(directory, "summary.md");
    const run = await execute(directory, ["tests/run.ts", "--jobs", "2", "--retry"], { GITHUB_STEP_SUMMARY: summary });
    expect(run.code).toBe(0);
    expect(run.output).toContain("Testing · 0% · 0/2 finished");
    expect(run.output).toContain("Testing · 0% · 0/2 finished · 0 running · ~2m left");
    expect(run.output).toContain("Retrying a.test.ts");
    expect(run.output).toContain("Retrying a.test.ts · 0% · 0/1 finished");
    expect(readFileSync(summary, "utf8")).toContain("2 passed · 0 failed · 0 skipped");
    expect(readFileSync(summary, "utf8")).toContain("| FLAKY | a.test.ts | 1 |");
  } finally {
    cleanup();
  }
}, 20_000);

test("inventory counts skipped and filtered tests without running bodies or lifecycle hooks", async () => {
  const { directory, cleanup } = fixture();
  try {
    runner(directory);
    writeFileSync(
      join(directory, "tests/count.test.ts"),
      `import { beforeAll, afterAll, describe, test } from "bun:test";
import { appendFileSync } from "node:fs";
const record = (name) => appendFileSync("executed", name + "\\n");
beforeAll(() => record("before"));
afterAll(() => record("after"));
describe("nested", () => {
  test("run one", () => record("one"));
  test("run two", () => record("two"));
  test.skip("run skipped", () => record("skipped"));
  test("filtered", () => record("filtered"));
});
`,
    );
    const summary = join(directory, "summary.md");
    const run = await execute(directory, ["tests/run.ts", "--jobs", "2", "--", "-t", "nested run"], {
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(run.code).toBe(0);
    expect(run.output).toContain("Testing · 0% · 0/4 finished");
    expect(run.output).toContain("50% · 2/4 finished · 0 running");
    expect(readFileSync(join(directory, "executed"), "utf8")).toBe("before\none\ntwo\nafter\n");
    expect(readFileSync(summary, "utf8")).toContain("2 passed · 0 failed · 2 skipped");
  } finally {
    cleanup();
  }
}, 20_000);

for (const flaky of [false, true])
  test(`runner cannot hide a crash ${flaky ? "beside a flaky test" : "alone"}`, async () => {
    const { directory, cleanup } = fixture();
    try {
      runner(directory);
      writeFileSync(
        join(directory, "tests/z_crash.test.ts"),
        'import { test } from "bun:test"; test("crash", () => process.exit(7));',
      );
      if (flaky)
        writeFileSync(
          join(directory, "tests/a_flaky.test.ts"),
          `import { test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
test("flaky", () => {
  const attempt = existsSync("attempts") ? Number(readFileSync("attempts", "utf8")) + 1 : 1;
  writeFileSync("attempts", String(attempt));
  if (attempt === 1) throw Error("first attempt fails");
});
`,
        );
      const summary = join(directory, "summary.md");
      const run = await execute(directory, ["tests/run.ts", "--jobs", "2", "--retry"], {
        GITHUB_STEP_SUMMARY: summary,
      });
      expect(run.code).not.toBe(0);
      expect(readFileSync(summary, "utf8")).toContain("Integration failure.");
      if (flaky) {
        expect(readFileSync(join(directory, "attempts"), "utf8")).toBe("2");
        expect(run.output).toContain("a_flaky.test.ts failed, then passed when run again");
      }
    } finally {
      cleanup();
    }
  }, 20_000);

test("Bun shards cover every selected file once while sharing a timing baseline", async () => {
  const { directory, cleanup } = fixture();
  try {
    runner(directory);
    const files: Record<string, number> = {};
    for (let i = 0; i < 5; i++) {
      const file = `tests/${i}.test.ts`;
      files[file] = i === 0 ? 1000 : 10;
      writeFileSync(join(directory, file), 'import { test } from "bun:test"; test("passes", () => {});');
    }
    const baseline = join(directory, ".zig-cache/integration-timings/baseline");
    mkdirSync(baseline, { recursive: true });
    writeFileSync(join(baseline, "1.json"), JSON.stringify({ version: 1, files }));
    const seen: string[] = [];
    for (const shard of [1, 2]) {
      const run = await execute(directory, ["tests/run.ts", "--jobs", "2", "--shard", `${shard}/2`]);
      expect(run.code).toBe(0);
      const timings = JSON.parse(
        readFileSync(join(directory, `.zig-cache/integration-timings/current/${shard}.json`), "utf8"),
      );
      expect(run.output).toContain(`Testing · 0% · 0/${Object.keys(timings.files).length} finished`);
      seen.push(...Object.keys(timings.files));
    }
    expect(seen.sort()).toEqual(Object.keys(files).sort());
    expect(JSON.parse(readFileSync(join(baseline, "1.json"), "utf8")).files).toEqual(files);
    const empty = await execute(directory, ["tests/run.ts", "0", "--shard", "2/2"]);
    expect(empty.code).toBe(0);
  } finally {
    cleanup();
  }
}, 20_000);

test("GitHub progress updates only the existing job and keeps its result owned by Actions", async () => {
  const { directory, cleanup } = fixture();
  const requests: {
    method: string;
    path: string;
    body: { output: { title: string; summary: string } };
  }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ id: 123 });
    },
  });
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_TOKEN: "fixture",
    GITHUB_REPOSITORY: "owner/repo",
    CORGI_TEST_CHECK_ID: "9007199254740993",
    GITHUB_API_URL: server.url.origin,
    GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
  };
  const reporter = await progress.Reporter.start(env);
  try {
    const attempt = reporter.begin("Testing", 4, 120_000);
    writeFileSync(join(attempt.CORGI_TEST_PROGRESS_DIR, "1.events"), "++-");
    await reporter.update();
    reporter.begin("Retrying flaky.test.ts", 2, 180_000);
    await reporter.update();
    await reporter.update("Cleanup");
  } finally {
    await reporter.finish(
      "success",
      [{ file: "/tests/flaky.test.ts", tests: 3, failures: 0, skipped: 1, seconds: 1 }],
      ["/tests/flaky.test.ts"],
    );
    server.stop(true);
  }
  try {
    for (const request of requests) {
      expect(request.method).toBe("PATCH");
      expect(request.path).toBe("/repos/owner/repo/check-runs/9007199254740993");
      expect(Object.keys(request.body)).toEqual(["output"]);
    }
    expect(requests[1].body.output.title).toBe("1/4 · 25% · ~2m left");
    expect(requests[1].body.output.summary).toContain("1/4 finished · 1 running");
    expect(requests[2].body.output.title).toBe("Retry · 0/2 · 0% · ~3m left");
    expect(requests[3].body.output.title).toBe("Cleanup");
    expect(requests.at(-1)?.body.output.title).toBe("3/3 · 100%");
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")).toContain("2 passed · 0 failed · 1 skipped");
  } finally {
    cleanup();
  }
});

for (const code of [403, 503])
  test(`GitHub HTTP ${code} cannot fail the tests`, async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("unavailable", { status: code }) });
    try {
      const reporter = await progress.Reporter.start({
        GITHUB_ACTIONS: "true",
        GITHUB_TOKEN: "fixture",
        GITHUB_REPOSITORY: "owner/repo",
        CORGI_TEST_CHECK_ID: "123",
        GITHUB_API_URL: server.url.origin,
      });
      reporter.begin("Testing");
      await reporter.update();
      await reporter.finish("success", [], []);
      expect(existsSync(reporter.directory)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

test("a missing or invalid job ID never falls back to creating another check or status", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return Response.json({ id: 123 });
    },
  });
  try {
    for (const id of [undefined, "0", "invalid"]) {
      const reporter = await progress.Reporter.start({
        GITHUB_ACTIONS: "true",
        GITHUB_TOKEN: "fixture",
        GITHUB_REPOSITORY: "owner/repo",
        CORGI_TEST_CHECK_ID: id,
        GITHUB_API_URL: server.url.origin,
      });
      reporter.begin("Testing");
      await reporter.update();
      await reporter.finish("success", [], []);
    }
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
  }
});
