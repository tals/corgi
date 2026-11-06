import { expect, setSystemTime, spyOn, test } from "bun:test";
import { Controller } from "./controller";
import { Frame, same } from "./composition";
import { Differ } from "./frame_diff";
import { transport } from "./fixtures/transport";
import { Terminal } from "./pane/terminal";
import * as mirror from "./mirror";
import * as viewer from "./viewer";
import * as subagentTooltip from "./subagent_tooltip";
import * as sidebar from "./sidebar";
import type { Element } from "./tricks";
import { microTimestamp } from "./clock";
import { Snapshot as Resources, Work } from "./trackers/resources";

function fixture() {
  const view = new Controller(
    transport(async () => {
      throw Error("UnexpectedRequest");
    }),
  );
  view.width = 100;
  view.height = 30;
  view.prefs.corgi_intensity = 0;
  const snapshot = {
    workspaces: [1, 2].map(id => ({
      id,
      name: `workspace ${id}`,
      cwd: "",
      model: { nodes: [{ pane: id }], tabs: [{ id, root: 0, title: `tab ${id}` }], revision: 0 },
    })),
    panes: [1, 2].map(id => ({
      id,
      workspace: id,
      tab: id,
      cols: 72,
      rows: 29,
      agent: { provider: "claude", state: "working", observation: { completed: 0, read: 0 } },
    })),
    conversations: [],
    headless_sessions: [],
  };
  view.receiveSnapshot(snapshot);
  const source = new Terminal(72, 29),
    reference = new Terminal(100, 30),
    result = new Terminal(100, 30),
    differ = Differ.create(100, 30),
    readAhead = spyOn(view.review_summaries, "want").mockImplementation(() => {}),
    images = [
      spyOn(view.images, "begin"),
      spyOn(view.images, "end"),
      spyOn(view.tab_icons, "begin"),
      spyOn(view.tab_icons, "end"),
    ];
  const at = (ms: number) => setSystemTime(new Date(10000 + ms));
  const update = (text: string, cursor = "\x1b[2;3H\x1b[?25h") => {
    source.feed("\x1b[0m\x1b[2J\x1b[H" + text + cursor);
    view.runtime.panes[0].terminal.receive(source.surface(1));
  };
  const compose = () => {
    const output = view.compose();
    view.dirty = false;
    return output;
  };
  const present = (frame: string | Frame) => {
    reference.feed(typeof frame === "string" ? frame : frame.text());
    result.feed(differ.diff(frame));
    const normalized = (terminal: Terminal) => {
      const surface = terminal.surface(0).surface;
      // Image IDs include the owning terminal's identity; placement and pixels agree.
      return {
        ...surface,
        images: surface.images?.map(placement => ({
          ...placement,
          image: { ...placement.image, id: "terminal-local" },
        })),
      };
    };
    expect(normalized(result)).toEqual(normalized(reference));
  };
  at(0);
  update("initial");
  const emit = (bytes: string) => {
    reference.feed(bytes);
    result.feed(bytes);
  };
  return {
    view,
    source,
    snapshot,
    images,
    at,
    update,
    compose,
    present,
    emit,
    close() {
      for (const image of images) image.mockRestore();
      readAhead.mockRestore();
      source.destroy();
      reference.destroy();
      result.destroy();
      differ.destroy();
      viewer.close(view);
      setSystemTime();
    },
  };
}
function retained(output: string | Frame): Frame {
  expect(output).toBeInstanceOf(Frame);
  return output as Frame;
}

