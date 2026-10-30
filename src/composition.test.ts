import { expect, spyOn, test } from "bun:test";
import { Frame, cursorBytes, same } from "./composition";
import { Differ } from "./frame_diff";
import { Model, Rect, Selection, View } from "./layout";
import * as mirror from "./mirror";
import * as render from "./render";
import * as sidebar from "./sidebar";
import { n } from "./native_ffi";
import { Terminal } from "./pane/terminal";
import { transport } from "./fixtures/transport";

test("sidebar repaint preserves complete frame bytes and moves its cursor insertion anchor", () => {
  let sidebar = "\x1b[1;1Hshort";
  const prefix = "\x1b[?2026h\x1b[?25l",
    suffix = "\x1b]22;default\x1b\\\x1b[?2026l",
    frame = new Frame();
  frame.sidebar = { at: 0, length: sidebar.length, draw: () => sidebar };
  frame.cursor = { x: 3, y: 4 };
  frame.cursor_at = sidebar.length;
  frame.finish(sidebar + suffix, prefix);
  const first = frame.text(),
    anchor = frame.cursor_at;
  sidebar = "\x1b[1;1H\x1b[31ma longer sidebar\x1b[0m";
  const next = frame.repaintSidebar()!;
  expect(frame.text()).toBe(first);
  expect(frame.cursor_at).toBe(anchor);
  expect(next.cursor_at).toBe(prefix.length + sidebar.length);
  expect(next.text()).toBe(prefix + sidebar + cursorBytes(frame.cursor) + suffix);
  expect(next.patchFrom(frame)).toBe("\x1b[0m" + sidebar + "\x1b[0m");
  expect(next.refreshed({ x: 8, y: 4 }).patchFrom(frame)).toBe(next.patchFrom(frame));
  expect(next.refreshed().finish(next.chrome, "", "\x1b[0m").patchFrom(frame)).toBeNull();
  const missed = frame.refreshed();
  missed.chrome += "different static UI";
  expect(next.patchFrom(missed)).toBeNull();
  missed.reusable = false;
  expect(next.patchFrom(missed)).toBeNull();
});

test("sidebar image appearance and removal each require complete chrome composition", () => {
  let sidebar = "\x1b[1;1Hplain";
  const frame = new Frame();
  frame.sidebar = { at: 0, length: sidebar.length, draw: () => sidebar };
  frame.finish(sidebar);
  sidebar += "\x1b_Ga=p,i=1,C=1\x1b\\";
  const pictured = frame.repaintSidebar()!;
  expect(pictured.patchFrom(frame)).toBeNull();
  sidebar = "\x1b[1;1Hplain again";
  const removed = pictured.repaintSidebar()!;
  expect(removed.patchFrom(pictured)).toBeNull();
  sidebar = "\x1b[1;1Hnext plain frame";
  expect(removed.repaintSidebar()!.patchFrom(removed)).not.toBeNull();
});

function fixture(split = true) {
  const width = 64,
    height = 12,
    model = new Model(),
    selection = new Selection(),
    first = model.newTab("composition");
  if (split) model.split(first, "horizontal");
  selection.reconcile(model);
  const layout = new View(model, selection),
    places = layout.placements(new Rect(0, 1, width, height - 1)),
    sources = places.map(place => new Terminal(place.rect.w, place.rect.h)),
    panes: mirror.Pane[] = places.map(place => ({
      binding: 1n,
      id: place.id,
      label: "",
      cwd: "/tmp",
      command: "",
      brand: null,
      agent: mirror.agent(),
      account: "",
      restoring: "",
      forking: false,
      dormant: false,
      restoring_since: 0,
      terminal: new mirror.Terminal(
        transport(async () => ({})),
        place.id,
        place.rect.w,
        place.rect.h,
      ),
    })),
    full = new Terminal(width, height),
    result = new Terminal(width, height),
    differ = Differ.create(width, height);
  const update = (index: number, text: string) => {
    sources[index].feed("\x1b[?25h\x1b[0m\x1b[2J\x1b[H" + text + "\x1b[2;3H");
    panes[index].terminal.receive(sources[index].surface(panes[index].id));
  };
  const compose = (fields: Partial<render.Ui> = {}) => {
    const ui = render.ui({ message: "", copy_mode: false, sidebar_open: false, ...fields });
    ui.prefs.corgi_intensity = 0;
    ui.prefs.resources.enabled = false;
    const frame = new Frame(),
      text = render.frame(layout, panes, width, height, ui);
    frame.finish(render.frame(layout, panes, width, height, ui, frame));
    expect(frame.text()).toBe(text);
    return { frame, text };
  };
  const present = (drawn: ReturnType<typeof compose>) => {
    const bytes = differ.diff(drawn.frame);
    full.feed(drawn.text);
    result.feed(bytes);
    expect(result.surface(0).surface).toEqual(full.surface(0).surface);
    return bytes.toString();
  };
  return {
    panes,
    sources,
    places,
    layout,
    compose,
    update,
    present,
    differ,
    full,
    result,
    close() {
      differ.destroy();
      full.destroy();
      result.destroy();
      for (const source of sources) source.destroy();
      for (const pane of panes) pane.terminal.destroy();
    },
  };
}

