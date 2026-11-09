import { expect, test } from "bun:test";
import * as viewer_stream from "./viewer_stream";
import { Terminal } from "./pane/terminal";
import * as surface from "./pane/surface";
import type { View } from "./viewer_protocol";
import * as protocol from "./protocol";

function view(terminal: Terminal): View {
  return {
    type: "view",
    viewer_protocol: protocol.viewer_version,
    session: null,
    session_hash: 1n,
    resources: null,
    resources_hash: 1n,
    surfaces: [surface.captureView(1, terminal)],
    bell_seq: 0n,
    bell_kind: "none",
    controls: [],
    viewer: 1,
    detach: false,
  };
}
test("receipts bound frames beyond socket buffers and skip blocked intermediate screens", () => {
  const output = new viewer_stream.Frames(),
    terminal = Terminal.create(80, 24);
  try {
    terminal.feed("first");
    const first = output.offer(view(terminal))!;
    output.acknowledge(first.frame);
    let base = first.view.surfaces[0];
    for (const text of ["second", "third", "fourth"]) {
      terminal.feed(`\r${text}`);
      const sent = output.offer(view(terminal))!;
      expect(sent.view.surfaces).toHaveLength(0);
      base = surface.apply(base, sent.view.patches![0]);
      expect(base).toEqual(view(terminal).surfaces[0]);
    }
    expect(output.available).toBe(false);
    terminal.feed("\rskipped");
    expect(output.offer(view(terminal))).toBeNull();
    output.acknowledge(4n);
    terminal.feed("\rlatest!");
    const latest = output.offer(view(terminal))!;
    expect(surface.apply(base, latest.view.patches![0])).toEqual(view(terminal).surfaces[0]);
    expect(() => output.acknowledge(latest.frame + 1n)).toThrow("InvalidAcknowledgement");
    output.acknowledge(1n);
  } finally {
    terminal.destroy();
  }
});
test("an oversized snapshot travels alone and a byte-full window resumes on receipt", () => {
  const output = new viewer_stream.Frames(),
    terminal = Terminal.create(132, 47);
  try {
    const large = view(terminal);
    large.session = { large: "界".repeat(20_000) } as unknown as View["session"];
    const first = output.offer(large)!;
    expect(first).not.toBeNull();
    expect(output.available).toBe(false);
    expect(output.offer(view(terminal))).toBeNull();
    output.acknowledge(first.frame);
    expect(output.offer(view(terminal))).not.toBeNull();
  } finally {
    terminal.destroy();
  }
});
test("dense screens use all three frame slots without queuing a fourth", () => {
  const output = new viewer_stream.Frames(),
    terminal = Terminal.create(132, 47);
  try {
    const first = output.offer(view(terminal))!;
    output.acknowledge(first.frame);
    let base = first.view.surfaces[0];
    for (const character of ["a", "b", "c"]) {
      for (let row = 0; row < 24; row++) terminal.feed(`\x1b[${row + 1};1H${character.repeat(108)}`);
      const sent = output.offer(view(terminal))!;
      expect(sent).not.toBeNull();
      base = sent.view.surfaces[0] ?? surface.apply(base, sent.view.patches![0]);
      expect(base).toEqual(view(terminal).surfaces[0]);
    }
    expect(output.offer(view(terminal))).toBeNull();
    output.acknowledge(4n);
    expect(output.offer(view(terminal))).not.toBeNull();
  } finally {
    terminal.destroy();
  }
});
test("large updates exhaust the byte budget before the frame slots", () => {
  const output = new viewer_stream.Frames(),
    terminal = Terminal.create(80, 24);
  try {
    output.acknowledge(output.offer(view(terminal))!.frame);
    const large = view(terminal);
    large.session = { large: "界".repeat(4_000) } as unknown as View["session"];
    expect(output.offer(large)).not.toBeNull();
    const second = output.offer(large)!;
    expect(second).not.toBeNull();
    expect(output.offer(large)).toBeNull();
    output.acknowledge(second.frame);
    expect(output.offer(large)).not.toBeNull();
  } finally {
    terminal.destroy();
  }
});
test("a drained small probe relearns propagation without losing the latest screen", () => {
  let now = 0;
  const output = new viewer_stream.Frames(() => now),
    terminal = Terminal.create(80, 24);
  try {
    const first = output.offer(view(terminal))!;
    now = 120;
    output.acknowledge(first.frame);
    terminal.feed("before path change");
    const second = output.offer(view(terminal))!;
    now += 300;
    output.acknowledge(second.frame);
    terminal.feed("\rlatest after change");
    const probe = output.offer(view(terminal))!;
    expect(probe.probe).toBe(true);
    expect(probe.view.surfaces).toHaveLength(0);
    expect(probe.view.patches).toHaveLength(0);
    expect(output.available).toBe(false);
    now += 300;
    output.acknowledge(probe.frame);
    const latest = output.offer(view(terminal))!;
    const before = surface.apply(first.view.surfaces[0], second.view.patches![0]);
    expect(surface.apply(before, latest.view.patches![0])).toEqual(view(terminal).surfaces[0]);
    // A healthy 300 ms path accommodates more than three outstanding frames.
    for (let i = 0; i < 3; i++) {
      terminal.feed(String(i));
      expect(output.offer(view(terminal))).not.toBeNull();
    }
  } finally {
    terminal.destroy();
  }
});
test("compressed wire accounting admits dense high-RTT frames while raw memory stays bounded", () => {
  let now = 0;
  const output = new viewer_stream.Frames(() => now),
    terminal = Terminal.create(80, 24);
  try {
    const first = output.offer(view(terminal))!;
    output.encoded(first.frame, 200);
    now = 600;
    output.acknowledge(first.frame);
    const large = view(terminal);
    large.session = { large: "界".repeat(20000) } as unknown as View["session"];
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      const sent = output.offer(large);
      if (!sent) break;
      output.encoded(sent.frame, 200);
      accepted++;
    }
    expect(accepted).toBeGreaterThan(3);
    expect(accepted).toBeLessThan(36);
    output.acknowledge(BigInt(accepted + 1));
    expect(output.available).toBe(true);
  } finally {
    terminal.destroy();
  }
});
test("raw and encoded byte budgets independently stop a large learned window", () => {
  for (const [characters, wire, maximum] of [
    [30000, 200, 23],
    [7000, 12000, 43],
  ]) {
    let now = 0;
    const output = new viewer_stream.Frames(() => now),
      terminal = Terminal.create(80, 24),
      large = view(terminal);
    large.session = { large: "界".repeat(characters) } as unknown as View["session"];
    try {
      for (let i = 0; i < 64; i++) {
        const frame = output.offer(large)!;
        output.encoded(frame.frame, wire);
        now += 1000;
        output.acknowledge(frame.frame);
      }
      let last = 0n,
        count = 0;
      for (;;) {
        const frame = output.offer(large);
        if (!frame) break;
        output.encoded(frame.frame, wire);
        last = frame.frame;
        count++;
        expect(count).toBeLessThan(64);
      }
      expect(count).toBe(maximum);
      output.acknowledge(last);
      expect(output.offer(large)).not.toBeNull();
    } finally {
      terminal.destroy();
    }
  }
});
test("row patches preserve Unicode, hyperlinks, cursor, scrollback and modes", () => {
  const terminal = Terminal.create(40, 5);
  try {
    terminal.feed("old\r\nkeep");
    const before = surface.captureView(1, terminal);
    terminal.feed("\x1b[H\x1b]8;;https://example.com\x1b\\界é\x1b]8;;\x1b\\\x1b[?2004h\x1b[3;4H");
    const after = surface.captureView(1, terminal),
      patch = surface.difference(before, after)!;
    expect(patch.surface.lines.length).toBeLessThan(before.surface.lines.length);
    expect(surface.apply(before, patch)).toEqual(after);
    expect(() => surface.apply(after, patch)).toThrow("InvalidSurfaceBase");
    expect(() =>
      surface.apply(before, { ...patch, surface: { ...patch.surface, lines: [{ row: 500, line: "bad" }] } }),
    ).toThrow("InvalidSurfaceRow");
    terminal.resize(50, 5);
    expect(surface.difference(after, surface.captureView(1, terminal))).toBeNull();
    expect(
      surface.difference(before, { ...after, stamp: { ...after.stamp, identity: after.stamp.identity + 1n } }),
    ).toBeNull();
  } finally {
    terminal.destroy();
  }
});

