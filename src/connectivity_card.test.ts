import { expect, test } from "bun:test";
import { Hover, draw, portAt, buttonAt, type Card } from "./connectivity_card";
import type { Forward } from "./port_forwards";
import { aim_ms } from "./menu_aim";
import { Stats } from "./connection_stats";
import { Rect } from "./layout";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";
import * as sidebar from "./sidebar";
import * as builds from "./machine_build";

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

test("machine hover includes the actual daemon release and update detail beside a mismatch", () => {
  const hover = new Hover();
  const endpoint = {
    ...connection("work"),
    daemonVersion: { version: "0.0.1", commit: "12345678", source_hash: "" },
    updateProgress: { message: "Installing…", detail: "Handing off the running daemon" },
  };
  hover.move({ machine: "work", rect: new Rect(2, 2, 24, 1) }, 5, 2, 0);
  const lines = hover.update(endpoint, 100, 40, 1000)!.lines.map(line => line.text);
  expect(lines).toContain("Version mismatch");
  expect(lines).toContain("Daemon   0.0.1 · 1234567");
  expect(lines).toContain("Viewer   " + builds.label(builds.viewer));
  expect(lines).toContain("Handing off the running daemon");
});

const forward = (port: number, local = port, open = 0): Forward => ({
  host: "localhost",
  port,
  local,
  url: `http://localhost:${local}/`,
  open,
  failure: null,
  realized: true,
});
function screen(card: Card, cols = 120, rows = 40): string {
  const w = new Writer(),
    terminal = new Terminal(cols, rows);
  try {
    draw(w, card);
    terminal.feed(w.buffered());
    return terminal.text();
  } finally {
    terminal.destroy();
  }
}

test("an SSH machine's card lists its forwarded ports, or says how one comes", () => {
  const hover = new Hover(),
    atlas = connection("atlas");
  hover.move({ machine: "atlas", rect: new Rect(2, 2, 34, 1) }, 20, 2, 0);
  const empty = hover.update(atlas, 120, 40, 1000, [])!;
  expect(screen(empty)).toContain("Forwarded ports");
  expect(screen(empty)).toContain("Opening a localhost link from this machine forwards its port");
  hover.clear();
  hover.move({ machine: "atlas", rect: new Rect(2, 2, 34, 1) }, 20, 2, 0);
  const refused = { ...forward(3000, 49152), failure: "refused" as const };
  const card = hover.update(atlas, 120, 40, 1000, [
    { forward: forward(5173, 5173, 2), name: "vite" },
    { forward: refused, name: "" },
  ])!;
  const text = screen(card);
  expect(text).toMatch(/5173 {2}vite +→ localhost:5173 +2 open/);
  expect(text).toMatch(/3000 +→ localhost:49152 +nothing listening/);
  expect(text).toContain("↑↓ or click to select");
  // The details lose nothing to the ports.
  expect(text).toContain("Response  —");
  expect(card.rect.y + card.rect.h).toBeLessThanOrEqual(40);
});

