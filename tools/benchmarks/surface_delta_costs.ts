/** Benchmark-only row wire prototype. Native capture is common and outside all timings. */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { suffix } from "bun:ffi";
import { Controller } from "../../src/controller";
import { Differ } from "../../src/frame_diff";
import { transport } from "../../src/fixtures/transport";
import * as json from "../../src/json";
import { Rect } from "../../src/layout";
import { Terminal as Mirror } from "../../src/mirror";
import { nativeRoot } from "../../src/native_paths";
import { Images } from "../../src/pane_images";
import { Terminal } from "../../src/pane/terminal";
import * as surface from "../../src/pane/surface";
import * as viewer from "../../src/viewer";
import * as viewerNative from "../../src/viewer_native";
import * as benchmark from "./cpu_lock";

type View = surface.View;
type Stamp = surface.Stamp;
type Rows = Omit<View, "surface"> & {
  base: Stamp;
  surface: Omit<surface.Surface, "lines"> & { changed: [number, string][] };
};
type Message = View | Rows;
type Method = "full" | "delta";
type Stage = "codec" | "viewer" | "combined";
type Scenario = "sparse" | "cursor" | "scroll" | "links" | "modes";
const scenarios: Scenario[] = ["sparse", "cursor", "scroll", "links", "modes"],
  stages: Stage[] = ["codec", "viewer", "combined"],
  cols = 132,
  rows = 47,
  baseTime = 1792985000000,
  root = resolve(import.meta.dir, "../.."),
  iterations = Number(process.env.SURFACE_DELTA_ITERATIONS ?? 512),
  trials = Number(process.env.SURFACE_DELTA_TRIALS ?? 4),
  warmup = 128;
let now = baseTime,
  sink = 0;
const realClock = Date.now;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stamp = (value: Stamp): Stamp => ({
  ...value,
  identity: BigInt(value.identity),
  revision: BigInt(value.revision),
});
const sameStamp = (a: Stamp | null, b: Stamp | null) =>
  a !== null && b !== null && a.identity === b.identity && a.revision === b.revision && a.offset === b.offset;
const sameShape = (a: View, b: Pick<View, "surface" | "stamp"> | Rows) =>
  a.stamp.identity === b.stamp.identity &&
  a.stamp.offset === b.stamp.offset &&
  a.surface.pane === b.surface.pane &&
  a.surface.cols === b.surface.cols &&
  a.surface.rows === b.surface.rows;
const isRows = (value: Message): value is Rows => "base" in value;

/** One last-sent full View per client, not a native generation implementation. */
class Sender {
  sent: View | null = null;
  constructor(readonly method: Method) {}
  message(view: View, known: Stamp | null): Message {
    if (this.method === "full") return view;
    const previous = this.sent;
    this.sent = view;
    if (
      !previous ||
      !sameStamp(previous.stamp, known) ||
      !sameShape(previous, view) ||
      view.stamp.revision < previous.stamp.revision
    )
      return view;
    const changed: [number, string][] = [];
    for (let row = 0; row < view.surface.rows; row++)
      if ((view.surface.lines[row] ?? "") !== (previous.surface.lines[row] ?? ""))
        changed.push([row, view.surface.lines[row] ?? ""]);
    const { lines: _lines, ...metadata } = view.surface;
    return { ...view, base: previous.stamp, surface: { ...metadata, changed } };
  }
}