test("retained multi-pane updates and chrome fallbacks reproduce complete styled frames", () => {
  const f = fixture();
  try {
    f.update(0, "\x1b[31;1mRED 界 é 🐕\x1b[0m\r\nleft");
    f.update(1, "\x1b]8;id=docs;https://example.com/\x1b\\Docs\x1b]8;;\x1b\\ right");
    let previous = f.compose();
    expect(previous.frame.panes).toHaveLength(2);
    expect(previous.frame.reusable).toBe(true);
    f.present(previous);
    const unchanged = f.compose();
    expect(same(previous.frame, unchanged.frame)).toBe(true);
    expect(f.present(unchanged)).toBe("");
    for (const [left, right] of [
      ["BLUE 界 é 🐕", "changed"],
      ["  erasure", "RED"],
      ["final", "end"],
    ]) {
      f.update(0, `\x1b[34;1m${left}\x1b[0m`);
      f.update(1, right);
      const current = f.compose();
      expect(current.frame.sharesChrome(previous.frame)).toBe(true);
      expect(same(previous.frame, current.frame)).toBe(false);
      f.present(current);
      previous = current;
    }
    const changedChrome = f.compose({ resizing: "horizontal" });
    expect(changedChrome.frame.sharesChrome(previous.frame)).toBe(false);
    f.present(changedChrome);
    f.update(0, "after full fallback");
    f.present(f.compose({ resizing: "horizontal" }));
  } finally {
    f.close();
  }
});

test("cursor position and visibility stay outside chrome and survive prefixed full fallback", () => {
  const f = fixture(false);
  try {
    f.update(0, "cursor reference");
    const first = f.compose();
    f.present(first);
    const moved = first.frame.refreshed({ x: 9, y: 4 });
    expect(moved.sharesChrome(first.frame)).toBe(true);
    expect(moved.panes[0].revision).toBe(first.frame.panes[0].revision);
    expect(same(first.frame, moved)).toBe(false);
    expect(same(moved, moved.refreshed(null))).toBe(false);
    for (const control of ["\x1b[5;10H\x1b[?25h", "\x1b[?25l", "\x1b[?25h"]) {
      f.sources[0].feed(control);
      f.panes[0].terminal.receive(f.sources[0].surface(f.panes[0].id));
      const current = f.compose();
      expect(current.frame.chrome).toBe(first.frame.chrome);
      expect(current.frame.cursor_at).toBe(first.frame.cursor_at);
      const at = current.frame.cursor_at!;
      expect(current.frame.chrome.slice(at)).toStartWith("\x1b]22;");
      expect(current.text).toContain(cursorBytes(current.frame.cursor) + "\x1b]22;");
      const prefix = "\x1b[?2026h",
        suffix = "\x1b[?2026l";
      current.frame.finish(current.frame.chrome, prefix, suffix);
      expect(current.frame.cursor_at).toBe(at + prefix.length);
      expect(current.frame.text()).toBe(prefix + current.text + suffix);
      f.present({ frame: current.frame, text: prefix + current.text + suffix });
    }
  } finally {
    f.close();
  }
});

test("a review-owned cursor remains in chrome and uses complete-frame fallback", () => {
  const f = fixture(false);
  try {
    f.update(0, "normal pane");
    f.present(f.compose());
    f.sources[0].resize(56, 11);
    f.update(0, "pane beside review");
    const frame = f.compose({
      review_width: 8,
      review_focused: true,
      review_draw: writer => writer.write("\x1b[3;61H\x1b[?25h"),
    });
    expect(frame.frame.panes).toHaveLength(1);
    expect(frame.frame.reusable).toBe(false);
    expect(frame.frame.cursor_at).toBeNull();
    expect(frame.frame.chrome).toContain("\x1b[3;61H\x1b[?25h");
    const compose = spyOn(n, "frame_diff_compose");
    try {
      f.present(frame);
      expect(compose).not.toHaveBeenCalled();
      expect(f.result.surface(0).surface.cursor).toEqual({ x: 60, y: 2 });
    } finally {
      compose.mockRestore();
    }
  } finally {
    f.close();
  }
});