test.each(["sidebar", "pane", "overlay"] as const)(
  "retained composition refreshes %s trick controls and clears removed drawings",
  surface => {
    const f = fixture();
    const button: Element = {
      kind: "button",
      spans: [{ text: "Tap" }],
      action: "instance.old",
      slot: "instance.panel.0",
    };
    try {
      f.present(f.compose());
      f.view.runtime.tricks = [
        surface === "overlay"
          ? { kind: "overlay", anchor: "top-right", lines: [], content: button }
          : { kind: "decorate", surface, where: { id: "pane:1" }, suffix: [], content: button },
      ];
      const first = retained(f.compose());
      f.present(first);
      expect(first.reusable).toBe(surface === "sidebar");
      expect(f.view.trick_controls.hits).toHaveLength(1);
      expect(f.view.trick_controls.hits[0].action).toBe("instance.old");
      f.view.trick_controls.focus = button.slot!;
      button.action = "instance.new";
      const focused = retained(f.compose());
      f.present(focused);
      expect(focused.chrome).toContain("\x1b[7m");
      expect(f.view.trick_controls.hits).toHaveLength(1);
      expect(f.view.trick_controls.hits[0].action).toBe("instance.new");
      expect(f.view.trick_controls.focus).toBe(button.slot!);
      f.view.runtime.tricks = [];
      const removed = retained(f.compose());
      f.present(removed);
      expect(removed.reusable).toBe(true);
      expect(removed.chrome).not.toContain("Tap");
      expect(f.view.trick_controls.hits).toEqual([]);
      expect(f.view.trick_controls.focus).toBeNull();
    } finally {
      f.close();
    }
  },
);

test("pane composition snapshots revisions and cursor independently", () => {
  const f = fixture();
  try {
    const first = retained(f.compose()),
      revision = first.panes[0].revision;
    f.present(first);
    expect(f.view.runtime.panes).toHaveLength(2);
    expect(first.panes).toHaveLength(1);
    f.at(50);
    f.update("updated before animation");
    const second = retained(f.compose());
    f.present(second);
    expect(second).not.toBe(first);
    expect(second.panes[0]).not.toBe(first.panes[0]);
    expect(second.cursor).not.toBe(first.cursor);
    expect(first.panes[0].revision).toBe(revision);
    expect(second.panes[0].revision).toBeGreaterThan(revision);
    expect(same(first, second)).toBe(false);
    f.at(75);
    f.update("animation deadline", "\x1b[6;9H\x1b[?25h");
    const animated = retained(f.compose());
    expect(animated.cursor).toEqual({ x: first.panes[0].x + 8, y: first.panes[0].y + 5 });
    expect(animated.panes[0].revision).toBeGreaterThan(second.panes[0].revision);
    expect(first.panes[0].revision).toBe(revision);
    expect(second.cursor).toEqual(first.cursor);
    f.present(animated);
    f.at(100);
    f.update("after animation");
    f.present(retained(f.compose()));
    f.at(150);
    f.update("hidden cursor at deadline", "\x1b[?25l");
    const hidden = retained(f.compose());
    expect(hidden.cursor).toBeNull();
    expect(animated.cursor).not.toBeNull();
    f.present(hidden);
  } finally {
    f.close();
  }
});

test("animation frames match a complete redraw with unchanged pane revisions", () => {
  const f = fixture();
  try {
    let previous = retained(f.compose());
    f.present(previous);
    for (const at of [75, 150, 225]) {
      f.at(at);
      const current = retained(f.compose());
      expect(current.panes[0].revision).toBe(previous.panes[0].revision);
      expect(current.text()).toBe(f.view.frame());
      f.present(current);
      previous = current;
    }
  } finally {
    f.close();
  }
});

test.each(["agent name", "workspace name", "sidebar width", "star"] as const)(
  "in-place %s changes compose current UI without a dirty flag",
  change => {
    const f = fixture();
    try {
      const first = retained(f.compose()),
        before = first.text();
      f.present(first);
      switch (change) {
        case "agent name":
          f.view.runtime.panes[0].label = "renamed agent";
          break;
        case "workspace name":
          f.view.current().name = "renamed workspace";
          break;
        case "sidebar width":
          f.view.prefs.sidebar_width += 4;
          break;
        case "star":
          f.view.current().pinned_agents.push({ pane: 1 });
          break;
      }
      expect(f.view.dirty).toBe(false);
      const next = f.compose(),
        bytes = typeof next === "string" ? next : next.text();
      expect(bytes).not.toBe(before);
      expect(bytes).toBe(f.view.frame());
      expect(first.text()).toBe(before);
      f.present(next);
    } finally {
      f.close();
    }
  },
);

