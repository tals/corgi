#!/usr/bin/env bun
/** Run integration suites in separate Bun processes, keeping fixture state isolated. */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2),
  selected: string[] = [],
  forwarded: string[] = [];
const env = { ...process.env };
let list = false,
  check = false,
  external = false,
  dev = false;
function usage(): never {
  console.log(
    "Usage: bun run tests/run.ts [suite ...] [--list|--check] [--external] [--dev] [--corgi PATH] [--herdr PATH] [-- bun-test-options]\nWithout suite names, runs all normal suites in isolated processes. Herdr handoff and developer-launch suites are opt-in.",
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
  else if (arg === "--corgi" || arg === "--herdr") {
    const value = args[++i];
    if (!value) throw new Error(`${arg} requires a path`);
    env[arg === "--corgi" ? "CORGI_TEST_BIN" : "HERDR_TEST_BIN"] =
      resolve(value);
  } else if (arg.startsWith("-"))
    throw new Error(`Unknown option ${arg}; put bun test options after --`);
  else selected.push(arg.replace(/^.*\//, "").replace(/\.test\.ts$/, ""));
}
const available = readdirSync(import.meta.dir)
  .filter((file) => file.endsWith(".test.ts"))
  .sort();
const suites = selected.length
  ? available.filter((file) => selected.includes(file.slice(0, -8)))
  : available.filter(
      (file) =>
        (external || file !== "herdr_handoff.test.ts") &&
        (dev || file !== "dev.test.ts"),
    );
for (const name of selected)
  if (!available.includes(name + ".test.ts"))
    throw new Error(`Unknown suite: ${name}`);
if (list) {
  console.log(suites.join("\n"));
  process.exit(0);
}
if (check) {
  const result = await Bun.build({
    entrypoints: suites.map((file) => resolve(import.meta.dir, file)),
    target: "bun",
  });
  for (const log of result.logs) console.error(log);
  console.log(
    `${result.success ? "Parsed and bundled" : "Failed to bundle"} ${suites.length} suites (tests not executed).`,
  );
  process.exit(result.success ? 0 : 1);
}
if (suites.includes("herdr_handoff.test.ts"))
  env.HERDR_TEST_BIN ??= Bun.which("herdr") || "herdr";
const results: { suite: string; code: number; seconds: number }[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined,
  interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });
for (const suite of suites) {
  if (interrupted) break;
  console.log(`\nRunning ${suite}`);
  const start = performance.now();
  child = Bun.spawn(
    [process.execPath, "test", resolve(import.meta.dir, suite), ...forwarded],
    {
      cwd: resolve(import.meta.dir, ".."),
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  results.push({
    suite,
    code: await child.exited,
    seconds: (performance.now() - start) / 1000,
  });
  child = undefined;
}
console.log("\nSuite results:");
for (const result of results)
  console.log(
    `${result.code === 0 ? "PASS" : "FAIL"}  ${result.suite}  ${result.seconds.toFixed(1)}s`,
  );
if (interrupted)
  console.error(`Interrupted after ${results.length}/${suites.length} suites.`);
process.exit(
  interrupted ? 130 : results.some((result) => result.code !== 0) ? 1 : 0,
);
