import { test, expect } from "bun:test";
import * as planView from "./plan_view";
import * as roadmap from "./activity/roadmap";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";
import * as palette from "./palette";

function fixture(): roadmap.Snapshot {
  const view = roadmap.emptyView();
  view.nodes = [
    {
      id: "e",
      parent: null,
      kind: "episode",
      title: "Correct retry offsets",
      subtitle: "A reset offset repeats the header",
      state: "active",
      evidence: [1],
    },
    {
      id: "s",
      parent: "e",
      kind: "step",
      title: "Run resume tests",
      subtitle: "The existing test exposed the regression",
      state: "failed",
      evidence: [1],
      bump: { kind: "verification", state: "open", detail: "Resume repeats the header", evidence: [1] },
    },
  ];
  view.known = true;
  view.focus = "e";
  view.focus_step = "s";
  view.counts = {
    e: { input: "2100", cached: "1000", output: "100", tools: "6" },
    s: { input: "2100", cached: "1000", output: "100", tools: "6" },
  };
  return view;
}
test.each(["corgi", "animal_style"] as const)(
  "plan renders a compact tail with local problems and whole-plan totals under %s",
  theme => {
    palette.use(theme);
    const view = fixture(),
      terminal = new Terminal(100, 30),
      rect = planView.geometry(100, 30);
    try {
      const writer = new Writer();
      planView.draw(writer, rect, "Download repair", view);
      terminal.feed(writer.buffered());
      const screen = terminal.text();
      expect(screen.split("\n")[rect.y + 1]).toContain("Correct retry offsets");
      expect(
        planView
          .tail(view, planView.capacity(rect))
          .rows.filter(r => r.kind === "node")
          .map(r => r.depth),
      ).toEqual([0, 1]);
      expect(screen.split("\n")[rect.y + 4]).toMatch(/^\s*Correct retry offsets/);
      expect(screen.split("\n")[rect.y + 5]).toContain("! Run resume tests");
      expect(screen.split("\n")[rect.y + 6]).toContain("Resume repeats the header");
      expect(screen.split("\n")[rect.y + 4]).not.toContain("!");
      expect(screen).toContain("! Run resume tests");
      expect(screen).not.toContain("✓");
      expect(screen).not.toContain("○");
      expect(screen).not.toContain("▾");
      expect(screen.split("\n").find(line => line.includes("Total"))).toMatch(/Total\s+≥2k\s+6\s+1k/);
      expect(screen).not.toContain("A reset offset repeats the header");
      expect(screen).not.toContain("Input ");
      expect(screen).not.toContain("PgUp");
      expect(screen).not.toContain("earlier items");
    } finally {
      terminal.destroy();
      palette.use("corgi");
    }
  },
);
test("a short terminal retains a close instruction; long labels stay inside the panel", () => {
  const writer = new Writer(),
    terminal = new Terminal(35, 10);
  try {
    planView.draw(writer, planView.geometry(35, 10), "Agent", fixture());
    terminal.feed(writer.buffered());
    expect(terminal.text()).toContain("Esc to close");
  } finally {
    terminal.destroy();
  }
});

test("a short tail keeps a setback, its explanation and episode together", () => {
  const view = fixture(),
    rect = planView.geometry(100, 12),
    terminal = new Terminal(100, 12);
  view.nodes.push({
    ...view.nodes[1],
    id: "s2",
    title: "Retry resume tests",
    bump: { ...view.nodes[1].bump!, state: "resolved" },
  });
  view.focus_step = "s2";
  try {
    const out = new Writer();
    planView.draw(out, rect, "Agent", view);
    terminal.feed(out.buffered());
    const lines = terminal.text().split("\n");
    expect(
      planView
        .tail(view, planView.capacity(rect))
        .rows.filter(r => r.kind === "node")
        .map(r => r.node.id),
    ).toEqual(["e", "s2"]);
    expect(lines[rect.y + 4]).toContain("Correct retry offsets");
    expect(lines[rect.y + 5]).toContain("! Retry resume tests");
    expect(lines[rect.y + 6]).toContain("Resume repeats the header");
    expect(terminal.text()).not.toContain("Resolved");
    expect(terminal.text()).not.toContain("more");
    expect(lines[rect.y + 8]).toContain("Total");
    expect(lines[rect.y + 9]).toContain("Esc close");
    expect(terminal.text()).not.toContain("! Run resume tests");
  } finally {
    terminal.destroy();
  }
});

