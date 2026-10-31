/** Correctness checks for shared-clock producer scheduling; no CPU claims. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as fixture from "./streaming_fixture";
import * as benchmark from "./cpu_lock";

const output = resolve(process.argv[2] ?? "dist/producer-check");
if (existsSync(output)) throw Error("Use a fresh producer-check directory");
mkdirSync(output, { recursive: true });
const release = await benchmark.acquire();
type Producer = {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  text: Promise<string>;
  errors: Promise<string>;
  id: string;
};
const checks: string[] = [];
function pass(name: string) {
  checks.push(name);
  console.log(name);
}
function spawn(name: string): Producer {
  const home = join(output, name);
  mkdirSync(home, { recursive: true });
  fixture.install(join(home, "bin"), "sparse");
  const proc = Bun.spawn([join(home, "bin/claude")], {
    cwd: home,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BUN_OPTIONS: "", HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home },
  });
  return { proc, text: new Response(proc.stdout).text(), errors: new Response(proc.stderr).text(), id: name };
}
async function send(p: Producer, text: string) {
  p.proc.stdin.write(text + "\n");
  await p.proc.stdin.flush();
}
async function close(p: Producer) {
  if (p.proc.exitCode === null) {
    try {
      await send(p, "exit");
    } catch {}
    await Promise.race([p.proc.exited, Bun.sleep(1000)]);
    if (p.proc.exitCode === null) p.proc.kill();
  }
  await p.proc.exited;
  writeFileSync(join(output, `${p.id}-stdout.txt`), await p.text);
  writeFileSync(join(output, `${p.id}-stderr.txt`), await p.errors);
}
async function corrupt(active: fixture.Active<Producer>, start: bigint, end: bigint, kind: "drop" | "late" | "bytes") {
  const directory = join(output, `${active.schedule}-${kind}`);
  mkdirSync(directory);
  for (let lane = 0; lane < active.panes.length; lane++) {
    const file = `${active.token}-${lane}-trace.json`;
    const row = JSON.parse(readFileSync(join(active.directory, file), "utf8"));
    if (lane === 0) {
      const eligible = row.records
        .map((r: [number, string, string, number], i: number) => ({ r, i }))
        .filter(
          ({ r }: { r: [number, string, string, number] }) =>
            BigInt(r[1]) > start + 100_000_000n && BigInt(r[1]) < end - 100_000_000n,
        );
      if (kind === "drop") row.records.splice(eligible[5].i, 1);
      if (kind === "bytes") row.records[eligible[5].i][3]++;
      if (kind === "late")
        for (const { i } of eligible.slice(5, 10)) {
          row.records[i][1] = String(BigInt(row.records[i][1]) + 4_000_000n);
          row.records[i][2] = String(BigInt(row.records[i][2]) + 4_000_000n);
        }
    }
    writeFileSync(join(directory, file), JSON.stringify(row));
  }
  let rejected = false;
  try {
    const result = await fixture.collect({ ...active, directory }, async () => {}, start, end, kind);
    fixture.validate(result);
  } catch {
    rejected = true;
  }
  if (!rejected) throw Error(`Corrupt ${kind} trace was accepted`);
  pass(`${active.schedule}: rejects ${kind} trace`);
}
try {
  const before = fixture.now();
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { now } from ${JSON.stringify(join(import.meta.dir, "streaming_fixture.ts"))}; console.log(String(now()));`,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } },
  );
  const stamp = BigInt((await new Response(child.stdout).text()).trim());
  if ((await child.exited) || stamp < before || stamp > fixture.now())
    throw Error("Clock is not shared across processes");
  pass("shared CLOCK_MONOTONIC epoch across processes");

  const late = spawn("late-arm");
  try {
    await send(
      late,
      "bench-stream-arm " +
        JSON.stringify({
          token: "late",
          directory: output,
          epoch_ns: String(fixture.now() + 100_000_000n),
          lane: 0,
          lanes: 1,
          schedule: "aligned",
          capacity: 256,
        }),
    );
    await Promise.race([late.proc.exited, Bun.sleep(2000)]);
    if (late.proc.exitCode === null || late.proc.exitCode === 0 || existsSync(join(output, "late-0-armed.json")))
      throw Error("Late provider arm was accepted");
    pass("late provider arm rejects before receipt");
  } finally {
    await close(late);
  }

  const barrier = [spawn("barrier-0"), spawn("barrier-1")];
  try {
    let rejected = false;
    try {
      await fixture.start(
        barrier,
        async (p, text) => {
          await send(p, text);
          await Bun.sleep(4100);
        },
        "aligned",
        join(output, "barrier"),
        10,
        "sparse",
      );
    } catch {
      rejected = true;
    }
    if (!rejected) throw Error("Late arming barrier accepted");
    pass("parent barrier rejects late completion");
  } finally {
    for (const p of barrier) await close(p);
  }

  for (const schedule of ["aligned", "staggered"] as const) {
    const producers = Array.from({ length: 16 }, (_, i) => spawn(`${schedule}-${i}`));
    try {
      const active = await fixture.start(producers, send, schedule, join(output, schedule), 30, "sparse");
      if (!active) throw Error("Expected a controlled schedule");
      await Bun.sleep(5000);
      const start = fixture.now();
      await Bun.sleep(5000);
      const end = fixture.now();
      const result = await fixture.collect(active, send, start, end, "sample");
      fixture.validate(result);
      pass(`${schedule}:16 lanes pass cadence, phase, bytes, drops and predeclared lateness guards`);
      if (schedule === "aligned")
        for (const kind of ["drop", "late", "bytes"] as const) await corrupt(active, start, end, kind);
    } finally {
      for (const p of producers) await close(p);
    }
  }
  writeFileSync(join(output, "checks.json"), JSON.stringify({ passed: checks.length, checks }, null, 2) + "\n");
} finally {
  await release();
}
