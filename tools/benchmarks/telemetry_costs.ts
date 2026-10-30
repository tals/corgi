/** Instrumentation cost only; run disabled, aggregates, and trace in separate processes. */
import { readFileSync } from "node:fs";
import * as telemetry from "../../src/telemetry";
import * as benchmark from "./cpu_lock";

const release = await benchmark.acquire();
let sink = 0;
function measure(instrument: boolean, milliseconds: number) {
  const started = performance.now(),
    cpu = process.cpuUsage();
  let iterations = 0;
  do {
    for (let i = 0; i < 1024; i++) {
      const start = instrument ? telemetry.begin() : 0;
      sink = (sink + i) | 0;
      if (instrument) telemetry.end("native.encode", start, 64);
      iterations++;
    }
  } while (performance.now() - started < milliseconds);
  const elapsed = performance.now() - started,
    used = process.cpuUsage(cpu);
  return {
    iterations,
    wall_ns: (elapsed * 1e6) / iterations,
    cpu_ns: ((used.user + used.system) * 1000) / iterations,
  };
}
try {
  measure(false, 100);
  measure(true, 100);
  const trials = [];
  for (let i = 0; i < 8; i++) {
    const order = i % 2 ? [true, false] : [false, true];
    for (const instrument of order) trials.push({ instrument, ...measure(instrument, 150) });
  }
  console.log(
    JSON.stringify(
      {
        enabled: telemetry.enabled,
        trace: !!process.env.CORGI_TELEMETRY_TRACE,
        affinity: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],
        bun: Bun.version,
        trials,
        sink,
        notes:
          "Paired hot-loop overhead; includes two clocks when enabled. Flush/I/O excluded; verify whole-app overhead separately.",
      },
      null,
      2,
    ),
  );
} finally {
  await release();
}