test("subagent metadata follows observation freshness without a dirty flag", () => {
  const f = fixture(),
    metadata = spyOn(f.view, "agentEntries");
  try {
    f.at(20000);
    const observed = microTimestamp() - subagentTooltip.fresh_window + 100000;
    f.view.runtime.panes[0].agent.conversation = 91;
    f.view.runtime.panes[0].agent.subagents = { running: 1, blocked: 0, waiting: false };
    f.view.runtime.conversations = [
      subagentTooltip.conversation({
        id: 91,
        observed_at: observed,
        children_observed_at: observed,
        agent: { provider: "codex", state: "working" },
      }),
      subagentTooltip.conversation({
        id: 92,
        parent: 91,
        observed_at: observed,
        agent: { provider: "codex", state: "working" },
      }),
    ];
    f.compose();
    expect((metadata.mock.results.at(-1)!.value as ReturnType<Controller["agentEntries"]>)[0].children).toBe(1);
    f.at(20075);
    f.compose();
    expect((metadata.mock.results.at(-1)!.value as ReturnType<Controller["agentEntries"]>)[0].children).toBe(1);
    f.at(20150);
    f.compose();
    expect((metadata.mock.results.at(-1)!.value as ReturnType<Controller["agentEntries"]>)[0].children).toBe(0);
  } finally {
    metadata.mockRestore();
    f.close();
  }
});

test.each(["exit", "unbound"] as const)("retained sidebar advances the existing %s transition", transition => {
  const f = fixture(),
    first = sidebar.entry({
      target: { pane: 1 },
      name: "stays",
      provider: "claude",
      conversation: 91,
      state: "working",
      activity: "reading",
    }),
    second = sidebar.entry({ target: { pane: 2 }, name: "leaves", provider: "claude" });
  let live = transition === "exit" ? [first, second] : [first];
  const metadata = spyOn(f.view, "agentEntries").mockImplementation(() => live);
  try {
    f.compose();
    f.at(10);
    live = transition === "exit" ? [first] : [{ ...first, conversation: 0, state: "unknown", name: "unbound" }];
    expect(f.view.dirty).toBe(false);
    const changed = retained(f.compose());
    expect(changed.chrome).toContain(transition === "exit" ? "leaves" : "stays");
    f.at(100);
    expect(retained(f.compose()).chrome).toContain(transition === "exit" ? "leaves" : "stays");
    f.at(transition === "exit" ? 260 : 700);
    const finished = retained(f.compose());
    if (transition === "exit") expect(finished.chrome).not.toContain("leaves");
    else expect(finished.chrome).toContain("unbound");
    expect(finished.text()).toBe(f.view.frame());
  } finally {
    metadata.mockRestore();
    f.close();
  }
});

