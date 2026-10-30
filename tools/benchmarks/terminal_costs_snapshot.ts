/** Normal recovery snapshot boundary; liveSnapshot is deliberately not equivalent.
 * CORGI_NATIVE_ROOT=/path/to/baseline/native/zig-out bun tools/benchmarks/terminal_costs_snapshot.ts --verify
 * Without --verify, runs serialized microbenchmarks; use numactl and the global lock.
 */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as binary from "../../src/base64";
import * as bridge from "../../src/native_bridge";
import * as json from "../../src/json";
import { Terminal } from "../../src/pane/terminal";
import * as benchmark from "./cpu_lock";

type SnapshotValue = string | number[];
type Parser = (value: string) => { value: SnapshotValue; err?: string };

/** Keeps the existing snapshot formatter and JSON wire format. Large replies
 * retain capacity instead of formatting twice on every subsequent snapshot.
 */
class SnapshotReply {
  private buffer: Buffer;
  calls = 0;
  bytes = 0;
  constructor(capacity = 65536) {
    this.buffer = Buffer.allocUnsafe(capacity);
  }
  wire(source: Terminal): string {
    // Match the existing request encoding so capacity and parsing are isolated.
    const input = Buffer.from(json.stringify({ op: "snapshot" }));
    const invoke = () => {
      this.calls++;
      return Number(
        bridge.symbols.app_terminal_json(
          source.handle,
          bridge.ptr(input),
          input.length,
          bridge.ptr(this.buffer),
          this.buffer.length,
        ),
      );
    };
    let length = invoke();
    if (length < -1) {
      if (-length > 64 * 1024 * 1024) throw Error("NativeMessageTooLarge");
      this.buffer = Buffer.allocUnsafe(-length);
      length = invoke();
    }
    if (length < 0) throw Error("NativeOperationFailed");
    this.bytes = length;
    return this.buffer.toString("utf8", 0, length);
  }
  value(source: Terminal, parse: Parser): SnapshotValue {
    const result = parse(this.wire(source));
    if (result.err) throw Error(result.err);
    return result.value;
  }
}

function snapshotBytes(value: SnapshotValue): Buffer {
  // Zig normally emits UTF-8 []u8 as a JSON string; invalid UTF-8 can use an array.
  return typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
}

interface Fixture {
  name: string;
  panes: Terminal[];
  source_bytes: number;
  source_lines_per_pane: number;
}

function fixture(lines: number): Fixture {
  const panes: Terminal[] = [];
  let sourceBytes = 0;
  try {
    for (let pane = 0; pane < 16; pane++) {
      // One visible pane and fifteen hidden panes, matching the default harness.
      const source = Terminal.create(pane === 0 ? 132 : 80, pane === 0 ? 47 : 24);
      panes.push(source);
      let content = `pane ${pane} ready\r\n`;
      for (let line = 0; line < lines; line++)
        content += (`Working (esc to interrupt) pane ${pane} line ${line} ` + ".".repeat(130)).slice(0, 130) + "\r\n";
      sourceBytes += Buffer.byteLength(content);
      source.feed(content);
    }
    return { name: `mixed-16-panes-${lines}-lines`, panes, source_bytes: sourceBytes, source_lines_per_pane: lines };
  } catch (error) {
    for (const pane of panes) pane.destroy();
    throw error;
  }
}

function verifyOne(source: Terminal) {
  const expected = source.snapshot();
  const reply = new SnapshotReply(32);
  const wire = reply.wire(source);
  const value = JSON.parse(wire).value as SnapshotValue;
  assert.ok(typeof value === "string" || Array.isArray(value));
  if (Array.isArray(value)) assert.ok(value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255));
  assert.deepEqual(snapshotBytes(value), expected);
  assert.equal(source.snapshotBase64(), binary.encode(expected));
  assert.deepEqual(snapshotBytes(reply.value(source, json.parse)), expected);
  assert.deepEqual(snapshotBytes(reply.value(source, JSON.parse)), expected);
  assert.equal(snapshotBytes(reply.value(source, JSON.parse)).toString("base64"), binary.encode(expected));
  const before = reply.calls;
  assert.deepEqual(snapshotBytes(reply.value(source, JSON.parse)), expected);
  assert.equal(reply.calls - before, 1);
  return {
    cols: source.cols,
    rows: source.rows,
    snapshot_bytes: expected.length,
    snapshot_sha256: createHash("sha256").update(expected).digest("hex"),
    json_bytes: Buffer.byteLength(wire),
    json_value_type: typeof value === "string" ? "string" : "number_array",
    baseline_native_calls: Buffer.byteLength(wire) > 65536 ? 2 : 1,
    retained_native_calls: 1,
    wire,
  };
}