test("long plans follow appended work, retain its episode, and total hidden work", () => {
  const view = fixture(),
    rect = planView.geometry(100, 24),
    terminal = new Terminal(100, 24);
  for (let i = 0; i < 60; i++) {
    const node = { ...view.nodes[1], id: "s" + i, title: "Inspect work item " + i, bump: null };
    view.nodes.push(node);
    view.counts[node.id] = roadmap.zero();
  }
  view.focus_step = "s59";
  const draw = () => {
    const out = new Writer();
    planView.draw(out, rect, "Agent", view);
    terminal.feed(out.buffered());
    return terminal.text();
  };
  try {
    expect(draw()).toContain("48 earlier items");
    expect(terminal.text()).toContain("├ … 48 more");
    expect(terminal.text()).not.toContain("(continued)");
    expect(terminal.text()).toContain("Inspect work item 59");
    expect(terminal.text()).not.toContain("Run resume tests");
    expect(terminal.text()).toContain("Correct retry offsets");
    expect(planView.tail(view, planView.capacity(rect)).rows.every(r => r.kind !== "node" || r.depth <= 1)).toBe(true);
    view.unassigned = { input: "1300", cached: "0", output: "0", tools: "1" };
    view.nodes.push({ ...view.nodes[1], id: "latest", title: "Verify final repair", state: "active", bump: null });
    view.focus_step = "latest";
    expect(draw()).toContain("Verify final repair");
    expect((terminal.text().match(/▶/g) ?? []).length).toBe(1);
    expect(terminal.text()).toContain("49 earlier items");
    expect(
      terminal
        .text()
        .split("\n")
        .find(line => line.includes("Total")),
    ).toMatch(/Total\s+≥3k\s+7\s+1k/);
    expect(terminal.text()).toContain("1k tokens unassigned");
    view.nodes[1].state = "active";
    view.nodes[1].bump = null;
    view.focus_step = "s";
    expect(
      planView
        .tail(view, 3)
        .rows.filter(r => r.kind === "node")
        .map(r => r.node.id),
    ).toEqual(["e", "latest", "s"]);
    expect(draw()).toContain("Run resume tests");
  } finally {
    terminal.destroy();
  }
});

test("legacy plans put the focused episode and step at the bottom, including in a short tail", () => {
  const view = fixture();
  view.nodes[1].state = "active";
  view.nodes[1].bump = null;
  view.nodes.push(
    { ...view.nodes[1], id: "s2", title: "Run another check" },
    { ...view.nodes[0], id: "e2", title: "Inspect another problem" },
    { ...view.nodes[1], id: "s3", parent: "e2", title: "Read the logs" },
  );
  const ids = (count: number) => planView.tail(view, count).rows.flatMap(r => (r.kind === "node" ? [r.node.id] : []));
  for (const [episode, step, expected] of [
    ["e", "s", ["e2", "s3", "e", "s2", "s"]],
    ["e2", "s3", ["e", "s", "s2", "e2", "s3"]],
    ["e", "s2", ["e2", "s3", "e", "s", "s2"]],
    ["e", "s", ["e2", "s3", "e", "s2", "s"]],
  ] satisfies [string, string, string[]][]) {
    view.focus = episode;
    view.focus_step = step;
    expect(ids(20)).toEqual(expected);
    const short = ids(4);
    expect(short).toContain(step);
    expect(short).toEqual(expected.filter(id => short.includes(id)));
    expect(short.at(-1)).toBe(step);
    expect(planView.tail(view, 20, false).rows.flatMap(r => (r.kind === "node" ? [r.node.id] : []))).toEqual(expected);
    const out = new Writer(),
      terminal = new Terminal(100, 20),
      rect = planView.geometry(100, 20);
    try {
      planView.draw(out, rect, "Agent", view);
      terminal.feed(out.buffered());
      expect(terminal.text().split("\n")[rect.y + 1]).toContain(
        episode === "e" ? "Correct retry offsets" : "Inspect another problem",
      );
    } finally {
      terminal.destroy();
    }
  }
});

