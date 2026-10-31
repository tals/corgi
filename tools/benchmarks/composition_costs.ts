/** Real Corgi chrome plus retained panes; run under numactl with the CPU slot.
 * bun tools/benchmarks/composition_costs.ts > dist/composition-costs.json
 * Fixture generation, exact surface checks and phase clocks are outside CPU trials.
 */
import { dlopen, FFIType, ptr, suffix, type Pointer } from "bun:ffi";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Frame, cursorBytes } from "../../src/composition";
import { Model, Selection, View } from "../../src/layout";
import * as mirror from "../../src/mirror";
import { stringify } from "../../src/json";
import { nativeRoot } from "../../src/native_paths";
import * as palette from "../../src/palette";
import { Terminal } from "../../src/pane/terminal";
import type { View as SurfaceView } from "../../src/pane/surface";
import * as render from "../../src/render";
import * as sidebar from "../../src/sidebar";
import { displayWidth } from "../../src/text";
import * as viewerNative from "../../src/viewer_native";
import * as benchmark from "./cpu_lock";

const root = resolve(import.meta.dir, "../.."),
  frozenHash = "3a9a86b9e5658b3ba043faba81847e1ec998311b51ba783880bfb2e959c3245b",
  frozenPath =
    "/tmp/corgi-native-1000/5bbdc473ccc1b2251b3cddc55c0410685a21bb1bbc4a60f6f0fd5729983046ea/lib/libcorgi_term.so",
  width = 160,
  height = 48,
  paneWidth = 132,
  paneHeight = 47,
  count = 16;
