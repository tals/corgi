import { expect, spyOn, test } from "bun:test";
import { Frame } from "./composition";
import { Differ } from "./frame_diff";
import { Rect } from "./layout";
import * as mirror from "./mirror";
import { n } from "./native_ffi";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";
import * as viewerNative from "./viewer_native";
import { transport } from "./fixtures/transport";

test("retained pane defaults match native row rendering across emoji wraps and resizing on a themed host", () => {
  const source = new Terminal(7, 4),
    pane = new mirror.Terminal(
      transport(async () => ({})),
      1,
      7,
      4,
    ),
    expected = new Terminal(24, 8),
    actual = new Terminal(24, 8),
    differ = Differ.create(24, 8),
    compose = spyOn(n, "frame_diff_compose"),
    replay = spyOn(n, "frame_diff_diff"),
    prefix = "\x1b[?7l\x1b[0m\x1b[H\x1b[Jchrome";
  const hostTheme = { foreground: { r: 150, g: 160, b: 170 }, background: { r: 30, g: 40, b: 50 } };
  source.applyTheme({ foreground: { r: 210, g: 220, b: 230 }, background: { r: 7, g: 8, b: 9 } });
  expected.applyTheme(hostTheme);
  actual.applyTheme(hostTheme);
  const frame = () => {
    const result = new Frame(),
      writer = new Writer();
    writer.write(prefix);
    result.pane(writer, pane, 1, new Rect(3, 1, source.cols, source.rows));
    result.cursor_at = writer.s.length;
    return result.finish(writer.s, "", "\x1b[H");
  };
  const present = (value: Frame) => {
    const reference =
      prefix + viewerNative.rows(pane.handle, 1, 3, 1, source.cols, source.rows, false, null) + "\x1b[?25l\x1b[H";
    expect(value.text()).toBe(reference);
    expected.feed(reference);
    const bytes = differ.diff(value);
    actual.feed(bytes);
    expect(actual.surface(0).surface).toEqual(expected.surface(0).surface);
    return bytes;
  };
  try {
    for (const cols of [7, 8, 6, 7]) {
      source.resize(cols, 4);
      // The wide glyph wraps after a spacer_head, omitted by daemon row capture.
      source.feed("\x1b[?7h\x1b[0m\x1b[2J\x1b[H" + "x".repeat(cols - 1) + "🦊 é");
      pane.receive(source.surface(1));
      present(frame());
      compose.mockClear();
      replay.mockClear();
      expect(present(frame()).length).toBe(0);
      expect(compose).toHaveBeenCalledTimes(1);
      expect(replay).not.toHaveBeenCalled();

      source.feed("\x1b[2;1H🐕");
      pane.receive(source.surface(1));
      present(frame());
      expect(compose.mock.calls.at(-1)![9]).toBe(1);
      expect(replay).not.toHaveBeenCalled();

      // Cover palette, inverse and background-only cells in the native source,
      // before canonical row serialization resolves them to explicit colors.
      pane.inner.feed("\x1b[3;1H\x1b[0;31;48;5;120m\x1b[2Kcolor\x1b[4;1H\x1b[0;7mflip\x1b[0m");
      pane.render_dirty = true;
      pane.updateRender();
      present(frame());
      expect(compose.mock.calls.at(-1)![9]).toBe(1);
      expect(replay).not.toHaveBeenCalled();

      const fallback = frame();
      fallback.reusable = false;
      present(fallback);
      expect(replay).toHaveBeenCalledTimes(1);
      present(frame());
      expect(compose.mock.calls.at(-1)![9]).toBe(0);
    }
  } finally {
    compose.mockRestore();
    replay.mockRestore();
    differ.destroy();
    source.destroy();
    pane.destroy();
    expected.destroy();
    actual.destroy();
  }
});