test("completed work loses its play icon without moving the episode from the tail", () => {
  const view = fixture(),
    rect = planView.geometry(100, 18),
    terminal = new Terminal(100, 18);
  try {
    for (const state of ["active", "done", "active"] as const) {
      view.nodes.forEach(n => {
        n.state = state;
        n.bump = null;
      });
      const out = new Writer();
      planView.draw(out, rect, "Agent", view);
      terminal.feed(out.buffered());
      expect((terminal.text().match(/▶/g) ?? []).length).toBe(state === "active" ? 1 : 0);
      expect(terminal.text().split("\n")[rect.y + 4]).toContain("Correct retry offsets");
      expect(view.focus).toBe("e");
    }
    view.nodes.push(
      { ...view.nodes[0], id: "e2", title: "Verify final repair" },
      { ...view.nodes[1], id: "s2", parent: "e2", title: "Run integration suite" },
    );
    view.focus = "e2";
    view.focus_step = "s2";
    const out = new Writer();
    planView.draw(out, rect, "Agent", view);
    terminal.feed(out.buffered());
    expect(terminal.text()).toContain("┣▶ Run integration suite");
    expect((terminal.text().match(/▶/g) ?? []).length).toBe(1);
    view.focus = "e";
    view.focus_step = "s";
    expect(
      planView
        .tail(view, 3)
        .rows.filter(r => r.kind === "node")
        .map(r => r.node.id),
    ).toEqual(["e", "s"]);
  } finally {
    terminal.destroy();
  }
});

test("an episode without a known current step shows an ellipsis until attribution arrives", () => {
  const view = fixture();
  view.nodes = view.nodes.slice(0, 1);
  view.focus_step = null;
  expect(planView.tail(view, 3).rows.map(r => r.kind)).toEqual(["node", "pending"]);
  view.nodes.push({ ...fixture().nodes[1], state: "active", bump: null });
  view.focus_step = "s";
  expect(planView.tail(view, 3).rows.map(r => r.kind)).toEqual(["node", "node"]);
  view.nodes.forEach(n => (n.state = "done"));
  expect(planView.tail(view, 3).rows.some(r => r.kind === "pending")).toBe(false);
});

test("alternating investigation steps keep exact costs and put the latest work last across pauses", () => {
  const view = fixture();
  view.nodes[1] = { ...view.nodes[1], title: "Trace pending usage across handoff", state: "active", bump: null };
  view.nodes.push({ ...view.nodes[1], id: "tracker", title: "Trace activity tracker handoff state" });
  const order = ["s", "tracker", "s", "tracker", "s", "tracker", "s", "tracker", "s"];
  const inputs = [250_000, 350_000, 675_000, 578_000, 319_000, 112_000, 113_000, 0, 235_000];
  const tools = [7, 4, 10, 6, 3, 1, 1, 1, 2];
  for (let i = 0; i < order.length; i++) {
    view.visits.push({
      step: order[i],
      from: i + 1,
      to: i + 1,
      counts: { input: String(inputs[i]), cached: String(inputs[i] / 2), output: "0", tools: String(tools[i]) },
    });
    view.focus_step = order[i];
    const rows = planView.tail(view, 30, true).rows.filter(r => r.kind === "node");
    expect(rows.map(r => r.node.id)).toEqual(i ? ["e", order[i - 1], order[i]] : ["e", "s"]);
    expect(rows.filter(r => r.current && r.depth === 1).map(r => r.node.id)).toEqual([order[i]]);
    expect(planView.tail(view, 2, true).rows.some(r => r.kind === "node" && r.node.id === order[i] && r.current)).toBe(
      true,
    );
    const paused = planView.tail(view, 30, false).rows.filter(r => r.kind === "node");
    expect(paused.map(r => r.node.id)).toEqual(rows.map(r => r.node.id));
    expect(paused.some(r => r.current)).toBe(false);
  }
  const rows = planView.tail(view, 30, true).rows.filter(r => r.kind === "node");
  expect(rows.map(r => [r.node.id, r.counts?.input, r.counts?.cached, r.counts?.tools])).toEqual([
    ["e", "2632000", "1316000", "35"],
    ["tracker", "1040000", "520000", "12"],
    ["s", "1592000", "796000", "23"],
  ]);
  view.visits = roadmap.appendVisits(view.visits, [{ from: 10, to: 10, node: "tracker", focus: false }]);
  view.visits[1].counts.input = "350100";
  const before = structuredClone(view);
  const updated = planView.tail(view, 30, true).rows.filter(r => r.kind === "node");
  expect(updated.map(r => r.node.id)).toEqual(["e", "tracker", "s"]);
  expect(updated[1].counts?.input).toBe("1040100");
  expect(view).toEqual(before);
});

