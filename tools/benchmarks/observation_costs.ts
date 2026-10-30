/** Isolated observation microbenchmarks, not whole-daemon speedups.
 * CORGI_NATIVE_ROOT=/path/to/native/zig-out bun tools/benchmarks/observation_costs.ts [--check]
 * OBSERVATION_MS=250 OBSERVATION_REPEATS=6 controls each variant's sampling.
 * Acquire the shared CPU benchmark slot before timing; --check only verifies fixtures.
 */
import { deepStrictEqual, strictEqual, notStrictEqual } from "node:assert";
import { mkdtempSync, writeFileSync, statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { Agent, Text, Path } from "../../src/agents";
import * as observation from "../../src/observation";
import * as resources from "../../src/trackers/resources";
import * as common from "../../src/providers/common";
import * as codex from "../../src/providers/codex/observer";
import type { Client } from "../../src/providers/codex/socket";
import * as json from "../../src/json";
import * as usage from "../../src/usage/worker";
import * as claudeUsage from "../../src/providers/claude/usage";
import { Model } from "../../src/providers/model";
import * as benchmark from "./cpu_lock";

function screenTail(screen: string) {
  const trimmed = screen.trimEnd();
  let start = trimmed.length;
  for (let i = 0; i < 8; i++) {
    start = trimmed.lastIndexOf("\n", start - 1);
    if (start < 0) break;
  }
  return trimmed.slice(start + 1, start + 1 + 8192).toLowerCase();
}

// Existing strings are already bounded and immutable; wrappers remain independent.
function copiedText<T extends { value: string; text(): string }>(source: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(source)), { value: source.text(), raw_bytes: undefined });
}
function snapshot(agent: Agent): Agent {
  const out = Object.assign(Object.create(Agent.prototype), agent) as Agent;
  for (const key of ["name", "turn", "last_finished_turn", "recent", "session", "activity", "tool"] as const)
    out[key] = copiedText(agent[key]);
  out.transcript = copiedText(agent.transcript);
  out.cwd = copiedText(agent.cwd);
  out.subagents = { ...agent.subagents };
  out.observation = Object.assign(Object.create(observation.State.prototype), agent.observation);
  return out;
}

function agentFixture(index: number) {
  return new Agent({
    provider: index % 2 ? "codex" : "claude",
    state: "working",
    name: new Text(`Investigate terminal cost ${index}`),
    session: new Text(`00000000-0000-0000-0000-${String(index).padStart(12, "0")}`),
    turn: new Text(`turn-${index}`),
    transcript: new Path(`/tmp/fixture-${index}/transcript.jsonl`),
    cwd: new Path(`/tmp/project-${index}`),
    activity: new Text("Comparing allocation and data movement 中文 🐶"),
    tool: new Text("exec_command"),
    last_seq: 9007199254740993n,
    observation: new observation.State({ completed: 7n, read: 6n }),
  });
}

function resourceFixture(workspaces: number, processes: number): resources.SampleRequest {
  const tracker = new resources.Tracker();
  tracker.workspaces = Array.from({ length: workspaces }, (_, i) => i + 1);
  tracker.current.workspaces = tracker.workspaces.map(id => {
    const work = new resources.Work(id);
    work.known = true;
    work.count = processes;
    const proc = (i: number) =>
      Object.assign(new resources.Process(id * 1000 + i, BigInt(i + 100), `process-${i}`), {
        cpu: i + 1,
        memory: BigInt(i + 1) * 1024n * 1024n,
        read: 1024n,
        written: 256n,
      });
    work.processes = Array.from({ length: processes }, (_, i) => proc(i));
    work.history = Array.from({ length: resources.history_capacity }, (_, i) => ({
      at: i * resources.history_bucket_ms,
      samples: 2,
      cpu: 42,
      memory: 1024n * 1024n * 1024n,
      io: 20000n,
      gpus: [],
      processes: Array.from({ length: Math.min(5, processes) }, (_, j) => proc(j)),
    }));
    return work;
  });
  tracker.batch.view = tracker.current;
  tracker.roots = tracker.workspaces.flatMap(workspace =>
    Array.from({ length: processes }, (_, i) => ({
      key: workspace * 1000 + i,
      pid: workspace * 1000 + i,
      start: BigInt(i + 100),
      workspace,
      agent_pid: workspace * 1000 + i,
      provider: "codex" as const,
      pane: workspace * 1000 + i,
      session: null,
    })),
  );
  tracker.batch.readings = tracker.roots.map(root => ({
    pid: root.pid,
    workspace: root.workspace,
    identity_start: root.start!,
    at: 240000,
    value: { start: root.start!, cpu_ns: 10000000n, memory: 1048576n, read: 1024n, written: 256n },
  }));
  tracker.origins = new Map(tracker.roots.map(r => [r.key, { pid: r.pid, start: r.start! }]));
  return {
    roots: tracker.roots,
    workspaces: tracker.workspaces,
    origins: tracker.origins,
    batch: tracker.batch,
    current: tracker.current,
    interval_ms: 2000,
    at: 242000,
  };
}