const transport: mirror.Transport = {
  async request() {
    throw Error("No transport in composition microbenchmark");
  },
};
function sha(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function fullLibrary(path: string) {
  return dlopen(path, {
    frame_diff_new: { args: ["u16", "u16"], returns: "ptr" },
    frame_diff_free: { args: ["ptr"], returns: "void" },
    frame_diff_diff: { args: ["ptr", "ptr", "usize"], returns: FFIType.i64_fast },
    frame_diff_take: { args: ["ptr", "ptr", "usize"], returns: FFIType.i64_fast },
    terminal_new: { args: [], returns: "ptr" },
    terminal_resize: { args: ["ptr", "u16", "u16"], returns: "i32" },
    terminal_free: { args: ["ptr"], returns: "void" },
    viewer_receive: { args: ["ptr", "ptr", "usize"], returns: "i32" },
    viewer_update_render: { args: ["ptr"], returns: "i32" },
  });
}
function composedLibrary(path: string) {
  return dlopen(path, {
    frame_diff_compose: {
      args: ["ptr", "ptr", "usize", "ptr", "ptr", "usize", "u16", "u16", "bool", "u8"],
      returns: FFIType.i64_fast,
    },
    frame_diff_timing_enable: { args: ["ptr", "bool"], returns: "void" },
    frame_diff_timing: { args: ["ptr", "ptr"], returns: "void" },
    frame_diff_stats: { args: ["ptr", "ptr"], returns: "void" },
  });
}
type Full = ReturnType<typeof fullLibrary>["symbols"];
type Composed = ReturnType<typeof composedLibrary>["symbols"];
interface Input {
  view: SurfaceView;
  frame: Frame;
  full: Buffer;
  chrome: Buffer;
  handles: BigUint64Array;
  rects: Uint16Array;
}
type Workload = "idle" | "cursor-only" | "sparse" | "scroll" | "styled-scroll" | "diverse-scroll";
function diverseLine(sequence: number) {
  const vocabulary = "const value = resolve(index + 17); return parse(input) / cache[key]; ";
  let line = `line ${sequence}: `,
    column = displayWidth(line);
  while (column < paneWidth) {
    const token =
      column % 31 === 0
        ? "é"
        : column % 23 === 0
          ? "界"
          : column % 19 === 0
            ? "🐕"
            : vocabulary[(column + sequence) % vocabulary.length];
    const cells = displayWidth(token);
    if (column + cells > paneWidth) break;
    line += token;
    column += cells;
  }
  return line;
}
function fixture(name: Workload, changingChrome = true) {
  const model = new Model(),
    selection = new Selection(),
    id = model.newTab("composition costs"),
    source = new Terminal(paneWidth, paneHeight),
    terminals: mirror.Terminal[] = [],
    inputs: Input[] = [];
  selection.reconcile(model);
  const layout = new View(model, selection),
    clock = Date.now;
  try {
    const line = (sequence: number) => {
      const style =
        name === "styled-scroll" || name === "diverse-scroll" ? palette.fg(sequence % 2 ? "muted" : "accent") : "";
      const value =
        name === "diverse-scroll" ? diverseLine(sequence) : `Working (esc to interrupt) ${sequence} ${".".repeat(100)}`;
      return style + value + "\x1b[0m";
    };
    let initial = "\x1b[?7l\x1b[?25h\x1b[0m\x1b[2J\x1b[H";
    for (let row = 0; row < paneHeight; row++) initial += `\x1b[${row + 1};1H${line(1000 + row)}`;
    source.feed(initial + "\x1b[47;1H");
    for (let index = 0; index < count; index++) {
      if (index > 0) {
        if (name === "sparse") source.feed(`\x1b[1;1H${line(1000 + index)}\x1b[47;1H`);
        else if (name === "cursor-only") source.feed(`\x1b[47;${index + 1}H`);
        else if (name !== "idle") source.feed(`\x1b[1S\x1b[47;1H${line(1000 + index + paneHeight - 1)}\x1b[47;1H`);
      }
      const view = source.surface(id);
      const terminal = new mirror.Terminal(transport, id, paneWidth, paneHeight);
      terminals.push(terminal);
      terminal.receive(view);
      const pane: mirror.Pane = {
        binding: 1n,
        id,
        label: "",
        cwd: "/benchmark/corgi",
        command: "claude",
        brand: "claude",
        agent: mirror.agent({ provider: "claude", state: "working" }),
        account: "",
        restoring: "",
        forking: false,
        dormant: false,
        restoring_since: 0,
        terminal,
      };
      model.tabs[0].rename(`Streaming task ${(changingChrome ? index : 0).toString().padStart(2, "0")}`);
      const ui = render.ui({
        message: "",
        copy_mode: false,
        sidebar_open: true,
        agents: Array.from({ length: 16 }, (_, agent) =>
          sidebar.entry({
            target: { pane: agent + 1 },
            provider: agent % 2 ? "codex" : "claude",
            name: `Agent ${agent + 1}${agent === 0 ? ` / ${changingChrome ? index : 0}` : ""}`,
            activity: "Working",
            state: "working",
            focused: agent === 0,
            cwd: "/benchmark/corgi",
          }),
        ),
        workspaces: [
          sidebar.workspaceEntry({
            id: 1,
            name: "Corgi",
            cwd: "/benchmark/corgi",
            active: true,
            agents: 16,
            working: 16,
          }),
        ],
      });
      ui.prefs.sidebar_width = 28;
      ui.prefs.corgi_intensity = 50;
      Date.now = () => 1792985000000 + (changingChrome ? index * 100 : 0);
      const frame = new Frame();
      frame.finish(render.frame(layout, [pane], width, height, ui, frame));
      const full = Buffer.from(render.frame(layout, [pane], width, height, ui));
      assert.equal(frame.text(), full.toString(), `${name}/${index}: full materialization`);
      assert.equal(frame.reusable, true);
      assert.equal(frame.panes.length, 1);
      const retained = frame.panes[0];
      assert.deepEqual([retained.x, retained.y, retained.w, retained.h], [28, 1, paneWidth, paneHeight]);
      if (inputs.length) {
        if (changingChrome)
          assert.notEqual(frame.chrome, inputs.at(-1)!.frame.chrome, "Chrome must change every frame");
        else assert.equal(frame.chrome, inputs.at(-1)!.frame.chrome, "Stable chrome must be identical");
      }
      inputs.push({
        view,
        frame,
        full,
        chrome: Buffer.from(frame.chrome),
        handles: BigUint64Array.of(BigInt(terminal.handle)),
        rects: Uint16Array.of(retained.x, retained.y, retained.w, retained.h),
      });
    }
  } catch (error) {
    for (const terminal of terminals) terminal.destroy();
    throw error;
  } finally {
    Date.now = clock;
    source.destroy();
  }
  return { name, inputs, close: () => terminals.forEach(terminal => terminal.destroy()) };
}
class Host {
  readonly handle: Pointer;
  private previousChrome: string | null = null;
  private readonly output = Buffer.allocUnsafe(1024 * 1024);
  constructor(
    readonly native: Full,
    readonly composed: Composed | null = null,
  ) {
    const handle = native.frame_diff_new(width, height);
    if (!handle) throw Error("OutOfMemory");
    this.handle = handle as Pointer;
  }
  full(input: Input) {
    this.previousChrome = null;
    return Number(this.native.frame_diff_diff(this.handle, ptr(input.full), input.full.length));
  }
  draw(input: Input, handles = input.handles) {
    const cursor = input.frame.cursor;
    const reuseChrome = this.previousChrome === input.frame.chrome;
    const size = this.composed
      ? Number(
          this.composed.frame_diff_compose(
            this.handle,
            reuseChrome ? null : ptr(input.chrome),
            reuseChrome ? 0 : input.chrome.length,
            ptr(handles),
            ptr(input.rects),
            1,
            cursor?.x ?? 0,
            cursor?.y ?? 0,
            cursor !== null,
            reuseChrome ? 1 : 0,
          ),
        )
      : this.full(input);
    this.previousChrome = this.composed ? input.frame.chrome : null;
    if (size < 0) throw Error(`Unexpected native failure/fallback: ${size}`);
    if (size > this.output.length) throw Error("Output buffer too small");
    if (size && Number(this.native.frame_diff_take(this.handle, ptr(this.output), this.output.length)) !== size)
      throw Error("Native output copy failed");
    return size;
  }
  bytes(size: number) {
    return this.output.subarray(0, size);
  }
  close() {
    this.native.frame_diff_free(this.handle);
  }
}
/** Matches the baseline's cached wire-row fast path, including JS concatenation. */
function materialize(input: Input): Buffer {
  const { frame, view } = input,
    pane = frame.panes[0],
    before =
      frame.chrome.slice(0, pane.at) +
      view.surface.lines.map((line, row) => `\x1b[${pane.y + row + 1};${pane.x + 1}H${line}`).join("");
  return Buffer.from(
    frame.cursor_at === null
      ? before + frame.chrome.slice(pane.at)
      : before +
          frame.chrome.slice(pane.at, frame.cursor_at) +
          cursorBytes(frame.cursor) +
          frame.chrome.slice(frame.cursor_at),
  );
}
type InstallMethod = "frozen_json_full" | "current_rows_full" | "current_incremental_compose";
class InstalledHost extends Host {
  private readonly terminal: mirror.Terminal | null;
  private readonly source: Pointer;
  private readonly handles: BigUint64Array;
  constructor(
    readonly method: InstallMethod,
    native: Full,
    composed: Composed | null,
  ) {
    super(native, composed);
    this.terminal = method === "frozen_json_full" ? null : new mirror.Terminal(transport, 1, paneWidth, paneHeight);
    const source = this.terminal?.handle ?? native.terminal_new();
    if (!source) throw Error("OutOfMemory");
    this.source = source as Pointer;
    this.handles = BigUint64Array.of(BigInt(source));
    if (!this.terminal && native.terminal_resize(this.source, paneWidth, paneHeight) !== 0) throw Error("InvalidSize");
  }
  override draw(input: Input) {
    switch (this.method) {
      case "frozen_json_full": {
        const bytes = Buffer.from(stringify(input.view));
        if (
          this.native.viewer_receive(this.source, ptr(bytes), bytes.length) < 0 ||
          this.native.viewer_update_render(this.source) < 0
        )
          throw Error("Frozen surface installation failed");
        break;
      }
      case "current_rows_full":
        viewerNative.receiveFrame(this.source, input.view);
        viewerNative.updateRender(this.source);
        break;
      case "current_incremental_compose":
        this.terminal!.receive(input.view);
        return super.draw(input, this.handles);
    }
    return super.draw({ ...input, full: materialize(input) });
  }
  override close() {
    if (this.terminal) this.terminal.destroy();
    else this.native.terminal_free(this.source);
    super.close();
  }
}
type Libraries = { old: Full; current: Full; composed: Composed };
function installedHosts(libraries: Libraries) {
  return {
    frozen_json_full: new InstalledHost("frozen_json_full", libraries.old, null),
    current_rows_full: new InstalledHost("current_rows_full", libraries.current, null),
    current_incremental_compose: new InstalledHost(
      "current_incremental_compose",
      libraries.current,
      libraries.composed,
    ),
  };
}
function verifyInstalled(inputs: Input[], libraries: Libraries) {
  const methods = installedHosts(libraries),
    names = Object.keys(methods) as InstallMethod[],
    screens = names.map(() => new Terminal(width, height)),
    expected = new Terminal(width, height),
    statistics: {
      frame: number;
      damaged_rows: number;
      compared_cells: number;
      owned_cell_capacity: number;
      managed_arena_capacity_bytes: number;
    }[] = [],
    counters = new BigUint64Array(4),
    outputBytes = [0, 0, 0];
  try {
    for (const input of inputs) assert.deepEqual(materialize(input), input.full);
    for (let index = 0; index < names.length; index++) {
      const host = methods[names[index]];
      assert.ok(host.full(inputs.at(-1)!) >= 0);
      screens[index].feed(inputs.at(-1)!.full);
      const size = host.draw(inputs.at(-1)!);
      screens[index].feed(host.bytes(size));
    }
    expected.feed(inputs.at(-1)!.full);
    for (let frame = 0; frame < inputs.length * 2; frame++) {
      const input = inputs[frame % inputs.length];
      expected.feed(input.full);
      const outputs = names.map((name, index) => {
        const host = methods[name],
          size = host.draw(input);
        outputBytes[index] += size;
        screens[index].feed(host.bytes(size));
        assert.deepEqual(screens[index].surface(0).surface, expected.surface(0).surface, `installed ${name}/${frame}`);
        return Buffer.from(host.bytes(size));
      });
      assert.deepEqual(outputs[1], outputs[0], `full installation output ${frame}`);
      assert.deepEqual(outputs[2], outputs[0], `incremental composition output ${frame}`);
      libraries.composed.frame_diff_stats(methods.current_incremental_compose.handle, ptr(counters));
      statistics.push({
        frame,
        damaged_rows: Number(counters[0]),
        compared_cells: Number(counters[1]),
        owned_cell_capacity: Number(counters[2]),
        managed_arena_capacity_bytes: Number(counters[3]),
      });
    }
    return {
      exact_surface_checks: inputs.length * 2 * names.length,
      exact_output_frames: inputs.length * 2,
      output_bytes: outputBytes,
      native_damage: statistics,
    };
  } finally {
    for (const host of Object.values(methods)) host.close();
    for (const screen of screens) screen.destroy();
    expected.destroy();
  }
}
function verify(inputs: Input[], libraries: { old: Full; current: Full; composed: Composed }) {
  const hosts = [new Host(libraries.old), new Host(libraries.current), new Host(libraries.current, libraries.composed)],
    screens = hosts.map(() => new Terminal(width, height)),
    expected = new Terminal(width, height),
    outputBytes = [0, 0, 0];
  let exactOutputFrames = 0;
  try {
    const initial = inputs.at(-1)!;
    expected.feed(initial.full);
    for (let index = 0; index < hosts.length; index++) {
      assert.ok(hosts[index].full(initial) >= 0);
      screens[index].feed(initial.full);
    }
    for (const input of [...inputs, ...inputs]) {
      expected.feed(input.full);
      const surface = expected.surface(0).surface;
      const outputs = hosts.map((host, index) => {
        const size = host.draw(input);
        outputBytes[index] += size;
        screens[index].feed(host.bytes(size));
        assert.deepEqual(screens[index].surface(0).surface, surface, `surface path ${index}`);
        return Buffer.from(host.bytes(size));
      });
      assert.deepEqual(outputs[1], outputs[0], "Current full differs from frozen full output bytes");
      assert.deepEqual(outputs[2], outputs[0], "Composed differs from frozen full output bytes");
      exactOutputFrames++;
    }
    return {
      exact_surface_checks: inputs.length * 2 * hosts.length,
      exact_output_frames: exactOutputFrames,
      output_bytes: outputBytes,
    };
  } finally {
    for (const host of hosts) host.close();
    for (const screen of screens) screen.destroy();
    expected.destroy();
  }
}
function seed(host: Host, input: Input) {
  assert.ok(host.full(input) >= 0);
  if (host instanceof InstalledHost) host.draw(input);
}
function trial(host: Host, inputs: Input[], milliseconds: number) {
  seed(host, inputs.at(-1)!);
  const usage = process.cpuUsage(),
    start = performance.now();
  let operations = 0,
    bytes = 0;
  do {
    for (const input of inputs) {
      bytes += host.draw(input);
      operations++;
    }
  } while (performance.now() - start < milliseconds);
  const wall = performance.now() - start,
    cpu = process.cpuUsage(usage);
  return {
    operations,
    cpu_us: (cpu.user + cpu.system) / operations,
    wall_us: (wall * 1000) / operations,
    output_bytes_per_op: bytes / operations,
  };
}
function phases(host: Host, inputs: Input[], timing: Composed) {
  seed(host, inputs.at(-1)!);
  timing.frame_diff_timing_enable(host.handle, true);
  const counters = new BigUint64Array(4),
    iterations = 16;
  for (let repeat = 0; repeat < iterations; repeat++) for (const input of inputs) host.draw(input);
  timing.frame_diff_timing(host.handle, ptr(counters));
  timing.frame_diff_timing_enable(host.handle, false);
  return Object.fromEntries(
    ["parse_us", "render_us", "compare_us", "emit_us"].map((name, index) => [
      name,
      Number(counters[index]) / (1000 * iterations * inputs.length),
    ]),
  );
}
function measureInstalled(inputs: Input[], libraries: Libraries) {
  const methods = installedHosts(libraries),
    names = Object.keys(methods) as InstallMethod[],
    trials: Record<InstallMethod, ReturnType<typeof trial>[]> = {
      frozen_json_full: [],
      current_rows_full: [],
      current_incremental_compose: [],
    };
  try {
    for (const name of names) trial(methods[name], inputs, 50);
    for (let pass = 0; pass < 6; pass++)
      for (const name of pass % 2 ? names.toReversed() : names) {
        Bun.gc(true);
        trials[name].push(trial(methods[name], inputs, 150));
      }
    return {
      trials,
      diagnostic_phase_wall_us: {
        current_full: phases(methods.current_rows_full, inputs, libraries.composed),
        current_compose: phases(methods.current_incremental_compose, inputs, libraries.composed),
      },
    };
  } finally {
    for (const host of Object.values(methods)) host.close();
  }
}
function measure(inputs: Input[], libraries: { old: Full; current: Full; composed: Composed }) {
  const methods = {
      frozen_full: new Host(libraries.old),
      current_full: new Host(libraries.current),
      current_compose: new Host(libraries.current, libraries.composed),
    },
    names = Object.keys(methods) as (keyof typeof methods)[];
  const trials: Record<keyof typeof methods, ReturnType<typeof trial>[]> = {
    frozen_full: [],
    current_full: [],
    current_compose: [],
  };
  try {
    for (const name of names) trial(methods[name], inputs, 50);
    for (let pass = 0; pass < 6; pass++)
      for (const name of pass % 2 ? names.toReversed() : names) {
        Bun.gc(true);
        trials[name].push(trial(methods[name], inputs, 150));
      }
    return {
      trials,
      diagnostic_phase_wall_us: {
        current_full: phases(methods.current_full, inputs, libraries.composed),
        current_compose: phases(methods.current_compose, inputs, libraries.composed),
      },
    };
  } finally {
    for (const host of Object.values(methods)) host.close();
  }
}
function cpus(list: string) {
  return list.split(",").flatMap(part => {
    const [first, last] = part.split("-").map(Number);
    return Array.from({ length: (last ?? first) - first + 1 }, (_, index) => first + index);
  });
}
function counters() {
  return new Map(
    readFileSync("/proc/stat", "utf8")
      .split("\n")
      .flatMap(line => {
        const match = /^cpu(\d+)\s+(.+)$/.exec(line);
        if (!match) return [];
        const ticks = match[2].trim().split(/\s+/).slice(0, 8).map(Number);
        return [
          [
            Number(match[1]),
            { total: ticks.reduce((sum, value) => sum + value, 0), idle: ticks[3] + ticks[4] },
          ] as const,
        ];
      }),
  );
}

const release = await benchmark.acquire();
try {
  if (process.env.CORGI_TELEMETRY_DIR) throw Error("Disable application telemetry for CPU trials");
  const directory = join(root, "dist/retained-native-pr15"),
    baseline = join(directory, `libcorgi_term.${suffix}`),
    current = join(nativeRoot, `lib/libcorgi_term.${suffix}`);
  assert.equal(sha(frozenPath), frozenHash, "Frozen embedded PR15 library provenance");
  mkdirSync(directory, { recursive: true });
  copyFileSync(frozenPath, baseline);
  assert.equal(sha(baseline), frozenHash);
  assert.notEqual(sha(current), frozenHash, "Current library must contain retained composition");
  const old = fullLibrary(baseline),
    fresh = fullLibrary(current),
    composed = composedLibrary(current),
    libraries = { old: old.symbols, current: fresh.symbols, composed: composed.symbols },
    status = readFileSync("/proc/self/status", "utf8"),
    affinity = status.match(/^Cpus_allowed_list:\s*(.+)$/m)![1],
    allowed = cpus(affinity),
    siblings = [
      ...new Set(
        allowed.flatMap(cpu =>
          cpus(readFileSync(`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`, "utf8").trim()),
        ),
      ),
    ].filter(cpu => !allowed.includes(cpu));
  const hashes = Object.fromEntries(
    [
      import.meta.path,
      baseline,
      current,
      ...[
        "src/render.ts",
        "src/sidebar.ts",
        "src/composition.ts",
        "src/mirror.ts",
        "native/frame_diff_bridge.zig",
        "native/zig/frame_diff.zig",
      ].map(path => join(root, path)),
    ].map(path => [path, sha(path)]),
  );
  const results = [],
    installed = [],
    before = counters();
  try {
    for (const name of ["sparse", "scroll", "styled-scroll", "diverse-scroll"] as const) {
      const f = fixture(name);
      try {
        const checked = verify(f.inputs, libraries);
        results.push({
          name,
          verification: checked,
          fixture: {
            frames: f.inputs.length,
            full_bytes_per_frame: f.inputs.reduce((sum, input) => sum + input.full.length, 0) / count,
            chrome_bytes_per_frame: f.inputs.reduce((sum, input) => sum + input.chrome.length, 0) / count,
            full_sha256: createHash("sha256")
              .update(Buffer.concat(f.inputs.map(input => input.full)))
              .digest("hex"),
          },
          ...measure(f.inputs, libraries),
        });
      } finally {
        f.close();
      }
    }
    const styled = results.find(result => result.name === "styled-scroll")!,
      diverse = results.find(result => result.name === "diverse-scroll")!;
    assert.notEqual(diverse.fixture.full_sha256, styled.fixture.full_sha256);
    assert.notEqual(diverse.fixture.full_bytes_per_frame, styled.fixture.full_bytes_per_frame);
    assert.notEqual(diverse.verification.output_bytes[0], styled.verification.output_bytes[0]);
    for (const name of ["idle", "cursor-only", "sparse", "scroll", "diverse-scroll"] as const) {
      for (const changingChrome of [false, true]) {
        const f = fixture(name, changingChrome);
        try {
          const checked = verifyInstalled(f.inputs, libraries),
            damage = checked.native_damage;
          if (!changingChrome && ["idle", "cursor-only", "sparse"].includes(name)) {
            const limit = name === "sparse" ? 1 : 0;
            assert.ok(
              damage.every(row => row.damaged_rows <= limit),
              `${name}: excessive native damaged rows`,
            );
            assert.ok(
              damage.every(row => row.compared_cells <= limit * paneWidth),
              `${name}: excessive exact comparisons`,
            );
          }
          const capacities = (rows: typeof damage) => ({
            cells: Math.max(...rows.map(row => row.owned_cell_capacity)),
            arena_bytes: Math.max(...rows.map(row => row.managed_arena_capacity_bytes)),
          });
          installed.push({
            name,
            changing_chrome: changingChrome,
            verification: checked,
            retained_capacity_first_cycle: capacities(damage.slice(0, count)),
            retained_capacity_second_cycle: capacities(damage.slice(count)),
            wire_changed_rows_per_transition: f.inputs.map((input, index) => {
              const previous = f.inputs[(index + count - 1) % count];
              return input.view.surface.lines.filter((line, row) => line !== previous.view.surface.lines[row]).length;
            }),
            ...measureInstalled(f.inputs, libraries),
          });
        } finally {
          f.close();
        }
      }
    }
    const after = counters();
    const load = (ids: number[]) =>
      Object.fromEntries(
        ids.map(cpu => {
          const first = before.get(cpu)!,
            last = after.get(cpu)!,
            total = last.total - first.total;
          return [cpu, total ? 100 * (1 - (last.idle - first.idle) / total) : 0];
        }),
      );
    console.log(
      JSON.stringify(
        {
          measured_at: new Date().toISOString(),
          bun: Bun.version,
          input_sha256: hashes,
          affinity,
          memory_nodes: status.match(/^Mems_allowed_list:\s*(.+)$/m)?.[1],
          host_busy_percent: { allowed: load(allowed), smt_siblings: load(siblings) },
          geometry: { cols: width, rows: height, pane: [28, 1, paneWidth, paneHeight], agents: 16, intensity: 50 },
          geometry_counts: {
            host_cells: width * height,
            retained_cells: paneWidth * paneHeight,
            exposed_chrome_cells: width * height - paneWidth * paneHeight,
          },
          notes: [
            "Actual render.frame chrome with 16 working sidebar entries; generated once at deterministic 100ms intervals. Diff-only fixtures change UI every frame.",
            "Producer uses one Terminal: sparse writes one row, cursor-only changes CUP, scrolling moves retained rows up and appends one row. Wire remains complete canonical line arrays.",
            "Diverse-scroll fills columns with changing ASCII text, wide CJK/emoji and combining graphemes; its input SHA and byte counts must differ from repeated-dot styled-scroll.",
            "diff_only: native host diff plus FFI and output copy to a reused buffer. Excludes source feed, surface transport, UI rendering, pane ANSI materialization and per-call JS output allocation. Distinct frozen terminal handles do not demonstrate incremental damage reuse.",
            "install_and_compose: frozen PR15 JSON installation + full replay, current full row installation + full replay, and production Mirror.receive incremental installation + composition. Full paths include pane ANSI materialization; UI rendering, producer capture, wire parsing and host output allocation remain excluded.",
            "Stable UI/cursor-only fixture requires identical actual Frame.chrome and explicitly reuses it while passing a fresh cursor scalar. This tests backend capability and production receiver, not the production UI cache decision. Macro animation receipts and visual driver test the full viewer.",
            "Each variant cycles identical fixed inputs, including last-to-first transition. Frozen full, current full and current composition require byte-exact output plus complete surface parity before timing.",
            "CPU includes all Bun process threads; trials alternate order. Phase counters are separate opt-in monotonic wall clocks, can include preemption, and are disabled for main trials.",
            "Native diagnostic stats count damaged rows and compared cells; retained capacities are storage, not allocation traffic or peak process memory. Stats are collected outside CPU trials.",
          ],
          diff_only: results,
          install_and_compose: installed,
        },
        null,
        2,
      ),
    );
  } finally {
    composed.close();
    fresh.close();
    old.close();
  }
} finally {
  await release();
}
