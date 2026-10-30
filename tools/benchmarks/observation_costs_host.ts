/** Linux host sampling decomposition. Run only in the exclusive CPU slot.
 * CORGI_NATIVE_ROOT=/path/to/native/zig-out bun tools/benchmarks/observation_costs_host.ts
 * OBSERVATION_HOST_MS=100 OBSERVATION_HOST_REPEATS=6 controls sampling.
 */
import { deepStrictEqual, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import * as resources from "../../src/trackers/resource_os";
import * as benchmark from "./cpu_lock";

type Inputs = { stat: string | null; pressure: string | null; memory: bigint; cores: number };

// The production Linux parsing expressions, with OS reads replaced by fixed inputs.
function baseline(input: Inputs): resources.Host {
  const out: resources.Host = {
    busy: 0n,
    total: 0n,
    cores: Math.max(1, input.cores),
    memory: input.memory,
    pressure: "unknown",
  };
  try {
    if (input.stat === null) throw Error("Unavailable");
    const values = input.stat.split("\n")[0].trim().split(/\s+/).slice(1, 9).map(BigInt);
    out.total = values.reduce((a, b) => a + b, 0n);
    out.busy = out.total - values[3] - values[4];
  } catch {}
  applyPressure(out, input.pressure);
  return out;
}

function applyPressure(out: resources.Host, text: string | null) {
  const p = text?.match(/some avg10=([\d.]+)/);
  if (p) {
    const value = Number(p[1]);
    out.pressure = value >= 10 ? "critical" : value >= 1 ? "warning" : "normal";
  }
}

function onlineCores(stat: string | null) {
  if (stat === null) return 0;
  let count = 0;
  for (let start = stat.indexOf("\ncpu"); start >= 0; start = stat.indexOf("\ncpu", start + 1)) {
    let end = start + 4;
    while (stat.charCodeAt(end) >= 48 && stat.charCodeAt(end) <= 57) end++;
    if (end > start + 4 && (stat[end] === " " || stat[end] === "\t")) count++;
  }
  return count;
}

function compact(input: Inputs, cores = onlineCores(input.stat) || input.cores): resources.Host {
  const out: resources.Host = {
    busy: 0n,
    total: 0n,
    cores: Math.max(1, cores),
    memory: input.memory,
    pressure: "unknown",
  };
  try {
    if (input.stat === null) throw Error("Unavailable");
    const newline = input.stat.indexOf("\n"),
      line = newline < 0 ? input.stat : input.stat.slice(0, newline),
      values = line.trim().split(/\s+/).slice(1, 9).map(BigInt);
    out.total = values.reduce((a, b) => a + b, 0n);
    out.busy = out.total - values[3] - values[4];
  } catch {}
  applyPressure(out, input.pressure);
  return out;
}

function read(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// No cached CPU count: hotplug changes appear in the same snapshot as CPU counters.
// Missing /proc CPU rows retain the production os.cpus() fallback.
function compactHost(): resources.Host {
  const stat = read("/proc/stat"),
    cores = onlineCores(stat) || cpus().length;
  return compact({ stat, pressure: read("/proc/pressure/memory"), memory: BigInt(totalmem()), cores }, cores);
}

function cpuList(list: string) {
  return list
    .trim()
    .split(",")
    .flatMap(part => {
      const [start, end = start] = part.split("-").map(Number);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    });
}

function loadSnapshot() {
  const result: Record<string, { busy: number; total: number }> = {};
  for (const line of readFileSync("/proc/stat", "utf8").split("\n")) {
    const fields = line.split(/\s+/);
    if (!/^cpu\d*$/.test(fields[0])) continue;
    const values = fields.slice(1, 9).map(Number),
      total = values.reduce((a, b) => a + b, 0);
    result[fields[0]] = { total, busy: total - values[3] - values[4] };
  }
  return result;
}

function verify() {
  let cases = 0;
  for (const count of [1, 16, 256])
    for (const pressure of [
      null,
      "some avg10=0.00 avg60=0.00",
      "some avg10=0.99",
      "some avg10=1.00",
      "some avg10=9.99",
      "some avg10=10.00",
      "full avg10=20.00",
    ])
      for (const first of ["cpu  1 2 3 4 5 6 7 8 9 10", "cpu  1 2 3", "cpu  invalid"]) {
        const stat =
          first +
          "\n" +
          Array.from({ length: count }, (_, i) => `cpu${i * 2} 1 2 3 4 5 6 7 8`).join("\n") +
          "\nintr 1\n";
        const input: Inputs = { stat, pressure, memory: 9007199254740993n, cores: count };
        deepStrictEqual(compact(input), baseline(input));
        cases++;
      }
  for (const stat of [null, "", "cpu 1 2 3 4 5 6 7 8\n", "cpu 1 2 3 4 5 6 7 8\ncpufoo 1\ncpu7x 1\n"]) {
    const input: Inputs = { stat, pressure: null, memory: 1n, cores: 7 };
    deepStrictEqual(compact(input), baseline(input));
    cases++;
  }
  strictEqual(onlineCores("cpu 1\ncpu0 1\ncpu3 1\ncpu99\t1\n"), 3);
  return cases + 1;
}

let checksum = 0;
function consume(host: resources.Host) {
  return host.cores + Number(host.total & 65535n);
}
type Sample = { cpu_us: number; wall_us: number; iterations: number };
function measure(run: () => number, milliseconds: number): Sample {
  Bun.gc(true);
  const start = performance.now(),
    cpu = process.cpuUsage();
  let iterations = 0;
  do {
    checksum += run();
    iterations++;
  } while (performance.now() - start < milliseconds);
  const wall = performance.now() - start,
    used = process.cpuUsage(cpu);
  return { cpu_us: (used.user + used.system) / iterations, wall_us: (wall * 1000) / iterations, iterations };
}
function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

const release = await benchmark.acquire();
try {
  if (process.platform !== "linux") throw Error("LinuxOnly");
  const checks = verify(),
    status = readFileSync("/proc/self/status", "utf8"),
    affinity = status.match(/^Cpus_allowed_list:\s*(.*)$/m)![1],
    allowed = cpuList(affinity),
    siblings = [
      ...new Set(
        allowed.flatMap(cpu =>
          cpuList(readFileSync(`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`, "utf8")),
        ),
      ),
    ].filter(cpu => !allowed.includes(cpu)),
    proc = readFileSync("/proc/stat", "utf8"),
    fixed: Inputs = {
      stat: proc,
      pressure: read("/proc/pressure/memory"),
      memory: BigInt(totalmem()),
      cores: cpus().length,
    },
    milliseconds = Number(process.env.OBSERVATION_HOST_MS ?? 100),
    repeats = Number(process.env.OBSERVATION_HOST_REPEATS ?? 6);
  deepStrictEqual(compact(fixed), baseline(fixed));
  const cases = [
      { name: "production_host", run: () => consume(resources.host()) },
      { name: "compact_host", run: () => consume(compactHost()) },
      { name: "os_cpus_length", run: () => cpus().length },
      { name: "proc_stat_read", run: () => readFileSync("/proc/stat", "utf8").length },
      { name: "pressure_read", run: () => read("/proc/pressure/memory")?.length ?? 0 },
      { name: "totalmem", run: () => totalmem() },
      { name: "fixed_baseline_parse", run: () => consume(baseline(fixed)) },
      { name: "fixed_compact_parse", run: () => consume(compact(fixed)) },
    ],
    samples = new Map(cases.map(entry => [entry.name, [] as Sample[]]));
  for (const entry of cases) checksum += entry.run();
  const started = Date.now(),
    before = loadSnapshot();
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const entry of repeat % 2 ? cases.toReversed() : cases)
      samples.get(entry.name)!.push(measure(entry.run, milliseconds));
  const after = loadSnapshot(),
    elapsed = Date.now() - started;
  const hostLoad = Object.fromEntries(
    ["cpu", ...siblings.map(cpu => `cpu${cpu}`)].map(name => {
      const first = before[name],
        last = after[name];
      return [name, first && last ? (100 * (last.busy - first.busy)) / (last.total - first.total) : null];
    }),
  );
  console.log(
    JSON.stringify(
      {
        node: process.env.OBSERVATION_NODE ?? null,
        bun: Bun.version,
        platform: process.platform,
        baseline: "fb129d2",
        affinity,
        memory_nodes: status.match(/^Mems_allowed_list:\s*(.*)$/m)?.[1],
        cores: fixed.cores,
        proc_stat_bytes: Buffer.byteLength(proc),
        pressure_bytes: fixed.pressure === null ? null : Buffer.byteLength(fixed.pressure),
        checks,
        repeats,
        milliseconds,
        elapsed_ms: elapsed,
        host_busy_percent: hostLoad,
        source_hashes: Object.fromEntries(
          ["src/trackers/resource_os.ts", "tools/benchmarks/observation_costs_host.ts"].map(path => [
            path,
            createHash("sha256").update(readFileSync(path)).digest("hex"),
          ]),
        ),
        meanings: [
          "Process CPU includes all Bun threads; times are per operation, not process CPU percentages.",
          "Production host is the actual imported implementation. Fixed baseline parser copies its Linux parsing expressions.",
          "Compact host reads CPU count and aggregate counters from one /proc/stat snapshot; count is refreshed each call.",
          "Missing CPU records fall back to os.cpus(). Full compatibility with unusual procfs mounts was not established.",
          "Hot loops measure warm repeated reads. Multiplying by 0.5 Hz is an estimate, not a macro saving bound.",
        ],
        results: cases.map(entry => ({
          name: entry.name,
          median_cpu_us: median(samples.get(entry.name)!.map(s => s.cpu_us)),
          median_wall_us: median(samples.get(entry.name)!.map(s => s.wall_us)),
          samples: samples.get(entry.name),
        })),
        checksum,
      },
      null,
      2,
    ),
  );
} finally {
  await release();
}