for (const rtt of [300, 600])
  test(`a sparse-to-dense RTT step to ${rtt} ms cannot trap the delivery estimate`, () => {
    let now = 0,
      departure = 0;
    const output = new viewer_stream.Frames(() => now),
      terminal = Terminal.create(80, 24);
    const receipts: { at: number; frame: bigint; probe: boolean }[] = [];
    let received = 0;
    try {
      for (now = 0; now < 20000; now++) {
        while (receipts[0]?.at <= now) {
          const receipt = receipts.shift()!;
          output.acknowledge(receipt.frame);
          if (now >= 15000 && !receipt.probe) received++;
        }
        if (now % 50) continue;
        const current = view(terminal);
        current.session = { text: "x".repeat(now < 5000 ? 200 : 6000), tick: now } as unknown as View["session"];
        const frame = output.offer(current);
        if (!frame) continue;
        const bytes = frame.probe ? 40 : now < 5000 ? 100 : 1700;
        output.encoded(frame.frame, bytes);
        departure = Math.max(now, departure) + bytes / 125; // 1 Mbit/s, with a FIFO bottleneck.
        receipts.push({ at: departure + (now < 5000 ? 120 : rtt), frame: frame.frame, probe: frame.probe });
      }
      expect(received / 5).toBeGreaterThanOrEqual(19);
    } finally {
      terminal.destroy();
    }
  });

