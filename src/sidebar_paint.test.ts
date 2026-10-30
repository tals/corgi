import { expect, spyOn, test } from "bun:test";
import * as sidebar from "./sidebar";
import * as corgiAnimation from "./corgi_animation";
import { Frame, same } from "./composition";
import { State } from "./sidebar_rows";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";
import { View as ContextView } from "./usage/context_window";

function setup(entries: sidebar.Entry[], width = 36) {
  const view = sidebar.View.init(100, 40, true, 0, entries.length).withWidth(width).withEntries(entries);
  view.corgi_intensity = 50;
  view.supports_kitty_graphics = true;
  const out = new Writer(),
    first = view.prepare(out, entries, [], 10000)!;
  expect(first).not.toBeNull();
  return { view, first, bytes: out.s };
}

test("detail-row patches preserve full sidebar cells and animation cadence", () => {
  const entries = [
    sidebar.entry({
      target: { pane: 8301 },
      name: "working 界",
      state: "working",
      activity: "Reading files",
      focused: true,
    }),
    sidebar.entry({ target: { pane: 8302 }, name: "awake", state: "working" }),
    sidebar.entry({ target: { pane: 8303 }, name: "sleeping", state: "idle", attention: "finished" }),
    sidebar.entry({
      target: { pane: 8304 },
      name: "compacting",
      state: "working",
      compacting: true,
      compacting_since: 10000000,
    }),
    sidebar.entry({ target: { pane: 8305 }, name: "blocked", state: "blocked", activity: "ignored" }),
  ];
  const f = setup(entries),
    actual = new Terminal(100, 40),
    reference = new Terminal(100, 40);
  let current = f.first;
  actual.feed("\x1b[?7l" + f.bytes);
  try {
    for (const now of [10000, 10075, 10150, 10450, 11000, 12350, 14500, 21000, 22100]) {
      const next = current.next(now),
        delay = corgiAnimation.frameDelay(),
        patch = next.patchFrom(current)!;
      expect(patch).not.toBeNull();
      expect(patch).not.toContain("working 界");
      expect(patch.length).toBeLessThan(f.bytes.length);
      actual.feed(patch);
      const full = new Writer();
      f.view.drawAt(full, entries, [], now);
      expect(corgiAnimation.frameDelay()).toBe(delay);
      expect(next.text()).toBe(full.s);
      reference.feed("\x1b[?7l\x1b[H\x1b[0m\x1b[J" + full.s);
      // A patch intentionally leaves its cursor at its last changed detail row.
      expect(actual.surface(0).surface.lines).toEqual(reference.surface(0).surface.lines);
      current = next;
    }
    expect(f.first.text()).toBe(f.bytes);
  } finally {
    actual.destroy();
    reference.destroy();
  }
});

test("unchanged detail fragments reuse their snapshot without redrawing names or headers", () => {
  const entries = [sidebar.entry({ target: { pane: 8311 }, name: "retained name", state: "blocked" })],
    f = setup(entries),
    names = spyOn(sidebar.View.prototype, "drawAgent");
  try {
    const next = f.first.next(10075);
    expect(next).toBe(f.first);
    expect(next.patchFrom(f.first)).toBe("");
    expect(names).not.toHaveBeenCalled();
  } finally {
    names.mockRestore();
  }
});

test.each(["plain", "focused", "hovered", "notes", "context", "grouped"] as const)(
  "detail patches preserve inherited %s rendition and wide cells",
  variant => {
    const agent = sidebar.entry({
      target: { pane: 8351 },
      provider: "codex",
      name: "styled",
      state: "working",
      activity: "Reading 界 é",
      focused: variant === "focused",
      notes: variant === "notes" ? 3 : 0,
      context: new ContextView(variant === "context" ? { used: 190000n, window: 258400n, at: 1 } : {}),
    });
    const entries =
      variant === "grouped"
        ? [
            sidebar.entry({ target: { group: 1 }, name: "group" }),
            agent,
            sidebar.entry({ target: { pane: 8352 }, state: "blocked", name: "last" }),
          ]
        : [agent];
    const f = setup(entries),
      actual = new Terminal(100, 40),
      reference = new Terminal(100, 40);
    if (variant === "hovered") f.view.hovered = 0;
    const initial = new Writer(),
      first = f.view.prepare(initial, entries, [], 10000)!;
    try {
      actual.feed("\x1b[?7l" + initial.s);
      const next = first.next(10150),
        patch = next.patchFrom(first)!;
      actual.feed(patch);
      const expected = new Writer();
      f.view.drawAt(expected, entries, [], 10150);
      reference.feed("\x1b[?7l" + expected.s);
      expect(next.text()).toBe(expected.s);
      expect(actual.surface(0).surface.lines).toEqual(reference.surface(0).surface.lines);
    } finally {
      actual.destroy();
      reference.destroy();
    }
  },
);

