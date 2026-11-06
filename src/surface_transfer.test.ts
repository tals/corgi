import { expect, test } from "bun:test";
import { Transfer, Assembly } from "./surface_transfer";
import { Terminal } from "./pane/terminal";
import * as surface from "./pane/surface";
import * as flow from "./flow";
import * as json from "./json";

test("a maximum-size truecolor pane arrives in bounded chunks with its original receipt", () => {
  const terminal = Terminal.create(500, 200);
  try {
    const row = Array.from(
      { length: 500 },
      (_, i) => `\x1b[38;2;${123 + (i % 2)};123;234m\x1b[48;2;${123 + (i % 2)};234;123mX`,
    ).join("");
    terminal.feed(Array.from({ length: 200 }, (_, i) => `\x1b[${i + 1};1H${row}`).join(""));
    const before = surface.captureView(7, terminal);
    expect(Buffer.byteLength(json.stringify(before))).toBeGreaterThan(flow.output_bytes);
    let captures = 0;
    function* views() {
      captures++;
      yield before;
      captures++;
      yield surface.captureView(8, terminal);
    }
    const transfer = new Transfer(views()),
      assembly = new Assembly();
    let chunk = transfer.read(null);
    expect(captures).toBe(1);
    terminal.feed("\x1b[HNEW");
    let chunks = 0;
    while (chunk) {
      expect(Buffer.byteLength(json.stringify({ ok: true, surfaces: [], chunk }))).toBeLessThan(flow.output_high);
      assembly.add(chunk);
      chunks++;
      chunk = transfer.read(chunk.next);
    }
    expect(chunks).toBeGreaterThan(2);
    expect(json.stringify(assembly.finish())).toBe(json.stringify([before, surface.captureView(8, terminal)]));
    expect(captures).toBe(2);
  } finally {
    terminal.destroy();
  }
});

test("transfers reject repeated or foreign cursors and never publish an incomplete pane", () => {
  const terminal = Terminal.create(80, 24);
  try {
    const view = surface.captureView(1, terminal);
    view.surface.lines = ["界😀\u001b".repeat(40_000)];
    const transfer = new Transfer([view][Symbol.iterator]()),
      assembly = new Assembly();
    const first = transfer.read(null)!;
    assembly.add(first);
    expect(first.end).toBe(false);
    expect(assembly.views).toEqual([]);
    expect(() => assembly.finish()).toThrow("IncompleteSurface");
    expect(() => transfer.read(null)).toThrow("SurfaceExpired");
    expect(() => new Transfer([view][Symbol.iterator]()).read(first.next)).toThrow("SurfaceExpired");
    let next = transfer.read(first.next);
    while (next) {
      assembly.add(next);
      next = transfer.read(next.next);
    }
    expect(json.stringify(assembly.finish())).toBe(json.stringify([view]));
  } finally {
    terminal.destroy();
  }
});
