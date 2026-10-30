import { expect, spyOn, test } from "bun:test";
import { Controller } from "./controller";
import { Picker } from "./agent_navigation";
import { transport } from "./fixtures/transport";
import { Rect } from "./layout";
import { View, type Section } from "./sidebar";
import * as sidebarFocus from "./sidebar_focus";

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
