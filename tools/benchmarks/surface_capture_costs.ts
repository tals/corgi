/** Live producer capture: frozen/reference DSO versus candidate, with unchanged wire format. */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dlopen, ptr, FFIType, type Pointer } from "bun:ffi";
import * as json from "../../src/json";
import * as surface from "../../src/pane/surface";
import * as benchmark from "./cpu_lock";

type Step = { feed?: string; command?: object; offset?: number | null; resize?: [number, number] };
type View = Parameters<typeof surface.view>[0];
type CacheStats = { formatted_rows: number; reused_rows: number; owned_bytes: number; capacity_bytes: number };
const spec = {
  terminal_new: { args: [], returns: "ptr" },
  terminal_free: { args: ["ptr"], returns: "void" },
  terminal_feed: { args: ["ptr", "ptr", "usize"], returns: "void" },
  terminal_resize: { args: ["ptr", "u16", "u16"], returns: "i32" },
  app_terminal_json: { args: ["ptr", "ptr", "usize", "ptr", "usize"], returns: FFIType.i64_fast },
} as const;
class Backend {
  library: ReturnType<typeof dlopen<typeof spec>>;
  statistics: ReturnType<
    typeof dlopen<{ terminal_surface_cache_stats: { args: ["ptr", "ptr"]; returns: "void" } }>
  > | null;
  constructor(
    readonly path: string,
    stats: boolean,
    readonly plain_surface = false,
    readonly normalize_surface = false,
  ) {
    this.library = dlopen(path, spec);
    this.statistics = stats
      ? dlopen(path, { terminal_surface_cache_stats: { args: ["ptr", "ptr"], returns: "void" } })
      : null;
  }
  close() {
    this.statistics?.close();
    this.library.close();
  }
}
class Terminal {
  handle: Pointer | bigint;
  private scratch = Buffer.allocUnsafe(65536);
  private counters = new BigUint64Array(4);
  offset: number | null = null;
  native_calls = 0;
  constructor(readonly backend: Backend) {
    const handle = backend.library.symbols.terminal_new();
    if (!handle) throw Error("TerminalCreateFailed");
    this.handle = handle;
    if (backend.library.symbols.terminal_resize(handle, 132, 47)) throw Error("ResizeFailed");
  }
  feed(value: string) {
    if (!value) return;
    const bytes = Buffer.from(value);
    this.backend.library.symbols.terminal_feed(this.handle, ptr(bytes), bytes.length);
  }
  call(request: object): Buffer {
    const input = Buffer.from(JSON.stringify(request));
    const invoke = (output: Buffer) => {
      this.native_calls++;
      return Number(
        this.backend.library.symbols.app_terminal_json(
          this.handle,
          ptr(input),
          input.length,
          ptr(output),
          output.length,
        ),
      );
    };
    let output = this.scratch;
    let size = invoke(output);
    if (size < -1) {
      if (-size > 64 * 1024 * 1024) throw Error("NativeMessageTooLarge");
      output = Buffer.allocUnsafe(-size);
      size = invoke(output);
    }
    if (size < 0) throw Error("NativeCaptureFailed");
    return output.subarray(0, size);
  }
  capture() {
    return this.call({ op: "surface", pane: 1, offset: this.offset });
  }
  apply(step: Step) {
    if (step.resize && this.backend.library.symbols.terminal_resize(this.handle, ...step.resize))
      throw Error("ResizeFailed");
    if (step.command) this.call(step.command);
    if (step.feed) this.feed(step.feed);
    if ("offset" in step) this.offset = step.offset ?? null;
  }
  stats(): CacheStats | null {
    if (!this.backend.statistics) return null;
    this.backend.statistics.symbols.terminal_surface_cache_stats(this.handle, ptr(this.counters));
    return {
      formatted_rows: Number(this.counters[0]),
      reused_rows: Number(this.counters[1]),
      owned_bytes: Number(this.counters[2]),
      capacity_bytes: Number(this.counters[3]),
    };
  }
  destroy() {
    this.backend.library.symbols.terminal_free(this.handle);
  }
}
const row = (value: string) => (value + ".".repeat(132)).slice(0, 132);
const initial =
  "\x1b[0m\x1b[2J" + Array.from({ length: 47 }, (_, y) => `\x1b[${y + 1};1H${row(`row ${y} `)}`).join("") + "\x1b[1;1H";
