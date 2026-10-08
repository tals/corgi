import { test, expect } from "bun:test";
import { Model, Selection, View, Rect } from "./layout";
test("nested split close preserves stable identities and collapses tree", () => {
  const m = new Model(),
    a = m.newTab(""),
    b = m.split(a, "horizontal"),
    c = m.split(b, "vertical");
  m.close(b);
  expect(m.findNode(b)).toBeNull();
  expect(m.firstPane(m.tabs[0].root)).toBe(a);
  expect(m.tabForPane(c)).toBe(0);
  m.close(a);
  expect(m.firstPane(m.tabs[0].root)).toBe(c);
  m.close(c);
  expect(m.count).toBe(0);
});
test("layout JSON validates identity, tree ownership, ratios and cycles", () => {
  const m = new Model();
  m.split(m.newTab("hello"), "horizontal");
  expect(Model.fromData(m.toJSON()).toJSON()).toEqual(m.toJSON());
  expect(() =>
    Model.fromData({
      nodes: [{ pane: 0 }],
      tabs: [{ id: 2, root: 0, title: "" }],
      revision: 0,
    } as any),
  ).toThrow("UnexpectedToken");
  expect(() =>
    Model.fromData({
      nodes: [{ split: { axis: "horizontal", ratio: 500, first: 0, second: 0 } }],
      tabs: [{ id: 2, root: 0, title: "" }],
      revision: 0,
    } as any),
  ).toThrow("UnexpectedToken");
});
test("selection survives reordered tabs and closed neighbor", () => {
  const m = new Model(),
    a = m.newTab(""),
    b = m.newTab(""),
    c = m.newTab(""),
    s = new Selection();
  s.reconcile(m);
  s.focus(m, b);
  m.close(b);
  s.reconcile(m);
  expect(s.tab().focus).toBe(a);
  m.moveTab(m.tabs[1].id, 0);
  s.reconcile(m);
  expect(s.tab().focus).toBe(a);
  expect(m.tabForPane(c)).toBe(0);
});
test("framed split geometry and divider agree", () => {
  const m = new Model(),
    a = m.newTab(""),
    b = m.split(a, "horizontal"),
    s = new Selection();
  s.reconcile(m);
  const v = new View(m, s),
    area = new Rect(0, 0, 82, 26),
    p = v.placements(area);
  expect(p[0].rect).toEqual(new Rect(1, 1, 39, 24));
  expect(v.neighbor("right", area)).toBe(b);
  expect(v.dividerAt(area, 40, 2)?.axis).toBe("horizontal");
  expect(v.borders(area)).toHaveLength(5);
  s.tab().zoom = true;
  expect(v.placements(area)).toEqual([{ id: a, rect: area }]);
});

