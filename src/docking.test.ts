import { expect, test } from "bun:test";
import * as layout from "./layout";
import * as docking from "./docking";
import * as protocol from "./protocol";
import { Drag } from "./docking_drag";

function scene(axis: layout.Axis | null = null) {
  const model = new layout.Model(),
    a = model.newTab("A"),
    b = axis ? model.split(a, axis) : null,
    source = model.newTab("C");
  const selection = new layout.Selection();
  selection.reconcile(model);
  const view = new layout.View(model, selection),
    area = new layout.Rect(0, 1, 120, 35);
  const drag = new Drag(1, { tab: model.tabs[1].id }, source, model, selection, area, 0, 120, 36, 17, 0);
  drag.dragging = true;
  return { model, view, area, drag, a, b, source };
}
test("docking carries a tab tree without mutating shared state", () => {
  const s = scene("horizontal"),
    original = docking.shape(s.model);
  const extra = s.model.split(s.source, "vertical");
  for (const direction of ["left", "right", "up", "down"] as const) {
    const before = docking.shape(s.model);
    const plan = docking.arrange(
      s.model,
      s.drag.source,
      { kind: "beside", pane: s.b!, direction, whole: false },
      extra,
      s.model.next_id,
    );
    expect(docking.shape(s.model)).toBe(before);
    expect(plan.model.count).toBe(1);
    expect(plan.focus).toBe(extra);
    expect(docking.panes(plan.model, plan.model.tabs[0].root).sort()).toEqual([s.a, s.b!, s.source, extra].sort());
  }
  expect(original).not.toBe(docking.shape(s.model));
});
test("a preview holds until crossing the midpoint, in both directions", () => {
  const s = scene();
  for (const reverse of [false, true]) {
    const xs = Array.from({ length: 120 }, (_, i) => i);
    if (reverse) xs.reverse();
    for (const x of xs) {
      s.drag.update(s.view, x, 15, 87, 1000);
      expect(s.drag.drop).toEqual({ kind: "beside", pane: s.a, direction: x < 60 ? "left" : "right", whole: false });
      expect(s.drag.plan).not.toBeNull();
    }
  }
});
test("outer frame targets nest in each leaf; the broad middle joins both", () => {
  for (const axis of ["horizontal", "vertical"] as const) {
    const s = scene(axis);
    const places = s.view.placements(s.area);
    for (const before of [true, false]) {
      for (const p of places) {
        const x = axis === "horizontal" ? p.rect.x + Math.floor(p.rect.w / 2) : before ? 0 : 119;
        const y = axis === "horizontal" ? (before ? 1 : 35) : p.rect.y + Math.floor(p.rect.h / 2);
        const drop = docking.target(s.view, s.area, x, y, null, false)!;
        expect(drop).toEqual({
          kind: "beside",
          pane: p.id,
          direction: axis === "horizontal" ? (before ? "up" : "down") : before ? "left" : "right",
          whole: false,
        });
        const plan = docking.arrange(s.model, s.drag.source, drop, s.source, s.model.next_id);
        const sibling = places.find(other => other.id !== p.id)!;
        expect(
          docking
            .view(plan)
            .placements(s.area)
            .find(other => other.id === sibling.id),
        ).toEqual(sibling);
      }
      const root = s.model.nodes[s.model.tabs[0].root]!;
      if (!("split" in root)) throw Error("ExpectedSplit");
      const middle = layout.splitRects(root.split, s.view.contentArea(s.area))[1];
      const drop = docking.target(
        s.view,
        s.area,
        axis === "horizontal" ? middle.x : before ? 0 : 119,
        axis === "horizontal" ? (before ? 1 : 35) : middle.y,
        null,
        false,
      );
      expect(drop && "whole" in drop && drop.whole).toBe(true);
    }
  }
});
test("pane drags can leave an edge preview for a center swap", () => {
  for (const axis of [null, "horizontal", "vertical"] as const) {
    const s = scene(axis),
      place = s.view.placements(s.area)[0],
      x = place.rect.x + Math.floor(place.rect.w / 2),
      y = place.rect.y + Math.floor(place.rect.h / 2);
    for (const whole of [false, true]) {
      const previous = { pane: place.id, whole, point: { direction: "up" as const, x, y: s.area.y } };
      const drop = docking.target(s.view, s.area, x, y, previous, true);
      expect(drop).toEqual({ kind: "swap", pane: place.id });
    }
  }
});
test("self-tab drops add a shell; pane self-drops and no-op reorders do not", () => {
  const s = scene("horizontal"),
    before = docking.shape(s.model);
  const drop = { kind: "beside" as const, pane: s.a, direction: "down" as const, whole: false };
  const plan = docking.arrange(s.model, { tab: s.model.tabs[0].id }, drop, s.b!, s.model.next_id);
  expect(plan.shell).toBe(s.model.next_id);
  expect(plan.focus).toBe(plan.shell!);
  expect(plan.model.count).toBe(s.model.count);
  expect(docking.shape(s.model)).toBe(before);
  expect(() => docking.arrange(s.model, { pane: s.a }, drop, s.a, s.model.next_id)).toThrow("InvalidDestination");
  expect(() => docking.arrange(s.model, s.drag.source, { kind: "tab", index: 1 }, s.source, s.model.next_id)).toThrow(
    "AlreadyHere",
  );
});
test("malformed docking requests are rejected at the wire boundary", () => {
  const request = {
    workspace: 1,
    viewer: 1,
    expected: 0,
    source: { tab: 2 },
    drop: { kind: "beside", pane: 3, direction: "down", whole: false },
    focus: 1,
    selected: 3,
    cols: 120,
    rows: 35,
  };
  expect(Object.keys(protocol.decodeCommand({ "layout.dock": request }))).toEqual(["layout.dock"]);
  for (const patch of [
    { source: { tab: 2, pane: 1 } },
    { drop: { ...request.drop, direction: "diagonal" } },
    { drop: { ...request.drop, arbitrary: true } },
    { expected: -1 },
  ])
    expect(() => protocol.decodeCommand({ "layout.dock": { ...request, ...patch } })).toThrow();
});