test("changing UI chrome and pane cells composes natively without materializing pane ANSI", () => {
  const f = fixture();
  try {
    f.update(0, "initial left");
    f.update(1, "initial right");
    let previous = f.compose();
    f.present(previous);
    for (let index = 0; index < 4; index++) {
      f.layout.model.tabs[0].rename(`changed tab ${index} 🐕`);
      f.update(0, `\x1b[31;1mleft ${index} 界 é\x1b[0m`);
      f.update(1, `right ${index} \x1b]8;id=docs;https://example.com/${index}\x1b\\link\x1b]8;;\x1b\\`);
      const drawn = f.compose();
      expect(drawn.frame.reusable).toBe(true);
      expect(drawn.frame.sharesChrome(previous.frame)).toBe(false);
      const rows = f.panes.map(pane => spyOn(pane.terminal, "rows")),
        compose = spyOn(n, "frame_diff_compose"),
        replay = spyOn(n, "frame_diff_diff");
      try {
        f.present(drawn);
        expect(compose).toHaveBeenCalledTimes(1);
        expect(replay).not.toHaveBeenCalled();
        for (const row of rows) expect(row).not.toHaveBeenCalled();
      } finally {
        for (const row of rows) row.mockRestore();
        compose.mockRestore();
        replay.mockRestore();
      }
      previous = drawn;
    }
  } finally {
    f.close();
  }
});

test("changed pointer controls retain the complete-frame fallback", () => {
  const f = fixture();
  try {
    f.update(0, "initial left");
    f.update(1, "initial right");
    f.present(f.compose());
    f.update(0, "after pointer change");
    const drawn = f.compose({ resizing: "horizontal" }),
      compose = spyOn(n, "frame_diff_compose"),
      replay = spyOn(n, "frame_diff_diff"),
      rows = f.panes.map(pane => spyOn(pane.terminal, "rows"));
    try {
      const written = f.present(drawn);
      expect(compose).toHaveBeenCalledTimes(1);
      expect(replay).toHaveBeenCalledTimes(1);
      for (const row of rows) expect(row).toHaveBeenCalledTimes(1);
      expect(written).toContain("\x1b]22;ew-resize\x1b\\");
    } finally {
      compose.mockRestore();
      replay.mockRestore();
      for (const row of rows) row.mockRestore();
    }
  } finally {
    f.close();
  }
});

test("unsupported or failed native composition falls back after unpublished native state changes", () => {
  for (const status of [-2, -1]) {
    const f = fixture();
    try {
      f.update(0, "old left");
      f.update(1, "old right");
      f.present(f.compose());
      f.layout.model.tabs[0].rename(`failed composition ${status}`);
      f.update(0, "NEW LEFT");
      f.update(1, "NEW RIGHT");
      const drawn = f.compose(),
        original = n.frame_diff_compose;
      const reject = ((...args: Parameters<typeof original>) => {
        expect(Number(original(...args))).toBeGreaterThanOrEqual(0);
        return status;
      }) as typeof original;
      const compose = spyOn(n, "frame_diff_compose").mockImplementation(reject),
        replay = spyOn(n, "frame_diff_diff"),
        rows = f.panes.map(pane => spyOn(pane.terminal, "rows"));
      try {
        const written = f.present(drawn);
        expect(compose).toHaveBeenCalledTimes(1);
        expect(replay).toHaveBeenCalledTimes(1);
        for (const row of rows) expect(row).toHaveBeenCalledTimes(1);
        expect(written).toContain("NEW LEFT");
        expect(written).toContain("NEW RIGHT");
      } finally {
        compose.mockRestore();
        replay.mockRestore();
        for (const row of rows) row.mockRestore();
      }
      f.layout.model.tabs[0].rename("recovered composition");
      f.update(0, "AFTER COMPOSE FALLBACK");
      f.present(f.compose());
    } finally {
      f.close();
    }
  }
});

test("overlapping status and toast content prevents direct pane repaint", () => {
  const f = fixture(false);
  try {
    f.update(0, "before overlay");
    for (const fields of [{ message: "A status over the pane" }, { copy_feedback: true }]) {
      const first = f.compose(fields);
      expect(first.frame.panes).toHaveLength(1);
      expect(first.frame.reusable).toBe(false);
      f.present(first);
      f.update(0, "updated behind overlay");
      const next = f.compose(fields);
      expect(next.frame.sharesChrome(first.frame)).toBe(false);
      const compose = spyOn(n, "frame_diff_compose");
      try {
        f.present(next);
        expect(compose).not.toHaveBeenCalled();
      } finally {
        compose.mockRestore();
      }
      expect(same(next.frame, f.compose(fields).frame)).toBe(true);
    }
    f.present(f.compose());
  } finally {
    f.close();
  }
});

