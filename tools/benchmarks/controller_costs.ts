/** Run the same file in frozen source trees under the exclusive CPU/NUMA slot.
 * Measures real Controller.compose + Differ.diff, including UI generation.
 */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { suffix } from "bun:ffi";
import { Controller } from "../../src/controller";
import { Frame } from "../../src/composition";
import { Differ } from "../../src/frame_diff";
import { transport } from "../../src/fixtures/transport";
import { nativeRoot } from "../../src/native_paths";
import { Terminal } from "../../src/pane/terminal";
import type { View as SurfaceView } from "../../src/pane/surface";
import * as corgiAnimation from "../../src/corgi_animation";
import * as sidebar from "../../src/sidebar";
import * as viewer from "../../src/viewer";
import * as benchmark from "./cpu_lock";

const root = resolve(import.meta.dir, "../.."),
  width = 160,
  height = 48,
  paneWidth = 132,
  paneHeight = 47,
  baseTime = 1792985000000,
  iterations = Number(process.env.CONTROLLER_ITERATIONS ?? 600),
  trials = Number(process.env.CONTROLLER_TRIALS ?? 5);
type Scenario = "spinner" | "awake" | "sleep" | "compacting" | "quiet" | "sparse" | "scroll";
const scenarios: Scenario[] = ["spinner", "awake", "sleep", "compacting", "quiet", "sparse", "scroll"];
let now = baseTime;
const realClock = Date.now;
function sha(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function corpus(scenario: Scenario): SurfaceView[] {
  const source = new Terminal(paneWidth, paneHeight),
    result: SurfaceView[] = [];
  try {
    source.feed("\x1b[?7l\x1b[H\x1b[38;2;120;180;220mA representative pane 界 é\x1b[0m\x1b[2;3H\x1b[?25h");
    for (let index = 0; index < 16; index++) {
      if (scenario === "sparse")
        source.feed(`\x1b[24;15H\x1b[36mprogress ${String(index).padStart(2, "0")}\x1b[0m\x1b[2;3H`);
      if (scenario === "scroll") {
        let bytes = "\x1b[H";
        for (let row = 0; row < paneHeight; row++)
          bytes +=
            `\x1b[${row + 1};1H\x1b[${row % 2 ? "36" : "32"}m` +
            `${String(row + index).padStart(4, "0")} src/retained.ts: details 界 é ` +
            "varied text abc 123 xyz ".repeat(4).slice(0, 84) +
            "\x1b[0m";
        source.feed(bytes + "\x1b[2;3H");
      }
      result.push(source.surface(1));
    }
    return result;
  } finally {
    source.destroy();
  }
}
function fixture(scenario: Scenario, inputs: SurfaceView[]) {
  now = baseTime;
  const ids = Array.from({ length: 16 }, (_, index) => index + 1);
  corgiAnimation.beginFrame();
  for (const id of ids) {
    const key = sidebar.animationKey(sidebar.entry({ target: { pane: id } })),
      presentation = corgiAnimation.observe(key, "asleep", now)!;
    // Reset each public presentation, including its private-to-the-viewer random sequence.
    Object.assign(presentation, new corgiAnimation.Presentation());
    presentation.playback.random = new corgiAnimation.Random(BigInt(id));
  }
  corgiAnimation.endFrame();
  const controller = new Controller(
    transport(async () => {
      throw Error("Unexpected benchmark transport");
    }),
  );
  controller.width = width;
  controller.height = height;
  controller.prefs.sidebar_width = 28;
  controller.prefs.corgi_intensity = scenario === "quiet" ? 0 : 50;
  controller.corgi_badge = "none";
  controller.review_summaries.want = () => {};
  controller.receiveSnapshot({
    workspaces: [
      {
        id: 1,
        name: "Representative repository",
        cwd: "",
        model: {
          nodes: ids.map(pane => ({ pane })),
          tabs: ids.map((id, root) => ({ id, root, title: `Agent ${id}` })),
          revision: 0,
        },
      },
    ],
    panes: ids.map(id => ({
      id,
      workspace: 1,
      tab: id,
      cols: paneWidth,
      rows: paneHeight,
      label: `Agent ${id}`,
      cwd: "",
      agent: {
        provider: id % 2 ? "claude" : "codex",
        state: scenario === "sleep" || scenario === "quiet" ? "idle" : "working",
        activity: scenario === "awake" ? "" : "Reading source files",
        compacting: scenario === "compacting",
        compacting_since: scenario === "compacting" ? baseTime * 1000 : 0,
        observation: { completed: 0, read: 0 },
      },
    })),
    conversations: [],
    headless_sessions: [],
  });
  const pane = controller.runtime.panes[0].terminal,
    differ = Differ.create(width, height);
  pane.receive(inputs[0]);
  let tick = 0;
  function step() {
    now = baseTime + tick * 75;
    if (scenario === "sparse" || scenario === "scroll") pane.receive(inputs[tick % inputs.length]);
    const frame = controller.compose();
    controller.dirty = false;
    if (!(frame instanceof Frame)) throw Error("Expected retained composition");
    const output = differ.diff(frame);
    tick++;
    return { frame, output };
  }
  return {
    controller,
    step,
    close() {
      differ.destroy();
      viewer.close(controller);
    },
  };
}
function verify(scenario: Scenario, inputs: SurfaceView[]) {
  const f = fixture(scenario, inputs),
    actual = new Terminal(width, height),
    expected = new Terminal(width, height),
    full = createHash("sha256"),
    output = createHash("sha256"),
    surface = createHash("sha256");
  let bytes = 0,
    frames = 0;
  try {
    for (let index = 0; index < 48; index++) {
      const current = f.step(),
        reference = current.frame.text();
      assert.equal(current.frame.panes.length, 1);
      const pane = current.frame.panes[0];
      assert.deepEqual([pane.x, pane.y, pane.w, pane.h], [28, 1, paneWidth, paneHeight]);
      expected.feed(reference);
      actual.feed(current.output);
      const value = actual.surface(0).surface;
      assert.deepEqual(value, expected.surface(0).surface, `${scenario}/${index}`);
      full.update(reference);
      output.update(current.output);
      surface.update(JSON.stringify(value));
      bytes += current.output.length;
      frames += Number(current.output.length > 0);
    }
    return {
      frames: 48,
      nonempty: frames,
      output_bytes: bytes,
      full_sha256: full.digest("hex"),
      output_sha256: output.digest("hex"),
      surface_sha256: surface.digest("hex"),
    };
  } finally {
    f.close();
    actual.destroy();
    expected.destroy();
  }
}
function sample(scenario: Scenario, inputs: SurfaceView[]) {
  const f = fixture(scenario, inputs);
  try {
    for (let index = 0; index < 200; index++) f.step();
    const samples = [];
    for (let trial = 0; trial < trials; trial++) {
      let bytes = 0,
        nonempty = 0;
      const usage = process.cpuUsage(),
        start = performance.now();
      for (let index = 0; index < iterations; index++) {
        const { output } = f.step();
        bytes += output.length;
        nonempty += Number(output.length > 0);
      }
      const wall = performance.now() - start,
        cpu = process.cpuUsage(usage);
      samples.push({
        cpu_us_per_frame: (cpu.user + cpu.system) / iterations,
        wall_us_per_frame: (wall * 1000) / iterations,
        output_bytes_per_frame: bytes / iterations,
        nonempty,
      });
    }
    return samples;
  } finally {
    f.close();
  }
}

const release = await benchmark.acquire();
try {
  if (process.env.CORGI_TELEMETRY_DIR) throw Error("Disable application telemetry for CPU trials");
  Date.now = () => now;
  const inputs = new Map(scenarios.map(scenario => [scenario, corpus(scenario)])),
    verification = Object.fromEntries(scenarios.map(scenario => [scenario, verify(scenario, inputs.get(scenario)!)])),
    samples = process.argv.includes("--verify-only")
      ? null
      : Object.fromEntries(scenarios.map(scenario => [scenario, sample(scenario, inputs.get(scenario)!)]));
  const sources = [
    "src/controller.ts",
    "src/composition.ts",
    "src/sidebar.ts",
    "src/sidebar_rows.ts",
    "src/render.ts",
    "src/mirror.ts",
    "src/frame_diff.ts",
    "src/viewer_native.ts",
    "tools/benchmarks/controller_costs.ts",
  ];
  process.stdout.write(
    JSON.stringify(
      {
        root,
        native: { path: nativeRoot, sha256: sha(readFileSync(join(nativeRoot, `lib/libcorgi_term.${suffix}`))) },
        sources: Object.fromEntries(sources.map(path => [path, sha(readFileSync(join(root, path)))])),
        process_status: readFileSync("/proc/self/status", "utf8")
          .split("\n")
          .filter(line => /^(Cpus_allowed_list|Mems_allowed_list):/.test(line)),
        topology: readFileSync("/proc/self/numa_maps", "utf8")
          .split("\n")
          .filter(line => line.includes(" heap "))
          .slice(0, 3),
        fixture: {
          width,
          height,
          agents: 16,
          cadence_ms: 75,
          iterations,
          trials,
          warmup_frames: 200,
          includes:
            "Controller.compose, real sidebar animation/UI generation, retained native diff and output buffer allocation; sparse/scroll also include Mirror.receive on predecoded surfaces",
          excludes:
            "daemon/provider work, PTY capture, RPC/JSON, stdout writes, timers, actual sleeping; surface corpus and exact verification are outside CPU trials",
          clock: "Date.now advances by 75ms per step; this is per-frame CPU, not a measured process CPU percentage",
          animation_seed:
            "Every fixture resets the 16 public Presentation objects and seeds their Random with the pane id",
        },
        verification,
        samples,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  Date.now = realClock;
  await release();
}
