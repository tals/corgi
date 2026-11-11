/** Linux: bun tools/benchmarks/local_scale/run.ts --out DIR --agents 4 --cpus 104,105,106,107,108,109,110,111 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { Session } from "../../ui_driver";
import * as lock from "../cpu_lock";
import * as fixture from "../streaming_fixture";
import * as progress from "../viewer_progress";
import { Connection } from "../../../src/rpc";
import * as paths from "../paths";

const arg = (name: string, fallback: string) => {
  const i = Bun.argv.indexOf("--" + name);
  return i < 0 ? fallback : Bun.argv[i + 1];
};
const binary = path.resolve(arg("binary", "dist/corgi")),
  output = paths.external(arg("out", paths.run("local-scale"))),
  count = Number(arg("agents", "4")),
  seconds = Number(arg("seconds", "20")),
  warmup = Number(arg("warmup", "8")),
  repeat = Number(arg("repeat", "0")),
  traced = arg("trace", "on") === "on",
  bandwidthSeconds = Number(arg("bandwidth-seconds", "0")),
  scenarios = arg("scenarios", "idle,mixed,spammy").split(","),
  cpus = arg("cpus", "104,105,106,107,108,109,110,111").split(","),
  observer = arg("observer", "0"),
  attachments = arg("attachments", "attached,detached").split(",");
if (![4, 8, 32].includes(count) || cpus.length !== 8 || seconds < 3 || warmup < 3)
  throw Error("InvalidBenchmarkArguments");
if (fs.existsSync(output)) throw Error("UseFreshOutputDirectory");
fs.mkdirSync(output, { recursive: true });
const release = await lock.acquire();
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function wrapper(name: string, cores: string[]) {
  const file = path.join(output, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec taskset -c ${quote(cores.join(","))} ${quote(binary)} "$@"\n`, {
    mode: 0o700,
  });
  return file;
}
const session = new Session(wrapper("viewer", cpus.slice(4, 5)), wrapper("daemon", cpus.slice(0, 4)), 160, 48);
session.env.CORGI_TELEMETRY_DIR = "";
session.env.CORGI_TELEMETRY_TRACE = "";
session.env.BUN_OPTIONS = "";
const ticks = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString());
function usage(pid: number) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
    fields = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
  return {
    pid,
    user: +fields[11],
    system: +fields[12],
    children: +fields[13] + +fields[14],
    start: fields[19],
    rss_kib: +fields[21] * 4,
  };
}
function cpu(before: ReturnType<typeof usage>, after: ReturnType<typeof usage>, elapsed: number) {
  if (before.start !== after.start) throw Error("ProcessReplaced");
  return {
    percent: (100 * (after.user + after.system - before.user - before.system)) / ticks / elapsed,
    user_percent: (100 * (after.user - before.user)) / ticks / elapsed,
    system_percent: (100 * (after.system - before.system)) / ticks / elapsed,
    waited_children_percent: (100 * (after.children - before.children)) / ticks / elapsed,
  };
}
function host() {
  return Object.fromEntries(
    fs
      .readFileSync("/proc/stat", "utf8")
      .split("\n")
      .filter(l => /^cpu\d+ /.test(l))
      .map(l => {
        const [id, ...values] = l.trim().split(/\s+/),
          v = values.slice(0, 8).map(Number);
        return [id.slice(3), { busy: v.reduce((a, b) => a + b, 0) - v[3] - v[4], total: v.reduce((a, b) => a + b, 0) }];
      }),
  );
}
function sockets(pid: number) {
  return Object.fromEntries(
    fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        return target.startsWith("socket:") ? [[fd, target]] : [];
      } catch {
        return [];
      }
    }),
  );
}
async function cli(...args: string[]): Promise<any> {
  const proc = Bun.spawn([binary, ...args, ...(args[0] === "rpc" || args.includes("--json") ? [] : ["--json"])], {
    env: session.env,
    cwd: session.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw Error(`${args.join(" ")}: ${err}`);
  return out.trim() ? JSON.parse(out) : null;
}
async function until<T>(read: () => Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = performance.now() + 30000;
  while (performance.now() < end) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await Bun.sleep(50);
  }
  throw Error("Timeout: " + label);
}
async function sleepUntil(at: bigint) {
  while (fixture.now() < at) await Bun.sleep(Math.max(1, Number(at - fixture.now()) / 1e6));
}
const panes: number[] = [],
  pids: number[] = [],
  rows: object[] = [];
let daemon = 0;
async function mode(name: string) {
  const modes = panes.map((_, i) =>
    name === "idle"
      ? "idle"
      : name === "spammy"
        ? "spammy"
        : i < count / 4
          ? "spammy"
          : i < count / 2
            ? "light"
            : "idle",
  );
  // Both revisions support raw setup RPC; the measured viewer uses its own native transport.
  const setup = new Connection(net.createConnection(session.env.CORGI_SOCKET!));
  const send = (pane: number, data: string) =>
    setup.call("session.command", { command: { "pane.input": { target: pane, data: data + "\r" } } });
  const epoch = fixture.now() + 6000000000n;
  try {
    for (const [i, pane] of panes.entries()) {
      await send(pane, modes[i] === "idle" ? "stop" : "work");
      await send(
        pane,
        "bench-mode " + JSON.stringify({ mode: modes[i], lane: i, lanes: count, epoch_ns: String(epoch) }),
      );
    }
  } finally {
    setup.close();
  }
  if (fixture.now() >= epoch) throw Error("ProducerArmingTooSlow");
  await sleepUntil(epoch + 100000000n);
  await until(async () => {
    const state = (await cli("list")).result;
    return panes.every((id, i) =>
      state.panes.some(
        (p: any) => p.id === id && !p.exited && p.agent.state === (modes[i] === "idle" ? "idle" : "working"),
      ),
    );
  }, "agent workload states");
  return modes;
}
async function receipts(after: bigint) {
  for (const pid of pids) process.kill(pid, "SIGUSR2");
  return Promise.all(
    pids.map(pid =>
      until(async () => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(session.home, `scale-${pid}.json`), "utf8"));
          return BigInt(r.at_ns) >= after ? r : null;
        } catch {
          return null;
        }
      }, "producer receipt"),
    ),
  );
}
async function measure(
  name: string,
  modes: string[],
  attached: boolean,
  focus: number,
  traced = arg("trace", "on") === "on",
  duration = seconds,
) {
  const seconds = duration;
  if (attached) await cli("focus", String(panes[focus]), "--viewer", "1");
  const label = `${attached ? "attached" : "detached"}-${name}`;
  console.log(JSON.stringify({ phase: label, agents: count, repeat, warmup, seconds, traced }));
  const start = fixture.now() + BigInt(warmup * 1e9),
    end = start + BigInt(seconds * 1e9);
  const trace = traced
    ? Bun.spawn(
        [
          "sudo",
          "-n",
          "taskset",
          "-c",
          observer,
          "bpftrace",
          "-f",
          "json",
          path.join(import.meta.dir, "socket_bytes.bt"),
          String(daemon),
          String(attached ? session.proc.pid : 0),
          String(start),
          String(end),
        ],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, BPFTRACE_MAX_MAP_KEYS: "4096" } },
      )
    : null;
  const traceOutput = trace ? new Response(trace.stdout).text() : null,
    traceError = trace ? new Response(trace.stderr).text() : null;
  const beforeSockets = { daemon: sockets(daemon), viewer: attached ? sockets(session.proc.pid) : null };
  const peerLines = Bun.spawnSync(["ss", "-xnpH"])
    .stdout.toString()
    .split("\n")
    .filter(line => line.includes(`pid=${daemon},`) || line.includes(`pid=${session.proc.pid},`));
  const viewerPeers = new Set(
    peerLines.filter(line => line.includes(`pid=${session.proc.pid},`)).map(line => line.trim().split(/\s+/)[7]),
  );
  const daemonPeers = new Set(
    peerLines.filter(line => line.includes(`pid=${daemon},`)).map(line => line.trim().split(/\s+/)[7]),
  );
  await sleepUntil(start);
  if (trace && trace.exitCode !== null) throw Error("BpfFailed: " + (await traceError));
  const at = fixture.now(),
    h0 = host(),
    d0 = usage(daemon),
    v0 = attached ? usage(session.proc.pid) : null,
    p0 = pids.map(usage),
    terminal0 = session.bytes,
    visible0 = progress.sequence(session.text().join("\n"));
  await sleepUntil(end);
  const done = fixture.now(),
    d1 = usage(daemon),
    v1 = attached ? usage(session.proc.pid) : null,
    p1 = pids.map(usage),
    terminal1 = session.bytes,
    visible1 = progress.sequence(session.text().join("\n")),
    h1 = host();
  const elapsed = Number(done - at) / 1e9;
  let bytes: Record<string, number> = {},
    calls: Record<string, number> = {};
  if (trace) {
    const code = await trace.exited,
      outputText = await traceOutput!,
      err = await traceError!;
    fs.writeFileSync(path.join(output, label + "-bpf.jsonl"), outputText);
    fs.writeFileSync(path.join(output, label + "-bpf.stderr"), err);
    if (code) throw Error("BpfFailed: " + err);
    let ready = 0n;
    for (const line of outputText
      .trim()
      .split("\n")
      .filter(line => line.trim())) {
      const row = JSON.parse(line);
      if (row.type === "map") {
        Object.assign(bytes, row.data["@bytes"] ?? {});
        Object.assign(calls, row.data["@writes"] ?? {});
        if (row.data["@ready_ns"]) ready = BigInt(row.data["@ready_ns"]);
      }
    }
    if (!ready || ready >= start) throw Error("BpfAttachedTooLate");
  }
  const observed = await receipts(end);
  const producers = observed.map((r, i) => {
    const writes: [string, string, number, number][] = r.writes.filter(
      (w: string[]) => BigInt(w[0]) >= start && BigInt(w[0]) < end,
    );
    const hz = modes[i] === "idle" ? 0 : modes[i] === "light" ? 2 : 20;
    if (Math.abs(writes.length - hz * seconds) > Math.max(2, hz * seconds * 0.02))
      throw Error(`ProducerCadence: lane ${i}: ${writes.length}`);
    return {
      pid: pids[i],
      mode: modes[i],
      writes: writes.length,
      hz: writes.length / seconds,
      bytes: writes.reduce((s, w) => s + w[3], 0),
      cpu: cpu(p0[i], p1[i], elapsed),
      max_write_ms: Math.max(0, ...writes.map(w => Number(BigInt(w[1]) - BigInt(w[0])) / 1e6)),
      records: writes,
    };
  });
  fs.writeFileSync(path.join(output, label + "-producers.json"), JSON.stringify(producers) + "\n");
  const sumBytes = (pid: number) =>
    Object.entries(bytes)
      .filter(([key]) => Number(key.split(",")[0]) === pid)
      .reduce((n, [, v]) => n + v, 0);
  const viewerBytes = Object.entries(bytes)
    .filter(([key]) => {
      const [pid, inode] = key.split(",");
      return Number(pid) === daemon && viewerPeers.has(inode);
    })
    .reduce((n, [, v]) => n + v, 0);
  const upstreamBytes = attached
    ? Object.entries(bytes)
        .filter(([key]) => {
          const [pid, inode] = key.split(",");
          return Number(pid) === session.proc.pid && daemonPeers.has(inode);
        })
        .reduce((n, [, v]) => n + v, 0)
    : 0;
  if (traced && attached && (!viewerPeers.size || !viewerBytes)) throw Error("MissingViewerSocketTraffic");
  const busy = Object.fromEntries(
    Object.keys(h0).map(c => [c, (h1[c].busy - h0[c].busy) / (h1[c].total - h0[c].total)]),
  );
  const siblings = [
    ...new Set(
      cpus.flatMap(c =>
        fs.readFileSync(`/sys/devices/system/cpu/cpu${c}/topology/thread_siblings_list`, "utf8").trim().split(","),
      ),
    ),
  ].filter(c => !cpus.includes(c));
  const row = {
    name: label,
    agents: count,
    repeat,
    attached,
    focus,
    modes,
    seconds: elapsed,
    traced,
    start_ns: String(start),
    end_ns: String(end),
    start_jitter_ms: Number(at - start) / 1e6,
    end_jitter_ms: Number(done - end) / 1e6,
    cpu_counters: { ticks, daemon: [d0, d1], viewer: v0 && v1 ? [v0, v1] : null },
    daemon_cpu: cpu(d0, d1, elapsed),
    viewer_cpu: v0 && v1 ? cpu(v0, v1, elapsed) : null,
    provider_cpu_percent: producers.reduce((n, p) => n + p.cpu.percent, 0),
    daemon_to_clients_Bps: traced ? sumBytes(daemon) / seconds : null,
    daemon_to_viewer_Bps: traced ? viewerBytes / seconds : null,
    daemon_other_unix_Bps: traced ? (sumBytes(daemon) - viewerBytes) / seconds : null,
    viewer_to_daemon_Bps: traced ? upstreamBytes / seconds : null,
    viewer_other_unix_Bps: traced ? (sumBytes(attached ? session.proc.pid : 0) - upstreamBytes) / seconds : null,
    terminal_Bps: attached ? (terminal1 - terminal0) / elapsed : 0,
    producer_Bps: producers.reduce((n, p) => n + p.bytes, 0) / seconds,
    visible_before: visible0,
    visible_after: visible1,
    daemon_rss_kib: d1.rss_kib,
    viewer_rss_kib: v1?.rss_kib,
    kernel_bytes_by_pid_socket: bytes,
    kernel_writes_by_pid_socket: calls,
    sockets: beforeSockets,
    socket_peers: peerLines,
    host_busy: busy,
    siblings,
    max_sibling_busy: Math.max(...siblings.map(c => busy[c])),
    producers: producers.map(({ records: _, ...p }) => p),
  };
  if (
    attached &&
    modes[focus] !== "idle" &&
    (visible0 === null || visible1 === null || visible1 - visible0 < seconds * (modes[focus] === "light" ? 1.8 : 18))
  )
    throw Error("VisibleOutputDidNotProgress");
  let presentation = null;
  if (attached && modes[focus] !== "idle") {
    presentation = await progress.probe(() => session.text().join("\n"));
    if (modes[focus] === "spammy") progress.validateCadence(presentation);
    const source = progress.sequence((await cli("pane", "read", String(panes[focus]), "--lines", "100")).result.text);
    const visible = progress.sequence(session.text().join("\n"));
    if (source === null || visible === null || Math.abs(source - visible) > 3) throw Error("VisibleSourceLag");
    fs.writeFileSync(
      path.join(output, label + "-presentation.json"),
      JSON.stringify({ presentation, source, visible }, null, 2) + "\n",
    );
  }
  Object.assign(row, {
    presentation: presentation && {
      hz: presentation.visible_changes_per_second,
      max_gap_ms: presentation.max_observed_gap_ms,
    },
  });
  rows.push(row);
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        binary,
        build: JSON.parse(fs.readFileSync(binary + ".build.json", "utf8")),
        count,
        repeat,
        cpus,
        platform: os.release(),
        cpu: os.cpus()[0].model,
        traced,
        warmup,
        seconds,
        daemon,
        viewer: session.proc.pid,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(output, label + "-screen.txt"), session.text().join("\n") + "\n");
  console.log(
    JSON.stringify({
      result: label,
      daemon_cpu: row.daemon_cpu.percent,
      viewer_cpu: row.viewer_cpu?.percent,
      down_Bps: row.daemon_to_clients_Bps,
      up_Bps: row.viewer_to_daemon_Bps,
      sibling_busy: row.max_sibling_busy,
    }),
  );
}
try {
  fixture.install(path.join(session.home, "bin"), "sparse");
  fs.copyFileSync(
    path.join(import.meta.dir, "producer.ts.fixture"),
    path.join(session.home, "bin/streaming-provider.ts"),
  );
  await session.start();
  daemon = await until(async () => {
    try {
      return (await cli("rpc", '{"op":"ping"}')).pid;
    } catch {
      return null;
    }
  }, "daemon");
  const initial = await until(async () => {
    const s = (await cli("list")).result;
    return s.panes.length === 1 && s;
  }, "initial shell");
  for (let i = 0; i < count; i++)
    panes.push(
      (
        await cli(
          "tab",
          "new",
          "--workspace",
          String(initial.workspaces[0].id),
          "--name",
          `agent-${i}`,
          "--command",
          i % 2 ? "codex" : "claude",
        )
      ).result.pane,
    );
  for (const pane of panes) {
    await cli("focus", String(pane), "--viewer", "1");
    await until(
      async () => (await cli("list")).result.panes.some((p: any) => p.id === pane && p.cols === 132 && p.rows === 47),
      "pane geometry",
    );
  }
  const snapshot = await until(async () => {
    const s = (await cli("list")).result;
    return (
      panes.every((id, i) =>
        s.panes.some(
          (p: any) =>
            p.id === id && !p.exited && p.agent.provider === (i % 2 ? "codex" : "claude") && p.agent.state === "idle",
        ),
      ) && s
    );
  }, "providers ready");
  // The command wrapper can be the pane leader; fixtures publish their actual PID in unique transcripts.
  for (const pane of panes) {
    const p = snapshot.panes.find((p: any) => p.id === pane);
    const raw = fs
      .readFileSync(`/proc/${p.pid}/task/${p.pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    const provider = [p.pid, ...raw].find(pid => {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(path.join(session.home, "bin"));
      } catch {
        return false;
      }
    });
    if (!provider) throw Error("MissingProviderPID");
    pids.push(provider);
    if (Bun.spawnSync(["taskset", "-apc", cpus.slice(5).join(","), String(provider)]).exitCode)
      throw Error("AffinityFailed");
  }
  fs.writeFileSync(
    path.join(output, "setup.json"),
    JSON.stringify({ home: session.home, daemon, viewer: session.proc.pid, panes, pids, snapshot }, null, 2) + "\n",
  );
  const order = [...scenarios.slice(repeat % scenarios.length), ...scenarios.slice(0, repeat % scenarios.length)];
  for (const attachment of attachments) {
    const attached = attachment === "attached";
    if (!attached) {
      session.write("\x02q");
      await session.proc.exited;
    }
    for (const name of order) {
      const modes = await mode(name);
      const overhead = traced && count === 32 && attached && name === "spammy";
      if (overhead && repeat % 2) await measure("spammy-untraced", modes, true, 0, false);
      await measure(name, modes, attached, 0);
      if (bandwidthSeconds && attached) await measure(name + "-bandwidth", modes, true, 0, true, bandwidthSeconds);
      if (overhead && !(repeat % 2)) await measure("spammy-untraced", modes, true, 0, false);
      if (attached && name === "mixed") {
        await measure("mixed-quiet-focus", modes, true, count - 1);
        if (bandwidthSeconds)
          await measure("mixed-quiet-focus-bandwidth", modes, true, count - 1, true, bandwidthSeconds);
      }
    }
  }
} catch (error) {
  fs.writeFileSync(path.join(output, "failure.txt"), String(error) + "\n" + session.output);
  throw error;
} finally {
  try {
    for (const entry of fs.readdirSync(session.home, { recursive: true })) {
      const name = String(entry);
      if (name.endsWith(".log") || name.includes("crash")) {
        const source = path.join(session.home, name);
        if (!fs.statSync(source).isFile()) continue;
        const target = path.join(output, "diagnostics", name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
    }
  } catch (error) {
    fs.writeFileSync(path.join(output, "diagnostics-error.txt"), String(error));
  }
  await session.close();
  fs.writeFileSync(path.join(output, "cleanup.json"), JSON.stringify({ clean: true }) + "\n");
  await release();
}
