import { expect, test } from "bun:test";
import { Hover, draw } from "./connectivity_card";
import { Stats } from "./connection_stats";
import { Rect } from "./layout";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";
import * as sidebar from "./sidebar";

const connection = (name: string) => ({ name, stats: new Stats(), description: () => "online" });

test("connection hover waits one second, follows its machine, and stays open over the card", () => {
  const hover = new Hover(),
    atlas = connection("atlas"),
    borealis = connection("borealis");
  const header = { machine: "atlas", rect: new Rect(2, 2, 34, 1) };
  atlas.stats.answer(20, false, 1000);
  atlas.stats.answer(40, false, 1000);
  hover.move(header, 20, 2, 1000);
  hover.move(header, 25, 2, 1500);
  expect(hover.update(atlas, 120, 40, 1999)).toBeNull();
  expect(hover.due()).toBe(2000);
  const card = hover.update(atlas, 120, 40, 2000)!;
  expect(card.lines[0].text).toBe("atlas · online");
  expect(card.lines.some(line => line.text === "Response  30 ms ± 10 ms (peak 40 ms)")).toBe(true);
  hover.move(null, card.rect.x + 3, card.rect.y + 2, 2100);
  expect(hover.machine).toBe("atlas");
  hover.move({ machine: "borealis", rect: new Rect(2, 7, 34, 1) }, 20, 7, 2200);
  expect(hover.update(borealis, 120, 40, 3199)).toBeNull();
  expect(hover.update(borealis, 120, 40, 3200)?.lines[0].text).toBe("borealis · online");
  hover.move(null, 0, 0, 3300);
  expect(hover.card).toBeNull();
  expect(hover.due()).toBe(Infinity);
  hover.clear();
  expect(hover.update(borealis, 120, 40, 5000)).toBeNull();
});

test("connection card stays on screen and omits the developer controls and noisy footer", () => {
  for (const [cols, rows] of [
    [120, 40],
    [80, 24],
    [40, 12],
  ]) {
    const hover = new Hover(),
      endpoint = connection("atlas");
    hover.move({ machine: "atlas", rect: new Rect(2, rows - 3, 34, 1) }, 20, rows - 3, 0);
    const card = hover.update(endpoint, cols, rows, 1000)!;
    expect(card.rect.x + card.rect.w).toBeLessThanOrEqual(cols);
    expect(card.rect.y + card.rect.h).toBeLessThanOrEqual(rows);
    const w = new Writer(),
      terminal = new Terminal(cols, rows);
    try {
      draw(w, card);
      terminal.feed(w.buffered());
      expect(terminal.text()).toContain("atlas · online");
      expect(terminal.text()).toContain("Response  —");
      expect(terminal.text()).not.toMatch(/Last data|s \/ cell|Stall after|network policy|Network policy|Developer/);
    } finally {
      terminal.destroy();
    }
  }
});

test("machine header hover follows repeated groups, scrolling, and resources layout", () => {
  const names = ["atlas", "local", "atlas", "borealis"];
  for (const resources of [true, false])
    for (const offset of [0, 1, 2]) {
      const side = sidebar.View.init(120, 50, true, 0, 0).withWidth(40).withWorkspaces(4, offset, names);
      side.resources.enabled = resources;
      for (let i = offset; i < offset + side.workspaceCapacity(); i++) {
        const y = side.workspaceY(i) - 1;
        expect(sidebar.machineHeaderAt(side, 10, y)?.machine).toBe(names[i]);
        expect(sidebar.machineHeaderAt(side, 10, y + 1)).toBeNull();
        expect(sidebar.machineHeaderAt(side, 45, y)).toBeNull();
      }
    }
});
