/** Compiled memory subject. Application modules are evaluated only by the selected mode. */
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "empty",
  fixturePath = process.argv[3] ?? "",
  verify = process.argv.includes("--verify"),
  releaseHidden = process.argv.includes("--release-hidden"),
  started = performance.now();
type State = { details: Record<string, unknown>; close(): void };

// BEGIN APPLICATION MODES
function controllerState(
  controller: import("../../src/controller").Controller,
  differ: import("../../src/frame_diff").Differ,
  closeViewer: typeof import("../../src/viewer").close,
  details: Record<string, unknown>,
): State {
  // This closure owns only the initialized UI. Setup inputs, reference buffers
  // and the sequence of intermediate frames do not survive through it.
  return {
    details,
    close() {
      differ.destroy();
      closeViewer(controller);
    },
  };
}

async function setup(): Promise<State> {
  const nothing = { details: {}, close() {} };
  if (mode === "empty") return nothing;
  if (mode === "prepare") {
    const { Terminal } = await import("../../src/pane/terminal"),
      source = new Terminal(132, 47);
    try {
      source.feed(
        "\x1b[?7l\x1b[H\x1b[36mA representative pane 界 é\x1b[0m" +
          "\x1b[24;15HStable content for memory attribution\x1b[2;3H\x1b[?25h",
      );
      const value = source.surface(1);
      writeFileSync(
        fixturePath,
        JSON.stringify({ ...value, stamp: { ...value.stamp, identity: "1", revision: "1" } }) + "\n",
      );
    } finally {
      source.destroy();
    }
    return nothing;
  }
  await import("../../src/native_ffi");
  await import("../../src/native_bridge");
  if (mode === "native") return nothing;
  const viewer = await import("../../src/viewer");
  const releasePolicy = Reflect.get(viewer, "releaseUninterested") as
    ((view: import("../../src/controller").Controller, interests: readonly { pane: number }[]) => void) | undefined;
  if (releaseHidden && typeof releasePolicy !== "function") throw Error("Frozen viewer has no native release policy");
  if (mode === "viewer") return nothing;
  if (!["controller0", "pane1", "metadata16", "visited16"].includes(mode)) throw Error("UnknownMemoryMode");
  const { Controller } = await import("../../src/controller"),
    { Differ } = await import("../../src/frame_diff"),
    { Frame } = await import("../../src/composition"),
    { transport } = await import("../../src/fixtures/transport"),
    surface = await import("../../src/pane/surface"),
    count = mode === "controller0" ? 0 : mode === "pane1" ? 1 : 16,
    ids = Array.from({ length: count }, (_, i) => i + 1),
    controller = new Controller(
      transport(async () => {
        throw Error("UnexpectedMemoryFixtureRPC");
      }),
    );
  controller.width = 160;
  controller.height = 48;
  controller.prefs.sidebar_width = 28;
  controller.prefs.corgi_intensity = 0;
  controller.corgi_badge = "none";
  // No daemon exists in this initialized-state ladder; disable only review read-ahead.
  controller.review_summaries.want = () => {};
  controller.receiveSnapshot({
    workspaces: [
      {
        id: 1,
        name: "Memory fixture",
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
      cols: 132,
      rows: 47,
      cwd: "",
      label: `Agent ${id}`,
      agent: { provider: "claude", state: "idle", observation: { completed: 0, read: 0 } },
    })),
    conversations: [],
    headless_sessions: [],
  });
  const differ = Differ.create(160, 48),
    output: Buffer[] = [];
  let last: ReturnType<typeof controller.compose> = "";
  const draw = () => {
    if (releaseHidden)
      releasePolicy!(
        controller,
        controller
          .layoutView()
          .placements(controller.area())
          .map(place => ({ pane: place.id })),
      );
    last = controller.compose();
    controller.dirty = false;
    const bytes = differ.diff(last);
    if (verify) output.push(bytes);
    if (
      releaseHidden &&
      controller.runtime.panes.filter(p => Reflect.get(p.terminal, "native") !== null).length !== (count ? 1 : 0)
    )
      throw Error("Hidden native mirror survived the release policy");
  };
  const install = (id: number) => {
    // Parse one separate wire object per visited pane, as real viewer receipts do.
    const input = surface.view(JSON.parse(readFileSync(fixturePath, "utf8")));
    input.surface.pane = id;
    input.stamp.identity = BigInt(id);
    controller.runtime.pane(id)!.terminal.receive(input);
    controller.focusPane(id);
    controller.dirty = true;
    draw();
  };
  if (mode === "visited16") for (const id of ids) install(id);
  else if (count) install(1);
  else draw();
  if (mode === "visited16") {
    controller.focusPane(1);
    controller.dirty = true;
    draw();
  }
  if (controller.sidebar_rows.moving(Date.now())) throw Error("Memory fixture has an unfinished sidebar movement");
  const initialized = controller.runtime.panes.filter(p => {
      if (!Object.hasOwn(p.terminal, "native")) throw Error("Frozen mirror allocation field changed");
      return Reflect.get(p.terminal, "native") !== null;
    }).length,
    expected = count === 0 ? 0 : mode === "visited16" && !releaseHidden ? 16 : 1;
  if (initialized !== expected) throw Error(`Unexpected native mirror count ${initialized}, expected ${expected}`);
  let parity: string | null = null;
  if (verify) {
    const { Terminal } = await import("../../src/pane/terminal"),
      { createHash } = await import("node:crypto"),
      reference = new Terminal(160, 48),
      actual = new Terminal(160, 48);
    try {
      const finalFrame = last as ReturnType<typeof controller.compose>;
      reference.feed(finalFrame instanceof Frame ? finalFrame.text() : finalFrame);
      for (const bytes of output) actual.feed(bytes);
      const want = JSON.stringify(reference.surface(0).surface),
        got = JSON.stringify(actual.surface(0).surface);
      if (want !== got) throw Error("Memory fixture full-frame parity failed");
      parity = createHash("sha256").update(got).digest("hex");
    } finally {
      reference.destroy();
      actual.destroy();
    }
  }
  return controllerState(controller, differ, viewer.close, {
    panes: count,
    initialized_mirrors: initialized,
    focused: count ? 1 : null,
    surface_sha256: parity,
  });
}
// END APPLICATION MODES

if (process.env.CORGI_NATIVE_ROOT || process.env.CORGI_TELEMETRY_DIR)
  throw Error("Use ordinary embedded native lookup");
const state = await setup();
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
write({
  type: "ready",
  mode,
  pid: process.pid,
  setup_ms: performance.now() - started,
  verify,
  release_hidden: releaseHidden,
  ...state.details,
});
if (mode === "prepare" || verify) {
  state.close();
  process.exit(0);
}
let pending = "",
  sampled = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk: string) => {
  pending += chunk;
  while (pending.includes("\n")) {
    const at = pending.indexOf("\n"),
      command = pending.slice(0, at);
    pending = pending.slice(at + 1);
    if (command === "stats" && !sampled) {
      sampled = true;
      // The runner has already captured smaps. This heap walk is deliberately last.
      const jsc = await import("bun:jsc"),
        before = performance.now(),
        memory = process.memoryUsage(),
        heap = jsc.heapStats();
      write({ type: "stats", mode, memory, heap, elapsed_ms: performance.now() - before });
    } else if (command === "close") {
      state.close();
      process.exit(0);
    } else throw Error("UnexpectedMemoryCommand");
  }
});
process.stdin.on("end", () => {
  state.close();
  process.exit(0);
});
