import { expect, spyOn, test } from "bun:test";
import { Controller } from "./controller";
import { Picker } from "./agent_navigation";
import { transport } from "./fixtures/transport";
import { Rect } from "./layout";
import { View, workspaceEntry, resourceAt, type Section } from "./sidebar";
import { Writer } from "./text";
import * as sidebarFocus from "./sidebar_focus";

test("archived workspaces fold at the bottom, scroll independently, and do not overlap active rows", () => {
  const active = Array.from({ length: 20 }, (_, i) =>
    workspaceEntry({ id: i + 1, name: `Active ${i}`, cwd: "", active: i === 0 }),
  );
  const archived = Array.from({ length: 32 }, (_, i) => ({ id: i + 100, name: `Archive ${i}`, active: false }));
  for (const rows of [13, 16, 24, 50])
    for (const enabled of [true, false]) {
      let v = View.init(100, rows, true, 0, 0);
      v.resources = { enabled };
      v = v.withArchives(archived.length, false, 0).withWorkspaces(active.length, 0);
      expect(v.archivedHeader()).toBe(v.middle() - 2);
      expect(v.hit(3, v.archivedHeader()!)).toEqual({ tag: "archives" });
      const closed = new Writer();
      v.draw(closed, [], active, archived);
      expect(closed.buffered()).toContain("▸ 32 archived");
      expect(closed.buffered()).not.toContain("Archive 0");
      v = v.withArchives(archived.length, true, 100).withWorkspaces(active.length, 0);
      const header = v.archivedHeader()!;
      for (let slot = 0; slot < v.workspaceCapacity(); slot++)
        expect(2 + slot * v.workspaceRows() + 1).toBeLessThan(header);
      for (let row = 0; row < v.archivedCapacity() * 3; row++) {
        const y = header + 1 + row;
        expect(v.hit(3, y)).toEqual({ tag: "archived_workspace", workspace: v.archived_offset + Math.floor(row / 3) });
        expect(resourceAt(v, active, 3, y)).toBeNull();
        expect(v.workspaceDrop(3, y)).toBeNull();
        expect(y).toBeLessThan(v.middle() - 1);
      }
      const expanded = new Writer();
      v.draw(expanded, [], active, archived);
      expect(expanded.buffered()).toContain("▾ 32 archived");
      expect(expanded.buffered()).toContain("Archive 31");
    }
});

test("sidebar geometry preserves compact, search, width, panel and drawer boundaries", () => {
  for (const cols of [0, 19, 39, 40, 47, 63, 64, 80, 160])
    for (const rows of [0, 12, 13, 48])
      for (const open of [false, true])
        for (const searching of [false, true])
          for (const preferred of [0, 19, 20, 28, 300]) {
            let width = rows >= 13 && open && cols >= 64 ? 28 : 0;
            if (searching && cols >= 40 && rows >= 13) width = Math.min(28, cols - 20);
            if (width > 0) width = Math.max(20, Math.min(preferred, cols - 20));
            const computed = View.fitWidth(cols, View.widthFor(cols, open, rows, searching), preferred);
            expect(computed).toBe(width);
            const view = View.init(cols, rows, open, 0, 0)
              .withSearch(searching ? { text: "", cursor: 0, selection: null } : null)
              .withWidth(preferred);
            expect(view.width).toBe(width);
            for (const drawer of [null, "agents", "workspaces"] as const)
              for (const panel of [0, 40, 200]) {
                const x = drawer === null ? width : 0;
                const expected = new Rect(x, 1, Math.max(0, cols - x - panel), Math.max(0, rows - 1));
                view.drawer = drawer;
                expect(view.withPanel(panel).area()).toEqual(expected);
                expect(View.paneArea(cols, rows, computed, panel, drawer)).toEqual(expected);
              }
          }
});

test("controller pane geometry agrees with its complete sidebar without constructing it", () => {
  const view = new Controller(
    transport(async () => {
      throw Error("UnexpectedRequest");
    }),
  );
  // This geometry does not depend on workspace or list contents.
  view.prefs.agents = "all";
  const picker = new Picker(1);
  const focus = new sidebarFocus.State({ workspace: 1 });
  try {
    for (const cols of [39, 40, 63, 64, 80, 160])
      for (const rows of [12, 13, 48])
        for (const open of [false, true])
          for (const searching of [false, true])
            for (const preferred of [20, 28, 300])
              for (const review of [false, true])
                for (const drawer of [null, "agents", "workspaces"] as (Section | null)[]) {
                  view.width = cols;
                  view.height = rows;
                  view.sidebar_open = open;
                  view.agent_picker = searching ? picker : null;
                  view.prefs.sidebar_width = preferred;
                  view.prefs.review_width = preferred;
                  view.review.open = review;
                  focus.drawer = drawer;
                  view.keyboard = { sidebar: focus };
                  expect(view.area()).toEqual(view.sidebarView([]).area());
                }
    const expected = view.sidebarView([]).area();
    const sidebar = spyOn(view, "sidebarView").mockImplementation(() => {
      throw Error("UnexpectedSidebarConstruction");
    });
    try {
      expect(view.area()).toEqual(expected);
    } finally {
      sidebar.mockRestore();
    }
  } finally {
    view.runtime.destroy();
  }
});