test("lazy chrome receipts preserve dropped-frame fallback without materializing the hot path", () => {
  const entries = [sidebar.entry({ target: { pane: 8321 }, name: "lazy", state: "working", activity: "Reading" })],
    f = setup(entries),
    first = new Frame();
  let now = 10150;
  first.sidebar = {
    at: 0,
    length: f.bytes.length,
    paint: f.first,
    draw: previous => previous!.next(now),
  };
  first.cursor_at = f.bytes.length;
  first.finish(f.bytes + "\x1b[?2026l", "\x1b[?2026h");
  const materialize = spyOn(sidebar.Paint.prototype, "text");
  try {
    const second = first.repaintSidebar()!;
    expect(second.patchFrom(first)).not.toBeNull();
    expect(second.refreshed().sharesChrome(second)).toBe(true);
    expect(same(second, second.refreshed())).toBe(true);
    now = 10225;
    const third = second.repaintSidebar()!;
    expect(third.patchFrom(first)).toBeNull();
    expect(third.patchFrom(second)).not.toBeNull();
    expect(materialize).not.toHaveBeenCalled();
    expect(first.text()).toBe("\x1b[?2026h" + f.bytes + "\x1b[?25l\x1b[?2026l");
    const full = new Writer();
    f.view.drawAt(full, entries, [], now);
    expect(third.text()).toBe("\x1b[?2026h" + full.s + "\x1b[?25l\x1b[?2026l");
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(third.text()).toBe(third.text());
    expect(materialize).toHaveBeenCalledTimes(1);
  } finally {
    materialize.mockRestore();
  }
});

test("row transitions and identity holds settle before static sidebar preparation", () => {
  const state = new State(),
    original = sidebar.entry({ target: { pane: 8331 }, provider: "codex", conversation: 42, state: "working" });
  state.update(1, [original], [], 0);
  expect(state.settled(0)).toBe(true);
  const lost = { ...original, conversation: 0, state: "unknown" };
  state.update(1, [lost], [], 10);
  expect(state.settled(10)).toBe(false);
  expect(state.settled(700)).toBe(false);
  state.update(1, [lost], [], 700);
  expect(state.settled(700)).toBe(true);
  const closing = state.update(1, [], [], 710),
    view = sidebar.View.init(100, 40, true, 0, closing.length).withEntries(closing),
    writer = new Writer();
  expect(view.prepare(writer, closing, [], 710)).toBeNull();
  expect(writer.s).toBe("");
  expect(state.settled(710)).toBe(false);
  state.update(1, [], [], 950);
  expect(state.settled(950)).toBe(true);
  const reopened = { ...original, reopened: true };
  state.update(1, [reopened], [], 960);
  expect(state.settled(960)).toBe(false);
  const settled = state.update(1, [reopened], [], 1200);
  expect(state.settled(1200)).toBe(true);
  expect(view.withEntries(settled).prepare(writer, settled, [], 1200)).not.toBeNull();
});

test("workspace animation and spotlight keep the complete sidebar renderer", () => {
  const entries = [sidebar.entry({ target: { pane: 8341 }, state: "idle" })],
    f = setup(entries),
    writer = new Writer(),
    pushing = sidebar.workspaceEntry({
      id: 1,
      name: "repository",
      cwd: "",
      active: true,
      git_push: { phase: "pushing", message: "" },
    });
  expect(f.view.prepare(writer, entries, [pushing], 10075)).toBeNull();
  expect(writer.s).toBe("");
  f.view.spotlight = { workspace: 1, path: "/worktree" };
  expect(f.view.prepare(writer, entries, [], 10075)).toBeNull();
  expect(writer.s).toBe("");
});

test("activity sections retain headers, starred labels and waiting colors while details advance", () => {
  const entries = [
      sidebar.entry({
        target: { section: "working" },
        group: { agents: 2, working: 1, attention: 1, folded: false, current: false },
      }),
      sidebar.entry({ target: { pane: 8361 }, name: "waiting", state: "blocked", section: "working", starred: true }),
      sidebar.entry({
        target: { section: "working", workspace: 1, checkout: "/repo/topic", run: 0 },
        name: "topic",
        group: { agents: 1, working: 1, attention: 0, folded: false, current: false, branch: true },
      }),
      sidebar.entry({
        target: { pane: 8362 },
        name: "working",
        state: "working",
        attention: "needs_input",
        section: "working",
        activity: "Reading",
      }),
    ],
    f = setup(entries),
    actual = new Terminal(100, 40),
    reference = new Terminal(100, 40);
  try {
    actual.feed("\x1b[?7l" + f.bytes);
    const next = f.first.next(10150);
    actual.feed(next.patchFrom(f.first)!);
    const full = new Writer();
    f.view.drawAt(full, entries, [], 10150);
    reference.feed("\x1b[?7l" + full.s);
    expect(next.text()).toBe(full.s);
    expect(actual.surface(0).surface.lines).toEqual(reference.surface(0).surface.lines);
  } finally {
    actual.destroy();
    reference.destroy();
  }
});

test("clipped, starting and sliding rows keep the full sidebar painter", () => {
  const many = Array.from({ length: 10 }, (_, index) =>
      sidebar.entry({ target: { pane: 8370 + index }, name: `agent ${index}`, state: "idle" }),
    ),
    clipped = sidebar.View.init(80, 20, true, 0, many.length).withEntries(many),
    out = new Writer();
  expect(clipped.prepare(out, many, [], 10000)).toBeNull();
  expect(out.s).toBe("");
  for (const entry of [
    sidebar.entry({ target: { pane: 8381 }, state: "idle", section: "working", starting: true }),
    sidebar.entry({ target: { pane: 8382 }, state: "working", slide: 1 }),
  ]) {
    const view = sidebar.View.init(100, 40, true, 0, 1).withEntries([entry]);
    expect(view.prepare(out, [entry], [], 10000)).toBeNull();
    expect(out.s).toBe("");
  }
});