test("failed attempts and retries with the same title remain distinct", () => {
  const view = fixture();
  view.nodes.push({ ...view.nodes[1], id: "retry", state: "active", bump: null });
  view.visits = roadmap.appendVisits(
    [],
    [
      { from: 1, to: 2, node: "s" },
      { from: 3, to: 4, node: "retry" },
    ],
  );
  view.focus_step = "retry";
  const steps = planView
    .tail(view, 10, true)
    .rows.filter(r => r.kind === "node")
    .filter(r => r.depth === 1);
  expect(steps.map(r => r.node.id)).toEqual(["s", "retry"]);
  expect(steps.map(r => r.node.state)).toEqual(["failed", "active"]);
});

test("steps accumulate within an episode while returned episodes keep separate costs", () => {
  const view = fixture();
  view.nodes[1].state = "active";
  view.nodes[1].bump!.evidence = [1];
  view.nodes.push(
    { ...view.nodes[1], id: "s2", title: "Inspect retry logs", bump: null },
    { ...view.nodes[0], id: "e2", title: "Verify cache accounting" },
    { ...view.nodes[1], id: "s3", parent: "e2", title: "Check cache receipts", bump: null },
  );
  view.visits = roadmap.appendVisits(
    [],
    [
      { from: 1, to: 2, node: "s" },
      { from: 3, to: 4, node: "s2" },
      { from: 5, to: 6, node: "s" },
      { from: 7, to: 8, node: "s3" },
      { from: 9, to: 10, node: "s" },
    ],
  );
  view.visits.forEach((v, i) => {
    v.counts = { input: String((i + 1) * 100), cached: "50", output: "0", tools: "1" };
  });
  const rows = planView.tail(view, 30).rows.filter(r => r.kind === "node");
  expect(rows.map(r => r.node.id)).toEqual(["e", "s2", "s", "e2", "s3", "e", "s"]);
  expect(rows.filter(r => r.node.id === "s").map(r => r.counts?.input)).toEqual(["400", "500"]);
  expect(rows.filter(r => r.returned).map(r => r.node.id)).toEqual(["e"]);
  expect(rows.filter(r => r.current).map(r => r.node.id)).toEqual(["e", "s"]);
  expect(rows.filter(r => r.depth === 0).map(r => r.counts?.input)).toEqual(["600", "400", "500"]);
  expect(rows.filter(r => r.node.bump)).toHaveLength(1);
  expect(planView.tail(view, 3).rows.flatMap(r => (r.kind === "node" ? [r.node.id] : []))).toEqual(["e", "s"]);
  const terminal = new Terminal(112, 30),
    rect = planView.geometry(112, 30);
  try {
    const out = new Writer();
    planView.draw(out, rect, "Agent", view);
    terminal.feed(out.buffered());
    const screen = terminal.text();
    expect((screen.match(/▶/g) ?? []).length).toBe(1);
    expect(screen).toContain("↩ Correct retry offsets");
    expect(screen).not.toContain("↩ Run resume tests");
    expect(
      screen
        .split("\n")
        .filter(l => l.includes("Run resume tests"))
        .at(-1),
    ).toMatch(/▶ Run resume tests\s+500\s+1\s+50/);
    const last = planView.tail(view, 30).rows.at(-1)!;
    expect(last.kind === "node" && last.current).toBe(true);
    view.nodes[1].bump!.state = "resolved";
    const updated = planView.tail(view, 30).rows.filter(r => r.kind === "node");
    expect(updated.find(r => r.node.id === "s")!.node.bump?.state).toBe("resolved");
    expect(updated.at(-1)!.node.bump).toBeNull();
  } finally {
    terminal.destroy();
  }
});

