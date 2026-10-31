import { expect, spyOn, test } from "bun:test";
import { Frame, cursorBytes, same, type Cursor } from "./composition";
import { Differ } from "./frame_diff";
import { Model, Rect, Selection, View } from "./layout";
import * as mirror from "./mirror";
import * as render from "./render";
import * as sidebar from "./sidebar";
import { n } from "./native_ffi";
import { Terminal } from "./pane/terminal";
import { transport } from "./fixtures/transport";
import * as surfaceFixture from "./fixtures/surface";

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
    expect(surfaceFixture.renamedLinkIds(result.surface(0).surface)).toEqual(
      surfaceFixture.renamedLinkIds(full.surface(0).surface),
    );
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
    f.present(unchanged);
    expect(f.present(f.compose())).toBe("");
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

test("an image write outside the frame keeps retained panes off the wire", () => {
  const f = fixture();
  try {
    f.update(0, "left pane text");
    f.update(1, "right pane text");
    f.present(f.compose());
    f.present(f.compose());
    f.differ.invalidateImages();
    const out = f.present(f.compose());
    expect(out).not.toContain("left pane text");
    expect(out).not.toContain("right pane text");
    f.update(0, "left changed");
    const next = f.present(f.compose());
    expect(next).toContain("changed");
    expect(next).not.toContain("right pane text");
  } finally {
    f.close();
  }
});

test("retained hyperlink groups stay distinct across panes, fallback transitions and hover", () => {
  const f = fixture(),
    uri = "https://example.com/shared",
    linked = (id: string, text: string) => `\x1b]8;id=${id};${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
  try {
    for (const index of [0, 1])
      f.update(index, linked("shared", "A") + " " + linked("other", "B") + "\r\n" + linked("shared", "C"));
    const first = f.compose(),
      rects = f.panes.map(pane => first.frame.panes.find(p => p.id === pane.id)!);
    const groups = () => {
      const all = f.result.hyperlinks(),
        grouped = rects.map(rect =>
          all.filter(
            link =>
              link.row >= rect.y && link.row < rect.y + rect.h && link.start >= rect.x && link.end <= rect.x + rect.w,
          ),
        );
      for (const [index, links] of grouped.entries()) {
        const rect = rects[index];
        expect(links.map(link => [link.row - rect.y, link.start - rect.x, link.end - rect.x, link.uri])).toEqual([
          [0, 0, 1, uri],
          [0, 2, 3, uri],
          [1, 0, 1, uri],
        ]);
        expect(links[0].id).toBe(links[2].id);
        expect(links[0].id).not.toBe(links[1].id);
      }
      expect(new Set(grouped.flatMap(links => links.slice(0, 2).map(link => link.id))).size).toBe(4);
      return grouped.map(links => links.map(link => link.id));
    };
    f.present(first);
    const replayIds = groups();
    // Entering retained composition rewrites the opaque namespace once.
    expect(f.present(f.compose())).toContain("\x1b]8;");
    const retainedIds = groups();
    expect(retainedIds).not.toEqual(replayIds);
    expect(f.present(f.compose())).toBe("");
    expect(groups()).toEqual(retainedIds);

    f.sources[0].feed("\x1b[3;1Hchanged");
    f.panes[0].terminal.receive(f.sources[0].surface(f.panes[0].id));
    f.present(f.compose());
    expect(groups()).toEqual(retainedIds);

    const fallback = f.compose();
    fallback.frame.reusable = false;
    f.present(fallback);
    expect(groups()).toEqual(replayIds);
    expect(f.present(f.compose())).toContain("\x1b]8;");
    expect(groups()).toEqual(retainedIds);
    expect(f.present(f.compose())).toBe("");

    const hovered = f.compose({ pointer: { x: rects[0].x, y: rects[0].y } });
    expect(hovered.frame.panes.map(pane => pane.id)).not.toContain(f.panes[0].id);
    f.present(hovered);
    groups();
    const lines = f.result.surface(0).surface.lines;
    expect(lines.join("").match(/\x1b\[4m/g)).toHaveLength(2);
    f.present(f.compose());
    f.present(f.compose());
    expect(groups()).toEqual(retainedIds);
    expect(f.present(f.compose())).toBe("");
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
    const withCursor = (frame: Frame, cursor: Cursor) =>
      Object.assign(new Frame(), frame, { cursor, panes: frame.panes.map(p => ({ ...p })) });
    const moved = withCursor(first.frame, { x: 9, y: 4 });
    expect(moved.sharesChrome(first.frame)).toBe(true);
    expect(moved.panes[0].revision).toBe(first.frame.panes[0].revision);
    expect(same(first.frame, moved)).toBe(false);
    expect(same(moved, withCursor(moved, null))).toBe(false);
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

test("rejected or failed native composition falls back to a complete frame", () => {
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
        if (status === -1) expect(Number(original(...args))).toBeGreaterThanOrEqual(0);
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

test("a rejected retained batch retries with fresh chrome", () => {
  const f = fixture();
  try {
    f.update(0, "old left");
    f.update(1, "old right");
    f.present(f.compose());
    expect(f.present(f.compose())).toBe("");
    f.update(0, "NEW LEFT");
    f.update(1, "NEW RIGHT");
    const frame = f.compose(),
      original = n.frame_diff_compose,
      modes: number[] = [];
    const reject = ((...args: Parameters<typeof original>) => {
      modes.push(Number(args[9]));
      return args[9] === 1 ? -2 : original(...args);
    }) as typeof original;
    const batch = spyOn(n, "frame_diff_compose").mockImplementation(reject),
      replay = spyOn(n, "frame_diff_diff");
    try {
      const written = f.present(frame);
      expect(modes).toEqual([1, 0]);
      expect(replay).not.toHaveBeenCalled();
      expect(written).toContain("NEW LEFT");
      expect(written).toContain("NEW RIGHT");
    } finally {
      batch.mockRestore();
      replay.mockRestore();
    }
    f.update(0, "AFTER FALLBACK");
    f.present(f.compose());
  } finally {
    f.close();
  }
});