function semanticChecks() {
  let colored = "";
  for (let row = 0; row < 47; row++) {
    colored += `\x1b[${row + 1};1H`;
    for (let col = 0; col < 132; col++) colored += `\x1b[38;2;${col % 256};${row};${(col * 3) % 256}mX`;
  }
  const cases = [
    { name: "empty", cols: 30, rows: 4, content: "" },
    {
      name: "unicode-style-link",
      cols: 30,
      rows: 4,
      content: "\x1b[38;2;10;20;30m漢字 e\u0301 🦊\x1b[0m\r\n\x1b]8;;https://example.com\x1b\\linked\x1b]8;;\x1b\\",
    },
    {
      name: "alternate-modes",
      cols: 30,
      rows: 4,
      content: "EARLY_HISTORY\r\n1\r\n2\r\n3\r\n4\r\n5\r\n\x1b[?1049h\x1b[?1000h\x1b[?2004h\x1b[31mALT_OUTPUT\x1b[",
    },
    { name: "large-colored-correctness-only", cols: 132, rows: 47, content: colored },
  ];
  return cases.map(({ name, cols, rows, content }) => {
    const source = Terminal.create(cols, rows);
    const restored = Terminal.create(cols, rows);
    try {
      source.feed(content);
      const { wire: _wire, ...check } = verifyOne(source);
      if (name === "large-colored-correctness-only") assert.ok(check.json_bytes > 65536);
      const reply = new SnapshotReply();
      restored.feed(snapshotBytes(reply.value(source, JSON.parse)));
      if (name === "alternate-modes") {
        restored.feed("\x1b[0m\r\nNEW_SHELL");
        const info = restored.native({ op: "info" });
        assert.equal(info.active_screen, "primary");
        assert.equal(info.modes.mouse_event, "none");
        assert.equal(info.modes.bracketed_paste, false);
        for (const word of ["EARLY_HISTORY", "ALT_OUTPUT", "NEW_SHELL"])
          assert.notEqual(restored.search(word).offset, null);
      }
      return { name, ...check };
    } finally {
      source.destroy();
      restored.destroy();
    }
  });
}

let sink = 0;
function trial(operation: () => number, milliseconds: number) {
  const start = performance.now();
  const usage = process.cpuUsage();
  let operations = 0;
  do {
    sink ^= operation();
    operations++;
  } while (performance.now() - start < milliseconds);
  const cpu = process.cpuUsage(usage);
  return {
    operations,
    wall_us_per_16_panes: ((performance.now() - start) * 1000) / operations,
    cpu_us_per_16_panes: (cpu.user + cpu.system) / operations,
  };
}