test("the machine card holds open as the resource card does: hover selects, a click or arrow holds it", () => {
  const hover = new Hover(),
    atlas = connection("atlas"),
    header = { machine: "atlas", rect: new Rect(1, 2, 30, 1) };
  const ports = [5173, 3000, 8080].map(port => ({ forward: forward(port), name: "" }));
  hover.move(header, 20, 2, 0);
  let card = hover.update(atlas, 120, 40, 1000, ports)!;
  const rowY = (i: number) => card.rect.y + card.rect.h - 3 - card.ports!.room + i;
  expect(card.ports!.room).toBe(3);
  // Hovering a port selects it, held or not.
  hover.move(null, card.rect.x + 5, rowY(1), 1100);
  expect(hover.selected).toBe(ports[1].forward);
  expect(portAt(card, card.rect.x + 5, rowY(1))).toBe(ports[1].forward);
  expect(portAt(card, card.rect.x, rowY(1))).toBeNull();
  expect(buttonAt(card, card.rect.x + card.rect.w - 5, card.rect.y + card.rect.h - 3)).toBeNull();
  hover.pin();
  expect(hover.pinned).toBe(true);
  expect(hover.selected).toBe(ports[1].forward);
  hover.step(1);
  hover.step(1);
  expect(hover.selected).toBe(ports[2].forward);
  // Held, the pointer leaving doesn't close it.
  hover.move(null, 100, 30, 1200);
  card = hover.update(atlas, 120, 40, 1300, ports)!;
  expect(card.ports!.pinned).toBe(true);
  const bar = card.rect.y + card.rect.h - 3,
    text = screen(card);
  expect(text).toContain("http://localhost:8080/");
  expect(text).toContain("↵ open   x stop");
  expect(text).toContain("↑↓ select  ↵ open  x stop  esc close");
  expect(buttonAt(card, card.rect.x + card.rect.w - 4, bar)).toBe("stop");
  expect(buttonAt(card, card.rect.x + card.rect.w - 11, bar)).toBe("open");
  // A stopped port leaves its row empty: the card keeps its size and place.
  const rect = card.rect;
  card = hover.update(atlas, 120, 40, 1400, ports.slice(0, 2))!;
  expect(card.rect).toEqual(rect);
  expect(hover.selected).toBe(ports[0].forward);
  // The last one stopped lets it go, in the same box.
  card = hover.update(atlas, 120, 40, 1500, [])!;
  expect(card.rect).toEqual(rect);
  expect(hover.pinned).toBe(false);
  expect(screen(card)).toContain("Opening a localhost link");
});

test("more ports than the card has room for scroll with the selection", () => {
  const hover = new Hover(),
    atlas = connection("atlas");
  const ports = Array.from({ length: 9 }, (_, i) => ({ forward: forward(3000 + i), name: "" }));
  hover.move({ machine: "atlas", rect: new Rect(1, 2, 30, 1) }, 20, 2, 0);
  hover.update(atlas, 120, 40, 1000, ports);
  hover.pin();
  for (let i = 0; i < 8; i++) hover.step(1);
  const card = hover.update(atlas, 120, 40, 1100, ports)!;
  expect(card.ports!.room).toBe(6);
  expect(card.ports!.offset).toBe(3);
  expect(screen(card)).toContain("3008");
  expect(screen(card)).not.toContain(" 3002 ");
});

test("the pointer heading from the header to the card keeps it a moment", () => {
  const hover = new Hover(),
    atlas = connection("atlas"),
    header = { machine: "atlas", rect: new Rect(1, 2, 30, 1) };
  hover.move(header, 28, 2, 0);
  const card = hover.update(atlas, 120, 40, 1000, [])!;
  expect(card.rect.x).toBe(31);
  // Down and right, toward the card, over rows that aren't the header.
  hover.move(null, 29, 3, 1100);
  expect(hover.card).not.toBeNull();
  expect(hover.expire(1100 + aim_ms - 1)).toBe(false);
  // Resting short of it, the card goes.
  expect(hover.expire(1100 + aim_ms)).toBe(true);
  expect(hover.card).toBeNull();
  // Straight down isn't toward it.
  hover.move(header, 10, 2, 2000);
  hover.update(atlas, 120, 40, 3000, []);
  hover.move(null, 10, 4, 3100);
  expect(hover.card).toBeNull();
});

test("a detail line that comes while the card is open grows it, rather than cutting the last one", () => {
  const hover = new Hover(),
    atlas: any = connection("atlas");
  hover.move({ machine: "atlas", rect: new Rect(1, 2, 30, 1) }, 20, 2, 0);
  const before = hover.update(atlas, 120, 40, 1000, [])!;
  atlas.updateError = "disk full";
  const after = hover.update(atlas, 120, 40, 2500, [])!;
  expect(after.lines.length).toBe(before.lines.length + 1);
  expect(after.rect.h).toBe(before.rect.h + 1);
  expect(after.rect.y).toBe(before.rect.y);
  expect(screen(after)).toContain("Update failed · disk full");
});