interface Path {
  duration: number;
  rtt: number;
  bytes_per_ms: number;
  hz: number;
  sparse?: boolean;
}
/** A FIFO bottleneck; receipts include both propagation directions and serialization. */
function network(paths: Path[]) {
  let now = 0,
    departure = 0,
    next = 0,
    last_visible = 0,
    last_receipt = 0,
    latest = 0;
  const output = new viewer_stream.Frames(() => now);
  const receipts: { at: number; frame: bigint }[] = [],
    arriving: { at: number; source: number; probe: boolean }[] = [],
    displayed: { at: number; source: number }[] = [],
    ages: { at: number; age: number }[] = [],
    probes: number[] = [],
    flights: number[] = [];
  for (const path of paths) {
    flights.push(receipts.length);
    const end = now + path.duration;
    for (; now < end; now++) {
      while (arriving[0]?.at <= now) {
        const frame = arriving.shift()!;
        if (frame.probe) continue;
        latest = frame.source;
        displayed.push(frame);
      }
      while (receipts[0]?.at <= now) output.acknowledge(receipts.shift()!.frame);
      if (now % 10 === 0) ages.push({ at: now, age: now - latest });
      if (now < next) continue;
      next += 1000 / path.hz;
      const current: View = {
        type: "view",
        viewer_protocol: protocol.viewer_version,
        session: { text: "x".repeat(path.sparse ? 200 : 6000), tick: now } as unknown as View["session"],
        session_hash: 1n,
        resources: null,
        resources_hash: 1n,
        surfaces: [],
        controls: [],
        bell_seq: 0n,
        bell_kind: "none",
        viewer: 1,
        detach: false,
      };
      const frame = output.offer(current);
      if (!frame) continue;
      const bytes = frame.probe ? 40 : path.sparse ? 100 : 1700;
      if (frame.probe) probes.push(now);
      output.encoded(frame.frame, bytes);
      departure = Math.max(now, departure) + bytes / path.bytes_per_ms;
      last_visible = Math.max(last_visible, departure + path.rtt / 2);
      last_receipt = Math.max(last_receipt, departure + path.rtt);
      arriving.push({ at: last_visible, source: now, probe: frame.probe });
      receipts.push({ at: last_receipt, frame: frame.frame });
    }
  }
  return {
    probes,
    flights,
    displayed,
    measure(start: number, end: number) {
      const held = ages
        .filter(a => a.at >= start && a.at < end)
        .map(a => a.age)
        .sort((a, b) => a - b);
      return {
        fps: displayed.filter(frame => frame.at >= start && frame.at < end).length / ((end - start) / 1000),
        p95: held[Math.floor(held.length * 0.95)],
        max: held.at(-1)!,
      };
    },
  };
}