function measure(fixture: Fixture, wire: string[]) {
  const generic = new SnapshotReply();
  const plain = new SnapshotReply();
  const fused = new SnapshotReply();
  const all = (capture: (source: Terminal) => string) => () => {
    let bytes = 0;
    for (const pane of fixture.panes) bytes += capture(pane).length;
    return bytes;
  };
  const parseOnly = (parse: Parser) => () => {
    let bytes = 0;
    for (const text of wire) bytes += binary.encode(snapshotBytes(parse(text).value)).length;
    return bytes;
  };
  const methods = {
    legacy_json_snapshot_base64: all(source => binary.encode(Buffer.from(source.native({ op: "snapshot" })))),
    raw_snapshot_base64: all(source => source.snapshotBase64()),
    raw_snapshot_owned_buffer_base64: all(source => binary.encode(source.snapshot())),
    retained_reply_generic_parse_base64: all(source => binary.encode(snapshotBytes(generic.value(source, json.parse)))),
    retained_reply_plain_parse_base64: all(source => binary.encode(snapshotBytes(plain.value(source, JSON.parse)))),
    retained_reply_plain_parse_direct_base64: all(source =>
      snapshotBytes(fused.value(source, JSON.parse)).toString("base64"),
    ),
    prepared_json_generic_parse_base64: parseOnly(json.parse),
    prepared_json_plain_parse_base64: parseOnly(JSON.parse),
  };
  const names = Object.keys(methods) as (keyof typeof methods)[];
  const results: Record<string, ReturnType<typeof trial>[]> = {};
  for (const name of names) {
    results[name] = [];
    trial(methods[name], 50);
  }
  for (let pass = 0; pass < 5; pass++) {
    for (const name of pass % 2 ? names.toReversed() : names) {
      Bun.gc(true);
      results[name].push(trial(methods[name], 150));
    }
  }
  return results;
}

const release = await benchmark.acquire();
try {
  if (process.env.CORGI_TELEMETRY_DIR) throw Error("Run snapshot timings with telemetry disabled");
  const checkOnly = process.argv.includes("--verify");
  const checks = semanticChecks();
  const results = [];
  for (const lines of [0, 64, 512, 4096]) {
    const f = fixture(lines);
    try {
      const verified = f.panes.map(verifyOne);
      const wire = verified.map(item => item.wire);
      results.push({
        name: f.name,
        source_bytes: f.source_bytes,
        source_lines_per_pane: f.source_lines_per_pane,
        panes: verified.map(({ wire: _wire, ...rest }) => rest),
        trials: checkOnly ? null : measure(f, wire),
      });
    } finally {
      for (const pane of f.panes) pane.destroy();
    }
  }
  const root = resolve(import.meta.dir, "../..");
  const inputs = [
    import.meta.path,
    `${bridge.nativeRoot}/lib/libcorgi_term.so`,
    ...["base64.ts", "json.ts", "native_bridge.ts", "pane/terminal.ts", "telemetry.ts"].map(
      name => `${root}/src/${name}`,
    ),
  ];
  console.log(
    JSON.stringify(
      {
        baseline: "fb129d2ef96511a3c727112e0d1df2191bb5b241",
        source_variant: "raw recovery snapshot boundary with default-disabled telemetry instrumentation",
        native_root: bridge.nativeRoot,
        input_sha256: Object.fromEntries(
          inputs.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
        ),
        bun: Bun.version,
        cpu_affinity: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],
        measured_at: new Date().toISOString(),
        check_only: checkOnly,
        notes: [
          "Normal recovery snapshot only; terminal_snapshot/liveSnapshot has different semantics and is not used.",
          "One operation snapshots and base64-encodes sixteen panes: one 132x47 and fifteen 80x24.",
          "Fixtures feed increasing output, but retained scrollback is bounded by the production terminal configuration; snapshot byte sizes show actual retention after page pruning.",
          "Prepared-JSON methods isolate parsing/byte conversion/base64 and overlap the complete methods; do not add them.",
          "Retained capacity and parse alternatives preserve exact snapshot bytes and checkpoint base64 data; known envelope has no 64-bit integers.",
          "Direct base64 removes base64.encode's extra Buffer.from copy without changing checkpoint output.",
          "Raw snapshot base64 reads the existing formatter's owned bytes synchronously and frees them immediately; it bypasses native JSON encoding, parsing, retry formatting and intermediate UTF-8 copies.",
          "Repeated unchanged terminals isolate snapshot work; fixture feeding is outside timing. No durable-state copy, metadata, JSON checkpoint serialization or disk write is included.",
          "Each method warms 50ms then has five 150ms trials, reversing order. Forced GC occurs outside each trial; CPU includes all process threads.",
          "Modeled saving at 0.5 saves/s is per-sixteen-pane saved CPU us*0.5/10000 percentage points; this is an estimate, not an application upper bound.",
        ],
        semantic_checks: checks,
        sink,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await release();
}