test("tab insertion preserves order, names, splits and logical focus", () => {
  const m = new Model(),
    s = new Selection();
  m.newTab("");
  s.reconcile(m);
  const first = m.tabs[0];
  m.newTab("named");
  s.reconcile(m);
  s.active = 1;
  const added = m.split(s.tab().focus, "horizontal");
  s.reconcile(m);
  s.focus(m, added);
  const second = m.tabs[1];
  m.newTab("");
  s.reconcile(m);
  s.active = 2;
  const third = m.tabs[2];
  m.moveTab(first.id, 3);
  s.reconcile(m);
  expect(m.tabs).toEqual([second, third, first]);
  expect(s.tab().id).toBe(third.id);
  m.moveTab(first.id, 0);
  s.reconcile(m);
  expect(m.tabs).toEqual([first, second, third]);
  m.moveTab(second.id, 2);
  s.reconcile(m);
  expect(m.tabs).toEqual([first, second, third]);
  expect(s.tab().id).toBe(third.id);
});
test("divider cells match gaps at every size and drag lands on requested cell", () => {
  const m = new Model(),
    s = new Selection(),
    a = m.newTab(""),
    b = m.split(a, "horizontal");
  m.split(b, "vertical");
  s.reconcile(m);
  const v = new View(m, s);
  for (let width = 0; width < 20; width++)
    for (let height = 0; height < 14; height++) {
      const area = new Rect(3, 2, width, height),
        p = v.placements(area),
        borders = v.borders(area);
      for (let y = area.y; y < area.y + area.h; y++)
        for (let x = area.x; x < area.x + area.w; x++) {
          let coverage = 0;
          for (const pane of p) if (pane.rect.contains(x, y)) coverage++;
          for (const border of borders)
            if (border.rect.contains(x, y)) {
              coverage++;
              expect(v.dividerAt(area, x, y) !== null).toBe(border.draggable);
            }
          expect(coverage).toBe(1);
        }
    }
  const area = new Rect(28, 1, 72, 28),
    d = v.dividerAt(area, 63, 2)!;
  const n = m.nodes[d.node]!;
  if ("split" in n) n.split.ratio = View.dividerRatio(d, 75, 2);
  expect(v.dividerAt(area, 75, 2)).not.toBeNull();
  s.tab().zoom = true;
  expect(v.borders(area)).toHaveLength(0);
  expect(v.dividerAt(area, 75, 2)).toBeNull();
});
test("only split layouts reserve an outer frame and closing restores the area", () => {
  const m = new Model(),
    s = new Selection(),
    a = m.newTab("");
  s.reconcile(m);
  const v = new View(m, s),
    area = new Rect(28, 1, 72, 28);
  expect(v.placements(area)[0].rect).toEqual(area);
  const b = m.split(a, "horizontal");
  s.reconcile(m);
  s.focus(m, b);
  for (const p of v.placements(area)) {
    expect(p.rect.x).toBeGreaterThan(area.x);
    expect(p.rect.y).toBeGreaterThan(area.y);
    expect(p.rect.x + p.rect.w).toBeLessThan(area.x + area.w);
    expect(p.rect.y + p.rect.h).toBeLessThan(area.y + area.h);
  }
  m.close(b);
  s.reconcile(m);
  expect(v.placements(area)[0].rect).toEqual(area);
});
test("shared model decoder rejects cycles orphan nodes and duplicate panes", () => {
  for (const d of [
    {
      nodes: [{ split: { axis: "horizontal", ratio: 500, first: 0, second: 1 } }, { pane: 1 }],
      tabs: [{ id: 2, root: 0, title: "" }],
      revision: 1,
    },
    {
      nodes: [{ pane: 1 }, { pane: 3 }],
      tabs: [{ id: 2, root: 0, title: "" }],
      revision: 1,
    },
    {
      nodes: [{ pane: 1 }, { pane: 1 }],
      tabs: [
        { id: 2, root: 0, title: "" },
        { id: 3, root: 1, title: "" },
      ],
      revision: 1,
    },
  ])
    expect(() => Model.fromData(d as any)).toThrow("UnexpectedToken");
});
test("closing the selected tab selects its nearest neighbour, preferring the left", () => {
  const m = new Model(),
    selection = new Selection();
  m.newTab("one");
  m.newTab("two");
  const c = m.newTab("three");
  m.newTab("four");
  selection.reconcile(m);
  selection.active = 2;
  m.close(c);
  selection.reconcile(m);
  expect(selection.active).toBe(1);
  selection.active = 0;
  m.removeTab(0);
  selection.reconcile(m);
  expect(selection.active).toBe(0);
  expect(selection.tabs[0].id).toBe(m.tabs[0].id);
  selection.active = 1;
  m.removeTab(1);
  selection.reconcile(m);
  expect(selection.active).toBe(0);
});
test("directional focus, zoom and resize keep geometry inside bounds", () => {
  const m = new Model(),
    selection = new Selection(),
    view = new View(m, selection),
    a = m.newTab("one");
  selection.reconcile(m);
  selection.active = m.count - 1;
  const b = m.split(selection.tab().focus, "horizontal");
  selection.reconcile(m);
  selection.focus(m, b);
  expect(view.neighbor("left", new Rect(0, 0, 81, 24))).toBe(a);
  m.resize(selection.tab().focus, "left");
  for (const placement of view.placements(new Rect(0, 0, 1, 1))) {
    expect(placement.rect.x + placement.rect.w).toBeLessThanOrEqual(1);
    expect(placement.rect.y + placement.rect.h).toBeLessThanOrEqual(1);
  }
  selection.tab().zoom = true;
  expect(view.placements(new Rect(0, 0, 81, 24))[0].id).toBe(b);
});

test("layout parser retains u64 revision and unnamed tab defaults", () => {
  const model = Model.jsonParse('{"nodes":[{"pane":1}],"tabs":[{"id":1,"root":0}],"revision":18446744073709551615}');
  expect(model.revision).toBe(18446744073709551615n);
  expect(model.tabs[0].title).toBe("");
  expect(Model.jsonParseFromValue(model.toJSON()).toJSON()).toEqual(model.toJSON());
});
