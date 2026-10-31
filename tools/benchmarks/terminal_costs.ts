/** Terminal representation experiments; no daemon, PTY or production changes.
 * CORGI_NATIVE_ROOT=/path/to/baseline/native/zig-out bun tools/benchmarks/terminal_costs.ts --verify
 * The same command without --verify prints measured JSON. Run under taskset/numactl.
 */
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import * as json from "../../src/json";
import * as bridge from "../../src/native_bridge";
import * as mirror from "../../src/mirror";
import * as viewerNative from "../../src/viewer_native";
import { Terminal } from "../../src/pane/terminal";
import * as surface from "../../src/pane/surface";
import type { View } from "../../src/pane/surface";
import { Differ } from "../../src/frame_diff";
import * as benchmark from "./cpu_lock";
import * as replay from "./frame_sequences/replay";

const transport: mirror.Transport = {
  async request() {
    throw Error("No transport in terminal microbenchmark");
  },
};
const reset = "\x1b[?7l\x1b[H\x1b[0m\x1b[2J";
function cursor(view: View): string {
  const at = view.surface.cursor;
  return at ? `\x1b[${at.y + 1};${at.x + 1}H\x1b[?25h` : "\x1b[?25l";
}
function rows(view: View): string {
  return view.surface.lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join("");
}
function frame(view: View): string {
  return "\x1b[?2026h" + reset + rows(view) + cursor(view) + "\x1b[?2026l";
}

/** Retains the wire representation and creates a native mirror only on demand.
 * This prototype covers normal drawing and the dimmed/selection fallback.
 * Production integration must preserve the rest of mirror.Terminal's interface.
 */
class LazyMirror {
  private view: View | null = null;
  private native: mirror.Terminal | null = null;
  private installed: View | null = null;
  receive(view: View) {
    this.view = surface.view(view);
  }
  rows(): string {
    return rows(this.view!);
  }
  materialize(): mirror.Terminal {
    const view = this.view!;
    this.native ??= new mirror.Terminal(transport, view.surface.pane, view.surface.cols, view.surface.rows);
    if (this.installed !== view) {
      this.native.receive(view);
      this.installed = view;
    }
    return this.native;
  }
  destroy() {
    this.native?.destroy();
  }
}

/** Whole rows are already independently styled and padded by surface.capture.
 * Comparing them avoids reconstructing a Ghostty terminal to discover changes.
 */
class RowDiffer {
  private previous: View | null = null;
  diff(view: View): Buffer {
    const previous = this.previous;
    const changed =
      !previous || previous.surface.cols !== view.surface.cols || previous.surface.rows !== view.surface.rows;
    let out = changed ? reset : "";
    for (let row = 0; row < view.surface.lines.length; row++) {
      const line = view.surface.lines[row];
      if (changed || line !== previous!.surface.lines[row]) out += `\x1b[${row + 1};1H${line}`;
    }
    if (out || !previous || cursor(previous) !== cursor(view)) out += cursor(view);
    this.previous = view;
    return Buffer.from(out ? "\x1b[?2026h" + out + "\x1b[?2026l" : "");
  }
}

/** Same existing native operation; keep JSON bytes opaque through the Bun relay.
 * Output owns its bytes, just like Client.queue's serialized Buffer.
 */
class RawSurface {
  private request = Buffer.from('{"op":"surface","pane":1,"offset":null}');
  private buffer = Buffer.allocUnsafe(65536);
  constructor(private source: Terminal) {}
  capture(): Buffer {
    const invoke = () =>
      Number(
        bridge.symbols.app_terminal_json(
          this.source.handle,
          bridge.ptr(this.request),
          this.request.length,
          bridge.ptr(this.buffer),
          this.buffer.length,
        ),
      );
    let length = invoke();
    if (length < -1) {
      if (-length > 64 * 1024 * 1024) throw Error("NativeMessageTooLarge");
      this.buffer = Buffer.allocUnsafe(-length);
      length = invoke();
    }
    if (length < 0 || this.buffer.toString("utf8", 0, 9) !== '{"value":') throw Error("NativeOperationFailed");
    return Buffer.from(this.buffer.subarray(9, length - 1));
  }
}