test("resources and snapshots compose current chrome without a dirty flag", () => {
  const f = fixture();
  try {
    f.view.prefs.resources.enabled = true;
    const initial = retained(f.compose());
    f.present(initial);
    const resources = new Resources();
    resources.workspaces.push(Object.assign(new Work(1), { known: true, cpu: 182, memory: 3n * 2n ** 30n }));
    f.view.runtime.receiveResources(resources);
    expect(f.view.dirty).toBe(false);
    const sampled = retained(f.compose());
    expect(sampled.chrome).not.toBe(initial.chrome);
    expect(sampled.chrome).toContain("CPU 182%");
    expect(sampled.chrome).toContain("3.0G");
    expect(sampled.text()).toBe(f.view.frame());
    f.present(sampled);

    Object.assign(f.view.runtime.resources.workspaces[0], { cpu: 37, memory: 512n * 2n ** 20n });
    expect(f.view.dirty).toBe(false);
    const updated = retained(f.compose());
    expect(updated.chrome).not.toBe(sampled.chrome);
    expect(updated.chrome).toContain("CPU 37%");
    expect(updated.chrome).toContain("512M");
    expect(updated.chrome).not.toContain("182%");
    expect(updated.text()).toBe(f.view.frame());
    f.present(updated);

    f.view.receiveSnapshot({
      ...f.snapshot,
      workspaces: f.snapshot.workspaces.map(workspace =>
        workspace.id === 1 ? { ...workspace, name: "snapshot workspace" } : workspace,
      ),
      panes: f.snapshot.panes.map(pane =>
        pane.id === 1 ? { ...pane, agent: { ...pane.agent, name: "snapshot agent" } } : pane,
      ),
    });
    f.view.dirty = false;
    const received = retained(f.compose());
    expect(received.chrome).not.toBe(updated.chrome);
    expect(received.chrome).toContain("snapshot workspace");
    expect(received.chrome).toContain("snapshot agent");
    expect(received.chrome).toContain("CPU 37%");
    expect(received.text()).toBe(f.view.frame());
    f.present(received);
  } finally {
    f.close();
  }
});

test.each(["moved", "hidden", "shown"] as const)(
  "a %s cursor retains exact chrome and its own presentation state",
  change => {
    const f = fixture();
    try {
      if (change === "shown") f.update("initial", "\x1b[2;3H\x1b[?25l");
      const first = retained(f.compose());
      f.present(first);
      f.at(20);
      f.source.feed(change === "moved" ? "\x1b[4;6H\x1b[?25h" : change === "hidden" ? "\x1b[?25l" : "\x1b[?25h");
      f.view.runtime.panes[0].terminal.receive(f.source.surface(1));
      const next = retained(f.compose());
      f.present(next);
      expect(next.chrome).toBe(first.chrome);
      expect(next.cursor_at).toBe(first.cursor_at);
      expect(next.sharesChrome(first)).toBe(true);
      expect(same(first, next)).toBe(false);
      expect(next.cursor).not.toEqual(first.cursor);
      f.at(40);
      const unchanged = retained(f.compose());
      f.present(unchanged);
      expect(same(next, unchanged)).toBe(true);
    } finally {
      f.close();
    }
  },
);

test.each(["pointer", "copy mode", "selection", "message", "prefix"] as const)(
  "%s composes the current complete frame without a dirty flag",
  change => {
    const f = fixture();
    try {
      f.compose();
      f.at(20);
      switch (change) {
        case "pointer":
          f.view.pointer = { x: 40, y: 10 };
          break;
        case "copy mode":
          f.view.copy_mode = true;
          break;
        case "selection":
          f.view.runtime.panes[0].terminal.select(0, 0, 2, 0);
          break;
        case "message":
          f.view.message = "new status";
          break;
        case "prefix":
          f.view.prefix = true;
          break;
      }
      expect(f.view.dirty).toBe(false);
      const next = f.compose();
      expect(typeof next === "string" ? next : next.text()).toBe(f.view.frame());
      f.present(next);
    } finally {
      f.close();
    }
  },
);

test("image appearance and removal run the complete image lifecycle", () => {
  const f = fixture();
  try {
    f.compose();
    f.at(20);
    const pane = f.view.runtime.panes[0];
    pane.terminal.images = [
      {
        image: { id: "fixture", width: 1, height: 1, format: 32, bytes: 4 },
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        source_x: 0,
        source_y: 0,
        source_width: 1,
        source_height: 1,
        z: 1,
      },
    ];
    f.compose();
    for (const image of f.images) expect(image).toHaveBeenCalledTimes(2);
    pane.terminal.images = [];
    f.at(40);
    f.compose();
    f.at(50);
    f.compose();
    for (const image of f.images) expect(image).toHaveBeenCalledTimes(4);
  } finally {
    f.close();
  }
});

