#!/usr/bin/env bun
/** Run integration suites in separate Bun processes, keeping fixture state isolated. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2),
  selected: string[] = [],
  forwarded: string[] = [];
const env = { ...process.env };
let list = false,
  check = false,
  external = false,
  dev = false,
  jobs = Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));
function usage(): never {
  console.log(
    "Usage: bun run tests/run.ts [suite ...] [--list|--check] [--jobs N] [--external] [--dev] [--corgi PATH] [--herdr PATH] [-- bun-test-options]\nWithout suite names, runs all normal suites in isolated processes, several at a time (--jobs 1 runs them one by one). Herdr handoff and developer-launch suites are opt-in.",
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
  else if (arg === "--jobs" || arg === "-j") {
    jobs = Number(args[++i]);
    if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`${arg} requires a positive integer`);
  } else if (arg === "--corgi" || arg === "--herdr") {
    const value = args[++i];
    if (!value) throw new Error(`${arg} requires a path`);
    env[arg === "--corgi" ? "CORGI_TEST_BIN" : "HERDR_TEST_BIN"] = resolve(value);
  } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}; put bun test options after --`);
  else selected.push(arg.replace(/^.*\//, "").replace(/\.test\.ts$/, ""));
}
const available = readdirSync(import.meta.dir)
  .filter(file => file.endsWith(".test.ts"))
  .sort();
const suites = selected.length
  ? available.filter(file => selected.includes(file.slice(0, -8)))
  : available.filter(file => (external || file !== "herdr_handoff.test.ts") && (dev || file !== "dev.test.ts"));
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
// Previous durations let the slowest suites start first.
const timingsPath = resolve(import.meta.dir, "../.zig-cache/test-timings.json");
let timings: Record<string, number> = {};
try {
  timings = JSON.parse(readFileSync(timingsPath, "utf8"));
} catch {}
const queue = [...suites].sort((a, b) => (timings[b] ?? Infinity) - (timings[a] ?? Infinity));
const results: { suite: string; code: number; seconds: number }[] = [];
const children = new Set<ReturnType<typeof Bun.spawn>>();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) child.kill(signal);
  });
const parallel = jobs > 1 && queue.length > 1;
async function runSuite(suite: string) {
  const start = performance.now();
  if (!parallel) console.log(`\nRunning ${suite}`);
  // Parallel suites buffer their output so each prints as one block.
  const child = Bun.spawn(
    // Bounds overlap within suites whose cases are marked concurrent.
    [process.execPath, "test", "--max-concurrency=4", resolve(import.meta.dir, suite), ...forwarded],
    {
      cwd: resolve(import.meta.dir, ".."),
      env,
      stdin: parallel ? "ignore" : "inherit",
      stdout: parallel ? "pipe" : "inherit",
      stderr: parallel ? "pipe" : "inherit",
    },
  );
  children.add(child);
  const output = parallel
    ? await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
      ])
    : [];
  const code = await child.exited;
  children.delete(child);
  const seconds = (performance.now() - start) / 1000;
  if (parallel) {
    console.log(`\nRunning ${suite}`);
    process.stdout.write(output[0] + output[1]);
  }
  results.push({ suite, code, seconds });
  timings[suite] = seconds;
}
async function worker() {
  while (queue.length > 0 && !interrupted) await runSuite(queue.shift()!);
}
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
try {
  mkdirSync(resolve(timingsPath, ".."), { recursive: true });
  writeFileSync(timingsPath, JSON.stringify(timings, null, 2));
} catch {}
results.sort((a, b) => a.suite.localeCompare(b.suite));
console.log("\nSuite results:");
for (const result of results)
  console.log(`${result.code === 0 ? "PASS" : "FAIL"}  ${result.suite}  ${result.seconds.toFixed(1)}s`);
if (interrupted) console.error(`Interrupted after ${results.length}/${suites.length} suites.`);
process.exit(interrupted ? 130 : results.some(result => result.code !== 0) ? 1 : 0);