interface Corpus {
  name: string;
  cols: number;
  rows: number;
  source: Terminal;
  views: View[];
  frames: Buffer[];
  updates: Buffer[];
  raw: RawSurface;
  sourceBytes: number;
}
async function corpus(name: string): Promise<Corpus> {
  const synthetic = /^(grid|scroll)-(\d+)x(\d+)$/.exec(name);
  const sequence = synthetic
    ? { cols: Number(synthetic[2]), rows: Number(synthetic[3]), frames: [] as { frame: string }[] }
    : await replay.load(name);
  const source = Terminal.create(sequence.cols, sequence.rows);
  const views: View[] = [];
  if (synthetic) {
    let initial = reset;
    for (let row = 0; row < sequence.rows; row++) {
      const line = (`row ${row} ` + ".".repeat(sequence.cols)).slice(0, sequence.cols);
      initial += `\x1b[${row + 1};1H${line}`;
    }
    source.feed(initial + `\x1b[${sequence.rows};1H`);
    for (let i = 0; i < 32; i++) {
      const content =
        synthetic[1] === "scroll"
          ? `\r\nWorking (esc to interrupt) ${i} ${".".repeat(100)}`
          : `\x1b[2;2H${i % 10}\x1b[?2004${i % 2 ? "h" : "l"}`;
      sequence.frames.push({ frame: content });
    }
  }
  for (const { frame: content } of sequence.frames) {
    source.feed(content);
    views.push(source.surface(1));
  }
  return {
    name,
    cols: sequence.cols,
    rows: sequence.rows,
    source,
    views,
    frames: views.map(view => Buffer.from(frame(view))),
    updates: sequence.frames.map(value => Buffer.from(value.frame)),
    raw: new RawSurface(source),
    sourceBytes: sequence.frames.reduce((sum, value) => sum + Buffer.byteLength(value.frame), 0),
  };
}
function verify(c: Corpus) {
  const eager = new mirror.Terminal(transport, 1, c.cols, c.rows);
  const lazy = new LazyMirror();
  const whole = Terminal.create(c.cols, c.rows);
  const cells = Terminal.create(c.cols, c.rows);
  const rowScreen = Terminal.create(c.cols, c.rows);
  const diff = Differ.create(c.cols, c.rows);
  const rowDiff = new RowDiffer();
  let cellBytes = 0,
    rowBytes = 0;
  try {
    assert.deepEqual(json.parse(c.raw.capture().toString()), json.parse(json.stringify(c.source.surface(1))));
    for (let i = 0; i < c.views.length; i++) {
      const view = c.views[i];
      eager.receive(view);
      lazy.receive(view);
      assert.equal(lazy.rows(), eager.rows(1, 0, 0, c.cols, c.rows, false, null), `${c.name}/${i}: normal rows`);
      assert.deepEqual(eager.cursor(), view.surface.cursor, `${c.name}/${i}: cursor`);
      assert.equal(eager.bracketedPaste(), view.modes.bracketed_paste);
      assert.equal(eager.pasteEvents(), view.modes.paste_events);
      if (i % 7 === 0) {
        const materialized = lazy.materialize();
        assert.equal(
          materialized.rows(1, 0, 0, c.cols, c.rows, true, null),
          eager.rows(1, 0, 0, c.cols, c.rows, true, null),
          `${c.name}/${i}: dim fallback`,
        );
        assert.deepEqual(materialized.hyperlinks(), eager.hyperlinks());
        materialized.select(0, 0, 3, 0);
        eager.select(0, 0, 3, 0);
        assert.equal(materialized.selectedText(), eager.selectedText());
        assert.equal(
          materialized.rows(1, 0, 0, c.cols, c.rows, false, null),
          eager.rows(1, 0, 0, c.cols, c.rows, false, null),
        );
        materialized.clearSelection();
        eager.clearSelection();
      }
      const cellOutput = diff.diff(c.frames[i]);
      const rowOutput = rowDiff.diff(view);
      cellBytes += cellOutput.length;
      rowBytes += rowOutput.length;
      whole.feed(c.frames[i]);
      cells.feed(cellOutput);
      rowScreen.feed(rowOutput);
      assert.deepEqual(cells.snapshot(), whole.snapshot(), `${c.name}/${i}: cell diff`);
      assert.deepEqual(rowScreen.snapshot(), whole.snapshot(), `${c.name}/${i}: row diff`);
      const expectedCursor = whole.surface(1).surface.cursor;
      assert.deepEqual(cells.surface(1).surface.cursor, expectedCursor);
      assert.deepEqual(rowScreen.surface(1).surface.cursor, expectedCursor);
      assert.equal(diff.diff(c.frames[i]).length, 0);
      assert.equal(rowDiff.diff(view).length, 0);
    }
    return { frames: c.views.length, cell_diff_bytes: cellBytes, row_diff_bytes: rowBytes };
  } finally {
    eager.destroy();
    lazy.destroy();
    whole.destroy();
    cells.destroy();
    rowScreen.destroy();
    diff.destroy();
  }
}

