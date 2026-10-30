/** Shared producer timing for Corgi/Herdr; all trace I/O is outside CPU windows. */
import { dlopen, ptr } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_PROVIDER, ORDINARY_PROVIDER, write_executable } from "../../tests/provider_sim";
import { richTranscript } from "./observation_costs_fixture";

export type Schedule = "independent" | "aligned" | "staggered";
export type Mode = "scroll" | "sparse";
type Send<T> = (pane: T, command: string) => Promise<unknown>;
export type Active<T> = {
  token: string;
  epoch: bigint;
  schedule: "aligned" | "staggered";
  panes: T[];
  directory: string;
  capacity: number;
  mode: Mode;
};
const period = 50_000_000n;
const armMargin = 1_000_000_000n;
const timespec = new BigInt64Array(2);
const address = ptr(timespec);
const libc = dlopen("libc.so.6", { clock_gettime: { args: ["i32", "ptr"], returns: "i32" } });
export function now(): bigint {
  if (libc.symbols.clock_gettime(1, address) !== 0) throw Error("clock_gettime failed");
  return timespec[0] * 1_000_000_000n + timespec[1];
}
export function schedule(value: string | undefined): Schedule {
  switch (value ?? "independent") {
    case "independent":
      return "independent";
    case "aligned":
      return "aligned";
    case "staggered":
      return "staggered";
    default:
      throw Error("Unknown producer schedule");
  }
}
export function mode(value: string | undefined): Mode {
  switch (value ?? "scroll") {
    case "scroll":
      return "scroll";
    case "sparse":
      return "sparse";
    default:
      throw Error("Unknown streaming fixture mode");
  }
}
export function install(bin: string, mode: Mode) {
  const runtime = readFileSync(join(import.meta.dir, "streaming_provider.ts.fixture"), "utf8");
  const provider = richTranscript(
    ORDINARY_PROVIDER.replace(
      "const provider=basename(process.argv[1]);",
      `import { handle, observeTerminal, terminalLog } from './streaming-provider.ts';\nconst provider=basename(process.argv[1]);
if(process.argv.includes('--version')) { console.log(provider==='codex' ? 'codex-cli 1.2.3' : '2.1.0 (Claude Code)'); process.exit(0); }
if(process.argv.includes('app-server')) { await import('./rpc-fixture.ts'); process.exit(0); }`,
    )
      .replaceAll("'ordinary-'+provider", "'ordinary-'+provider+'-'+process.pid")
      .replaceAll("console.log(", "terminalLog(")
      .replace("let turn=0;", "observeTerminal();\nlet turn=0;")
      .replace(
        "if(command==='exit') break;",
        `if(handle(command,${JSON.stringify(mode)})) continue;\nif(command==='exit') break;`,
      ),
  );
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "streaming-provider.ts"), runtime);
  write_executable(join(bin, "rpc-fixture.ts"), NATIVE_PROVIDER);
  for (const name of ["claude", "codex"]) write_executable(join(bin, name), provider);
  return {
    schema: "stream-phase-v1",
    runtime_sha256: createHash("sha256").update(runtime).digest("hex"),
    provider_sha256: createHash("sha256").update(provider).digest("hex"),
    write_boundary: "one writeSync per controlled payload; pre/post CLOCK_MONOTONIC stamps",
    terminal_io: "terminal-io-v1: counted fixture stdout/stderr writes; SIGUSR2 receipts outside CPU windows",
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid producer receipt");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("Invalid producer integer");
  return value;
}
function timestamp(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw Error("Invalid producer timestamp");
  return BigInt(value);
}
function receipt<T>(value: unknown, active: Active<T>, lane: number) {
  const row = object(value);
  const phase = active.schedule === "aligned" ? 0n : (BigInt(lane) * period) / BigInt(active.panes.length);
  if (
    row.schema !== "stream-phase-v1" ||
    row.token !== active.token ||
    row.lane !== lane ||
    row.lanes !== active.panes.length ||
    row.schedule !== active.schedule ||
    row.mode !== active.mode ||
    timestamp(row.epoch_ns) !== active.epoch ||
    timestamp(row.phase_ns) !== phase ||
    timestamp(row.period_ns) !== period ||
    timestamp(row.armed_ns) > active.epoch - armMargin
  )
    throw Error("Producer receipt disagrees with the shared schedule");
  return { row, phase };
}
async function until(deadline: bigint, read: () => boolean) {
  while (!read()) {
    if (now() >= deadline) throw Error("Producer receipt deadline missed");
    await Bun.sleep(5);
  }
}
export async function start<T>(
  panes: T[],
  send: Send<T>,
  selected: Schedule,
  output: string,
  maxSeconds: number,
  mode: Mode,
) {
  if (selected === "independent") {
    for (const pane of panes) await send(pane, "stream");
    return null;
  }
  const directory = join(output, "producer-traces");
  mkdirSync(directory, { recursive: true });
  const active: Active<T> = {
    token: randomUUID(),
    epoch: now() + BigInt(Math.max(5, Math.ceil(panes.length / 16) * 5)) * 1_000_000_000n,
    schedule: selected,
    panes: [...panes],
    directory,
    capacity: Math.ceil(maxSeconds * 20) + 1024,
    mode,
  };
  for (const [lane, pane] of panes.entries()) {
    if (now() >= active.epoch - armMargin) throw Error("Late producer arming");
    await send(
      pane,
      "bench-stream-arm " +
        JSON.stringify({
          token: active.token,
          directory,
          epoch_ns: String(active.epoch),
          lane,
          lanes: panes.length,
          schedule: selected,
          capacity: active.capacity,
        }),
    );
  }
  await until(active.epoch - armMargin, () =>
    panes.every((_, lane) => existsSync(join(directory, `${active.token}-${lane}-armed.json`))),
  );
  const armed = panes.map((_, lane) => {
    const value: unknown = JSON.parse(readFileSync(join(directory, `${active.token}-${lane}-armed.json`), "utf8"));
    const { row } = receipt(value, active, lane);
    if (row.clock !== "CLOCK_MONOTONIC" || row.capacity !== active.capacity)
      throw Error("Producer clock/storage mismatch");
    return row;
  });
  if (now() >= active.epoch - armMargin) throw Error("Arming barrier completed too late");
  writeFileSync(join(output, "producer-armed.json"), JSON.stringify(armed, null, 2) + "\n");
  while (now() < active.epoch + period) await Bun.sleep(Math.max(1, Number(active.epoch + period - now()) / 1e6));
  return active;
}
function distribution(values: number[]) {
  if (!values.length) throw Error("Empty producer timing sample");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    minimum: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    maximum: sorted.at(-1)!,
  };
}
type Write = { index: number; before: bigint; after: bigint; bytes: number; target: bigint };
export async function collect<T>(active: Active<T>, send: Send<T>, start: bigint, end: bigint, phaseName: string) {
  if (end <= start + 2n * period) throw Error("Producer sample window too short");
  for (const pane of active.panes) await send(pane, "bench-stream-flush " + active.token);
  const paths = active.panes.map((_, lane) => join(active.directory, `${active.token}-${lane}-trace.json`));
  await until(now() + 5_000_000_000n, () =>
    paths.every(path => {
      if (!existsSync(path)) return false;
      try {
        return timestamp(object(JSON.parse(readFileSync(path, "utf8"))).flushed_ns) >= end;
      } catch {
        return false;
      }
    }),
  );
  const all: Write[][] = [];
  const failures: string[] = [];
  const lanes = paths.map((path, lane) => {
    const raw = readFileSync(path);
    const savedPath = join(active.directory, `${phaseName}-${lane}-trace.json`);
    writeFileSync(savedPath, raw);
    const value: unknown = JSON.parse(raw.toString("utf8"));
    const { row, phase } = receipt(value, active, lane);
    if (
      row.overflow !== false ||
      integer(row.short_writes) !== 0 ||
      row.capacity !== active.capacity ||
      !Array.isArray(row.records)
    )
      throw Error("Producer trace overflow or short write");
    const writes: Write[] = row.records.map(value => {
      if (!Array.isArray(value) || value.length !== 4) throw Error("Invalid producer write record");
      const index = integer(value[0]),
        before = timestamp(value[1]),
        after = timestamp(value[2]);
      if (after < before) throw Error("Producer clock went backwards");
      const bytes = integer(value[3]);
      const line = "Working (esc to interrupt) " + (index + 1) + " " + ".".repeat(100);
      const expectedBytes = Buffer.byteLength(active.mode === "sparse" ? "\x1b[1;1H" + line + "\x1b[K" : line + "\n");
      if (bytes !== expectedBytes) throw Error("Producer payload byte count changed");
      return { index, before, after, bytes, target: active.epoch + phase + BigInt(index) * period };
    });
    for (let i = 1; i < writes.length; i++)
      if (writes[i].index <= writes[i - 1].index || writes[i].before < writes[i - 1].after)
        throw Error("Producer write trace is not ordered");
    // Exclude one period at each edge so a bounded late write cannot cross the CPU-window boundary.
    const from = start + period,
      to = end - period;
    const selected = writes.filter(write => write.target >= from && write.target < to);
    const origin = active.epoch + phase;
    const first = Number((from - origin + period - 1n) / period);
    const last = Number((to - origin + period - 1n) / period);
    const expected = last - first;
    const dropped = expected - selected.length;
    if (dropped !== 0 || selected.some((write, i) => write.index !== first + i))
      failures.push(`Lane ${lane} dropped a measured deadline`);
    const lateness = distribution(selected.map(write => Number(write.before - write.target) / 1e6));
    if (lateness.minimum < 0 || lateness.p99 > 2 || lateness.maximum >= 25)
      failures.push(`Lane ${lane} lateness exceeds the predeclared limit`);
    const width = selected.at(-1)!.before - selected[0].before;
    all.push(selected);
    return {
      lane,
      writes: selected.length,
      expected,
      dropped,
      lateness_ms: lateness,
      over_2ms: selected.filter(write => write.before - write.target > 2_000_000n).length,
      actual_hz: ((selected.length - 1) * 1e9) / Number(width),
      write_duration_ms: distribution(selected.map(write => Number(write.after - write.before) / 1e6)),
      dropped_total: integer(row.dropped_total),
      late_over_2ms_total: integer(row.late_over_2ms_total),
      trace: savedPath,
      trace_sha256: createHash("sha256").update(raw).digest("hex"),
    };
  });
  const byIndex = new Map<number, bigint[]>();
  for (const writes of all)
    for (const write of writes) {
      const group = byIndex.get(write.index) ?? [];
      group.push(write.before);
      byIndex.set(write.index, group);
    }
  const spreads = [...byIndex.values()]
    .filter(group => group.length === active.panes.length)
    .map(group => {
      const sorted = [...group].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return Number(sorted.at(-1)! - sorted[0]) / 1e6;
    });
  const spread = distribution(spreads);
  if (active.schedule === "aligned" && (spread.p99 > 3 || spread.maximum >= 25))
    failures.push("Aligned producer spread exceeds the predeclared limit");
  const result = {
    schema: "stream-phase-v1",
    valid: failures.length === 0,
    failures,
    schedule: active.schedule,
    epoch_ns: String(active.epoch),
    period_ns: String(period),
    window_start_ns: String(start),
    window_end_ns: String(end),
    excluded_edge_ms: 50,
    clock: "CLOCK_MONOTONIC",
    outside_cpu_window: true,
    thresholds: {
      measured_drops: 0,
      p99_lateness_ms: 2,
      maximum_lateness_ms_exclusive: 25,
      aligned_p99_spread_ms: 3,
      aligned_maximum_spread_ms_exclusive: 25,
    },
    same_index_spread_ms: spread,
    lanes,
  };
  writeFileSync(join(active.directory, `${phaseName}-summary.json`), JSON.stringify(result, null, 2) + "\n");
  return result;
}

export function validate(value: { valid: boolean; failures: string[] }) {
  if (!value.valid) throw Error(value.failures.join("; "));
}
