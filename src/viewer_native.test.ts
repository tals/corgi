import { expect, test } from "bun:test";
import * as viewer_native from "./viewer_native";
import { Terminal } from "./pane/terminal";
import * as json from "./json";

test("direct surface installation preserves rows, cursor and input modes", () => {
  const source = Terminal.create(32, 4),
    reference = Terminal.create(1, 1),
    direct = Terminal.create(1, 1);
  try {
    for (const input of [
      "\x1b[31;1mRed 界 é 🐕\x1b[0m\r\n\x1b]8;id=docs;https://example.com/\x1b\\Docs\x1b]8;;\x1b\\",
      "\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[?1h\x1b[?67h\x1b[>4;2m\x1b[>3u\x1b[?25l",
      "\x1b[?2004l\x1b[?1003l\x1b[?1006l\x1b[?1l\x1b[?67l\x1b[>4;0m\x1b[<u\x1b[?25h\r\nnext",
    ]) {
      source.feed(input);
      const view = source.surface(7);
      viewer_native.receive(reference.handle, json.stringify(view));
      viewer_native.receiveFrame(direct.handle, view);
      viewer_native.updateRender(reference.handle);
      viewer_native.updateRender(direct.handle);
      expect(viewer_native.rows(direct.handle, 7, 0, 0, 32, 4, false, null)).toBe(
        viewer_native.rows(reference.handle, 7, 0, 0, 32, 4, false, null),
      );
      expect(viewer_native.cursor(direct.handle)).toEqual(viewer_native.cursor(reference.handle));
      expect(viewer_native.mouseEvents(direct.handle)).toBe(viewer_native.mouseEvents(reference.handle));
      expect(viewer_native.bracketedPaste(direct.handle)).toBe(viewer_native.bracketedPaste(reference.handle));
      expect(viewer_native.pasteEvents(direct.handle)).toBe(viewer_native.pasteEvents(reference.handle));
      for (const cp of [8, 9, 13, 27, 65, 127, 0xe000])
        for (const mods of [{}, { alt: true }, { ctrl: true }, { shift: true }])
          expect(viewer_native.encodeKey(direct.handle, { codepoint: cp, mods })).toBe(
            viewer_native.encodeKey(reference.handle, { codepoint: cp, mods }),
          );
      expect(viewer_native.encodeMouse(direct.handle, 0, 3, 2, false)).toBe(
        viewer_native.encodeMouse(reference.handle, 0, 3, 2, false),
      );
    }
  } finally {
    source.destroy();
    reference.destroy();
    direct.destroy();
  }
});

test("direct surface installation rejects invalid scalar fields before mutation", () => {
  const source = Terminal.create(8, 2),
    target = Terminal.create(8, 2);
  try {
    source.feed("kept");
    const view = source.surface(1);
    viewer_native.receiveFrame(target.handle, view);
    for (const bad of [
      { ...view, surface: { ...view.surface, cols: 65536 } },
      { ...view, surface: { ...view.surface, rows: 2.5 } },
      { ...view, modes: { ...view.modes, kitty: 4294967296 } },
      { ...view, modes: { ...view.modes, mouse_event: "toString" } },
      { ...view, modes: { ...view.modes, mouse_format: "constructor" } },
    ])
      expect(() => viewer_native.receiveFrame(target.handle, bad)).toThrow("InvalidSurface");
    expect(target.liveText()).toContain("kept");
  } finally {
    source.destroy();
    target.destroy();
  }
});
