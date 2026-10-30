/** Real launcher publication in frozen source trees; provider I/O is excluded. */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { suffix } from "bun:ffi";
import * as accounts from "../../src/accounts";
import * as json from "../../src/json";
import * as launchService from "../../src/launch_service";
import { Option, Preview } from "../../src/launch/preview";
import { nativeRoot } from "../../src/native_paths";
import type { Client } from "../../src/peer";
import { Provider, Text, byProvider } from "../../src/providers";
import type { Server } from "../../src/server";
import { Window } from "../../src/usage/account";
import * as benchmark from "./cpu_lock";

const root = resolve(import.meta.dir, "../.."),
  fixtureRoot = `/tmp/corgi-preview-costs-${process.getuid!()}`,
  cwd = join(fixtureRoot, "project"),
  baseTime = 1792985000000,
  iterations = Number(process.env.PREVIEW_ITERATIONS ?? 4000),
  trials = Number(process.env.PREVIEW_TRIALS ?? 5),
  warmup = 500;
type Scenario = "stable" | "equivalent-source" | "metadata-change" | "restored-pending";
const scenarios: Scenario[] = ["stable", "equivalent-source", "metadata-change", "restored-pending"];
let now = baseTime;
const realClock = Date.now,
  savedEnv = { ...process.env };
