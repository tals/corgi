/** Linux CPU playbook: bun tools/benchmarks/cpu.ts BINARY OUTPUT [SECONDS=15]
 * Set CPU_PROFILE=1 for Bun profiles (use a separate run for timing).
 * CPU_WARMUP_SECONDS=10, CPU_AGENTS=8. CPU_IDLE_ONLY=1 measures an empty daemon;
 * CPU_IDLE_ONLY=viewer measures only a quiet shell with an attached viewer.
 * CPU_MATRIX_ONLY=1 selects the four idle/streaming, attached/detached phases.
 * CPU_INITIAL_WARMUP_SECONDS overrides the first agent phase's warmup.
 * CPU includes all process threads; 100% is one core. Provider CPU is excluded.
 * Streaming produces one approximately 130-byte line per agent every 50 ms.
 * Every phase shares a private UI-driver runtime and fake provider accounts.
 * Claude sessions bind through hooks. Codex fixtures omit UUID titles and stay
 * screen-tracked; this does not exercise full Codex app-server session polling.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Session } from "../ui_driver";
import { ORDINARY_PROVIDER, NATIVE_PROVIDER, write_executable } from "../../tests/provider_sim";
import * as benchmark from "./cpu_lock";
import * as progress from "./viewer_progress";

const release = await benchmark.acquire();
const binary = resolve(process.argv[2] ?? "dist/corgi"),
  output = resolve(process.argv[3] ?? "dist/cpu"),
  seconds = Number(process.argv[4] ?? 15),
  warmup = Number(process.env.CPU_WARMUP_SECONDS ?? 10),
  initialWarmup = Number(process.env.CPU_INITIAL_WARMUP_SECONDS ?? warmup),
  count = Number(process.env.CPU_AGENTS ?? 8),
  matrix = !!process.env.CPU_MATRIX_ONLY,
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
if (existsSync(join(output, "results.json"))) throw Error("Use a fresh output directory");
mkdirSync(output, { recursive: true });
const s = new Session(binary, binary, 160, 48);
const ticks = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString());
function usage(pid: number) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8"),
    stat = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return {
    cpu: (Number(stat[11]) + Number(stat[12])) / ticks,
    children: (Number(stat[13]) + Number(stat[14])) / ticks,
  };
}
async function cli(...args: string[]) {
  const p = Bun.spawn([binary, ...args, ...(args[0] === "rpc" || args.includes("--json") ? [] : ["--json"])], {
    env: { ...s.env, BUN_OPTIONS: "" },
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
  const streaming = name === "streaming-agents-viewer",
    visibleBefore = streaming ? progress.sequence(s.text().join("\n")) : null;
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
  const visibleAfter = streaming ? progress.sequence(s.text().join("\n")) : null,
    visibleAt = performance.now();
  let streaming_progress: (ReturnType<typeof progress.reading> & { source_read_delay_ms: number }) | null = null;
  if (streaming) {
    const source = await cli("pane", "read", String(panes[0]), "--lines", "100");
    streaming_progress = {
      ...progress.reading(visibleBefore, visibleAfter, progress.sequence(source.result.text), elapsed),
      source_read_delay_ms: performance.now() - visibleAt,
    };
  }
  const streaming_quality = streaming ? await progress.probe(() => s.text().join("\n")) : null;
  const row = {
    name,
    warmup: wait,
    started_at: startedAt,
    seconds: elapsed,
    daemon_cpu: (100 * (end.cpu - d.cpu)) / elapsed,
    daemon_child_cpu: (100 * (end.children - d.children)) / elapsed,
    viewer_cpu: v && vend ? (100 * (vend.cpu - v.cpu)) / elapsed : null,
    viewer_bytes_per_second: (endBytes - bytes) / elapsed,
    streaming_progress,
    streaming_quality,
  };
  const snapshot = (await cli("list")).result;
  if (state && !checkAgents(snapshot, state)) throw Error(`${name}: expected ${count} ${state} agents`);
  writeFileSync(join(output, `${name}.json`), JSON.stringify(snapshot, null, 2) + "\n");
  results.push(row);
  console.log(JSON.stringify(row));
  writeFileSync(
    join(output, "results.json"),
    JSON.stringify(
      {
        binary,
        daemon,
        viewer: s.proc?.pid,
        seconds,
        warmup,
        initialWarmup,
        matrix,
        agents: count,
        profiled: !!process.env.CPU_PROFILE,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  if (viewer) writeFileSync(join(output, `${name}.txt`), s.text().join("\n") + "\n");
  if (streaming_progress) progress.validate(streaming_progress);
  if (streaming_quality) progress.validateCadence(streaming_quality);
}
async function run() {
  try {
    // Distinct fixture IDs, plus bounded terminal output controlled through stdin.
    write_executable(join(s.home, "bin", "rpc-fixture.ts"), NATIVE_PROVIDER);
    const provider = ORDINARY_PROVIDER.replace(
      "const provider=basename(process.argv[1]);",
      `const provider=basename(process.argv[1]);
if(process.argv.includes('--version')) { console.log(provider==='codex' ? 'codex-cli 1.2.3' : '2.1.0 (Claude Code)'); process.exit(0); }
if(process.argv.includes('app-server')) { await import('./rpc-fixture.ts'); process.exit(0); }`,
    )
      .replaceAll("'ordinary-'+provider", "'ordinary-'+provider+'-'+process.pid")
      .replace("let loading=", "let stream=null; let seq=0;\nlet loading=")
      .replace(
        "if(command==='exit') break;",
        `if(command==='stream') { stream ??= setInterval(()=>console.log('Working (esc to interrupt) '+(++seq)+' '+'.'.repeat(100)),50); continue; }
if(command==='quiet') { clearInterval(stream); stream=null; continue; }
if(command==='exit') break;`,
      );
    for (const name of ["claude", "codex"]) write_executable(join(s.home, "bin", name), provider);
    if (process.env.CPU_PROFILE) s.env.BUN_OPTIONS = `--cpu-prof --cpu-prof-dir=${output}`;
    await s.seed(`'${binary.replaceAll("'", "'\\''")}' start`);
    daemon = (await cli("rpc", '{"op":"ping"}')).pid;
    const runtime = { home: s.home, daemon, binary, started_at: new Date().toISOString() };
    writeFileSync(join(output, "runtime.json"), JSON.stringify(runtime, null, 2) + "\n");
    console.log(JSON.stringify(runtime));
    if (!matrix && idle !== "viewer") await measure("empty-daemon");
    if (idle === "daemon") return;
    await s.start();
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
    if (matrix) await cli("focus", String(shell), "--viewer", "1");
    await measure("idle-agents-viewer", true, "idle");
    for (const pane of panes) await cli("pane", "send", String(pane), "work", "--enter");
    if (!matrix) await measure("working-agents-viewer", true, "working");
    for (const pane of panes) await cli("pane", "send", String(pane), "stream", "--enter");
    await cli("focus", String(panes[0]), "--viewer", "1");
    await measure("streaming-agents-viewer", true, "working");
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
