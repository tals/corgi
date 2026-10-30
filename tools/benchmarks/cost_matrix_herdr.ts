/** Isolated Herdr counterpart of cpu.ts; same fixtures, progress and cadence checks. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { Terminal } from "../../src/pane/terminal";
import { Scope } from "../../scripts/process_scope";
import * as benchmark from "./cpu_lock";
import * as progress from "./viewer_progress";
import * as geometry from "./cost_matrix_geometry";
import * as memory from "./cpu_memory";
import * as streamingFixture from "./streaming_fixture";
import * as matrixQuality from "./matrix_quality";

type Pane = {
  pane_id: string;
  agent?: string;
  agent_status: string;
  agent_session?: { value: string };
};
type Snapshot = {
  panes: Pane[];
  workspaces: { workspace_id: string }[];
  layouts: { area: { width: number; height: number } }[];
};
type Answers = {
  "ping": unknown;
  "integration.install": unknown;
  "session.snapshot": { snapshot: Snapshot };
  "pane.send_input": unknown;
  "pane.read": { read: { text: string } };
  "tab.create": { root_pane: { pane_id: string }; tab: { tab_id: string } };
  "pane.focus": unknown;
  "server.stop": unknown;
};

const release = await benchmark.acquire();
const producerSchedule = streamingFixture.schedule(process.env.CPU_STREAM_PHASE);

const binary = resolve(process.argv[2] ?? "herdr-v0.9.5");
const output = resolve(process.argv[3] ?? "results/smoke");
const seconds = Number(process.argv[4] ?? 20);
const warmup = Number(process.env.CPU_WARMUP_SECONDS ?? 10);
const count = Number(process.env.CPU_AGENTS ?? 16);
const initialWarmup = Number(process.env.CPU_INITIAL_WARMUP_SECONDS ?? warmup);
const matrix = !!process.env.CPU_MATRIX_ONLY;
const workload = matrixQuality.workload(process.env.CPU_MATRIX_WORKLOAD);
const streamOnly = process.env.CPU_STREAM_ONLY === "1";
const streamMode = streamingFixture.mode(process.env.CPU_STREAM_MODE);
const matchGeometry = !!process.env.CPU_MATCH_GEOMETRY;
const cols = matchGeometry ? 159 : 160;
const idle = process.env.CPU_IDLE_ONLY === "viewer" ? "viewer" : process.env.CPU_IDLE_ONLY ? "daemon" : null;
if (
  process.platform !== "linux" ||
  !Number.isFinite(seconds) ||
  seconds <= 0 ||
  !Number.isFinite(warmup) ||
  warmup < 0 ||
  !Number.isFinite(initialWarmup) ||
  initialWarmup < 0 ||
  !Number.isInteger(count) ||
  count < 1
)
  throw Error("Needs Linux, positive sample duration and agent count, nonnegative warmup");
if (streamOnly && (!matrix || idle)) throw Error("Streaming-only requires the agent matrix");
if (workload !== "all" && (!matrix || streamOnly || idle))
  throw Error("Workload selector requires the full agent matrix");
if (streamMode !== "scroll" && streamMode !== "sparse") throw Error("Unknown streaming fixture mode");
mkdirSync(output, { recursive: true });
const root = join(output, "runtime");
if (join(root, "run", "herdr.sock").length > 100)
  throw Error("Use an output path under 78 characters for Unix sockets");
if (existsSync(root)) throw Error(`Refusing to reuse runtime: ${root}`);
for (const dir of [
  "",
  "home",
  "config",
  "state",
  "cache",
  "data",
  "run",
  "tmp",
  "project",
  "home/.codex",
  "home/.claude",
])
  mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
const env: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(process.env))
  if (
    !["CORGI_", "HERDR_", "XDG_", "CODEX_", "CLAUDE_", "TMUX", "ZDOTDIR", "ENV", "BASH_ENV", "BUN_OPTIONS"].some(p =>
      key.startsWith(p),
    )
  )
    env[key] = value;
const socketPath = join(root, "run", "herdr.sock");
const configPath = join(root, "config", "config.toml");
writeFileSync(
  configPath,
  'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n',
);
Object.assign(env, {
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_RUNTIME_DIR: join(root, "run"),
  TMPDIR: join(root, "tmp"),
  CODEX_HOME: join(root, "home/.codex"),
  CLAUDE_CONFIG_DIR: join(root, "home/.claude"),
  HERDR_SOCKET_PATH: socketPath,
  HERDR_CONFIG_PATH: configPath,
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  TERM_PROGRAM: "ghostty",
  COLORTERM: "truecolor",
  PS1: "$ ",
  ENV: "",
  BASH_ENV: "",
  BUN_OPTIONS: "",
  PATH: `${join(root, "home/bin")}:${process.env.PATH}`,
});
if (process.env.HERDR_RENDER_PROF) env.HERDR_RENDER_PROF = process.env.HERDR_RENDER_PROF;
const scope = await Scope.start(env);
const scopedEnv = scope.env;
const ticks = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString());
const screen = new Terminal(cols, 48);
let bytes = 0;
const tty = new Bun.Terminal({
  cols,
  rows: 48,
  data: (_t, data) => {
    bytes += data.length;
    screen.feed(data);
  },
});
let daemon: Bun.Subprocess | undefined;
let viewer: Bun.Subprocess | undefined;
let sequence = 0;
const results: object[] = [];
const panes: string[] = [];
let shell = "";
let providerPids: number[] = [];
const readScreens = async () => {
  const screens: string[] = [];
  for (const pane_id of panes)
    screens.push((await rpc("pane.read", { pane_id, source: "visible", format: "text" })).read.text);
  return screens;
};
async function detachViewer() {
  tty.write("\x02q");
  await boundedExit(viewer!);
  if (existsSync(`/proc/${viewer!.pid}`)) throw Error("Viewer remains alive after detach");
}
let activeProducer: streamingFixture.Active<string> | null = null;
const producerSource = streamingFixture.install(join(root, "home/bin"), streamMode);

function usage(pid: number) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const stat = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return {
    cpu: (Number(stat[11]) + Number(stat[12])) / ticks,
    children: (Number(stat[13]) + Number(stat[14])) / ticks,
    user: Number(stat[11]) / ticks,
    system: Number(stat[12]) / ticks,
    children_user: Number(stat[13]) / ticks,
    children_system: Number(stat[14]) / ticks,
  };
}
function rpc<K extends keyof Answers>(method: K, params: object = {}): Promise<Answers[K]> {
  return new Promise((resolve, reject) => {
    const id = `cpu-${++sequence}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(Error(`RPC timed out: ${method}`));
    }, 10000);
    socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.on("data", data => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      clearTimeout(timeout);
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { error?: unknown; result: Answers[K] };
        if (response.error) reject(Error(`${method}: ${JSON.stringify(response.error)}`));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
async function until<T>(predicate: () => Promise<T>, name: string, timeout = 20000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      last = value;
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    if (daemon?.exitCode !== null && daemon?.exitCode !== undefined) throw Error(`Daemon exited: ${daemon.exitCode}`);
    await Bun.sleep(100);
  }
  throw Error(`Timeout: ${name}: ${JSON.stringify(last)}`);
}
const snapshot = async () => (await rpc("session.snapshot")).snapshot;
const send = (pane_id: string, text: string) => rpc("pane.send_input", { pane_id, text, keys: ["Enter"] });
function checkAgents(snap: Snapshot, state: "idle" | "working") {
  const agents = snap.panes.filter(p => panes.includes(p.pane_id));
  return (
    agents.length === count &&
    (!matrix || (snap.panes.length === count + 1 && snap.panes.some(p => p.pane_id === shell && !p.agent))) &&
    new Set(agents.map(p => p.agent_session?.value)).size === count &&
    agents.every(
      p =>
        p.agent === (panes.indexOf(p.pane_id) % 2 ? "codex" : "claude") &&
        p.agent_session?.value &&
        (state === "idle" ? ["idle", "done"].includes(p.agent_status) : p.agent_status === state),
    )
  );
}
async function measure(name: string, attached = false, state?: "idle" | "working") {
  if (state)
    await until(async () => {
      const snap = await snapshot();
      return checkAgents(snap, state) && snap;
    }, `${count} ${state} agents`);
  const wait = name === "idle-agents-viewer" ? initialWarmup : warmup;
  console.log(JSON.stringify({ warming: name, seconds: wait }));
  const screensBefore = state === "idle" ? await readScreens() : [];
  await Bun.sleep(wait * 1000);
  if (!attached && state && existsSync(`/proc/${viewer!.pid}`)) throw Error("Detached viewer is still alive");
  const idleBefore = state === "idle" ? await matrixQuality.counters(join(root, "home"), providerPids) : null;
  const streaming = name === "streaming-agents-viewer";
  const visibleBefore = streaming ? progress.sequence(screen.text()) : null;
  const producerStart = activeProducer && name.startsWith("streaming-") ? streamingFixture.now() : null;
  const started_at = new Date().toISOString();
  const start = performance.now(),
    d = usage(daemon!.pid),
    v = attached ? usage(viewer!.pid) : null,
    initialBytes = bytes;
  await Bun.sleep(seconds * 1000);
  const elapsed = (performance.now() - start) / 1000,
    end = usage(daemon!.pid),
    vend = attached ? usage(viewer!.pid) : null;
  const endBytes = bytes;
  const producerEnd = producerStart !== null ? streamingFixture.now() : null;
  const idleAfter = idleBefore ? await matrixQuality.counters(join(root, "home"), providerPids) : null;
  const visibleAfter = streaming ? progress.sequence(screen.text()) : null;
  let streaming_progress: ReturnType<typeof progress.reading> | null = null;
  if (streaming) {
    const source = await rpc("pane.read", { pane_id: panes[0], source: "visible", format: "text" });
    streaming_progress = progress.reading(visibleBefore, visibleAfter, progress.sequence(source.read.text), elapsed);
  }
  const streaming_quality = streaming ? await progress.probe(() => screen.text()) : null;
  const memoryAfter = { daemon: memory.read(daemon!.pid), viewer: attached ? memory.read(viewer!.pid) : null };
  const producer_phase =
    activeProducer && producerStart !== null && producerEnd !== null
      ? await streamingFixture.collect(activeProducer, send, producerStart, producerEnd, name)
      : null;
  const snap = await snapshot();
  writeFileSync(join(output, `${name}.json`), JSON.stringify(snap, null, 2) + "\n");
  if (state && !checkAgents(snap, state)) throw Error(`${name}: expected ${count} ${state} agents; snapshot saved`);
  if (state) {
    const pids = snap.panes
      .filter(p => panes.includes(p.pane_id))
      .map(p => {
        const match = /^ordinary-(?:claude|codex)-(\d+)$/.exec(p.agent_session?.value ?? "");
        if (!match) throw Error("Expected isolated provider PID in session identity");
        return Number(match[1]);
      });
    writeFileSync(join(output, `geometry-${name}.json`), JSON.stringify(geometry.read(pids, matchGeometry)) + "\n");
    if (
      matchGeometry &&
      attached &&
      !snap.layouts.every(layout => layout.area.width === 133 && layout.area.height === 47)
    )
      throw Error("Herdr layout must be 133x47 including its scrollbar column");
  }
  const idle_quality =
    idleBefore && idleAfter ? matrixQuality.idle(idleBefore, idleAfter, screensBefore, await readScreens()) : null;
  const row = {
    name,
    warmup: wait,
    viewer_attached: attached,
    viewer_pid: attached ? viewer!.pid : null,
    idle_quality,
    started_at,
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
    viewer_bytes_per_second: (endBytes - initialBytes) / elapsed,
    streaming_progress,
    streaming_quality,
    producer_phase,
    memory_after: memoryAfter,
  };
  results.push(row);
  console.log(JSON.stringify(row));
  writeFileSync(
    join(output, "results.json"),
    JSON.stringify(
      {
        cpu_accounting: "proc-stat-user-system-v1",
        binary,
        daemon: daemon!.pid,
        viewer: viewer?.pid,
        seconds,
        warmup,
        initialWarmup,
        workload,
        stream_only: streamOnly,
        stream_mode: streamMode,
        producer_schedule: producerSchedule,
        producer_source: producerSource,
        matched_geometry: matchGeometry,
        agents: count,
        dimensions: [cols, 48],
        ticks,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  if (attached) writeFileSync(join(output, `${name}.txt`), screen.text() + "\n");
  if (streaming_progress) progress.validate(streaming_progress);
  if (streaming_quality) progress.validateCadence(streaming_quality);
  if (producer_phase) streamingFixture.validate(producer_phase);
  if (idle_quality) matrixQuality.validate(idle_quality);
}
async function boundedExit(proc: Bun.Subprocess, timeout = 5000) {
  await Promise.race([
    proc.exited,
    Bun.sleep(timeout).then(() => {
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        throw Error(`Process ${proc.pid} failed to exit`);
      }
    }),
  ]);
}
try {
  daemon = Bun.spawn([binary, "server"], {
    env: scopedEnv,
    cwd: join(root, "project"),
    stdin: "ignore",
    stdout: Bun.file(join(output, "server.log")),
    stderr: Bun.file(join(output, "server.log")),
  });
  const pong = await until(() => rpc("ping"), "server start");
  writeFileSync(join(output, "ping.json"), JSON.stringify(pong, null, 2) + "\n");
  const integrations = [];
  for (const target of ["claude", "codex"]) integrations.push(await rpc("integration.install", { target }));
  writeFileSync(join(output, "integrations.json"), JSON.stringify(integrations, null, 2) + "\n");
  console.log(JSON.stringify({ root, daemon: daemon.pid, binary, agents: count }));
  if (!matrix && idle !== "viewer") {
    const empty = await snapshot();
    if (empty.panes.length) throw Error("Expected empty daemon");
    await measure("empty-daemon");
  }
  if (idle !== "daemon") {
    viewer = Bun.spawn([binary], { env: scopedEnv, cwd: join(root, "project"), terminal: tty });
    await until(async () => {
      const snap = await snapshot();
      return snap.panes.length === 1 && snap;
    }, "initial shell");
    shell = (await snapshot()).panes[0].pane_id;
    writeFileSync(
      join(output, "runtime.json"),
      JSON.stringify({ daemon: daemon.pid, viewer: viewer.pid, binary }) + "\n",
    );
    if (!matrix) await measure("idle-shell-viewer", true);
    if (idle !== "viewer") {
      const workspace_id = (await snapshot()).workspaces[0].workspace_id;
      for (let i = 0; i < count; i++) {
        const created = await rpc("tab.create", {
          workspace_id,
          cwd: join(root, "project"),
          focus: false,
          label: `agent-${i}`,
        });
        const pane = created.root_pane.pane_id;
        panes.push(pane);
        await send(pane, `exec ${i % 2 ? "codex" : "claude"}`);
      }
      writeFileSync(join(output, "panes.json"), JSON.stringify(panes, null, 2) + "\n");
      await until(async () => checkAgents(await snapshot(), "idle"), "all providers ready");
      providerPids = matrixQuality.providers(join(root, "home"), count);
      await rpc("pane.focus", { pane_id: panes[0] });
      if (!streamOnly && workload !== "busy") await measure("idle-agents-viewer", true, "idle");
      if (workload === "idle") {
        await detachViewer();
        await measure("idle-agents-detached", false, "idle");
      } else {
        for (const pane of panes) await send(pane, "work");
        if (!matrix) await measure("working-agents-viewer", true, "working");
        activeProducer = await streamingFixture.start(
          panes,
          send,
          producerSchedule,
          output,
          (streamOnly ? 1 : 2) * (warmup + seconds) + 60,
          streamMode,
        );
        await rpc("pane.focus", { pane_id: panes[0] });
        await measure("streaming-agents-viewer", true, "working");
        if (!streamOnly) {
          await detachViewer();
          await measure("streaming-agents-detached", false, "working");
          if (workload !== "busy") {
            for (const pane of panes) {
              await send(pane, "quiet");
              await send(pane, "stop");
            }
            await measure("idle-agents-detached", false, "idle");
          }
        }
      }
    }
  }
} catch (error) {
  try {
    writeFileSync(join(output, "failure-snapshot.json"), JSON.stringify(await snapshot(), null, 2) + "\n");
  } catch {}
  writeFileSync(join(output, "failure-screen.txt"), screen.text() + "\n");
  throw error;
} finally {
  if (viewer?.exitCode === null) {
    tty.write("\x02q");
    try {
      await boundedExit(viewer);
    } catch {}
  }
  if (daemon?.exitCode === null) {
    try {
      await rpc("server.stop");
      await boundedExit(daemon);
    } catch {
      daemon.kill("SIGTERM");
      try {
        await boundedExit(daemon);
      } catch {}
    }
  }
  tty.close();
  screen.destroy();
  const cleanup = await scope.close();
  writeFileSync(
    join(output, "cleanup.json"),
    JSON.stringify({ ...cleanup, clean: cleanup.remaining.length === 0 && cleanup.reaped.length === 0 }, null, 2) +
      "\n",
  );
  await release();
  if (cleanup.remaining.length) throw Error(`Processes survived cleanup: ${cleanup.remaining}`);
}
