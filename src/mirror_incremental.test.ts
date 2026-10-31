import { toArrayBuffer, type Pointer } from "bun:ffi";
import { expect, spyOn, test } from "bun:test";
import { Frame, same } from "./composition";
import { Differ } from "./frame_diff";
import { transport } from "./fixtures/transport";
import * as json from "./json";
import * as keyboard from "./keyboard";
import { Rect } from "./layout";
import * as mirror from "./mirror";
import { n } from "./native_ffi";
import { Terminal } from "./pane/terminal";
import type { View } from "./pane/surface";
import type { Wire } from "./protocol";
import { Writer } from "./text";
import * as viewerNative from "./viewer_native";

interface Installation {
  full: boolean;
  rows: number[];
  bytes: string;
}
function fixture(cols = 32, rows = 4) {
  const source = new Terminal(cols, rows),
    reference = new Terminal(cols, rows),
    pane = new mirror.Terminal(
      transport(async () => ({})),
      1,
      cols,
      rows,
    ),
    calls: Installation[] = [],
    original = n.viewer_receive_frame;
  const inspect = ((...args: Parameters<typeof original>) => {
    if (args[0] === pane.handle) {
      const count = Number(args[11]);
      calls.push({
        full: Boolean(args[9]),
        rows: count ? Array.from(new Uint16Array(toArrayBuffer(args[10] as Pointer, 0, count * 2))) : [],
        bytes: Buffer.from(toArrayBuffer(args[1] as Pointer, 0, Number(args[2]))).toString(),
      });
    }
    return original(...args);
  }) as typeof original;
  const receive = spyOn(n, "viewer_receive_frame").mockImplementation(inspect);
  const wire = (view: View): Wire<View> => json.parse(json.stringify(view)) as Wire<View>;
  const compare = () => {
    viewerNative.updateRender(reference.handle);
    pane.updateRender();
    expect(viewerNative.rows(pane.handle, 1, 0, 0, pane.inner.cols, pane.inner.rows, false, null)).toBe(
      viewerNative.rows(reference.handle, 1, 0, 0, pane.inner.cols, pane.inner.rows, false, null),
    );
    expect(viewerNative.cursor(pane.handle)).toEqual(viewerNative.cursor(reference.handle));
    expect(viewerNative.mouseEvents(pane.handle)).toBe(viewerNative.mouseEvents(reference.handle));
    expect(viewerNative.bracketedPaste(pane.handle)).toBe(viewerNative.bracketedPaste(reference.handle));
    expect(viewerNative.pasteEvents(pane.handle)).toBe(viewerNative.pasteEvents(reference.handle));
  };
  const install = (view = source.surface(1)) => {
    pane.receive(wire(view));
    viewerNative.receiveFrame(reference.handle, view);
    reference.cols = view.surface.cols;
    reference.rows = view.surface.rows;
    if (pane.selection) {
      const sel = pane.selection;
      reference.select(sel.x, sel.y, sel.end_x, sel.end_y);
    }
    compare();
    expect(pane.known).toEqual(view.stamp);
    return view;
  };
  source.feed("\x1b[?7l\x1b[?25h\x1b[1;1Hfirst\x1b[2;1Hsecond\x1b[3;1Hthird\x1b[4;1Hfourth\x1b[1;1H");
  return {
    source,
    reference,
    pane,
    calls,
    wire,
    install,
    compare,
    last: () => calls.at(-1)!,
    close() {
      receive.mockRestore();
      source.destroy();
      reference.destroy();
      pane.destroy();
    },
  };
}

test("fresh wire objects with identical row values install no rows", () => {
  const f = fixture();
  try {
    const first = f.install();
    expect(f.last().full).toBe(true);
    f.calls.length = 0;
    // A real new source revision, with no change to the displayed cells.
    f.source.feed("\x1b[1;1H");
    const next = f.source.surface(1);
    expect(next.stamp.identity).toBe(first.stamp.identity);
    expect(next.stamp.revision).toBeGreaterThan(first.stamp.revision);
    expect(next.surface.lines).toEqual(first.surface.lines);
    f.install(next);
    expect(f.last().full).toBe(false);
    expect(f.last().rows).toEqual([]);
    expect(f.last().bytes).not.toContain("first");
    expect(f.last().bytes).not.toContain("second");
    expect(f.last().bytes.length).toBeLessThan(40);
    const duplicate = f.wire(next);
    expect(duplicate).not.toBe(next);
    expect(duplicate.surface.lines).not.toBe(next.surface.lines);
    f.pane.receive(duplicate);
    expect(f.last().full).toBe(false);
    expect(f.last().rows).toEqual([]);
    f.compare();
  } finally {
    f.close();
  }
});