test("selection, images and mismatched geometry keep their pane on the complete rendering path", () => {
  const f = fixture();
  try {
    f.update(0, "select this");
    f.update(1, "other pane");
    f.panes[0].terminal.select(0, 0, 5, 0);
    let drawn = f.compose();
    expect(drawn.frame.panes.map(p => p.id)).toEqual([f.panes[1].id]);
    f.present(drawn);
    f.panes[0].terminal.clearSelection();
    f.panes[0].terminal.images = [
      {
        image: { id: "fixture", width: 1, height: 1, format: 24, bytes: 3 },
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        source_x: 0,
        source_y: 0,
        source_width: 1,
        source_height: 1,
        z: 0,
      },
    ];
    drawn = f.compose();
    expect(drawn.frame.panes.map(p => p.id)).toEqual([f.panes[1].id]);
    f.present(drawn);
    f.panes[0].terminal.images = [];
    f.sources[0].resize(f.places[0].rect.w - 1, f.places[0].rect.h);
    f.update(0, "different size");
    drawn = f.compose();
    expect(drawn.frame.panes.map(p => p.id)).toEqual([f.panes[1].id]);
    f.present(drawn);
  } finally {
    f.close();
  }
});

test("pane updates during a sidebar drag retain the final hidden cursor", () => {
  const f = fixture(false),
    fields = { dragged_agent: new sidebar.Preview(0, 0) };
  try {
    f.update(0, "before drag");
    const first = f.compose(fields);
    expect(first.frame.panes).toHaveLength(1);
    expect(first.frame.cursor).toBeNull();
    f.present(first);
    f.update(0, "during drag");
    const next = f.compose(fields);
    expect(next.frame.sharesChrome(first.frame)).toBe(true);
    f.present(next);
    expect(f.result.surface(0).surface.cursor).toBeNull();
  } finally {
    f.close();
  }
});

test("replacing a mirrored terminal invalidates a retained frame even at the same revision", () => {
  const f = fixture(false);
  try {
    f.update(0, "before replacement");
    const previous = f.compose();
    f.present(previous);
    const old = f.panes[0].terminal;
    f.panes[0].terminal = new mirror.Terminal(old.conn, old.id, old.inner.cols, old.inner.rows);
    f.update(0, "replacement");
    old.destroy();
    const next = f.compose();
    expect(next.frame.panes[0].revision).toBe(previous.frame.panes[0].revision);
    expect(same(previous.frame, next.frame)).toBe(false);
    expect(next.frame.sharesChrome(previous.frame)).toBe(false);
    f.present(next);
  } finally {
    f.close();
  }
});

test("external image invalidation replays image controls from a retained frame", () => {
  const f = fixture(false),
    image = "\x1b_Ga=p,i=7,p=1,C=1,q=2\x1b\\",
    placement = "\x1b7\x1b[2;2H" + image + "\x1b8";
  const decorate = () => {
    const drawn = f.compose();
    drawn.frame.chrome += placement;
    drawn.text += placement;
    return drawn;
  };
  try {
    f.update(0, "unchanged image frame");
    f.present(decorate());
    expect(f.present(decorate())).toBe("");
    f.differ.invalidateImages();
    expect(f.present(decorate())).toContain(image);
    f.update(0, "after image invalidation");
    f.present(decorate());
  } finally {
    f.close();
  }
});

test("a rejected retained batch discards unpublished cell changes before full fallback", () => {
  const f = fixture();
  try {
    f.update(0, "old left");
    f.update(1, "old right");
    f.present(f.compose());
    expect(f.present(f.compose())).toBe("");
    f.update(0, "NEW LEFT");
    f.update(1, "NEW RIGHT");
    const frame = f.compose(),
      original = n.frame_diff_compose;
    const reject = ((...args: Parameters<typeof original>) => {
      expect(args[9]).toBe(1);
      expect(Number(original(...args))).toBeGreaterThanOrEqual(0);
      return -2;
    }) as typeof original;
    const batch = spyOn(n, "frame_diff_compose").mockImplementation(reject);
    try {
      const written = f.present(frame);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(written).toContain("NEW LEFT");
      expect(written).toContain("NEW RIGHT");
    } finally {
      batch.mockRestore();
    }
    f.update(0, "AFTER FALLBACK");
    f.present(f.compose());
  } finally {
    f.close();
  }
});