/** Apply only against the installed receipt; a rejection keeps the old display. */
class Receiver {
  current: View | null = null;
  known: Stamp | null = null;
  constructor(readonly pane?: Mirror) {}
  receive(message: Message): boolean {
    if (this.pane?.holding_selection) return false;
    let next: View;
    if (isRows(message)) {
      const previous = this.current,
        base = stamp(message.base),
        receipt = stamp(message.stamp);
      if (
        !previous ||
        !sameStamp(this.known, base) ||
        !sameShape(previous, { ...message, stamp: receipt }) ||
        receipt.revision < base.revision
      ) {
        this.known = null;
        return false;
      }
      // Validate the whole patch before mutating either row references or native state.
      const seen = new Set<number>();
      for (const [row, text] of message.surface.changed) {
        if (
          !Number.isInteger(row) ||
          row < 0 ||
          row >= message.surface.rows ||
          seen.has(row) ||
          typeof text !== "string"
        ) {
          this.known = null;
          return false;
        }
        seen.add(row);
      }
      const lines = previous.surface.lines.slice(),
        { changed, ...metadata } = message.surface;
      for (const [row, text] of changed) lines[row] = text;
      next = {
        surface: { ...metadata, lines },
        stamp: receipt,
        modes: message.modes,
        bottom: message.bottom,
        offset: message.offset,
      };
    } else next = surface.view(message);
    try {
      this.pane?.receive(next);
    } catch (error) {
      this.known = null;
      throw error;
    }
    this.current = next;
    this.known = next.stamp;
    return true;
  }
}
const encode = (message: Message) => Buffer.from(json.stringify(message));
const decode = (bytes: Buffer) => json.parse(bytes.toString()) as Message;
const rowText = (row: number, generation: number) =>
  `${String(row + generation).padStart(4, "0")} src/example.ts: 界 é λ alpha 123 beta ` + "diverse text 789 ".repeat(4);
const initial =
  "\x1b[?7l\x1b[?25h\x1b[2J" +
  Array.from(
    { length: rows },
    (_, row) => `\x1b[${row + 1};1H\x1b[${row % 2 ? 36 : 32}m${rowText(row, 0)}\x1b[0m`,
  ).join("") +
  "\x1b[2;3H";