test("one changed wire row sends only that row and preserves the other rows", () => {
  const f = fixture();
  try {
    f.install();
    f.source.feed("\x1b[2;1H\x1b[2KCHANGED\x1b[1;1H");
    f.install();
    expect(f.last().full).toBe(false);
    expect(f.last().rows).toEqual([1]);
    expect(f.last().bytes).toContain("CHANGED");
    for (const untouched of ["first", "third", "fourth"]) expect(f.last().bytes).not.toContain(untouched);
    expect(f.pane.inner.liveText()).toContain("third");
  } finally {
    f.close();
  }
});

test("shortened rows erase old wide glyphs and trailing contents", () => {
  const f = fixture();
  try {
    f.source.feed("\x1b[2;1H\x1b[2K界 é 🐕 trailing contents\x1b[1;1H");
    f.install();
    f.source.feed("\x1b[2;1H\x1b[2Kx\x1b[1;1H");
    f.install();
    expect(f.last().full).toBe(false);
    expect(f.last().rows).toEqual([1]);
    expect(f.pane.inner.liveText()).not.toContain("trailing contents");
    expect(f.pane.inner.liveText()).not.toContain("界");
    // An independently styled short row also had full-clear semantics before patches.
    f.source.feed("\x1b[2;1H\x1b[2KZ\x1b[1;1H");
    const short = f.source.surface(1);
    short.surface.lines[1] = "\x1b[0mZ\x1b[0m";
    f.install(short);
    expect(f.last().rows).toEqual([1]);
  } finally {
    f.close();
  }
});

test("style and hyperlink target changes dirty their row even when text is unchanged", () => {
  const f = fixture();
  try {
    const styled = (color: number, target: string) =>
      f.source.feed(`\x1b[2;1H\x1b[2K\x1b[${color}m\x1b]8;id=docs;${target}\x1b\\Docs\x1b]8;;\x1b\\\x1b[0m\x1b[1;1H`);
    styled(31, "https://example.com/one");
    const first = f.install();
    styled(34, "https://example.com/one");
    const recolored = f.install();
    expect(recolored.surface.lines[1]).not.toBe(first.surface.lines[1]);
    expect(f.last().rows).toEqual([1]);
    styled(34, "https://example.com/two");
    f.install();
    expect(f.last().rows).toEqual([1]);
    expect(f.last().bytes).toContain("https://example.com/two");
    expect(f.pane.hyperlinks().map(link => link.uri)).toContain("https://example.com/two");
  } finally {
    f.close();
  }
});

test("cursor and input mode changes apply without replaying unchanged rows", () => {
  const f = fixture();
  try {
    f.install();
    for (const changes of [
      "\x1b[3;7H\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[?1h\x1b[?67h\x1b[>4;2m\x1b[>3u",
      "\x1b[?25l\x1b[?2004l\x1b[?1003l\x1b[?1006l\x1b[?1l\x1b[?67l\x1b[>4;0m\x1b[<u",
      "\x1b[4;9H\x1b[?25h",
    ]) {
      f.source.feed(changes);
      f.install();
      expect(f.last().full).toBe(false);
      expect(f.last().rows).toEqual([]);
      expect(f.last().bytes.length).toBeLessThan(40);
      for (const cp of [8, 9, 13, 27, 65, 127, 0xe000])
        for (const mods of [{}, { alt: true }, { ctrl: true }])
          expect(viewerNative.encodeKey(f.pane.handle, { codepoint: cp, mods })).toBe(
            viewerNative.encodeKey(f.reference.handle, { codepoint: cp, mods }),
          );
      expect(viewerNative.encodeMouse(f.pane.handle, 0, 3, 2, false)).toBe(
        viewerNative.encodeMouse(f.reference.handle, 0, 3, 2, false),
      );
    }
  } finally {
    f.close();
  }
});