test("a running agent keeps a tail marker between named steps without reopening completed work", () => {
  const view = fixture(),
    terminal = new Terminal(100, 18),
    rect = planView.geometry(100, 18);
  view.nodes.forEach(n => {
    n.state = "done";
    n.bump = null;
  });
  view.visits = roadmap.appendVisits([], [{ from: 1, to: 1, node: "s" }]);
  view.visits[0].counts = view.counts.s;
  const before = structuredClone(view);
  const draw = (running: boolean) => {
    const out = new Writer();
    planView.draw(out, rect, "Agent", view, running);
    terminal.feed(out.buffered());
    return terminal.text();
  };
  try {
    expect(draw(true)).toContain("▶ …");
    expect((terminal.text().match(/▶/g) ?? []).length).toBe(1);
    expect(
      terminal
        .text()
        .split("\n")
        .find(l => l.includes("Run resume tests")),
    ).not.toContain("▶");
    expect(terminal.text()).toContain("╰  Run resume tests");
    expect(planView.tail(view, 3, true).rows.at(-1)).toEqual({ kind: "pending", parent: null, active: true });
    expect(view).toEqual(before);
    expect(draw(false)).not.toContain("▶");
    view.nodes[0].state = "active";
    expect((draw(true).match(/▶/g) ?? []).length).toBe(1);
    expect(terminal.text()).toContain("┣▶ …");
    view.nodes[1].state = "active";
    expect(draw(true)).not.toContain("▶ …");
    expect((terminal.text().match(/▶/g) ?? []).length).toBe(1);
    expect(draw(false)).not.toContain("▶");
    const out = new Writer();
    planView.draw(out, rect, "New agent", roadmap.emptyView(), true);
    terminal.feed(out.buffered());
    expect(terminal.text()).toContain("▶ …");
  } finally {
    terminal.destroy();
  }
});

test("a short tooltip keeps a running tool with its step when later tools finish", () => {
  const view = fixture();
  view.nodes[1].bump = null;
  view.nodes[1].state = "active";
  view.visits = [{ step: "s", from: 1, to: 9, counts: roadmap.zero() }];
  view.tool_rows = Array.from({ length: 8 }, (_, i) => ({ visit: 1, title: "Call " + i, running: i === 0 }));
  const { rows } = planView.tail(view, 5, true);
  expect(planView.height(rows)).toBeLessThanOrEqual(5);
  expect(rows.flatMap(r => (r.kind === "node" ? [r.node.id] : []))).toEqual(["e", "s"]);
  expect(rows.some(r => r.kind === "tool" && r.title === "Call 0" && r.active)).toBe(true);
  expect(planView.tail(view, 5, false).rows.some(r => r.kind === "tool" && r.active)).toBe(false);
});

test("expanded tools pin the remaining count below the moving window of calls", () => {
  const view = roadmap.emptyView();
  const members = Array.from({ length: 44 }, (_, i) => "Read source " + (i + 1));
  view.tool_rows = [{ first: 1, visit: null, running: false, title: "Inspected sources", members, outcome: "success" }];
  const lines = (offset: number, count = 12) => {
    const result: string[] = [];
    planView.drawRows(view, planView.tail(view, count, false, { id: 1, offset }).rows, 80, {
      line: (_, text) => result.push(text.trim()),
      mark: () => {},
    });
    return result;
  };
  const first = lines(0);
  expect(first[1]).toBe("· Read source 1");
  expect(first.at(-1)).toBe("↓ 38 more");
  const middle = lines(20);
  expect(middle[1]).toBe("· Read source 21");
  expect(middle[first.length - 1]).toBe("↓ 18 more");
  expect(lines(37).at(-1)).toBe("↓ 1 more");
  const last = lines(1000);
  expect(last).toHaveLength(first.length);
  expect(last.at(-2)).toBe("· Read source 44");
  expect(last.at(-1)).toBe("");
  expect(lines(0, 4)).toEqual([
    "▾ ✓ Succeeded (1–2/44) Inspected sources",
    "· Read source 1",
    "· Read source 2",
    "↓ 42 more",
  ]);
  view.tool_rows[0].members = members.slice(0, 2);
  expect(lines(100)).toEqual(["▾ ✓ Succeeded (2) Inspected sources", "· Read source 1", "· Read source 2"]);
});

test("an opaque result keeps its count and offers details only when recorded", () => {
  const view = roadmap.emptyView();
  const row: NonNullable<roadmap.Snapshot["tool_rows"]>[number] = {
    first: 1,
    visit: null,
    running: false,
    title: "…",
    members: ["…"],
    outcome: "success",
  };
  view.tool_rows = [row];
  const draw = () => {
    const lines: string[] = [];
    planView.drawRows(view, planView.tail(view, 12, false, { id: 1, offset: 0 }).rows, 80, {
      line: (_, text) => lines.push(text.trim()),
      mark: () => {},
    });
    return lines;
  };
  expect(draw()).toEqual(["✓ Succeeded (1)"]);
  row.members = ["…", "Run tests", "…"];
  expect(draw()).toEqual(["▾ ✓ Succeeded (3)", "· Run tests", "· Without a description: 2"]);
});
