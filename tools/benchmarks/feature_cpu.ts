/** Linux CPU playbook: bun tools/benchmarks/cpu.ts BINARY OUTPUT [SECONDS=15]
 * Set CPU_PROFILE=1 for Bun profiles (use a separate run for timing).
 * CPU_WARMUP_SECONDS=10, CPU_AGENTS=8. CPU_IDLE_ONLY=1 measures an empty daemon;
 * CPU_IDLE_ONLY=viewer measures only a quiet shell with an attached viewer.
 * CPU_MATRIX_ONLY=1 selects the four idle/streaming, attached/detached phases.
 * CPU_INITIAL_WARMUP_SECONDS overrides the first agent phase's warmup.
 * CPU_STREAM_ONLY=1 with CPU_MATRIX_ONLY=1 measures just attached streaming.
 * CPU includes all process threads; 100% is one core. Provider CPU is excluded.
 * Streaming produces one approximately 130-byte line per agent every 50 ms.
 * Every phase shares a private UI-driver runtime and fake provider accounts.
 * Claude sessions bind through hooks. Codex fixtures omit UUID titles and stay
 * screen-tracked; this does not exercise full Codex app-server session polling.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Session } from "../ui_driver";
import * as benchmark from "./cpu_lock";
import * as progress from "./feature_progress";
import * as geometry from "./cost_matrix_geometry";
import * as memory from "./cpu_memory";
import * as telemetrySnapshot from "./telemetry_snapshot";
import * as streamingFixture from "./streaming_fixture";

const release = await benchmark.acquire();
const producerSchedule = streamingFixture.schedule(process.env.CPU_STREAM_PHASE);
const binary = resolve(process.argv[2] ?? "dist/corgi"),
  output = resolve(process.argv[3] ?? "dist/cpu"),
  seconds = Number(process.argv[4] ?? 15),
  warmup = Number(process.env.CPU_WARMUP_SECONDS ?? 10),
  initialWarmup = Number(process.env.CPU_INITIAL_WARMUP_SECONDS ?? warmup),
  count = Number(process.env.CPU_AGENTS ?? 8),
  matrix = !!process.env.CPU_MATRIX_ONLY,
  streamOnly = process.env.CPU_STREAM_ONLY === "1",
  streamMode = streamingFixture.mode(process.env.CPU_STREAM_MODE),
  matchGeometry = !!process.env.CPU_MATCH_GEOMETRY,
  idle = process.env.CPU_IDLE_ONLY === "viewer" ? "viewer" : process.env.CPU_IDLE_ONLY ? "daemon" : null;
if (
  process.platform !== "linux" ||
  !Number.isFinite(seconds) ||
  !(seconds > 0) ||
  !Number.isFinite(warmup) ||
  !(warmup >= 0) ||
  !Number.isFinite(initialWarmup) ||
  initialWarmup < 0 ||
  !Number.isInteger(count) ||
  count < 1
)
  throw Error("Needs Linux, a positive sample duration and agent count, and a nonnegative warmup");
if (streamOnly && (!matrix || idle)) throw Error("Streaming-only requires the agent matrix");
if (streamMode !== "scroll" && streamMode !== "sparse") throw Error("Unknown streaming fixture mode");
if (existsSync(join(output, "results.json"))) throw Error("Use a fresh output directory");
mkdirSync(output, { recursive: true });
const s = new Session(binary, binary, 160, 48);
const intensity = Number(process.env.CPU_CORGI_INTENSITY ?? 50);
if (!Number.isInteger(intensity) || intensity < 0 || intensity > 100) throw Error("Invalid corgi intensity");
const resources = process.env.CPU_RESOURCES !== "0";
writeFileSync(
  join(s.home, ".local/state/corgi/viewer.json"),
  JSON.stringify({
    onboarding_complete: true,
    preset: "corgi",
    prefix: "ctrl_b",
    corgi_intensity: intensity,
    resources: { enabled: resources },
  }),
);
const telemetryDirectory = process.env.CPU_TELEMETRY ? join(output, "telemetry-live") : null;
s.env.CORGI_TELEMETRY_DIR = telemetryDirectory ?? "";
s.env.CORGI_TELEMETRY_TRACE = process.env.CPU_TELEMETRY_TRACE ?? "";
const ticks = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString());
function usage(pid: number) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8"),
    stat = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return {
    cpu: (Number(stat[11]) + Number(stat[12])) / ticks,
    children: (Number(stat[13]) + Number(stat[14])) / ticks,
    user: Number(stat[11]) / ticks,
    system: Number(stat[12]) / ticks,
    children_user: Number(stat[13]) / ticks,
    children_system: Number(stat[14]) / ticks,
  };
}
async function cli(...args: string[]) {
  const p = Bun.spawn([binary, ...args, ...(args[0] === "rpc" || args.includes("--json") ? [] : ["--json"])], {
    env: { ...s.env, BUN_OPTIONS: "", CORGI_TELEMETRY_DIR: "" },
    cwd: s.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw Error(`${args.join(" ")}: ${stderr}`);
  return stdout.trim() ? JSON.parse(stdout) : null;
}
let daemon = 0;
const results: object[] = [];
const panes: number[] = [];
let activeProducer: streamingFixture.Active<number> | null = null;
let producerSource: ReturnType<typeof streamingFixture.install> | null = null;
const sendProducer = (pane: number, command: string) => cli("pane", "send", String(pane), command, "--enter");
let shell = 0;
function checkAgents(snapshot: any, state: "idle" | "working") {
  const agents = snapshot.panes.filter((p: { id: number }) => panes.includes(p.id));
  const claude = agents.filter((p: any) => p.agent.provider === "claude");
  return (
    agents.length === count &&
    new Set(agents.map((p: any) => p.pid)).size === count &&
    agents.every(
      (p: any) =>
        !p.exited && p.agent.provider === (panes.indexOf(p.id) % 2 ? "codex" : "claude") && p.agent.state === state,
    ) &&
    claude.every((p: any) => p.agent.session) &&
    new Set(claude.map((p: any) => p.agent.session)).size === claude.length &&
    (!matrix ||
      (snapshot.panes.length === count + 1 &&
        snapshot.panes.some((p: any) => p.id === shell && !p.exited && !p.agent.provider)))
  );
}
async function until<T>(read: () => Promise<T>, name: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result as NonNullable<T>;
    await Bun.sleep(100);
  }
  throw Error(`Timed out: ${name}`);
}
async function measure(name: string, viewer = false, state?: "idle" | "working") {
  if (state) await until(async () => checkAgents((await cli("list")).result, state), `${count} ${state} agents`);
  const wait = name === "idle-agents-viewer" ? initialWarmup : warmup;
  console.log(JSON.stringify({ warming: name, seconds: wait }));
  await Bun.sleep(wait * 1000);
  const telemetryBefore = telemetryDirectory
    ? await telemetrySnapshot.capture(telemetryDirectory, [daemon, ...(viewer ? [s.proc.pid] : [])])
    : null;
  const featureResourcesBefore = (await cli("list")).result.resources;
  const streaming = name === "streaming-agents-viewer",
    visibleBefore = streaming ? progress.sequence(s.text().join("\n")) : null;
  const producerStart = activeProducer && name.startsWith("streaming-") ? streamingFixture.now() : null;
  const startedAt = new Date().toISOString(),
    start = performance.now(),
    d = usage(daemon),
    v = viewer ? usage(s.proc.pid) : null,
    bytes = s.bytes;
  await Bun.sleep(seconds * 1000);
  const elapsed = (performance.now() - start) / 1000,
    end = usage(daemon),
    vend = v ? usage(s.proc.pid) : null,
    endBytes = s.bytes;
  const producerEnd = producerStart !== null ? streamingFixture.now() : null;
  const visibleAfter = streaming ? progress.sequence(s.text().join("\n")) : null,
    visibleAt = performance.now();
  const telemetryAfter = telemetryDirectory
    ? await telemetrySnapshot.capture(telemetryDirectory, [daemon, ...(viewer ? [s.proc.pid] : [])])
    : null;
  if (telemetryBefore && telemetryAfter)
    writeFileSync(
      join(output, `${name}-telemetry.json`),
      JSON.stringify({ before: telemetryBefore, after: telemetryAfter }),
    );
  let streaming_progress: (ReturnType<typeof progress.reading> & { source_read_delay_ms: number }) | null = null;
  if (streaming) {
    const source = await cli("pane", "read", String(panes[0]), "--lines", "100");
    streaming_progress = {
      ...progress.reading(visibleBefore, visibleAfter, progress.sequence(source.result.text), elapsed),
      source_read_delay_ms: performance.now() - visibleAt,
    };
  }
  const streaming_quality = streaming ? await progress.probe(() => s.text().join("\n"), intensity === 0) : null;
  const memoryAfter = { daemon: memory.read(daemon), viewer: viewer ? memory.read(s.proc.pid) : null };
  const producer_phase =
    activeProducer && producerStart !== null && producerEnd !== null
      ? await streamingFixture.collect(activeProducer, sendProducer, producerStart, producerEnd, name)
      : null;
  const row = {
    name,
    warmup: wait,
    started_at: startedAt,
    seconds: elapsed,
    daemon_cpu: (100 * (end.cpu - d.cpu)) / elapsed,
    daemon_child_cpu: (100 * (end.children - d.children)) / elapsed,
    viewer_cpu: v && vend ? (100 * (vend.cpu - v.cpu)) / elapsed : null,
    daemon_user_cpu: (100 * (end.user - d.user)) / elapsed,
    daemon_system_cpu: (100 * (end.system - d.system)) / elapsed,
    daemon_child_user_cpu: (100 * (end.children_user - d.children_user)) / elapsed,
    daemon_child_system_cpu: (100 * (end.children_system - d.children_system)) / elapsed,
    viewer_user_cpu: v && vend ? (100 * (vend.user - v.user)) / elapsed : null,
    viewer_system_cpu: v && vend ? (100 * (vend.system - v.system)) / elapsed : null,
    viewer_bytes_per_second: (endBytes - bytes) / elapsed,
    streaming_progress,
    streaming_quality,
    producer_phase,
    memory_after: memoryAfter,
  };
  const snapshot = (await cli("list")).result;
  const featureResources = progress.validateResources(featureResourcesBefore, snapshot.resources, resources);
  Object.assign(row, { feature_resources: featureResources });
  if (state)
    writeFileSync(
      join(output, `geometry-${name}.json`),
      JSON.stringify(
        geometry.read(
          snapshot.panes.map((p: { pid: number }) => p.pid),
          matchGeometry,
        ),
      ) + "\n",
    );
  if (state && !checkAgents(snapshot, state)) throw Error(`${name}: expected ${count} ${state} agents`);
  writeFileSync(join(output, `${name}.json`), JSON.stringify(snapshot, null, 2) + "\n");
  results.push(row);
  console.log(JSON.stringify(row));
  writeFileSync(
    join(output, "results.json"),
    JSON.stringify(
      {
        cpu_accounting: "proc-stat-user-system-v1",
        binary,
        daemon,
        viewer: s.proc?.pid,
        seconds,
        warmup,
        initialWarmup,
        matrix,
        stream_only: streamOnly,
        stream_mode: streamMode,
        producer_schedule: producerSchedule,
        producer_source: producerSource,
        agents: count,
        profiled: !!process.env.CPU_PROFILE,
        telemetry: !!telemetryDirectory,
        rich_transcripts: process.env.CPU_RICH_TRANSCRIPTS === "1",
        corgi_intensity: intensity,
        resources,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  if (viewer) writeFileSync(join(output, `${name}.txt`), s.text().join("\n") + "\n");
  if (streaming_progress) progress.validate(streaming_progress);
  if (streaming_quality) progress.validateCadence(streaming_quality);
  if (streaming_quality) progress.validateAnimation(streaming_quality.animation);
  if (producer_phase) streamingFixture.validate(producer_phase);
}
async function run() {
  try {
    producerSource = streamingFixture.install(join(s.home, "bin"), streamMode);
    if (process.env.CPU_PROFILE) s.env.BUN_OPTIONS = `--cpu-prof --cpu-prof-dir=${output}`;
    await s.seed(`'${binary.replaceAll("'", "'\\''")}' start`);
    daemon = (await cli("rpc", '{"op":"ping"}')).pid;
    const runtime = { home: s.home, daemon, binary, started_at: new Date().toISOString() };
    writeFileSync(join(output, "runtime.json"), JSON.stringify(runtime, null, 2) + "\n");
    console.log(JSON.stringify(runtime));
    if (!matrix && idle !== "viewer") await measure("empty-daemon");
    if (idle === "daemon") return;
    await s.start();
    writeFileSync(join(output, "runtime.json"), JSON.stringify({ ...runtime, viewer: s.proc.pid }) + "\n");
    if (matrix) {
      shell = await until(async () => {
        const snapshot = (await cli("list")).result;
        return (
          snapshot.panes.length === 1 &&
          !snapshot.panes[0].exited &&
          !snapshot.panes[0].agent.provider &&
          snapshot.panes[0].id
        );
      }, "initial quiet shell");
    } else await measure("idle-shell-viewer", true);
    if (idle === "viewer") return;
    const listing = await cli("list", "--json"),
      workspace = listing.result.workspaces[0].id;
    for (let i = 0; i < count; i++) {
      const created = await cli(
        "tab",
        "new",
        "--workspace",
        String(workspace),
        "--name",
        `agent-${i}`,
        "--command",
        i % 2 ? "codex" : "claude",
        "--json",
      );
      panes.push(created.result.pane);
    }
    if (matchGeometry) {
      for (const pane of panes) {
        await cli("focus", String(pane), "--viewer", "1");
        await until(async () => {
          const snapshot = (await cli("list")).result;
          return snapshot.panes.some(
            (p: { id: number; cols: number; rows: number }) => p.id === pane && p.cols === 132 && p.rows === 47,
          );
        }, `pane ${pane} geometry`);
      }
      const snapshot = (await cli("list")).result;
      writeFileSync(
        join(output, "geometry-setup.json"),
        JSON.stringify(
          geometry.read(
            snapshot.panes.map((p: { pid: number }) => p.pid),
            true,
          ),
        ) + "\n",
      );
    }
    if (matrix) await cli("focus", String(shell), "--viewer", "1");
    if (!streamOnly) await measure("idle-agents-viewer", true, "idle");
    for (const pane of panes) await cli("pane", "send", String(pane), "work", "--enter");
    if (!matrix) await measure("working-agents-viewer", true, "working");
    activeProducer = await streamingFixture.start(
      panes,
      sendProducer,
      producerSchedule,
      output,
      (streamOnly ? 1 : 2) * (warmup + seconds) + 60,
      streamMode,
    );
    await cli("focus", String(panes[0]), "--viewer", "1");
    await measure("streaming-agents-viewer", true, "working");
    if (streamOnly) return;
    s.write("\x02q");
    await s.proc.exited;
    await measure("streaming-agents-detached", false, "working");
    for (const pane of panes) {
      await cli("pane", "send", String(pane), "quiet", "--enter");
      await cli("pane", "send", String(pane), "stop", "--enter");
    }
    await measure("idle-agents-detached", false, "idle");
  } catch (error) {
    writeFileSync(join(output, "failure.txt"), String(error) + "\n" + s.output);
    throw error;
  } finally {
    await s.close();
    writeFileSync(join(output, "cleanup.json"), JSON.stringify({ clean: true }) + "\n");
  }
}
try {
  await run();
} finally {
  await release();
}
