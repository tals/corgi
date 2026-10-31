/** Same-JSON wake/pull versus push. Benchmark-only; use the exclusive CPU slot. */
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as json from "../../src/json";
import * as surface from "../../src/pane/surface";
import type { View } from "../../src/protocol";
import * as benchmark from "./cpu_lock";

type Mode = "pull" | "push" | "paced";
type Scenario = "timed" | "pressure" | "disconnect";
type Config = {
  mode: Mode;
  scenario: Scenario;
  fixture: string;
  directory: string;
  warmup: number;
  seconds: number;
  phase: number;
  heartbeat: number;
};
type Corpus = { format: string; kind: string; frames: View[]; provenance?: unknown };
type Packet = View & { exchange: { sequence: number; produced_ms: number; fixture: number } };
const file = import.meta.path;
const arg = (key: string, fallback = "") => {
  const i = process.argv.indexOf(key);
  return i < 0 ? fallback : process.argv[i + 1];
};
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert(Date.now() < end, "deadline exceeded");
    await sleep(2);
  }
}
function corpus(path: string): Corpus {
  const input = json.parse(readFileSync(path, "utf8"));
  const value: Corpus =
    Array.isArray(input) || input.type === "view"
      ? { format: "saved-views", kind: "saved", frames: Array.isArray(input) ? input : [input] }
      : input;
  assert(value.frames.length > 0);
  for (const frame of value.frames) {
    assert.equal(frame.type, "view");
    assert(frame.surfaces.length > 0);
    for (const s of frame.surfaces) assert.equal(s.surface.lines.length, s.surface.rows);
  }
  return value;
}
class Lines {
  buffer = "";
  bytes = 0;
  callbacks = 0;
  constructor(readonly receive: (value: any) => void) {}
  feed(chunk: string) {
    this.callbacks++;
    this.buffer += chunk;
    assert(Buffer.byteLength(this.buffer) <= 64 * 1024 * 1024, "MessageTooLarge");
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      this.bytes += Buffer.byteLength(line) + 1;
      this.receive(json.parse(line));
    }
  }
}
class Wire {
  socket: Socket;
  lines: Lines;
  pending: { resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  failure: Error | null = null;
  onView: (value: Packet) => void = () => {};
  onDone: (value: any) => void = () => {};
  constructor(
    path: string,
    readonly mode: Mode,
  ) {
    this.lines = new Lines(value => {
      if (value.kind === "done") this.onDone(value);
      else if (value.type === "view" && mode !== "pull") this.onView(value);
      else this.pending.shift()?.resolve(value);
    });
    this.socket = createConnection(path).setEncoding("utf8");
    this.socket.on("data", (value: string) => this.lines.feed(value));
    this.socket.on("error", error => this.fail(error));
    this.socket.on("close", () => this.fail(Error("ConnectionClosed")));
  }
  fail(error: Error) {
    this.failure = error;
    for (const p of this.pending.splice(0)) p.reject(error);
  }
  request(value: object): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(json.stringify(value) + "\n");
    });
  }
}
function counters() {
  return {
    frames: 0,
    row_compares: 0,
    changed_rows: 0,
    requests: 0,
    wake_callbacks: 0,
    wake_bytes: 0,
    settle_callbacks: 0,
    heartbeat_callbacks: 0,
    unchanged: 0,
  };
}
function verifyFraming(fixture: Corpus) {
  const values = [fixture.frames[0], { text: "界 é 👋", revision: 18446744073709551615n }];
  const bytes = Buffer.from(values.map(value => json.stringify(value) + "\n").join("\n"));
  for (const width of [1, 7, bytes.length]) {
    const actual: unknown[] = [],
      decoder = new StringDecoder("utf8"),
      lines = new Lines(value => actual.push(value));
    for (let offset = 0; offset < bytes.length; offset += width)
      lines.feed(decoder.write(bytes.subarray(offset, offset + width)));
    lines.feed(decoder.end());
    assert.deepEqual(
      actual,
      values.map(value => json.parse(json.stringify(value))),
    );
    assert.equal(lines.buffer, "");
  }
}
function sample() {
  const usage = process.resourceUsage();
  return {
    cpu: process.cpuUsage(),
    at: process.hrtime.bigint(),
    wall: Date.now(),
    voluntary: usage.voluntaryContextSwitches,
    involuntary: usage.involuntaryContextSwitches,
  };
}
function difference(before: ReturnType<typeof sample>, after: ReturnType<typeof sample>) {
  const elapsed_ms = Number(after.at - before.at) / 1e6;
  const user_us = after.cpu.user - before.cpu.user,
    system_us = after.cpu.system - before.cpu.system;
  return {
    elapsed_ms,
    user_us,
    system_us,
    cpu_percent: (user_us + system_us) / (elapsed_ms * 10),
    voluntary: after.voluntary - before.voluntary,
    involuntary: after.involuntary - before.involuntary,
    start_wall: before.wall,
    end_wall: after.wall,
  };
}
function delta(before: ReturnType<typeof counters>, after: ReturnType<typeof counters>) {
  return Object.fromEntries(
    Object.keys(before).map(key => [key, after[key as keyof typeof after] - before[key as keyof typeof before]]),
  );
}
async function server(config: Config) {
  // This is the production daemon socket path, including its readiness thread.
  const { Client } = await import("../../src/peer");
  const { ReadyLoop, READ } = await import("../../src/fd_loop");
  const { n, ptr } = await import("../../src/native_ffi");
  const fixture = corpus(config.fixture),
    path = join(config.directory, "socket"),
    loop = new ReadyLoop(),
    listener = n.probe_listen(ptr(Buffer.from(path + "\0")));
  assert(listener >= 0);
  const clients: InstanceType<typeof Client>[] = [];
  let data: InstanceType<typeof Client> | null = null,
    wake: InstanceType<typeof Client> | null = null;
  let sequence = 0,
    latest: Packet | null = null,
    requests = 0,
    wakes = 0,
    settles = 0,
    outputPeak = 0,
    disconnected = 0,
    maxLateness = 0;
  let begin: ReturnType<typeof sample> | null = null,
    result: object | null = null;
  let producedStart = 0,
    requestStart = 0,
    wakeStart = 0,
    settleStart = 0;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => (finish = resolve)),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (at: number, body: () => void) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        body();
      },
      Math.max(0, at - Date.now()),
    );
    timers.add(timer);
  };
  let firstChange: number | null = null,
    lastChange = 0,
    lastSent = 0;
  let pacedTimer: ReturnType<typeof setTimeout> | null = null;
  const paced = () => {
    const now = Date.now();
    firstChange ??= now;
    lastChange = now;
    if (pacedTimer) clearTimeout(pacedTimer);
    const due = Math.max(Math.min(lastChange + 2, firstChange + 33), lastSent + 8);
    pacedTimer = setTimeout(
      () => {
        pacedTimer = null;
        firstChange = null;
        lastSent = Date.now();
        settles++;
        data!.queue(latest);
        outputPeak = Math.max(outputPeak, data!.output.length - data!.sent);
      },
      Math.max(0, due - Date.now()),
    );
  };
  const emit = () => {
    const index = sequence++ % fixture.frames.length,
      source = fixture.frames[index];
    latest = {
      ...source,
      surfaces: source.surfaces.map(s => ({ ...s, stamp: { ...s.stamp, revision: BigInt(sequence) } })),
      exchange: { sequence, produced_ms: Date.now(), fixture: index },
    };
    if (config.mode === "push") data!.queue(latest);
    else if (config.mode === "paced") paced();
    else {
      wake!.queue({ type: "viewer.wake" });
      wakes++;
    }
    outputPeak = Math.max(outputPeak, data!.output.length - data!.sent);
  };
  const start = (at: number) => {
    assert(data && wake);
    const measureAt = at + config.warmup * 1000,
      end = measureAt + config.seconds * 1000;
    later(measureAt, () => {
      begin = sample();
      producedStart = sequence;
      requestStart = requests;
      wakeStart = wakes;
      settleStart = settles;
    });
    if (config.scenario === "timed") {
      const ticks = Math.round((config.warmup + config.seconds) * 20);
      const tick = () => {
        maxLateness = Math.max(maxLateness, Date.now() - (at + 25 + config.phase + sequence * 50));
        emit();
        if (sequence < ticks) later(at + 25 + config.phase + sequence * 50, tick);
      };
      later(at + 25 + config.phase, tick);
    } else
      later(at + 25, () => {
        for (let i = 0; i < 96; i++) emit();
        if (config.scenario === "disconnect") data!.close();
      });
    later(end, () => {
      assert(begin);
      result = {
        ...difference(begin, sample()),
        produced: sequence - producedStart,
        requests: requests - requestStart,
        wakes: wakes - wakeStart,
        settle_callbacks: settles - settleStart,
        output_peak: outputPeak,
        disconnected,
        max_timer_lateness_ms: maxLateness,
      };
      data!.queue({ kind: "done", sequence });
      writeFileSync(join(config.directory, "server.json"), JSON.stringify(result));
    });
  };
  const registration = loop.watch(listener, () => {
    for (;;) {
      const fd = n.probe_accept(listener);
      if (fd < 0) break;
      const client = new Client(
        fd,
        loop,
        peer => {
          const request = peer.take();
          switch (request.op) {
            case "register":
              if (request.role === "data") data = peer;
              else wake = peer;
              peer.queue({ kind: "registered" });
              break;
            case "start":
              start(request.at);
              peer.queue({ kind: "started" });
              break;
            case "viewer.sync":
              requests++;
              assert(latest);
              peer.queue(
                Number(request.interests?.[0]?.known?.revision ?? 0) < sequence ? latest : { kind: "unchanged" },
              );
              break;
            case "wait_closed":
              break;
            case "stop":
              finish();
              break;
            default:
              throw Error("UnexpectedRequest");
          }
          peer.done();
        },
        () => {
          disconnected++;
        },
      );
      clients.push(client);
    }
    registration.arm(READ);
  });
  registration.arm(READ);
  writeFileSync(join(config.directory, "ready"), String(process.pid));
  try {
    await finished;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (pacedTimer) clearTimeout(pacedTimer);
    for (const client of clients) client.close();
    registration.close();
    n.probe_close(listener);
    loop.close();
  }
}
async function client(config: Config) {
  const configPath = join(config.directory, "config.json");
  const processServer = Bun.spawn([process.execPath, file, "--server", configPath], {
    stdout: "ignore",
    stderr: "pipe",
  });
  let wire: Wire | null = null,
    wake: Socket | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let pulse: ReturnType<typeof setInterval> | null = null;
  try {
    await until(() => existsSync(join(config.directory, "ready")));
    const path = join(config.directory, "socket"),
      fixture = corpus(config.fixture),
      metrics = counters();
    wire = new Wire(path, config.mode);
    await wire.request({ op: "register", role: "data" });
    wake = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      wake!.once("error", reject);
      wake!.once("data", () => resolve());
      wake!.write('{"op":"register","role":"wake"}\n');
    });
    let last = 0,
      previous: string[][] = [],
      active = false,
      pulling = false;
    let firstWake: number | null = null,
      lastWake = 0,
      lastSync = 0,
      pullTimer: ReturnType<typeof setTimeout> | null = null;
    const latency: number[] = [],
      sequences: number[] = [];
    const accept = (value: Packet) => {
      const { sequence, produced_ms, fixture: index } = value.exchange;
      assert(sequence > last, "duplicate or reordered frame");
      last = sequence;
      metrics.frames++;
      sequences.push(sequence);
      if (measuring) latency.push(Date.now() - produced_ms);
      previous = value.surfaces.map((encoded, pane) => {
        const view = surface.view(encoded),
          expected = fixture.frames[index].surfaces[pane].surface;
        assert.equal(view.stamp.revision, BigInt(sequence));
        assert.equal(view.surface.cols, expected.cols);
        assert.equal(view.surface.rows, expected.rows);
        for (let row = 0; row < view.surface.lines.length; row++) {
          assert.equal(view.surface.lines[row], expected.lines[row]);
          metrics.row_compares++;
          if (view.surface.lines[row] !== previous[pane]?.[row]) metrics.changed_rows++;
        }
        return view.surface.lines;
      });
    };
    wire.onView = accept;
    let done!: (value: any) => void;
    const completed = new Promise<any>(resolve => (done = resolve));
    wire.onDone = done;
    const schedule = () => {
      if (pulling || firstWake === null || !active) return;
      if (pullTimer) clearTimeout(pullTimer);
      const due = Math.max(Math.min(lastWake + 2, firstWake + 33), lastSync + 8);
      pullTimer = setTimeout(
        () => {
          pullTimer = null;
          metrics.settle_callbacks++;
          firstWake = null;
          pulling = true;
          lastSync = Date.now();
          metrics.requests++;
          void wire!
            .request({
              op: "viewer.sync",
              protocol: 3,
              viewer_protocol: 3,
              ack: 0n,
              session_hash: 0n,
              resources_hash: 0n,
              watched: true,
              resources: true,
              active: false,
              focus: 1,
              workspace: 1,
              interests: [
                { pane: 1, cols: 132, rows: 47, known: { identity: 1n, revision: BigInt(last), offset: null } },
              ],
            })
            .then(value => {
              if (value.kind === "unchanged") metrics.unchanged++;
              else accept(value);
            })
            .catch(error => {
              if (config.scenario !== "disconnect") throw error;
            })
            .finally(() => {
              pulling = false;
              schedule();
            });
        },
        Math.max(0, due - Date.now()),
      );
    };
    wake.on("data", (bytes: Buffer) => {
      metrics.wake_callbacks++;
      metrics.wake_bytes += bytes.length;
      if (!active || config.mode !== "pull") return;
      firstWake ??= Date.now();
      lastWake = Date.now();
      schedule();
    });
    wake.on("error", error => {
      if (active) throw error;
    });
    const at = Date.now() + 250,
      measureAt = at + config.warmup * 1000,
      end = measureAt + config.seconds * 1000;
    let measuring = false,
      beginning: ReturnType<typeof sample> | null = null,
      counts = counters();
    let mainBytes = 0,
      callbacks = 0,
      result: object | null = null;
    timers.push(
      setTimeout(
        () => {
          beginning = sample();
          counts = { ...metrics };
          mainBytes = wire!.lines.bytes;
          callbacks = wire!.lines.callbacks;
          measuring = true;
        },
        Math.max(0, measureAt - Date.now()),
      ),
    );
    timers.push(
      setTimeout(
        () => {
          assert(beginning);
          measuring = false;
          result = {
            ...difference(beginning, sample()),
            counts: delta(counts, metrics),
            main_bytes: wire!.lines.bytes - mainBytes,
            data_callbacks: wire!.lines.callbacks - callbacks,
          };
        },
        Math.max(0, end - Date.now()),
      ),
    );
    if (config.heartbeat)
      pulse = setInterval(() => {
        metrics.heartbeat_callbacks++;
      }, config.heartbeat);
    await wire.request({ op: "start", at });
    active = config.scenario !== "disconnect";
    const rejected = config.scenario === "disconnect" ? assert.rejects(wire.request({ op: "wait_closed" })) : null;
    if (config.scenario === "pressure") {
      wire.socket.pause();
      timers.push(setTimeout(() => wire!.socket.resume(), Math.max(0, at + 175 - Date.now())));
    }
    let finalSequence = 0;
    if (config.scenario === "disconnect") {
      await until(() => wire!.failure !== null, 5000);
      await rejected;
      await assert.rejects(wire.request({ op: "viewer.sync" }));
      await until(() => existsSync(join(config.directory, "server.json")), 5000);
    } else {
      let deadline!: ReturnType<typeof setTimeout>;
      const finished = await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(Error("TrialTimeout")), (config.warmup + config.seconds + 4) * 1000);
        }),
      ]).finally(() => clearTimeout(deadline));
      finalSequence = finished.sequence;
      await until(() => last === finalSequence && !pulling);
      if (config.scenario === "timed") {
        assert.deepEqual(
          sequences,
          Array.from({ length: finalSequence }, (_, i) => i + 1),
          "timed trial dropped revisions",
        );
        assert.equal(
          latency.length,
          Math.round(config.seconds * 20),
          "measurement did not receive every expected update",
        );
      }
    }
    active = false;
    if (pullTimer) clearTimeout(pullTimer);
    await until(() => result !== null);
    wake.write('{"op":"stop"}\n');
    assert.equal(await processServer.exited, 0, await new Response(processServer.stderr).text());
    assert(result);
    const serverResult = JSON.parse(readFileSync(join(config.directory, "server.json"), "utf8"));
    if (config.scenario === "pressure" && config.mode === "push") {
      assert(serverResult.output_peak > 0, "fixture did not exercise server write backpressure");
      assert.equal(sequences.length, 96, "push backpressure lost frames");
    }
    latency.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        config,
        client: result,
        server: serverResult,
        final_sequence: finalSequence,
        received: sequences.length,
        latency_ms: {
          resolution: 1,
          median: latency[Math.floor(latency.length / 2)] ?? null,
          p95: latency[Math.floor(latency.length * 0.95)] ?? null,
          max: latency.at(-1) ?? null,
        },
      }),
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (pulse) clearInterval(pulse);
    wire?.socket.destroy();
    wake?.destroy();
    if (processServer.exitCode === null) {
      processServer.kill();
      await processServer.exited;
    }
  }
}
async function makeFixture(destination: string, kind: string) {
  const { Terminal } = await import("../../src/pane/terminal");
  const { nativeRoot } = await import("../../src/native_paths");
  const terminal = Terminal.create(132, 47),
    frames: View[] = [];
  try {
    terminal.feed("\x1b[?7l");
    for (let row = 0; row < 47; row++) terminal.feed(`\x1b[${row + 1};1H${("row " + row + " ").padEnd(132, ".")}`);
    for (let i = 0; i < 32; i++) {
      terminal.feed(
        `\x1b[${(i % 47) + 1};1H\x1b[2K` +
          (kind === "styled"
            ? `\x1b[38;2;${i + 32};180;240m界 é \x1b]8;id=bench;https://example.com\x1b\\link\x1b]8;;\x1b\\ `
            : "") +
          `Working ${String(i).padStart(4, "0")} ` +
          "x".repeat(100) +
          "\x1b[0m",
      );
      frames.push({
        type: "view",
        viewer_protocol: 3,
        session: null,
        session_hash: 0n,
        resources: null,
        resources_hash: 0n,
        surfaces: [terminal.surface(1)],
        bell_seq: 0n,
        bell_kind: "none",
        controls: [],
        viewer: 1,
        detach: false,
      });
    }
    writeFileSync(
      destination,
      json.stringify({
        format: "corgi-view-exchange-v1",
        kind,
        frames,
        provenance: {
          source: "canonical Terminal.surface; surrounding hot View envelope",
          bun: Bun.version,
          native: sha(readFileSync(join(nativeRoot, "lib/libcorgi_term.so"))),
          bytes: frames.map(f => Buffer.byteLength(json.stringify(f) + "\n")),
        },
      }),
    );
  } finally {
    terminal.destroy();
  }
}
async function run() {
  const destination = arg("--out", "dist/viewer-exchange");
  mkdirSync(destination, { recursive: true });
  const release = await benchmark.acquire();
  try {
    if (process.argv.includes("--make-fixture"))
      return await makeFixture(resolve(arg("--make-fixture")), arg("--kind", "plain"));
    assert(arg("--fixture"), "--fixture is required");
    const fixture = resolve(arg("--fixture")),
      views = corpus(fixture);
    verifyFraming(views);
    const verify = process.argv.includes("--verify-only"),
      candidate: Mode = process.argv.includes("--paced-push") ? "paced" : "push",
      plan: { mode: Mode; scenario: Scenario }[] = verify
        ? (["pull", candidate] as const).flatMap(mode =>
            (["timed", "pressure", "disconnect"] as const).map(scenario => ({ mode, scenario })),
          )
        : (["pull", candidate, candidate, "pull"] as const).map(mode => ({ mode, scenario: "timed" }));
    const { nativeRoot } = await import("../../src/native_paths");
    writeFileSync(
      join(destination, "manifest.json"),
      JSON.stringify(
        {
          bun: Bun.version,
          revision: Bun.revision,
          source: sha(readFileSync(file)),
          fixture,
          fixture_sha256: sha(readFileSync(fixture)),
          source_rpc: sha(readFileSync(resolve(import.meta.dir, "../../src/rpc.ts"))),
          dependencies: Object.fromEntries(
            ["peer.ts", "fd_loop.ts", "native_bridge.ts", "native_ffi.ts", "json.ts", "pane/surface.ts"].map(path => [
              path,
              sha(readFileSync(resolve(import.meta.dir, "../../src", path))),
            ]),
          ),
          native: Object.fromEntries(
            ["libcorgi_term.so", "libcorgi_system.so"].map(path => [
              path,
              sha(readFileSync(join(nativeRoot, "lib", path))),
            ]),
          ),
          affinity: readFileSync("/proc/self/status", "utf8")
            .split("\n")
            .filter(x => /^(Cpus_allowed_list|Mems_allowed_list)/.test(x)),
          note: "Transport/codec/receipt experiment; excludes capture/rendering/UI policy. Date.now latency has 1 ms resolution. Both endpoints include all process threads. Callback counts and context switches are not exact event-loop wake counts.",
        },
        null,
        2,
      ),
    );
    for (const [index, trial] of plan.entries()) {
      const directory = mkdtempSync(join(tmpdir(), "corgi-exchange-"));
      const config: Config = {
        ...trial,
        directory,
        fixture,
        warmup: verify ? 0 : Number(arg("--warmup", "3")),
        seconds: verify ? 0.5 : Number(arg("--seconds", "10")),
        phase: Number(arg("--phase", "0")),
        heartbeat: Number(arg("--heartbeat", "16")),
      };
      assert(config.phase >= 0 && config.phase < 20);
      assert(config.seconds > 0 && config.warmup >= 0);
      writeFileSync(join(directory, "config.json"), JSON.stringify(config));
      const child = Bun.spawn(["setsid", process.execPath, file, "--client", join(directory, "config.json")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stop = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      const deadline = setTimeout(stop, (config.warmup + config.seconds + 12) * 1000);
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(deadline);
      stop();
      const record = { index, ...trial, code, output: code === 0 ? JSON.parse(output) : output, error };
      appendFileSync(join(destination, "trials.jsonl"), JSON.stringify(record) + "\n");
      rmSync(directory, { recursive: true, force: true });
      assert.equal(code, 0, error);
      console.log(JSON.stringify(record));
    }
  } finally {
    await release();
  }
}
if (process.argv.includes("--server")) await server(JSON.parse(readFileSync(arg("--server"), "utf8")));
else if (process.argv.includes("--client")) await client(JSON.parse(readFileSync(arg("--client"), "utf8")));
else await run();
