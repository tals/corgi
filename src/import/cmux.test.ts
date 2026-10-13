import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { convert, saved } from "./cmux";
import { validate } from "./layout";
import type { Tab } from "./catalog";
function shape(tab: Tab, index = tab.nodes.length - 1): string {
  const node = tab.nodes[index];
  if ("pane" in node) return tab.panes[node.pane].id;
  return `${node.split.axis === "horizontal" ? "h" : "v"}${node.split.ratio}(${shape(tab, node.split.first)},${shape(tab, node.split.second)})`;
}
test("cmux selected surfaces first then stable layers, every surface exactly once", () => {
  const source = JSON.parse(readFileSync(new URL("../testdata/cmux-tree.json", import.meta.url), "utf8")).windows[0]
    .workspaces;
  const ws = convert(source[0])!;
  expect(ws.recovery).toBe("full");
  expect(ws.tabs.map(t => shape(t))).toEqual(["h600(A,Y)", "h600(B,X)", "C"]);
  expect(ws.tabs[0].panes[0].name).toBe("Editor");
  expect(ws.tabs[0].panes[0].cwd).toBe("/tmp");
  expect(ws.tabs[2].panes[0].url).toBe("https://example.test/docs");
  expect(convert(source[1])!.recovery).toBe("layout");
  expect(shape(convert(source[1])!.tabs[0])).toBe("h500(Q,Z)");
  expect(convert(source[2])!.recovery).toBe("workspace");
  expect(convert(source[2])!.name).toBe("research");
  expect(shape(convert(source[2])!.tabs[0])).toBe("new-shell");
});
test("cmux nested layouts collapse empty branches without losing split ratios", () => {
  const ws = convert({
    id: "ws",
    panes: [
      { id: "left", surfaces: [{ id: "A" }, { id: "B" }] },
      { id: "top", surfaces: [{ id: "C" }] },
      { id: "bottom", surfaces: [{ id: "D" }, { id: "E" }] },
    ],
    layout: {
      direction: "horizontal",
      split: 0.7,
      children: [
        { pane: { id: "left" } },
        {
          direction: "vertical",
          split: 0.3,
          children: [{ pane: { id: "top" } }, { pane: { id: "bottom" } }],
        },
      ],
    },
  })!;
  expect(ws.tabs.map(t => shape(t))).toEqual(["h700(A,v300(C,D))", "h700(B,E)"]);
});
test("cmux malformed tree falls back to pixel geometry joined by pane id", () => {
  const ws = convert(
    {
      id: "ws",
      panes: [
        { id: "bottom", surfaces: [{ id: "B" }] },
        { id: "top", surfaces: [{ id: "A" }] },
      ],
      layout: {
        direction: "horizontal",
        split: 0.5,
        children: [{ pane: { id: "top" } }, { pane: { id: "not-a-pane" } }],
      },
    },
    {
      panes: [
        { id: "top", pixel_frame: { x: 100, y: 50, width: 100, height: 30 } },
        {
          id: "bottom",
          pixel_frame: { x: 100, y: 80, width: 100, height: 70 },
        },
      ],
    },
  )!;
  expect(ws.recovery).toBe("layout");
  expect(shape(ws.tabs[0])).toBe("v300(A,B)");
});
test("cmux keeps readable surfaces despite malformed and duplicate entries", () => {
  const ws = convert({
    name: "old workspace",
    panes: [
      {
        surfaces: [
          false,
          {},
          { id: "A", title: "kept" },
          { id: "A", title: "duplicate" },
          { name: "missing id", selected: true },
        ],
      },
      null,
      { id: "broken", surfaces: "new schema" },
    ],
  })!;
  expect(ws.recovery).toBe("partial");
  expect(ws.tabs.length).toBe(2);
  expect(ws.tabs[0].panes[0].name).toBe("missing id");
  expect(ws.tabs[1].panes[0].id).toBe("A");
  expect(ws.tabs[0].panes.length).toBe(1);
  expect(convert({ name: "names survive" })!.recovery).toBe("workspace");
  for (const input of [
    { panes: [{ surfaces: [{ id: "A" }, { id: "B" }] }] },
    { surfaces: [{ id: "A" }, { id: "B" }] },
  ]) {
    const unnamed = convert(input)!;
    expect(unnamed.name).toBe("Untitled");
    expect(unnamed.recovery).toBe("partial");
    expect(unnamed.tabs.map(t => shape(t))).toEqual(["A", "B"]);
  }
  expect(convert(null)).toBe(null);
});
test("cmux projection retains each surface once across uneven stack sizes and selections", () => {
  for (let left = 1; left < 5; left++)
    for (let middle = 1; middle < 5; middle++)
      for (let right = 1; right < 5; right++) {
        const counts = [left, middle, right],
          panes = counts.map((count, pi) => ({
            id: `pane-${pi}`,
            surfaces: Array.from({ length: count }, (_, si) => ({
              id: `${pi}-${si}`,
              selected: si === (left + middle + right + pi) % count,
            })),
          })),
          ws = convert({ id: "ws", panes })!;
        expect(ws.tabs.length).toBe(Math.max(...counts));
        const seen = new Set<string>();
        for (const tab of ws.tabs) {
          validate(tab.nodes, tab.panes.length);
          for (const p of tab.panes) {
            expect(seen.has(p.id)).toBe(false);
            seen.add(p.id);
          }
        }
        expect(seen.size).toBe(left + middle + right);
        for (const [pi, p] of ws.tabs[0].panes.entries())
          expect(p.id).toBe(panes[pi].surfaces[(left + middle + right + pi) % counts[pi]].id);
      }
});
test("cmux saved sessions import like the tree, splits and selections intact", () => {
  const session = JSON.parse(readFileSync(new URL("../testdata/cmux-session.json", import.meta.url), "utf8"));
  const [project, notes, research] = saved(session)!.map(ws => convert(ws)!);
  expect(project.name).toBe("cmux project");
  expect(project.recovery).toBe("full");
  expect(project.tabs.map(t => shape(t))).toEqual(["h600(B,v300(C,D))", "A"]);
  const [build, docs] = project.tabs[0].panes;
  expect([build.name, build.cwd, build.restart_command]).toEqual(["Build", "/var/tmp", ""]);
  expect(docs.url).toBe("https://example.test/docs");
  expect(project.tabs[1].panes[0].restart_command).toBe("");
  expect([notes.name, notes.recovery]).toEqual(["notes", "partial"]);
  expect(notes.tabs.map(t => shape(t))).toEqual(["E"]);
  expect([research.name, research.recovery]).toEqual(["research", "workspace"]);
  expect(saved({ windows: [{ tabManager: {} }] })).toBe(null);
  expect(saved(null)).toBe(null);
});