function sha(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function listing(count: number, revision = 0) {
  mkdirSync(dirname(accounts.path()), { recursive: true });
  writeFileSync(
    accounts.path(),
    JSON.stringify({
      accounts: Array.from({ length: count }, (_, index) => ({
        provider: index % 2 ? "claude" : "codex",
        dir: join(fixtureRoot, `account-${index}`),
        name: `account-${index}${revision ? "-renamed" : ""}`,
        managed: false,
      })),
      defaults: { codex: revision ? "renamed" : "work" },
    }),
  );
  accounts.reset();
}
function reading(index: number) {
  const option = new Option();
  option.pending = false;
  option.signed_in = true;
  option.setModel(`fixture-model-${index}`, "Project", `Fixture model ${index}`);
  option.account = new Text(`fixture-${index}@example.invalid`);
  option.plan = new Text("Pro");
  option.limits = {
    windows: [
      new Window({ minutes: 300, used: 29 + index, reset_at: baseTime / 1000 + 3600 }),
      new Window({ minutes: 10080, used: 53 + index, reset_at: baseTime / 1000 + 86400 }),
    ],
  };
  option.usage_fetched_at = baseTime / 1000;
  option.history = [Array.from({ length: 14 }, (_, n) => n * 2), Array.from({ length: 14 }, (_, n) => n * 3)];
  option.spend_history = Array.from({ length: 14 }, (_, n) => ({ minor: 10 + n, earlier: n < 3 }));
  return option;
}
function settled(preview: Preview) {
  return Object.assign(new Preview(), preview, {
    pending: false,
    options: byProvider(p => reading(Provider.all.indexOf(p))),
    accounts: preview.accounts.map((a, index) => ({ ...a, option: reading(index + 4) })),
  });
}
function fixture(count: number, scenario: Scenario) {
  now = baseTime;
  listing(count);
  const server = {} as Server,
    worker = launchService.service(server).launch_previews,
    messages: string[] = [];
  let pumps = 0,
    tick = 0;
  worker.pump = async () => void pumps++;
  const initial = settled(worker.preview(cwd)),
    job = worker.jobs[0];
  assert.equal(initial.accounts.length, count);
  assert.ok(Provider.all.every(p => initial.installed[p]));
  job.preview = initial;
  job.updated = now;
  job.queued = false;
  const subscription: launchService.Subscription = {
      cwd,
      preview: initial,
      checked: now,
      history_asked: false,
      history_epoch: 0n,
      history_sent: 0n,
    },
    client = {
      dead: false,
      output: Buffer.alloc(0),
      launch_preview: subscription,
      queue: (value: unknown) => messages.push(json.stringify(value) + "\n"),
    } as unknown as Client;
  if (scenario === "restored-pending") worker.jobs = [];
  const setupPumps = pumps;
  return {
    messages,
    subscription,
    worker,
    step() {
      now += 100;
      // Keep provider readings fresh without performing their unrelated I/O.
      const live = worker.jobs[0];
      if (live) live.updated = now;
      if (scenario === "equivalent-source" && tick % 50 === 0)
        live.preview = Object.assign(new Preview(), live.preview);
      if (scenario === "metadata-change" && tick === 20) listing(count, 1);
      if (scenario === "restored-pending" && tick === 40) {
        live.preview = settled(live.preview);
        live.queued = false;
      }
      const before = worker.jobs[0]?.preview;
      launchService.publish(server, client);
      tick++;
      return before === worker.jobs[0]?.preview;
    },
    pumps: () => pumps - setupPumps,
    close: () => launchService.stop(server),
  };
}
async function verify(count: number, scenario: Scenario) {
  const f = fixture(count, scenario),
    oldToJSON = Option.prototype.toJSON;
  let serializations = 0,
    reused = 0;
  Option.prototype.toJSON = function () {
    serializations++;
    return oldToJSON.call(this);
  };
  try {
    for (let tick = 0; tick < 120; tick++) reused += Number(f.step());
  } finally {
    Option.prototype.toJSON = oldToJSON;
  }
  try {
    assert.equal(f.messages.length, scenario === "metadata-change" ? 1 : scenario === "restored-pending" ? 2 : 0);
    if (scenario === "metadata-change") {
      assert.equal(f.subscription.preview.names.codex, "renamed");
      assert.equal(f.subscription.preview.pending, true);
      assert.equal(f.subscription.preview.options.codex.model.text(), "fixture-model-0");
    }
    if (scenario === "restored-pending") {
      const first = json.parse(f.messages[0]);
      assert.equal(first.preview.pending, true);
      assert.deepEqual(first.preview.options.codex.model, reading(0).model.toJSON());
      assert.equal(f.subscription.preview.pending, false);
      assert.equal(f.subscription.preview.accounts.length, count);
    }
    return {
      polls: 120,
      messages: f.messages,
      message_count: f.messages.length,
      message_bytes: f.messages.reduce((total, value) => total + Buffer.byteLength(value), 0),
      message_sha256: sha(f.messages.join("")),
      final_preview_sha256: sha(json.stringify(f.subscription.preview)),
      diagnostics: { option_serializations: serializations, reused_worker_source: reused, stub_pumps: f.pumps() },
    };
  } finally {
    await f.close();
  }
}
async function sample(count: number, scenario: "stable" | "equivalent-source") {
  const f = fixture(count, scenario);
  try {
    for (let index = 0; index < warmup; index++) f.step();
    const samples = [];
    for (let trial = 0; trial < trials; trial++) {
      const usage = process.cpuUsage(),
        start = performance.now();
      for (let index = 0; index < iterations; index++) f.step();
      const wall = performance.now() - start,
        cpu = process.cpuUsage(usage),
        cpuPerPoll = (cpu.user + cpu.system) / iterations;
      samples.push({
        trial,
        polls: iterations,
        cpu_us_per_poll: cpuPerPoll,
        wall_us_per_poll: (wall * 1000) / iterations,
        projected_single_core_percent_at_10hz: cpuPerPoll / 1000,
      });
    }
    assert.equal(f.messages.length, 0);
    return samples;
  } finally {
    await f.close();
  }
}

const release = await benchmark.acquire();
let created = false;
try {
  if (process.env.CORGI_TELEMETRY_DIR || process.env.CORGI_TELEMETRY_TRACE) throw Error("Disable telemetry");
  mkdirSync(fixtureRoot, { mode: 0o700 });
  created = true;
  mkdirSync(cwd);
  process.env.HOME = fixtureRoot;
  process.env.CORGI_ENV_BASE = fixtureRoot;
  process.env.XDG_STATE_HOME = fixtureRoot;
  process.env.XDG_CONFIG_HOME = fixtureRoot;
  process.env.CODEX_HOME = join(fixtureRoot, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(fixtureRoot, "claude");
  process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "pi");
  const executable = join(fixtureRoot, "provider-must-not-run");
  writeFileSync(executable, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  for (const provider of Provider.all) process.env[`CORGI_${provider.toUpperCase()}_BIN`] = executable;
  Date.now = () => now;
  const verification: Record<string, Awaited<ReturnType<typeof verify>>> = {},
    samples: Record<string, Awaited<ReturnType<typeof sample>>> = {};
  for (const count of [0, 8]) {
    for (const scenario of scenarios) verification[`${scenario}/${count}`] = await verify(count, scenario);
    if (!process.argv.includes("--verify-only"))
      for (const scenario of ["stable", "equivalent-source"] as const)
        samples[`${scenario}/${count}`] = await sample(count, scenario);
  }
  const sources = [
    "src/launch/preview.ts",
    "src/launch_service.ts",
    "src/accounts.ts",
    "src/json.ts",
    "tools/benchmarks/preview_costs.ts",
  ];
  console.log(
    JSON.stringify(
      {
        root,
        bun: Bun.version,
        sources: Object.fromEntries(sources.map(path => [path, sha(readFileSync(join(root, path)))])),
        native: Object.fromEntries(
          ["term", "system"].map(name => [
            name,
            {
              path: join(nativeRoot, `lib/libcorgi_${name}.${suffix}`),
              sha256: sha(readFileSync(join(nativeRoot, `lib/libcorgi_${name}.${suffix}`))),
            },
          ]),
        ),
        native_maps: readFileSync("/proc/self/maps", "utf8")
          .split("\n")
          .filter(line => line.includes("libcorgi_")),
        affinity: readFileSync("/proc/self/status", "utf8")
          .split("\n")
          .filter(line => /^(Cpus_allowed_list|Mems_allowed_list):/.test(line)),
        fixture: {
          cadence_ms: 100,
          warmup_polls: warmup,
          iterations,
          trials,
          extra_accounts: [0, 8],
          includes:
            "Real launch_service.publish, Worker.request/list, accounts.json stat/cache, account discovery cache expiration, executable install refresh every five simulated seconds; equivalent source replacement every fifty polls",
          excludes:
            "Provider I/O (pump stubbed), history subscription, socket writes, actual sleeping, fixture creation and metadata writes, serialization counters and exact-output checks; timing loop advances clock and reading freshness",
          clock:
            "Date.now advances 100 ms per poll; job.updated kept fresh to isolate completed readings. Projected CPU percent is per-poll cost times ten, not whole-daemon measurement",
          queue: "Captures real json.stringify plus newline; no messages are expected in timed stable/equivalent cases",
          allocations:
            "Source identity and Option.toJSON calls are diagnostic mechanism counts; no allocation-rate inference from RSS or retained heap",
        },
        verification,
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  Date.now = realClock;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  accounts.reset();
  if (created) rmSync(fixtureRoot, { recursive: true, force: true });
  await release();
}
