import { expect, spyOn, test } from "bun:test";
import { Frame } from "./composition";
import { Differ } from "./frame_diff";
import { Rect } from "./layout";
import { Terminal } from "./pane/terminal";
import * as mirror from "./mirror";
import { n } from "./native_ffi";
import { Writer } from "./text";
import { transport } from "./fixtures/transport";

function fixture() {
  const source = new Terminal(16, 5),
    pane = new mirror.Terminal(
      transport(async () => ({})),
      1,
      16,
      5,
    ),
    expected = new Terminal(20, 6),
    actual = new Terminal(20, 6),
    differ = Differ.create(20, 6);
  let label = "abc";
  const draw = () => {
    let result = "";
    for (let row = 1; row <= 6; row++) result += `\x1b[${row};1H\x1b[0;34m${row === 3 ? label.padEnd(4) : "    "}`;
    return result + "\x1b[0m";
  };
  const update = (value: string) => {
    source.feed(value);
    pane.receive(source.surface(1));
    pane.updateRender();
  };
  update("pane 界 é\x1b[2;3H");
  const first = new Frame(),
    writer = new Writer();
  writer.write("\x1b[?1003h\x1b[?2026h\x1b[?25l\x1b[0m\x1b[H\x1b[J\x1b[1;5Htitle");
  first.pane(writer, pane, 1, new Rect(4, 1, 16, 5));
  const at = writer.s.length,
    bytes = draw();
  writer.write(bytes);
  first.sidebar = { at, length: bytes.length, draw };
  first.cursor = { x: 6, y: 2 };
  first.cursor_at = writer.s.length;
  writer.write("\x1b]22;default\x1b\\\x1b[?2026l");
  first.finish(writer.s);
  const present = (frame: Frame) => {
    expected.feed(frame.text());
    actual.feed(differ.diff(frame));
    expect(actual.surface(0).surface).toEqual(expected.surface(0).surface);
  };
  // First display establishes the host, then its separate pure-chrome surface.
  present(first);
  present(first.refreshed());
  const compose = spyOn(n, "frame_diff_compose"),
    full = spyOn(n, "frame_diff_diff");
  return {
    first,
    differ,
    present,
    compose,
    full,
    update,
    label(value: string) {
      label = value;
    },
    close() {
      compose.mockRestore();
      full.mockRestore();
      differ.destroy();
      source.destroy();
      pane.destroy();
      expected.destroy();
      actual.destroy();
    },
  };
}

test("sidebar patches and pane-only updates preserve the complete-frame surface", () => {
  const f = fixture();
  try {
    f.label("x");
    const next = f.first.repaintSidebar()!;
    f.present(next);
    expect(f.compose.mock.calls.at(-1)![9]).toBe(2);
    expect(f.full).not.toHaveBeenCalled();
    f.update("\x1b[3;1Hnew 界");
    const pane = next.refreshed({ x: 9, y: 3 });
    f.present(pane);
    expect(f.compose.mock.calls.at(-1)![9]).toBe(1);
    f.label("end");
    f.present(pane.repaintSidebar()!);
    expect(f.compose.mock.calls.at(-1)![9]).toBe(2);
    expect(f.full).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

test("a skipped sidebar baseline installs complete chrome before further patches", () => {
  const f = fixture();
  try {
    f.label("a");
    const skipped = f.first.repaintSidebar()!;
    f.label("b");
    const current = skipped.repaintSidebar()!;
    f.present(current);
    expect(f.compose.mock.calls.at(-1)![9]).toBe(0);
    expect(f.full).not.toHaveBeenCalled();
    f.label("c");
    f.present(current.repaintSidebar()!);
    expect(f.compose.mock.calls.at(-1)![9]).toBe(2);
  } finally {
    f.close();
  }
});

test("image invalidation and rejected chrome patches recover through the complete frame", () => {
  const f = fixture();
  try {
    f.label("a");
    const next = f.first.repaintSidebar()!;
    f.differ.invalidateImages();
    f.present(next);
    expect(f.full).toHaveBeenCalledTimes(1);
    f.present(next.refreshed());
    expect(f.compose.mock.calls.at(-1)![9]).toBe(0);
    f.label("b");
    const unsupported = next.repaintSidebar()!;
    // An untrusted patch must never reset the retained UI behind the caller's back.
    unsupported.chromePatch!.bytes = "\x1b[2J";
    f.present(unsupported);
    expect(f.full).toHaveBeenCalledTimes(2);
    f.present(unsupported.refreshed());
    expect(f.compose.mock.calls.at(-1)![9]).toBe(0);
    f.label("c");
    f.present(unsupported.repaintSidebar()!);
    expect(f.compose.mock.calls.at(-1)![9]).toBe(2);
  } finally {
    f.close();
  }
});