const fixtures = {
  unchanged: (_i: number): Step => ({}),
  modes: (i: number): Step => ({ feed: `\x1b[?2004${i % 2 ? "h" : "l"}` }),
  cursor: (i: number): Step => ({ feed: `\x1b[${i % 2 ? 1 : 47};2H` }),
  sparse: (i: number): Step => ({ feed: `\x1b[1;1H${row(`Working ${String(i % 32).padStart(4, "0")} `)}` }),
  scroll: (i: number): Step => ({
    feed: `\x1b[47;1H\r\n${row(`Working ${String(i % 32).padStart(4, "0")} `).slice(0, 130)}`,
  }),
  styled: (i: number): Step => ({
    feed: `\x1b[1;1H\x1b[38;2;${i % 2 ? 127 : 63};200;100m${row(`style ${i % 10} `)}\x1b[0m`,
  }),
  reverse: (i: number): Step => ({ feed: `\x1b[?5${i % 2 ? "h" : "l"}` }),
  autolink: (i: number): Step => ({
    feed: `\x1b[1;1H\x1b[2K界 e\u0301 https://example.com/${i % 10}\x1b[2;1H\x1b]8;id=explicit;https://example.com/target\x1b\\label\x1b]8;;\x1b\\`,
  }),
  synchronized: (i: number): Step => ({
    feed:
      i % 3 === 0 ? `\x1b[?2026h\x1b[1;1H${row(`hidden ${i % 10}`)}` : i % 3 === 1 ? "\x1b[2;1Hpending" : "\x1b[?2026l",
  }),
};
function value(bytes: Buffer, plain = false): View {
  const text = bytes.toString();
  const reply = (plain ? JSON.parse(text) : json.parse(text)) as { value?: View; err?: string };
  if (reply.err || !reply.value) throw Error(reply.err ?? "InvalidSurface");
  return reply.value;
}
function normalized(view: View) {
  const result = surface.view(view);
  return { ...result, stamp: { ...result.stamp, identity: 0n } };
}
function checks(backends: Backend[]) {
  const results = [];
  function frame(terminals: Terminal[], label: string) {
    const bytes = terminals.map(t => t.capture());
    const values = bytes.map((bytes, i) => value(bytes, backends[i].plain_surface));
    const views = values.map(normalized);
    assert.deepEqual(views[1], views[0], label);
    const wire = views.map(view => json.stringify(view));
    assert.equal(wire[1], wire[0], `${label}: canonical wire`);
    const capture_bytes = bytes.map(bytes => bytes.length);
    // Terminal identities are random u64s and may have different decimal lengths.
    const capture_bytes_normalized_identity = values.map(
      (view, i) => capture_bytes[i] - String(view.stamp.identity).length + 1,
    );
    if (backends[1].plain_surface) {
      assert.notEqual(typeof values[0].stamp.identity, "string", `${label}: reference stamp encoding`);
      assert.notEqual(typeof values[0].stamp.revision, "string", `${label}: reference stamp encoding`);
      assert.equal(typeof values[1].stamp.identity, "string", `${label}: candidate stamp encoding`);
      assert.equal(typeof values[1].stamp.revision, "string", `${label}: candidate stamp encoding`);
      assert.equal(
        capture_bytes_normalized_identity[1] - capture_bytes_normalized_identity[0],
        4,
        `${label}: two quoted stamp integers`,
      );
    }
    return {
      capture_bytes,
      capture_bytes_normalized_identity,
      wire_bytes: wire.map(value => Buffer.byteLength(value)),
      sha256: createHash("sha256").update(wire[0]).digest("hex"),
    };
  }
  for (const [name, fixture] of Object.entries(fixtures)) {
    const terminals = backends.map(b => new Terminal(b));
    try {
      for (const t of terminals) t.feed(initial);
      const frames = [];
      for (let i = 0; i < 40; i++) {
        for (const t of terminals) t.apply(fixture(i));
        frames.push(frame(terminals, `${name}/${i}`));
      }
      results.push({
        name,
        exact_views: frames.length,
        frame_sha256: frames.map(frame => frame.sha256),
        frame_bytes: frames.map(({ sha256: _hash, ...bytes }) => bytes),
        candidate_cache: terminals[1].stats(),
      });
    } finally {
      for (const t of terminals) t.destroy();
    }
  }
  const terminals = backends.map(b => new Terminal(b));
  try {
    for (const t of terminals) t.feed("history 界\r\n".repeat(80) + initial);
    const steps: Step[] = [
      { offset: 0 },
      { offset: null },
      { command: { op: "select", start_x: 0, start_y: 1, end_x: 8, end_y: 3 } },
      { command: { op: "clearSelection" } },
      { resize: [110, 42] },
      { resize: [132, 47] },
    ];
    const frames = [];
    for (const [i, step] of steps.entries()) {
      for (const t of terminals) t.apply(step);
      frames.push(frame(terminals, `viewport-selection-resize/${i}`));
    }
    results.push({
      name: "viewport-selection-resize",
      exact_views: steps.length,
      frame_sha256: frames.map(frame => frame.sha256),
      frame_bytes: frames.map(({ sha256: _hash, ...bytes }) => bytes),
      candidate_cache: terminals[1].stats(),
    });
  } finally {
    for (const t of terminals) t.destroy();
  }
  return results;
}
let sink = 0;
function trial(
  terminals: Terminal[],
  fixture: (i: number) => Step,
  stage: "capture_only" | "feed_capture_decode_reencode",
  milliseconds: number,
) {
  const before = terminals.map(t => t.stats());
  const started = performance.now();
  let operations = 0,
    cpu = 0,
    elapsed = 0,
    round = 0;
  while (performance.now() - started < milliseconds) {
    const step = fixture(round++);
    if (stage === "capture_only") for (const t of terminals) t.apply(step);
    const wall = performance.now(),
      usage = process.cpuUsage();
    for (const t of terminals) {
      if (stage !== "capture_only") t.apply(step);
      const bytes = t.capture();
      if (stage === "capture_only") sink ^= bytes.length;
      else {
        const view = value(bytes, t.backend.plain_surface);
        sink ^= Buffer.byteLength(json.stringify(t.backend.normalize_surface ? surface.view(view) : view));
      }
    }
    const delta = process.cpuUsage(usage);
    cpu += delta.user + delta.system;
    elapsed += (performance.now() - wall) * 1000;
    operations += terminals.length;
  }
  const after = terminals.map(t => t.stats());
  return {
    operations,
    cpu_us_per_capture: cpu / operations,
    wall_us_per_capture: elapsed / operations,
    cache: after[0]
      ? {
          formatted_rows_per_capture:
            after.reduce((n, v, i) => n + v!.formatted_rows - before[i]!.formatted_rows, 0) / operations,
          reused_rows_per_capture:
            after.reduce((n, v, i) => n + v!.reused_rows - before[i]!.reused_rows, 0) / operations,
          owned_bytes_per_terminal: after[0]!.owned_bytes,
          capacity_bytes_per_terminal: after[0]!.capacity_bytes,
        }
      : null,
  };
}
const release = await benchmark.acquire();
try {
  const verifyOnly = process.argv.includes("--verify");
  const plainSurface = process.argv.includes("--plain-surface");
  const paths = process.argv
    .slice(2)
    .filter(arg => arg !== "--verify" && arg !== "--plain-surface")
    .map(path => resolve(path));
  if (paths.length !== 2)
    throw Error("Usage: surface_capture_costs.ts REFERENCE_DSO CANDIDATE_DSO [--verify] [--plain-surface]");
  const backends = paths.map((path, i) => new Backend(path, i === 1, plainSurface && i === 1, plainSurface));
  try {
    const verified = checks(backends),
      results = [];
    for (const [name, fixture] of verifyOnly ? [] : Object.entries(fixtures)) {
      const worlds = backends.map(b => Array.from({ length: 8 }, () => new Terminal(b)));
      try {
        for (const world of worlds)
          for (const t of world) {
            t.feed(initial);
            t.capture();
          }
        for (const stage of ["capture_only", "feed_capture_decode_reencode"] as const) {
          for (const world of worlds) trial(world, fixture, stage, 50);
          const runs = [];
          for (let pass = 0; pass < 3; pass++)
            for (const index of pass % 2 ? [1, 0] : [0, 1]) {
              Bun.gc(true);
              runs.push({
                backend: index === 0 ? "reference" : "candidate",
                pass,
                ...trial(worlds[index], fixture, stage, 150),
              });
            }
          results.push({ name, stage, runs });
        }
      } finally {
        for (const world of worlds) for (const t of world) t.destroy();
      }
    }
    console.log(
      json.stringify({
        binaries: paths.map(path => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") })),
        dimensions: [132, 47],
        batch: 8,
        verified,
        results,
        sink,
        verify_only: verifyOnly,
        plain_surface: plainSurface,
        boundary: plainSurface
          ? {
              reference: "generic bigint reviver + production surface.view normalization + wire encoding",
              candidate: "plain JSON.parse + production surface.view normalization + wire encoding",
            }
          : {
              reference: "generic bigint reviver + wire encoding (original harness)",
              candidate: "generic bigint reviver + wire encoding (original harness)",
            },
        benchmark_sha256: createHash("sha256")
          .update(readFileSync(import.meta.path))
          .digest("hex"),
        limits: [
          "capture_only excludes producer feed but includes request Buffer/native JSON capture; feed_capture_decode_reencode includes feed and JS boundary conversions, not sockets/UI/agent services.",
          "All rows still travel on the unchanged full wire format. Cache bytes/capacity exclude caller snapshot copies, JSON and row descriptors.",
          "Three alternating trials per stage; process CPU includes Bun auxiliary threads. No hidden allocation rate is inferred from capacity.",
        ],
      }),
    );
  } finally {
    for (const backend of backends) backend.close();
  }
} finally {
  await release();
}