test("stable Kitty badge and tab placements survive redraws and equivalent pixel-size objects", () => {
  const f = fixture();
  try {
    f.view.supports_kitty_graphics = true;
    f.view.cell_pixels = { width: 8, height: 16 };
    f.view.corgi_badge = "image";
    f.view.current().model.tabs[0].rename("");
    f.emit("\x1b_Ga=t,t=d,f=24,s=1,v=1,i=730031,q=2;AAAA\x1b\\");
    const first = retained(f.compose());
    f.present(first);
    const upload = f.view.effects
      .flatMap(effect => ("write_terminal" in effect ? [effect.write_terminal] : []))
      .join("");
    expect(upload).toContain("\x1b_Ga=t");
    f.emit(upload);
    f.view.clearEffects();
    f.at(10);
    const placed = retained(f.compose());
    f.present(placed);
    expect(placed.chrome).toContain("\x1b_Ga=d,d=i");
    expect(placed.chrome).toContain("\x1b_Ga=p");
    f.at(20);
    f.view.cell_pixels = { width: 8, height: 16 };
    f.update("pane changed under static graphics");
    const hit = retained(f.compose());
    f.present(hit);
    expect(hit.chrome).toBe(placed.chrome);
    expect(f.view.effects).toHaveLength(0);
    f.at(30);
    f.view.cell_pixels = { width: 9, height: 16 };
    f.compose();
    expect(f.view.effects.some(effect => "write_terminal" in effect)).toBe(true);
    f.view.clearEffects();
    f.at(40);
    f.compose();
  } finally {
    f.close();
  }
});

test("changed geometry uses current pane bounds and full ANSI fallback", () => {
  const f = fixture();
  try {
    const first = retained(f.compose());
    f.at(20);
    expect(first.text()).toBe(f.view.frame());
    f.view.width++;
    const resized = f.compose();
    expect(typeof resized).toBe("string");
    expect(resized).toBe(f.view.frame());
    f.source.resize(73, 29);
    f.update("resized pane");
    const retainedSize = retained(f.compose());
    expect(retainedSize.panes[0].w).toBe(73);
    expect(retainedSize.sharesChrome(first)).toBe(false);
    expect(retainedSize.text()).toBe(f.view.frame());
  } finally {
    f.close();
  }
});

test("one retained pane among multiple visible panes never freezes the other pane", () => {
  const f = fixture();
  try {
    f.view.receiveSnapshot({
      ...f.snapshot,
      workspaces: [
        {
          ...f.snapshot.workspaces[0],
          model: {
            nodes: [{ split: { axis: "horizontal", ratio: 500, first: 1, second: 2 } }, { pane: 1 }, { pane: 2 }],
            tabs: [{ id: 1, root: 0, title: "split" }],
            revision: 1,
          },
        },
      ],
      panes: f.snapshot.panes.map(pane => ({ ...pane, workspace: 1, tab: 1 })),
    });
    const place = f.view
      .layoutView()
      .placements(f.view.area())
      .find(place => place.id === 1)!;
    f.source.resize(place.rect.w, place.rect.h);
    f.update("retained first pane");
    const first = retained(f.compose());
    expect(first.panes).toHaveLength(1);
    f.at(20);
    const other = f.view.runtime.panes[1].terminal;
    other.inner.feed("SECOND PANE CHANGED");
    other.render_dirty = true;
    const next = retained(f.compose());
    expect(next.chrome).toContain("SECOND PANE CHANGED");
  } finally {
    f.close();
  }
});

test("replacing a terminal composes the new native owner after destroying the old terminal", () => {
  const f = fixture();
  try {
    f.compose();
    const pane = f.view.runtime.panes[0],
      old = pane.terminal;
    const replacement = new mirror.Terminal(f.view.connection, pane.id, 72, 29);
    replacement.receive(f.source.surface(1));
    pane.terminal = replacement;
    old.destroy();
    f.at(20);
    const frame = retained(f.compose());
    expect(frame.panes[0].terminal).toBe(replacement);
    f.present(frame);
  } finally {
    f.close();
  }
});