// Same output in both paths; sampling itself is excluded to isolate transport cost.
function resourceRoundTrip(input: resources.SampleRequest) {
  const received = structuredClone(input),
    worker = new resources.Tracker();
  Object.assign(worker, received, {
    batch: resources.restoreBatch(received.batch),
    current: resources.restoreSnapshot(received.current),
  });
  const output = structuredClone({ pending: worker.batch, origins: worker.origins });
  return resources.restoreBatch(output.pending);
}
function retainedRoundTrip(input: resources.SampleRequest) {
  structuredClone({ roots: input.roots, workspaces: input.workspaces, interval_ms: input.interval_ms, at: input.at });
  const output = structuredClone({ pending: input.batch, origins: input.origins });
  return resources.restoreBatch(output.pending);
}

type Sample = { wall_ns: number; cpu_ns: number; iterations: number };
type Case = { name: string; original: () => number; compact: () => number; meaning: object };
let checksum = 0;
function measure(run: () => number, ms: number): Sample {
  Bun.gc(true);
  const cpu = process.cpuUsage(),
    start = performance.now();
  let iterations = 0;
  do {
    for (let i = 0; i < 32; i++) checksum += run();
    iterations += 32;
  } while (performance.now() - start < ms);
  const elapsed = performance.now() - start,
    used = process.cpuUsage(cpu);
  return {
    wall_ns: (elapsed * 1000000) / iterations,
    cpu_ns: ((used.user + used.system) * 1000) / iterations,
    iterations,
  };
}
function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

function codexFixture(items: number, newestCommand = false) {
  const session = "00000000-0000-0000-0000-000000000001",
    entries: object[] = Array.from({ length: items }, (_, i) => ({
      turnId: "turn-1",
      item: { type: "agentMessage", id: `item-${i}`, text: "x".repeat(1024) },
    }));
  if (newestCommand)
    entries[0] = {
      turnId: "turn-2",
      item: { type: "commandExecution", id: "command-1", cwd: "/tmp/project", status: "completed" },
    };
  let counts: Record<string, number> = {};
  let bytes = 0;
  const client = {
    async call(method: string, params: { cursor?: string | null }) {
      counts[method] = (counts[method] ?? 0) + 1;
      let result: object;
      switch (method) {
        case "thread/read":
          result = { thread: { id: session, cwd: "/tmp/project", status: { type: "idle" }, updatedAt: 1 } };
          break;
        case "thread/items/list": {
          const at = Number(params.cursor ?? 0);
          result = { data: entries.slice(at, at + 100), nextCursor: at + 100 < items ? String(at + 100) : null };
          break;
        }
        default:
          result = { data: [], nextCursor: null };
      }
      const encoded = JSON.stringify({ result });
      bytes += Buffer.byteLength(encoded);
      return json.parse(encoded);
    },
  };
  return async () => {
    counts = {};
    bytes = 0;
    const result = await codex.snapshot(
      client as Client,
      { pane: 1, pid: 1, prefix: new common.Text(session), actor: 0, generation: 0n, title_revision: 0n },
      session,
    );
    strictEqual(result.state, "idle");
    if (newestCommand) strictEqual(result.location?.cwd, "/tmp/project");
    else strictEqual(result.location, null);
    return {
      items,
      newest_command: newestCommand,
      calls: counts,
      response_bytes: bytes,
      note: newestCommand
        ? "One unchanged idle session; newest item is a command in a new turn, following items belong to an older turn"
        : "One unchanged idle session; no location-bearing items",
    };
  };
}

async function measureAsync(run: () => Promise<{ response_bytes: number }>, ms: number): Promise<Sample> {
  Bun.gc(true);
  const cpu = process.cpuUsage(),
    start = performance.now();
  let iterations = 0;
  do {
    checksum += (await run()).response_bytes;
    iterations++;
  } while (performance.now() - start < ms);
  const elapsed = performance.now() - start,
    used = process.cpuUsage(cpu);
  return {
    wall_ns: (elapsed * 1000000) / iterations,
    cpu_ns: ((used.user + used.system) * 1000) / iterations,
    iterations,
  };
}