let sink = 0;
function trial(operation: (index: number) => number, milliseconds: number) {
  const start = performance.now();
  const usage = process.cpuUsage();
  let operations = 0;
  do {
    for (let batch = 0; batch < 32; batch++) sink ^= operation(operations++);
  } while (performance.now() - start < milliseconds);
  const cpu = process.cpuUsage(usage);
  return {
    operations,
    wall_us: ((performance.now() - start) * 1000) / operations,
    cpu_us: (cpu.user + cpu.system) / operations,
  };
}
function graph(view: View) {
  let objects = 0,
    strings = 0,
    stringBytes = 0;
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      strings++;
      stringBytes += Buffer.byteLength(value);
    } else if (value && typeof value === "object") {
      objects++;
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(view);
  return { objects, strings, string_bytes: stringBytes };
}
function measure(c: Corpus, check: ReturnType<typeof verify>) {
  const eager = new mirror.Terminal(transport, 1, c.cols, c.rows);
  const lazy = new LazyMirror();
  const diff = Differ.create(c.cols, c.rows);
  const rowDiff = new RowDiffer();
  const wire = c.views.map(view => json.stringify(view));
  const native = Terminal.create(c.cols, c.rows);
  const pty = Terminal.create(c.cols, c.rows);
  const methods = {
    pty_feed: (i: number) => {
      const update = c.updates[i % c.updates.length];
      pty.feed(update);
      return update.length;
    },
    daemon_capture_reserialize: () => Buffer.from(json.stringify(c.source.surface(1))).length,
    daemon_capture_opaque_relay: () => c.raw.capture().length,
    viewer_wire_parse: (i: number) => (json.parse(wire[i % wire.length]) as View).surface.lines.length,
    viewer_receive_render: (i: number) => {
      eager.receive(c.views[i % c.views.length]);
      return eager.rows(1, 0, 0, c.cols, c.rows, false, null).length;
    },
    viewer_lazy_receive_render: (i: number) => {
      lazy.receive(c.views[i % c.views.length]);
      return lazy.rows().length;
    },
    viewer_native_receive: (i: number) => {
      viewerNative.receive(native.handle, wire[i % wire.length]);
      viewerNative.updateRender(native.handle);
      return 1;
    },
    viewer_ansi_replay: (i: number) => {
      native.feed(c.frames[i % c.frames.length]);
      viewerNative.updateRender(native.handle);
      return 1;
    },
    host_cell_diff: (i: number) => diff.diff(c.frames[i % c.frames.length]).length,
    host_row_diff: (i: number) => rowDiff.diff(c.views[i % c.views.length]).length,
  };
  const results: Record<string, ReturnType<typeof trial>[]> = {};
  const names = Object.keys(methods) as (keyof typeof methods)[];
  try {
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
    return {
      name: c.name,
      cols: c.cols,
      rows: c.rows,
      verification: check,
      input_frame_bytes: c.frames.reduce((sum, value) => sum + value.length, 0),
      source_update_bytes: c.sourceBytes,
      surface_json_bytes: wire.reduce((sum, value) => sum + Buffer.byteLength(value), 0),
      representative_export_bytes: c.raw.capture().length,
      representative_object_graph: graph(c.views.at(-1)!),
      trials: results,
    };
  } finally {
    eager.destroy();
    lazy.destroy();
    native.destroy();
    pty.destroy();
    diff.destroy();
  }
}

const release = await benchmark.acquire();
try {
  if (process.env.CORGI_TELEMETRY_DIR) throw Error("Run terminal timings with telemetry disabled");
  const root = resolve(import.meta.dir, "../..");
  const inputs = [
    import.meta.path,
    `${bridge.nativeRoot}/lib/libcorgi_term.so`,
    ...["mirror.ts", "native_bridge.ts", "viewer_native.ts", "pane/terminal.ts", "frame_diff.ts", "telemetry.ts"].map(
      name => `${root}/src/${name}`,
    ),
  ];
  const hashes = Object.fromEntries(
    inputs.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
  const checkOnly = process.argv.includes("--verify");
  const names = process.argv.slice(2).filter(arg => arg !== "--verify");
  const results = [];
  for (const name of names.length
    ? names
    : [...replay.names(), "grid-80x24", "grid-160x48", "grid-320x96", "scroll-132x47"]) {
    const c = await corpus(name);
    try {
      const verified = verify(c);
      results.push(checkOnly ? { name, ...verified } : measure(c, verified));
    } finally {
      c.source.destroy();
    }
  }
  console.log(
    JSON.stringify(
      {
        baseline: "fb129d2ef96511a3c727112e0d1df2191bb5b241",
        source_variant: "working tree with default-disabled telemetry instrumentation",
        native_root: bridge.nativeRoot,
        input_sha256: hashes,
        bun: Bun.version,
        cpu_affinity: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],
        measured_at: new Date().toISOString(),
        check_only: checkOnly,
        notes: [
          "Synchronous stage microbenchmarks; no socket, PTY, daemon scheduling, provider or UI composition cost.",
          "Export uses the last corpus screen with current native render state, excluding PTY feed and dirty render updates.",
          "The native library is baseline PR15; TypeScript wrappers include disabled telemetry hooks, not byte-exact PR15 source.",
          "Receive and diff cycle every corpus frame, including transition from last back to first.",
          "pty_feed parses original fixture updates only; viewer_ansi_replay isolates precomposed ANSI replay/render, excluding JSON, row assembly and modes.",
          "Lazy mirror covers normal rows; dimming, links and selection materialize existing native mirror on demand.",
          "Row diff supports complete text surfaces only; overlays, image placement and partial pane clipping are outside scope.",
          "Object graph is a materialization inventory, not an allocator or GC measurement. RSS is not reported as allocations.",
          "Each method warms 50ms, then five 150ms trials reversing order; forced GC is outside each trial.",
          "CPU time includes all Bun threads and natural collection within a trial. Stages overlap and must not be summed blindly.",
        ],
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
