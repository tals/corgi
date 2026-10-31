/** Fresh process-group membership: full /proc record versus getpgid. */
import { strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processGroup, processJob } from "../../src/os";
import { nativeRoot } from "../../src/native_paths";
import * as benchmark from "./cpu_lock";

const baseline = (pid: number) => processJob(pid)?.pgid ?? null;
let checksum = 0;
function measure(run: () => number | null, milliseconds: number) {
  const start = performance.now(),
    cpu = process.cpuUsage();
  let iterations = 0;
  do {
    for (let i = 0; i < 128; i++) checksum += run() ?? 0;
    iterations += 128;
  } while (performance.now() - start < milliseconds);
  const elapsed = performance.now() - start,
    used = process.cpuUsage(cpu);
  return { iterations, cpu_us: (used.user + used.system) / iterations, wall_us: (1000 * elapsed) / iterations };
}
function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

const release = await benchmark.acquire();
const children: ReturnType<typeof Bun.spawn>[] = [];
try {
  if (process.platform !== "linux") throw Error("LinuxOnly");
  for (const detached of [false, true])
    children.push(
      Bun.spawn(["/bin/sleep", "30"], {
        detached,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
  let checks = 0;
  const inputs = [
    { name: "current", pid: process.pid },
    { name: "inherited", pid: children[0].pid },
    { name: "isolated", pid: children[1].pid },
    { name: "missing", pid: 2147483647 },
  ];
  for (const { pid } of inputs) {
    strictEqual(processGroup(pid), baseline(pid));
    checks++;
  }
  for (const pid of [-1, 0, process.pid + 2 ** 32, process.pid + 0.5, NaN]) {
    strictEqual(processGroup(pid), null);
    checks++;
  }
  strictEqual(processGroup(children[0].pid), processGroup(process.pid));
  checks++;
  strictEqual(processGroup(children[1].pid), children[1].pid);
  checks++;
  const milliseconds = Number(process.env.GROUP_MS ?? 100),
    repeats = Number(process.env.GROUP_REPEATS ?? 6),
    reverse = process.argv.includes("--reverse"),
    cases = inputs.flatMap(({ name, pid }) => [
      { name: name + ".proc_stat", run: () => baseline(pid) },
      { name: name + ".getpgid", run: () => processGroup(pid) },
    ]),
    results = new Map(cases.map(entry => [entry.name, [] as ReturnType<typeof measure>[]]));
  for (const entry of cases) for (let i = 0; i < 1000; i++) checksum += entry.run() ?? 0;
  for (let trial = 0; trial < repeats; trial++)
    for (const entry of (trial + Number(reverse)) % 2 ? cases.toReversed() : cases)
      results.get(entry.name)!.push(measure(entry.run, milliseconds));
  for (const child of children) {
    child.kill("SIGKILL");
    await child.exited;
    strictEqual(processGroup(child.pid), null);
    checks++;
  }
  console.log(
    JSON.stringify(
      {
        checks,
        bun: Bun.version,
        milliseconds,
        repeats,
        reverse,
        provenance: Object.fromEntries(
          [
            "src/os.ts",
            "src/detection.ts",
            "src/native_ffi.ts",
            "native/posix.zig",
            "tools/benchmarks/process_group_costs.ts",
            join(nativeRoot, "lib/libcorgi_system.so"),
          ].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
        ),
        meanings: [
          "Both methods read the kernel on every call; no PID or exec cache and no observation cadence change.",
          "Baseline is actual processJob(pid)?.pgid; candidate is actual processGroup(pid).",
          "The old helper opens, reads to EOF, closes, decodes and parses /proc/PID/stat; candidate uses getpgid only.",
          "Process CPU includes Bun auxiliary threads. Hot-loop timings are not a macro CPU saving bound.",
        ],
        results: cases.map(entry => ({
          name: entry.name,
          median_cpu_us: median(results.get(entry.name)!.map(sample => sample.cpu_us)),
          median_wall_us: median(results.get(entry.name)!.map(sample => sample.wall_us)),
          samples: results.get(entry.name),
        })),
        checksum,
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  await release();
}