test("multiple row patches before presentation retain all changes", () => {
  const f = fixture(),
    host = new Terminal(32, 4),
    reference = new Terminal(32, 4),
    differ = Differ.create(32, 4);
  const frame = () => {
    f.pane.updateRender();
    const result = new Frame(),
      writer = new Writer();
    writer.write("\x1b[?2026h\x1b[?25l\x1b[0m\x1b[H\x1b[J");
    result.pane(writer, f.pane, 1, new Rect(0, 0, 32, 4));
    result.cursor = f.pane.cursor();
    writer.write(result.cursor ? `\x1b[${result.cursor.y + 1};${result.cursor.x + 1}H\x1b[?25h` : "\x1b[?25l");
    return result.finish(writer.s + "\x1b[?2026l");
  };
  try {
    f.install();
    const first = frame();
    host.feed(differ.diff(first));
    reference.feed(first.text());
    f.source.feed("\x1b[1;1HROW ONE\x1b[1;1H");
    f.install();
    expect(f.last().rows).toEqual([0]);
    f.source.feed("\x1b[3;1HROW THREE\x1b[1;1H");
    f.install();
    expect(f.last().rows).toEqual([2]);
    // Incidental consumers must not consume pending presentation changes.
    f.pane.hyperlinks();
    f.pane.rows(1, 0, 0, 32, 4, false, null);
    const next = frame();
    host.feed(differ.diff(next));
    reference.feed(next.text());
    expect(host.surface(0).surface).toEqual(reference.surface(0).surface);
    expect(host.liveText()).toContain("ROW ONE");
    expect(host.liveText()).toContain("ROW THREE");
  } finally {
    differ.destroy();
    host.destroy();
    reference.destroy();
    f.close();
  }
});

test("selection holds do not acknowledge or replace the installed row baseline", () => {
  const f = fixture();
  try {
    const first = f.install();
    f.pane.select(0, 0, 3, 0);
    f.pane.holding_selection = true;
    f.calls.length = 0;
    f.source.feed("\x1b[1;1HNEW CONTENT\x1b[1;1H");
    const next = f.source.surface(1);
    f.pane.receive(f.wire(next));
    expect(f.calls).toHaveLength(0);
    expect(f.pane.known).toEqual(first.stamp);
    f.pane.clearSelection();
    f.install(next);
    if (!f.last().full) expect(f.last().rows).toEqual([0]);
    expect(f.pane.selection).toBeNull();
    expect(f.pane.inner.liveText()).toContain("NEW CONTENT");
    f.pane.select(0, 1, 3, 1);
    f.source.feed("\x1b[2;1HSELECTED\x1b[1;1H");
    f.install();
    expect(f.last().full).toBe(true);
  } finally {
    f.close();
  }
});

test("viewport changes and resizing require a full install before later row patches", () => {
  const f = fixture();
  try {
    f.source.feed("\x1b[?7h\x1b[4;1H\r\nline five\r\nline six\r\nline seven");
    f.install();
    f.pane.scrollViewport("top");
    f.install(f.source.surface(1, 0));
    expect(f.last().full).toBe(true);
    f.pane.scrollViewport("bottom");
    f.install(f.source.surface(1));
    expect(f.last().full).toBe(true);
    f.source.resize(40, 5);
    f.install();
    expect(f.last().full).toBe(true);
    f.source.feed("\x1b[2;1Hresized patch\x1b[1;1H");
    f.install();
    expect(f.last().full).toBe(false);
    expect(f.last().rows).toEqual([1]);
  } finally {
    f.close();
  }
});

test("a replacement source with the same revision cannot reuse the old terminal identity", () => {
  const f = fixture(),
    replacement = new Terminal(32, 4);
  try {
    replacement.feed("replacement source");
    const previous = f.install(),
      next = replacement.surface(1);
    expect(next.stamp.revision).toBe(previous.stamp.revision);
    expect(next.stamp.identity).not.toBe(previous.stamp.identity);
    f.install(next);
    expect(f.last().full).toBe(true);
    expect(f.pane.inner.liveText()).toContain("replacement source");
    expect(f.pane.inner.liveText()).not.toContain("fourth");
  } finally {
    replacement.destroy();
    f.close();
  }
});

function retainedFrame(pane: mirror.Terminal): Frame {
  pane.updateRender();
  const frame = new Frame(),
    writer = new Writer();
  frame.pane(writer, pane, pane.id, new Rect(0, 0, pane.inner.cols, pane.inner.rows));
  frame.cursor = pane.cursor();
  frame.cursor_at = writer.s.length;
  return frame.finish(writer.s);
}

