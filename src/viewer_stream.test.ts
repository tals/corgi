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
    large.session = { large: "界".repeat(10_000) } as unknown as View["session"];
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