function corpus(scenario: Scenario): View[] {
  const source = new Terminal(cols, rows),
    result: View[] = [];
  try {
    source.feed(initial);
    for (let index = 0; index < 64; index++) {
      switch (scenario) {
        case "sparse":
          source.feed(
            `\x1b[${24 + (index % 3)};1H\x1b[2K\x1b[36mprogress ${String(index).padStart(3, "0")} 界 é\x1b[0m\x1b[2;3H`,
          );
          break;
        case "cursor":
          source.feed(`\x1b[${1 + (index % rows)};${1 + (index % cols)}H\x1b[?25${index % 3 ? "h" : "l"}`);
          break;
        case "scroll":
          source.feed(`\x1b[47;1H\r\n\x1b[${index % 2 ? 36 : 32}m${rowText(47, index)}\x1b[0m\x1b[2;3H`);
          break;
        case "links":
          source.feed(
            `\x1b[1;1H\x1b[2Khttps://example.com/${index}\x1b[2;1H\x1b]8;id=stable;https://example.com/${index}\x1b\\\x1b[4;31mlink 界\x1b[0m\x1b]8;;\x1b\\\x1b[3;3H`,
          );
          break;
        case "modes":
          source.feed(
            `\x1b[?2004${index % 2 ? "h" : "l"}\x1b[?1003${index % 2 ? "h" : "l"}\x1b[?1006h\x1b[>${index % 2 ? 1 : 0}u`,
          );
          break;
      }
      result.push(source.surface(1));
    }
    return result;
  } finally {
    source.destroy();
  }
}
function fixture(compose: boolean) {
  if (!compose) return { receiver: new Receiver(), draw: () => Buffer.alloc(0), close() {} };
  const controller = new Controller(
    transport(async () => {
      throw Error("Unexpected transport");
    }),
  );
  controller.width = 160;
  controller.height = 48;
  controller.prefs.sidebar_width = 28;
  controller.prefs.corgi_intensity = 0;
  controller.corgi_badge = "none";
  controller.review_summaries.want = () => {};
  const ids = Array.from({ length: 16 }, (_, i) => i + 1);
  controller.receiveSnapshot({
    workspaces: [
      {
        id: 1,
        name: "Surface delta fixture",
        cwd: "",
        model: {
          nodes: ids.map(pane => ({ pane })),
          tabs: ids.map((id, index) => ({ id, root: index, title: `Agent ${id}` })),
          revision: 0,
        },
      },
    ],
    panes: ids.map(id => ({
      id,
      workspace: 1,
      tab: id,
      cols,
      rows,
      label: `Agent ${id}`,
      cwd: "",
      agent: {
        provider: id % 2 ? "claude" : "codex",
        state: "idle",
        observation: { completed: 0, read: 0 },
      },
    })),
    conversations: [],
    headless_sessions: [],
  });
  const differ = Differ.create(160, 48),
    receiver = new Receiver(controller.runtime.panes[0].terminal);
  return {
    receiver,
    draw() {
      const frame = controller.compose();
      controller.dirty = false;
      return differ.diff(frame);
    },
    close() {
      differ.destroy();
      viewer.close(controller);
    },
  };
}
function installed(receiver: Receiver) {
  const pane = receiver.pane!;
  return {
    rows: viewerNative.rows(pane.handle, 1, 0, 0, pane.inner.cols, pane.inner.rows, false, null),
    cursor: pane.cursor(),
    links: pane.hyperlinks(),
    images: pane.images,
    mouse: pane.mouseEvents(),
    bracketed: pane.bracketedPaste(),
    paste: pane.pasteEvents(),
  };
}
function verify(inputs: View[], label: string) {
  const full = fixture(true),
    delta = fixture(true),
    sender = new Sender("delta"),
    fullHost = new Terminal(160, 48),
    deltaHost = new Terminal(160, 48),
    hash = createHash("sha256");
  let patches = 0,
    changed = 0;
  try {
    for (const [index, view] of inputs.entries()) {
      now = baseTime + index * 50;
      const message = sender.message(view, delta.receiver.known);
      if (isRows(message)) {
        patches++;
        changed += message.surface.changed.length;
      }
      assert.ok(full.receiver.receive(decode(encode(view))));
      assert.ok(delta.receiver.receive(decode(encode(message))));
      assert.deepEqual(delta.receiver.current, full.receiver.current, `${label}/${index}: view`);
      assert.deepEqual(installed(delta.receiver), installed(full.receiver), `${label}/${index}: installed`);
      const expected = full.draw(),
        actual = delta.draw();
      assert.deepEqual(actual, expected, `${label}/${index}: differential ANSI`);
      fullHost.feed(expected);
      deltaHost.feed(actual);
      assert.deepEqual(deltaHost.surface(0).surface, fullHost.surface(0).surface, `${label}/${index}: host`);
      hash.update(actual);
    }
    return { views: inputs.length, patches, changed_rows: changed, output_sha256: hash.digest("hex") };
  } finally {
    full.close();
    delta.close();
    fullHost.destroy();
    deltaHost.destroy();
  }
}
function recoveryChecks(inputs: View[]) {
  const a = fixture(true),
    b = fixture(true),
    sendA = new Sender("delta"),
    sendB = new Sender("delta");
  let checks = 0;
  const accept = (f: ReturnType<typeof fixture>, message: Message, expected: View) => {
    assert.ok(f.receiver.receive(decode(encode(message))));
    assert.deepEqual(f.receiver.current, expected);
    checks++;
  };
  try {
    accept(a, sendA.message(inputs[0], null), inputs[0]);
    accept(b, sendB.message(inputs[0], null), inputs[0]);
    for (let i = 1; i < 8; i++) accept(a, sendA.message(inputs[i], a.receiver.known), inputs[i]);
    const delayed = sendB.message(inputs[7], b.receiver.known);
    assert.ok(isRows(delayed));
    assert.equal(delayed.surface.changed.length, 3, "a delayed client gets all three intervening row changes");
    accept(b, delayed, inputs[7]);
    assert.deepEqual(installed(a.receiver), installed(b.receiver));
    // A sent but dropped response cannot become either client's acknowledged baseline.
    const dropped = sendA.message(inputs[8], a.receiver.known);
    assert.ok(isRows(dropped));
    const recover = sendA.message(inputs[9], a.receiver.known);
    assert.ok(!isRows(recover));
    accept(a, recover, inputs[9]);
    // Multiple installations before drawing retain all final rows in the mirror.
    accept(b, sendB.message(inputs[8], b.receiver.known), inputs[8]);
    accept(b, sendB.message(inputs[9], b.receiver.known), inputs[9]);
    assert.deepEqual(installed(a.receiver), installed(b.receiver));
    a.receiver.pane!.holding_selection = true;
    const held = sendA.message(inputs[10], a.receiver.known);
    assert.equal(a.receiver.receive(decode(encode(held))), false);
    assert.deepEqual(a.receiver.known, inputs[9].stamp);
    a.receiver.pane!.holding_selection = false;
    const released = sendA.message(inputs[11], a.receiver.known);
    assert.ok(!isRows(released));
    accept(a, released, inputs[11]);
    const patch = sendA.message(inputs[12], a.receiver.known);
    assert.ok(isRows(patch));
    const before = installed(a.receiver);
    for (const changed of [
      [[-1, "bad"]],
      [
        [0, "one"],
        [0, "two"],
      ],
      [[rows, "bad"]],
    ] as [number, string][][]) {
      a.receiver.known = inputs[11].stamp;
      assert.equal(a.receiver.receive({ ...patch, surface: { ...patch.surface, changed } }), false);
      assert.equal(a.receiver.known, null);
      assert.deepEqual(installed(a.receiver), before);
      checks++;
    }
    a.receiver.known = inputs[0].stamp;
    assert.equal(a.receiver.receive(patch), false);
    assert.deepEqual(installed(a.receiver), before);
    accept(a, sendA.message(inputs[13], a.receiver.known), inputs[13]);
    return { checks, independent_clients: 2, dropped_reply: true, held_selection: true, malformed_patch_atomic: true };
  } finally {
    a.close();
    b.close();
  }
}
function resetCorpus() {
  const source = new Terminal(cols, rows),
    replacement = new Terminal(cols, rows),
    values: View[] = [];
  try {
    source.feed("history 界\r\n".repeat(80) + initial);
    values.push(source.surface(1), source.surface(1, 0), source.surface(1));
    source.feed("\x1b[1;1H\x1b[2K界 wide\x1b[2;1Hlong tail\x1b[2;3H");
    values.push(source.surface(1));
    source.feed("\x1b[1;1Ha\x1b[K\x1b[2;1Hx\x1b[K");
    values.push(source.surface(1));
    source.resize(110, 42);
    values.push(source.surface(1));
    source.resize(cols, rows);
    values.push(source.surface(1));
    source.select(0, 0, 5, 1);
    values.push(source.surface(1));
    source.clearSelection();
    values.push(source.surface(1));
    source.feed("\x1b[?2026h\x1b[Hpending");
    values.push(source.surface(1));
    source.feed("\x1b[?2026l");
    values.push(source.surface(1));
    source.feed("\x1b[?1049hnew alternate");
    values.push(source.surface(1));
    source.feed("\x1b[?1049l");
    values.push(source.surface(1));
    replacement.feed(initial);
    values.push(replacement.surface(1));
    return values;
  } finally {
    source.destroy();
    replacement.destroy();
  }
}
async function imageChecks() {
  const source = new Terminal(cols, rows),
    mirrors = [0, 1].map(
      () =>
        new Mirror(
          transport(async () => ({})),
          1,
          cols,
          rows,
        ),
    ),
    receivers = mirrors.map(pane => new Receiver(pane)),
    images = [new Images(() => {}), new Images(() => {})],
    sender = new Sender("delta"),
    commands = [
      "\x1b_Ga=T,f=24,s=1,v=1,i=71,c=2,r=2,C=1,q=2;/wAA\x1b\\",
      "\x1b[2;2H\x1b_Ga=p,i=71,p=2,c=3,r=2,C=1,q=2\x1b\\",
      "\x1b[?2026h\x1b_Ga=d,d=A,q=2\x1b\\",
      "\x1b[?2026l",
    ],
    hash = createHash("sha256");
  try {
    for (const command of commands) {
      source.feed(command);
      const view = source.surface(1),
        messages = [view, sender.message(view, receivers[1].known)];
      if (command === commands[0]) {
        assert.ok((view.surface.images?.length ?? 0) > 0, "fixture must actually contain an image");
        assert.equal(source.native({ op: "image", text: view.surface.images![0].image.id }), "/wAA");
      }
      for (let i = 0; i < 2; i++) assert.ok(receivers[i].receive(decode(encode(messages[i]))));
      assert.deepEqual(installed(receivers[1]), installed(receivers[0]));
      const bytes = ["", ""];
      for (let i = 0; i < 2; i++) {
        const paint = () =>
          images[i].begin() +
          images[i].draw(mirrors[i].images, new Rect(28, 1, cols, rows), { width: 8, height: 16 }, async (id, offset) =>
            source.native({ op: "image", text: id, skip: offset }),
          ) +
          images[i].end();
        bytes[i] += paint();
        await images[i].settled();
        bytes[i] += paint();
        bytes[i] += paint();
      }
      assert.equal(bytes[1], bytes[0], "image pixels/uploads/placements/removal");
      if (command === commands[0]) assert.ok(bytes[0].includes("\x1b_G"));
      hash.update(bytes[0]);
    }
    return { views: commands.length, exact_image_command_sha256: hash.digest("hex") };
  } finally {
    source.destroy();
    for (const pane of mirrors) pane.destroy();
  }
}
function viewportChecks() {
  const source = new Terminal(cols, rows),
    clients = [0, 1].map(() => ({ sender: new Sender("delta"), receiver: new Receiver() }));
  let views = 0;
  try {
    source.feed("old history 界\r\n".repeat(80) + initial);
    for (let index = 0; index < 8; index++) {
      source.feed(`\x1b[47;1H\r\nnew line ${index}`);
      for (let i = 0; i < 2; i++) {
        const client = clients[i],
          current = source.surface(1, i ? 0 : null);
        assert.ok(client.receiver.receive(decode(encode(client.sender.message(current, client.receiver.known)))));
        assert.deepEqual(client.receiver.current, current);
        views++;
      }
      assert.notEqual(clients[0].receiver.known!.offset, clients[1].receiver.known!.offset);
    }
    return { views, independent_viewports: 2 };
  } finally {
    source.destroy();
  }
}
function plan(inputs: View[], method: Method) {
  const sender = new Sender(method),
    receiver = new Receiver(),
    bytes: Buffer[] = [];
  let rowStrings = 0,
    rowBytes = 0,
    rowRefs = 0,
    patches = 0,
    retainedBytes = 0;
  for (const input of inputs) {
    const message = sender.message(input, receiver.known),
      strings = isRows(message) ? message.surface.changed.map(([, value]) => value) : message.surface.lines;
    bytes.push(encode(message));
    rowStrings += strings.length;
    rowBytes += strings.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    if (isRows(message)) {
      patches++;
      rowRefs += input.surface.rows;
    }
    assert.ok(receiver.receive(decode(bytes.at(-1)!)));
    retainedBytes = Math.max(
      retainedBytes,
      sender.sent?.surface.lines.reduce((sum, text) => sum + Buffer.byteLength(text), 0) ?? 0,
    );
  }
  return {
    bytes,
    metrics: {
      frames: inputs.length,
      patches,
      wire_bytes: bytes.reduce((sum, bytes) => sum + bytes.length, 0),
      decoded_row_strings: rowStrings,
      decoded_row_utf8_bytes: rowBytes,
      reconstructed_row_references: rowRefs,
      max_sender_retained_row_utf8_bytes: retainedBytes,
    },
  };
}
function sample(inputs: View[], method: Method, stage: Stage, wire: Buffer[]) {
  now = baseTime;
  const f = fixture(stage !== "codec"),
    sender = new Sender(method);
  let tick = 0;
  function step() {
    const index = tick % inputs.length;
    now = baseTime + tick++ * 50;
    const bytes = stage === "viewer" ? wire[index] : encode(sender.message(inputs[index], f.receiver.known));
    if (!f.receiver.receive(decode(bytes))) throw Error("Timed receipt mismatch");
    if (stage !== "codec") sink += f.draw().length;
    sink += f.receiver.current!.surface.lines.length;
  }
  try {
    for (let i = 0; i < warmup; i++) step();
    const started_at = new Date(realClock()).toISOString(),
      start = performance.now(),
      usage = process.cpuUsage();
    for (let i = 0; i < iterations; i++) step();
    const cpu = process.cpuUsage(usage),
      wall = performance.now() - start;
    return {
      started_at,
      seconds: wall / 1000,
      cpu_us_per_frame: (cpu.user + cpu.system) / iterations,
      user_us_per_frame: cpu.user / iterations,
      system_us_per_frame: cpu.system / iterations,
      wall_us_per_frame: (wall * 1000) / iterations,
    };
  } finally {
    f.close();
  }
}