async function eofAudit() {
  const directory = mkdtempSync(join(tmpdir(), "corgi-observation-eof-")),
    file = join(directory, "fixture.jsonl"),
    worker = new usage.Worker();
  try {
    writeFileSync(file, "{}\n");
    const stat = statSync(file),
      agent = agentFixture(0),
      tail = new usage.Tail();
    agent.transcript = new Path(file);
    Object.assign(tail, { actor: 1, inode: stat.ino, device: stat.dev, offset: stat.size, opened: true });
    tail.model = Model.resolve("claude-sonnet-4-5");
    worker.watchers.set(1, tail);
    worker.readers.set("claude", claudeUsage.open());
    worker.requests = [{ actor: 1, workspace: 1, since: 0, agent, child: false, tracked_since: 0 }];
    const emissions: number[] = [];
    for (let i = 0; i < 4; i++) {
      await worker.run();
      emissions.push(worker.take().length);
    }
    deepStrictEqual(emissions, [1, 1, 1, 1]);
    return { polls: 4, unchanged_eof_results: emissions, file_bytes: stat.size, model: tail.model.id.text() };
  } finally {
    worker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

const release = await benchmark.acquire();
try {
  const agents = Array.from({ length: 16 }, (_, i) => agentFixture(i)),
    cases: Case[] = [];
  for (const agent of agents) {
    const original = agent.snapshot(),
      compact = snapshot(agent);
    deepStrictEqual(compact, original);
    notStrictEqual(compact.name, agent.name);
    notStrictEqual(compact.observation, agent.observation);
    compact.name.append("!");
    strictEqual(agent.name.text() + "!", compact.name.text());
  }
  cases.push({
    name: "agent-snapshot-16",
    original: () => agents.reduce((sum, agent) => sum + agent.snapshot().name.len, 0),
    compact: () => agents.reduce((sum, agent) => sum + snapshot(agent).name.len, 0),
    meaning: {
      agents: 16,
      invocations_per_second: 4,
      change: "Copy already-bounded immutable strings without reencoding",
    },
  });
  for (const rows of [48, 200, 2000]) {
    const text = Array.from({ length: rows }, (_, i) => `${i} ${"AbCd".repeat(30)}`).join("\n") + "\n \t\u2003";
    strictEqual(screenTail(text), common.screenTail(text));
    cases.push({
      name: `screen-tail-${rows}-rows`,
      original: () => common.screenTail(text).length,
      compact: () => screenTail(text).length,
      meaning: { rows, bytes: Buffer.byteLength(text), change: "Find the last eight rows without splitting all rows" },
    });
  }
  for (const text of ["", "\n", "a", "a\nb", "x".repeat(20000), "\u2003a\u2003", "X\n".repeat(8)])
    strictEqual(screenTail(text), common.screenTail(text));
  for (const [workspaces, processes] of [
    [1, 16],
    [8, 8],
  ]) {
    const input = resourceFixture(workspaces, processes);
    deepStrictEqual(resourceRoundTrip(input), retainedRoundTrip(input));
    cases.push({
      name: `resource-roundtrip-${workspaces}-workspaces-${processes}-processes`,
      original: () => resourceRoundTrip(input).view.workspaces[0].history.length,
      compact: () => retainedRoundTrip(input).view.workspaces[0].history.length,
      meaning: {
        workspaces,
        processes_per_workspace: processes,
        history_buckets: resources.history_capacity,
        history_processes_per_bucket: 5,
        invocations_per_second: 0.5,
        change: "Retain prior sampler state in the worker; send only roots and options, keep identical full output",
        scope: "structured clone and prototype restoration only; no process scan, OS reads, or thread scheduling",
      },
    });
  }

  const codexCases = [
    { name: "codex-100-items-no-location", run: codexFixture(100) },
    { name: "codex-3000-items-no-location", run: codexFixture(3000) },
    { name: "codex-3000-items-newest-command", run: codexFixture(3000, true) },
  ];
  const audits = { codex: await Promise.all(codexCases.map(entry => entry.run())), eof: await eofAudit() };
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify({ verified: cases.map(c => c.name), audits }, null, 2));
  } else {
    const ms = Number(process.env.OBSERVATION_MS ?? 250),
      repeats = Number(process.env.OBSERVATION_REPEATS ?? 6);
    if (!(ms > 0) || !Number.isInteger(repeats) || repeats < 2) throw Error("Invalid sample parameters");
    const results = [];
    for (const entry of cases) {
      measure(entry.original, ms);
      measure(entry.compact, ms);
      const original: Sample[] = [],
        compact: Sample[] = [];
      for (let i = 0; i < repeats; i++) {
        if (i % 2) {
          compact.push(measure(entry.compact, ms));
          original.push(measure(entry.original, ms));
        } else {
          original.push(measure(entry.original, ms));
          compact.push(measure(entry.compact, ms));
        }
      }
      results.push({
        name: entry.name,
        meaning: entry.meaning,
        original,
        compact,
        median_wall_ns: {
          original: median(original.map(s => s.wall_ns)),
          compact: median(compact.map(s => s.wall_ns)),
        },
        median_cpu_ns: { original: median(original.map(s => s.cpu_ns)), compact: median(compact.map(s => s.cpu_ns)) },
      });
    }
    const codexResults = [];
    for (const entry of codexCases) {
      await measureAsync(entry.run, ms);
      const samples = [];
      for (let i = 0; i < repeats; i++) samples.push(await measureAsync(entry.run, ms));
      codexResults.push({
        name: entry.name,
        samples,
        median_wall_ns: median(samples.map(s => s.wall_ns)),
        median_cpu_ns: median(samples.map(s => s.cpu_ns)),
        scope:
          "JS fake-server response serialization + real client JSON parser + production snapshot extraction; no socket or provider CPU",
      });
    }
    console.log(
      JSON.stringify(
        {
          bun: Bun.version,
          cpu: cpus()[0].model,
          affinity: readFileSync("/proc/self/status", "utf8")
            .split("\n")
            .filter(s => /Cpus_allowed_list|Mems_allowed_list/.test(s)),
          ms,
          repeats,
          audits,
          results,
          codex_results: codexResults,
          checksum,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await release();
}
