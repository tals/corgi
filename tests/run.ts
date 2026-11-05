#!/usr/bin/env bun
/** Select integration suites and let Bun schedule their execution. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { Scope } from "../scripts/process_scope";
import * as progress from "./progress";

const args = process.argv.slice(2),
  selected: string[] = [],
  forwarded: string[] = [];
const env = { ...process.env };
let list = false,
  check = false,
  external = false,
  dev = false,
  retry = false,
  shard: [number, number] | null = null,
  jobs = Math.max(1, Math.min(2, Math.floor(availableParallelism() / 4)));
function usage(): never {
  console.log(
    "Usage: bun run tests/run.ts [suite ...] [--list|--check] [--jobs N] [--shard K/N] [--retry] [--external] [--dev] [--corgi PATH] [--herdr PATH] [-- bun-test-options]\nWithout suite names, runs normal suites with Bun file isolation (--jobs N workers); --list lists eligible suites before sharding; --shard K/N delegates partitioning to Bun; --retry runs each failed suite once more, alone. Herdr handoff, real-Codex and developer-launch suites are opt-in.",
  );
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--") {
    forwarded.push(...args.slice(i + 1));
    break;
  }
  if (arg === "--help" || arg === "-h") usage();
  else if (arg === "--list") list = true;
  else if (arg === "--check") check = true;
  else if (arg === "--external") external = true;
  else if (arg === "--dev") dev = true;
  else if (arg === "--retry") retry = true;
  else if (arg === "--jobs" || arg === "-j") {
    jobs = Number(args[++i]);
    if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`${arg} requires a positive integer`);
  } else if (arg === "--shard") {
    const match = /^(\d+)\/(\d+)$/.exec(args[++i] ?? "");
    shard = match ? [Number(match[1]), Number(match[2])] : null;
    if (!shard || shard[0] < 1 || shard[0] > shard[1]) throw new Error(`${arg} requires K/N with 1 <= K <= N`);
  } else if (arg === "--corgi" || arg === "--herdr") {
    const value = args[++i];
    if (!value) throw new Error(`${arg} requires a path`);
    env[arg === "--corgi" ? "CORGI_TEST_BIN" : "HERDR_TEST_BIN"] = resolve(value);
  } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}; put bun test options after --`);
  else selected.push(arg.replace(/^.*\//, "").replace(/\.test\.ts$/, ""));
}
/** Suites that run other people's programs: Herdr, and Codex on a fake model. */
const externals = ["herdr_handoff.test.ts", "codex_overload.test.ts"];
const available = readdirSync(import.meta.dir)
  .filter(file => file.endsWith(".test.ts"))
  .sort();
const suites = selected.length
  ? available.filter(file => selected.includes(file.slice(0, -8)))
  : available.filter(file => (external || !externals.includes(file)) && (dev || file !== "dev.test.ts"));
for (const name of selected) if (!available.includes(name + ".test.ts")) throw new Error(`Unknown suite: ${name}`);
if (list) {
  console.log(suites.join("\n"));
  process.exit(0);
}
if (check) {
  const result = await Bun.build({
    entrypoints: suites.map(file => resolve(import.meta.dir, file)),
    target: "bun",
  });
  for (const log of result.logs) console.error(log);
  console.log(
    `${result.success ? "Parsed and bundled" : "Failed to bundle"} ${suites.length} suites (tests not executed).`,
  );
  process.exit(result.success ? 0 : 1);
}
if (suites.includes("herdr_handoff.test.ts")) env.HERDR_TEST_BIN ??= Bun.which("herdr") || "herdr";
const root = resolve(import.meta.dir, "..");
const timingRoot = resolve(root, ".zig-cache/integration-timings");
const timingOutput = shard ? resolve(timingRoot, `current/${shard[0]}.json`) : resolve(timingRoot, "local.json");
mkdirSync(resolve(timingOutput, ".."), { recursive: true });
// All CI shards read the same immutable baseline shipped with the build.
if (shard) rmSync(timingOutput, { force: true });
const baseline = resolve(timingRoot, "baseline");
const timings = [
  timingOutput,
  ...(existsSync(baseline)
    ? readdirSync(baseline)
        .filter(file => file.endsWith(".json"))
        .sort()
        .map(file => resolve(baseline, file))
    : []),
];
const scope = await Scope.start(env);
const reporter = await progress.Reporter.start();
const reports = resolve(reporter.directory, "reports");
mkdirSync(reports);
let child: ReturnType<typeof Bun.spawn> | null = null;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    interrupted = true;
    child?.kill(signal);
    void scope.close().catch(error => console.error(error));
  });