const release = await benchmark.acquire();
try {
  if (process.env.CORGI_TELEMETRY_DIR) throw Error("Disable telemetry for CPU measurements");
  if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(trials) || trials < 1)
    throw Error("Invalid trial size");
  Date.now = () => now;
  const inputs = new Map(scenarios.map(scenario => [scenario, corpus(scenario)])),
    verification = {
      cases: Object.fromEntries(scenarios.map(scenario => [scenario, verify(inputs.get(scenario)!, scenario)])),
      resets: verify(resetCorpus(), "resets"),
      recovery: recoveryChecks(inputs.get("sparse")!),
      viewports: viewportChecks(),
      images: await imageChecks(),
    },
    plans = new Map(
      scenarios.map(scenario => [
        scenario,
        {
          full: plan(inputs.get(scenario)!, "full"),
          delta: plan(inputs.get(scenario)!, "delta"),
        },
      ]),
    ),
    results: object[] = [];
  if (!process.argv.includes("--verify-only")) {
    for (const scenario of scenarios)
      for (const stage of stages)
        for (let trial = 0; trial < trials; trial++) {
          const methods: Method[] =
            (trial + Number(process.argv.includes("--reverse"))) % 2 ? ["delta", "full"] : ["full", "delta"];
          for (const method of methods)
            results.push({
              scenario,
              stage,
              trial,
              method,
              ...sample(inputs.get(scenario)!, method, stage, plans.get(scenario)![method].bytes),
            });
        }
  }
  const files = [
    "tools/benchmarks/surface_delta_costs.ts",
    "src/json.ts",
    "src/mirror.ts",
    "src/viewer_native.ts",
    "src/controller.ts",
    "src/composition.ts",
    "src/frame_diff.ts",
    "src/pane/surface.ts",
    "src/pane_images.ts",
  ];
  process.stdout.write(
    JSON.stringify(
      {
        root,
        bun: Bun.version,
        source_sha256: Object.fromEntries(files.map(file => [file, sha(readFileSync(join(root, file)))])),
        native: { root: nativeRoot, term_sha256: sha(readFileSync(join(nativeRoot, `lib/libcorgi_term.${suffix}`))) },
        process_status: readFileSync("/proc/self/status", "utf8")
          .split("\n")
          .filter(line => /^(Cpus_allowed_list|Mems_allowed_list):/.test(line)),
        fixture: {
          cols,
          rows,
          host: [160, 48],
          agents: 16,
          cadence_ms: 50,
          corpus_frames: 64,
          iterations,
          trials,
          warmup,
          codec: "JSON stringify + UTF-8 buffer + decode/reviver + normalization/reconstruction, no native calls",
          viewer:
            "pre-encoded UTF-8 decode + reconstruction + production Mirror.receive + Controller.compose + Differ.diff",
          combined: "codec + viewer pipeline; sender row comparison and receiver reference-array copy included",
          excluded:
            "native capture/feed, socket syscalls/wakeups, metadata RPC, provider/daemon work, stdout, async image transfer, animation",
          gc: "ordinary runtime GC only; no forced GC. Row/string/byte counters are workload proxies, not measured allocations or RSS",
          limits:
            "Bun last-sent baseline prototype; does not model native row-generation capture savings. Ring wrap sends one full frame per 64 updates. Per-frame CPU is not whole-app CPU percentage",
        },
        verification,
        payload: Object.fromEntries(
          scenarios.map(scenario => [
            scenario,
            {
              full: plans.get(scenario)!.full.metrics,
              delta: plans.get(scenario)!.delta.metrics,
            },
          ]),
        ),
        samples: results,
        sink,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  Date.now = realClock;
  await release();
}
