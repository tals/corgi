import { expect, test } from "bun:test";
import { Frames } from "./viewer_stream";
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
  const output = new Frames(),
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
  const output = new Frames(),
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
  const output = new Frames(),
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
  const output = new Frames(),
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
  const output = new Frames(() => now),
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
  const output = new Frames(() => now),
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
    const output = new Frames(() => now),
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