test("nonvisual SGR and input mode feeds preserve composition identity while advancing their receipt", () => {
  const f = fixture();
  try {
    let installed = f.install();
    const first = retainedFrame(f.pane),
      revision = f.pane.render_revision;
    for (const enabled of [true, true, false, false]) {
      const mode = enabled ? "h" : "l";
      f.source.feed(`\x1b[31m\x1b[?2004${mode}\x1b[?1${mode}\x1b[?1003${mode}`);
      const next = f.install();
      expect(next.stamp.revision).toBeGreaterThan(installed.stamp.revision);
      expect(f.pane.known).toEqual(next.stamp);
      expect(f.last().rows).toEqual([]);
      expect(f.pane.render_revision).toBe(revision);
      expect(same(first, retainedFrame(f.pane))).toBe(true);
      expect(f.pane.bracketedPaste()).toBe(enabled);
      expect(f.pane.mouseEvents()).toBe(enabled);
      expect(viewerNative.encodeKey(f.pane.handle, { codepoint: keyboard.arrow_up, mods: {} })).toBe(
        enabled ? "\x1bOA" : "\x1b[A",
      );
      installed = next;
    }
  } finally {
    f.close();
  }
});

test("row edits and visible cursor changes still invalidate composition after nonvisual feeds", () => {
  const f = fixture();
  try {
    f.install();
    let previous = retainedFrame(f.pane);
    for (const [control, rows] of [
      ["\x1b[2;1HCHANGED\x1b[1;1H", [1]],
      ["\x1b[3;7H", []],
      ["\x1b[?25l", []],
      ["\x1b[?25h", []],
    ] as const) {
      f.source.feed(control);
      f.install();
      const current = retainedFrame(f.pane);
      expect(f.last().rows).toEqual([...rows]);
      expect(current.panes[0].revision).toBeGreaterThan(previous.panes[0].revision);
      expect(same(previous, current)).toBe(false);
      f.source.feed("\x1b[0m");
      f.install();
      expect(same(current, retainedFrame(f.pane))).toBe(true);
      previous = current;
    }
  } finally {
    f.close();
  }
});

test("nonvisual receive preserves pending selection release and viewport invalidation", () => {
  const f = fixture();
  try {
    f.install();
    f.pane.select(0, 0, 3, 0);
    f.install();
    const selected = f.pane.rows(1, 0, 0, 32, 4, false, null);
    let revision = f.pane.render_revision;
    f.pane.clearSelection();
    f.reference.clearSelection();
    expect(f.pane.render_dirty).toBe(true);
    f.source.feed("\x1b[31m");
    f.install();
    expect(f.last().rows).toEqual([]);
    expect(f.pane.render_revision).toBeGreaterThan(revision);
    expect(f.pane.rows(1, 0, 0, 32, 4, false, null)).not.toBe(selected);
    revision = f.pane.render_revision;
    // Requesting the current viewport still clears any local selection state.
    f.pane.scrollViewport("bottom");
    expect(f.pane.render_dirty).toBe(true);
    f.source.feed("\x1b[0m");
    f.install();
    expect(f.last().full).toBe(false);
    expect(f.last().rows).toEqual([]);
    expect(f.pane.render_revision).toBeGreaterThan(revision);
  } finally {
    f.close();
  }
});

test("image-bearing receipts and image removal conservatively invalidate the visible surface", () => {
  const f = fixture();
  try {
    f.install();
    let revision = f.pane.render_revision;
    f.source.feed("\x1b_Ga=T,f=24,s=1,v=1,i=71,c=2,r=2,C=1,q=2;/wAA\x1b\\");
    const image = f.install();
    expect(image.surface.images?.length).toBeGreaterThan(0);
    expect(f.last().rows).toEqual([]);
    expect(f.pane.render_revision).toBeGreaterThan(revision);
    revision = f.pane.render_revision;
    f.source.feed("\x1b[31m");
    f.install();
    expect(f.last().rows).toEqual([]);
    expect(f.pane.render_revision).toBeGreaterThan(revision);
    revision = f.pane.render_revision;
    f.source.feed("\x1b_Ga=d,d=A,q=2\x1b\\");
    const removed = f.install();
    expect(removed.surface.images ?? []).toHaveLength(0);
    expect(f.last().rows).toEqual([]);
    expect(f.pane.render_revision).toBeGreaterThan(revision);
    revision = f.pane.render_revision;
    f.source.feed("\x1b[0m");
    f.install();
    expect(f.pane.render_revision).toBe(revision);
  } finally {
    f.close();
  }
});