test("a stable constrained path does not repeatedly drain to rediscover the same RTT", () => {
  const run = network([
    { duration: 5000, rtt: 120, bytes_per_ms: 125, hz: 20, sparse: true },
    { duration: 30000, rtt: 600, bytes_per_ms: 8, hz: 20 },
  ]);
  const steady = run.measure(15000, 35000);
  expect(steady.fps).toBeGreaterThanOrEqual(2.8);
  expect(steady.p95).toBeLessThan(1600);
  expect(run.probes.filter(at => at >= 10000)).toHaveLength(0);
});

test("RTT changes during continuous flight still recover the source cadence", () => {
  const run = network([
    { duration: 5000, rtt: 120, bytes_per_ms: 125, hz: 60 },
    { duration: 15000, rtt: 600, bytes_per_ms: 125, hz: 60 },
    { duration: 10000, rtt: 300, bytes_per_ms: 125, hz: 60 },
  ]);
  expect(run.flights[1]).toBeGreaterThan(0);
  expect(run.flights[2]).toBeGreaterThan(0);
  expect(run.measure(15000, 20000).fps).toBeGreaterThanOrEqual(59);
  expect(run.measure(25000, 30000).fps).toBeGreaterThanOrEqual(59);
  expect(run.measure(25000, 30000).p95).toBeLessThan(250);
});

test("a faster dense source fills a healthy high-RTT path after sparse traffic", () => {
  const run = network([
    { duration: 5000, rtt: 300, bytes_per_ms: 125, hz: 20, sparse: true },
    { duration: 15000, rtt: 300, bytes_per_ms: 125, hz: 60 },
  ]);
  const steady = run.measure(15000, 20000);
  expect(steady.fps).toBeGreaterThanOrEqual(59);
  expect(steady.p95).toBeLessThan(250);
});

for (const rtt of [120, 600])
  test(`a capacity collapse at ${rtt} ms RTT bounds old work and recovers after the cap lifts`, () => {
    const run = network([
      { duration: 5000, rtt, bytes_per_ms: 125, hz: 20 },
      { duration: 20000, rtt, bytes_per_ms: 8, hz: 20 },
      { duration: 15000, rtt, bytes_per_ms: 125, hz: 20 },
    ]);
    expect(run.measure(5000, 25000).max).toBeLessThan(4500);
    const fresh = run.displayed.find(frame => frame.source >= 25000 && frame.at - frame.source < rtt / 2 + 250);
    expect(fresh).toBeDefined();
    expect(fresh!.at - 25000).toBeLessThan(2000);
    expect(run.measure(35000, 40000).fps).toBeGreaterThanOrEqual(19);
  });
test("a pane the stream forgot comes back as its whole screen", () => {
  const output = new viewer_stream.Frames(),
    terminal = Terminal.create(80, 24);
  try {
    terminal.feed("first");
    output.acknowledge(output.offer(view(terminal))!.frame);
    output.keep(new Set([1]));
    terminal.feed("\rsecond");
    const kept = output.offer(view(terminal))!;
    expect([kept.view.surfaces.length, kept.view.patches!.length]).toEqual([0, 1]);
    output.acknowledge(kept.frame);
    output.keep(new Set());
    terminal.feed("\rthird");
    const back = output.offer(view(terminal))!;
    expect(back.view.surfaces).toEqual(view(terminal).surfaces);
    expect(back.view.patches).toEqual([]);
  } finally {
    terminal.destroy();
  }
});