let reportNumber = 0;
async function run(
  files: string[],
  phase: string,
  flags: string[],
  total: number | null = null,
  duration: number | null = null,
) {
  const report = resolve(reports, `${++reportNumber}.xml`);
  const command = [process.execPath, "test", "--max-concurrency=2", ...flags, ...forwarded, ...files];
  if (total === null && !interrupted) {
    await reporter.update("Counting tests");
    // Filtering every test still produces JUnit inventory, without running hooks or test bodies.
    child = Bun.spawn(
      [
        ...command.filter(arg => arg !== "--update-timings"),
        "--test-name-pattern=a^",
        "--pass-with-no-tests",
        "--reporter=junit",
        `--reporter-outfile=${report}.count`,
      ],
      { cwd: root, env: scope.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const counted = await child.exited;
    child = null;
    if (counted === 0 && existsSync(`${report}.count`)) {
      try {
        const inventory = progress.results(readFileSync(`${report}.count`, "utf8"), root);
        if (inventory.every(result => result.failures === 0)) {
          total = inventory.reduce((sum, result) => sum + result.tests, 0);
          if (!forwarded.length)
            duration = progress.duration(
              inventory.map(result => result.file),
              timings,
              root,
              jobs,
            );
        }
      } catch {}
    }
  }
  const environment = { ...scope.env, ...reporter.begin(phase, total, duration) };
  await reporter.update();
  if (interrupted) return { code: 130, results: [] };
  child = Bun.spawn(
    [
      ...command,
      "--preload",
      resolve(import.meta.dir, "progress.ts"),
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: root, env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  const code = await child.exited;
  child = null;
  // Bun exits successfully without a report when a shard has no files.
  const results =
    interrupted || (code === 0 && !existsSync(report)) ? [] : progress.results(readFileSync(report, "utf8"), root);
  const selected = new Set(files);
  if (results.some(result => !selected.has(result.file))) throw Error("JUnit report contains an unselected suite");
  return { code, results };
}
let code = 1;
let results: progress.Result[] = [];
const flaky: string[] = [];
try {
  if (suites.length) {
    const initial = await run(
      suites.map(file => resolve(import.meta.dir, file)),
      "Testing",
      [
        `--parallel=${jobs}`,
        ...timings.map(path => `--timings=${path}`),
        "--update-timings",
        ...(shard ? [`--shard=${shard.join("/")}`] : []),
      ],
    );
    code = initial.code;
    results = initial.results;
    const failed = results.filter(result => result.failures > 0);
    if (retry && code === 1 && failed.length) {
      let recovered = true;
      for (const result of failed) {
        if (interrupted) break;
        const rerun = await run(
          [result.file],
          `Retrying ${result.file.split("/").at(-1)}`,
          ["--parallel=1"],
          result.tests,
          result.seconds * 1000 || null,
        );
        const replacement = rerun.results.find(item => item.file === result.file);
        if (replacement) results[results.indexOf(result)] = replacement;
        if (rerun.code === 0 && replacement && replacement.failures === 0) {
          flaky.push(result.file);
          console.log(`${env.GITHUB_ACTIONS ? "::warning::" : ""}${result.file} failed, then passed when run again`);
        } else recovered = false;
      }
      if (recovered && !interrupted) code = 0;
    }
  } else code = 0;
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  await reporter.update("Cleanup");
  try {
    await scope.assertClean();
  } catch (error) {
    console.error(error);
    code = 1;
  }
  process.exitCode = interrupted ? 130 : code;
  await reporter.finish(interrupted ? "cancelled" : code === 0 ? "success" : "failure", results, flaky);
}
