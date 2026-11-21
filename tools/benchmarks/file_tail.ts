#!/usr/bin/env bun
// Compares the file peek's reader with `tail` on a large log:
//   bun tools/benchmarks/file_tail.ts [--size MiB] [--rate lines/s] [--seconds N] [--dir DIR]
// It writes a log of `--size` MiB (default 1024) into DIR (default /dev/shm,
// else the temp folder), then measures:
//   open    the newest lines: Source.open in-process against `tail -n 40`
//   seek    a line a fifth of the way in: Source.open at a line against `sed -n 'Np;Nq'`
//   follow  appending `--rate` lines a second for `--seconds`: CPU and the
//           delay before each follower sees a marked line, ours in its own
//           process against `tail -F`
// CPU comes from /proc on Linux; elsewhere it is left out.
import { appendFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Source } from "../../src/file_source";

const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const ms = (n: number) => `${n.toFixed(2)} ms`;
const line = (i: number) =>
  `2026-11-08T14:02:31.${String(i % 1000).padStart(3, "0")}Z INFO  render frame pane=3 rows=48 dirty=${i % 7} ms=0.${i % 10}${i % 10} seq=${i}\n`;

// The follower half: runs in its own process so its CPU is its own.
if (process.argv[2] === "--follower") {
  const path = process.argv[3],
    latencies: number[] = [];
  const marks = new Set<string>();
  const source = await Source.open(path, {
    // As a viewer would, it decodes only the newest lines: the writer puts
    // a timed mark last in a batch.
    changed: () => {
      for (let row = Math.max(0, source.count - 3); row < source.count; row++) {
        const text = source.line(row);
        if (!text.startsWith("MARK ") || marks.has(text)) continue;
        marks.add(text);
        latencies.push(performance.timeOrigin + performance.now() - Number(text.slice(5)));
      }
    },
  });
  process.stdout.write("ready\n");
  // A timer keeps Bun waiting; a bare promise and a signal leave it spinning.
  const alive = setInterval(() => {}, 1 << 30);
  await new Promise<void>(resolve => process.on("SIGTERM", () => resolve()));
  clearInterval(alive);
  const cpu = process.cpuUsage();
  process.stdout.write(
    JSON.stringify({ latencies, cpu_ms: (cpu.user + cpu.system) / 1000, lines: source.added }) + "\n",
  );
  process.exit(0);
}

const size_mib = flag("--size", 1024),
  rate = flag("--rate", 50_000),
  seconds = flag("--seconds", 5);
const base = process.argv.includes("--dir")
  ? process.argv[process.argv.indexOf("--dir") + 1]
  : existsSync("/dev/shm")
    ? "/dev/shm"
    : tmpdir();
const dir = mkdtempSync(join(base, "corgi-tail-bench-"));
const path = join(dir, "big.log");
const ticks = (pid: number) => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
  } catch {
    return NaN;
  }
};
try {
  // A log of `size_mib` MiB.
  const fd = openSync(path, "w");
  let lines = 0;
  const chunk = Array.from({ length: 10_000 }, (_, i) => line(i)).join("");
  const target = size_mib * 1024 * 1024;
  for (let written = 0; written < target; written += chunk.length) {
    writeSync(fd, chunk);
    lines += 10_000;
  }
  closeSync(fd);
  console.log(`log: ${size_mib} MiB, ${lines.toLocaleString()} lines in ${dir}\n`);

  // Newest lines.
  const ours: number[] = [],
    theirs: number[] = [];
  for (let i = 0; i < 20; i++) {
    let t = performance.now();
    const s = await Source.open(path, { follow: false });
    ours.push(performance.now() - t);
    if (!s.line(s.count - 1).endsWith("seq=9999")) throw Error("wrong last line");
    await s.close();
    t = performance.now();
    const tail = Bun.spawnSync(["tail", "-n", "40", path], { stdout: "ignore" });
    theirs.push(performance.now() - t);
    if (tail.exitCode !== 0) throw Error("tail failed");
  }
  console.log("open the newest lines (median of 20)");
  console.log(`  corgi Source.open (reads 256 KiB)   ${ms(median(ours))}`);
  console.log(`  tail -n 40 (process included)       ${ms(median(theirs))}\n`);

  // A line a fifth of the way in.
  const middle = Math.floor(lines / 5),
    seek_ours: number[] = [],
    seek_theirs: number[] = [];
  for (let i = 0; i < 5; i++) {
    let t = performance.now();
    const s = await Source.open(path, { follow: false, line: middle });
    seek_ours.push(performance.now() - t);
    const row = s.rowOf(middle);
    if (row === null || !s.line(row).includes(`seq=${(middle - 1) % 10_000}`)) throw Error("wrong line");
    await s.close();
    t = performance.now();
    Bun.spawnSync(["sed", "-n", `${middle}p;${middle}q`, path], { stdout: "ignore" });
    seek_theirs.push(performance.now() - t);
  }
  console.log(`line ${middle.toLocaleString()} of ${lines.toLocaleString()} (median of 5)`);
  console.log(`  corgi Source.open at the line       ${ms(median(seek_ours))}`);
  console.log(`  sed -n 'Np;Nq'                      ${ms(median(seek_theirs))}\n`);

  // Following.
  const follower = Bun.spawn([process.execPath, import.meta.path, "--follower", path], { stdout: "pipe" });
  const tail = Bun.spawn(["tail", "-n", "0", "-F", path], { stdout: "pipe" });
  const reader = follower.stdout.getReader();
  const first = await reader.read();
  if (!new TextDecoder().decode(first.value).includes("ready")) throw Error("follower failed");
  const tail_latencies: number[] = [];
  let pending = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of tail.stdout) {
      const now = performance.timeOrigin + performance.now();
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop()!;
      for (const part of parts) {
        const mark = /MARK (\d+)/.exec(part);
        if (mark) tail_latencies.push(now - Number(mark[1]));
      }
    }
  })();
  await Bun.sleep(300);
  const tail_before = ticks(tail.pid);
  const batch = Math.max(1, Math.round(rate / 100));
  const end = performance.now() + seconds * 1000;
  let n = 0;
  while (performance.now() < end) {
    let text = "";
    for (let i = 0; i < batch; i++) text += line(n++);
    if (n % (batch * 5) < batch) text += `MARK ${performance.timeOrigin + performance.now()}\n`;
    appendFileSync(path, text);
    await Bun.sleep(10);
  }
  await Bun.sleep(1500);
  const tail_cpu = ticks(tail.pid) - tail_before;
  follower.kill("SIGTERM");
  let report = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    report += new TextDecoder().decode(chunk.value);
  tail.kill();
  const result = JSON.parse(report.trim().split("\n").pop()!);
  console.log(
    `follow ${n.toLocaleString()} lines over ${seconds}s (${rate.toLocaleString()} lines/s, ${((n * line(0).length) / seconds / 1e6).toFixed(1)} MB/s)`,
  );
  console.log(
    `  corgi Source  cpu ${ms(result.cpu_ms)} total   delay p50 ${ms(median(result.latencies))}  p99 ${ms(pct(result.latencies, 0.99))}`,
  );
  console.log(
    `  tail -F       cpu ${ms(tail_cpu)} total   delay p50 ${ms(median(tail_latencies))}  p99 ${ms(pct(tail_latencies, 0.99))}`,
  );
  console.log("  (corgi's cpu includes its Bun process starting; tail's counts only the follow)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
