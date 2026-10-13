// Mirrors the tests in commands.zig.
import { expect, test } from "bun:test";
import type * as dropdown from "./dropdown";
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import { TabMenu, fade_ms } from "./commands";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";

const c = (s: string) => s.charCodeAt(0);

test("menu keys pick the rows each menu shows", () => {
  const tab = new TabMenu({ tab: 1, anchor_x: 0 });
  expect(tab.itemFor(c("n"))).toBe("new");
  expect(tab.itemFor(c("r"))).toBe("rename");
  expect(tab.itemFor(c("x"))).toBe("close");
  // Shift picks the same row.
  expect(tab.itemFor(c("R"))).toBe("rename");
  expect(tab.itemFor(c("X"))).toBe("close");
  expect(tab.itemFor(c("v"))).toBeNull();
  const workspace = new TabMenu({ tab: 1, anchor_x: 0, workspace: true });
  expect(workspace.itemFor(c("n"))).toBeNull();
  const pane = new TabMenu({ tab: 1, anchor_x: 0, pane: true });
  expect(pane.itemFor(c("d"))).toBe("split-down");
  expect(pane.itemFor(c("c"))).toBe("clear-name");
  expect(pane.itemFor(c("-"))).toBeNull();
  expect(pane.itemFor(c("s"))).toBeNull();
  const swap = new TabMenu({ tab: 1, anchor_x: 0, pane: true, source: 2 });
  expect(swap.itemFor(c("s"))).toBe("swap");
  const agent = new TabMenu({ tab: 1, anchor_x: 0, agent: true });
  expect(agent.itemFor(c("r"))).toBe("rename");
  expect(agent.itemFor(c("f"))).toBe("fork");
  expect(agent.itemFor(c("c"))).toBe("copy-id");
  expect(agent.itemFor(c("u"))).toBe("mark-unread");
  expect(agent.itemFor(c("x"))).toBe("close");
  expect(agent.itemFor(c("n"))).toBeNull();
});

test("a worktree group's menu folds first and keeps Close all below a rule", () => {
  const menu = new TabMenu({ tab: 1, anchor_x: 0, worktree: "/repo/.worktrees/one", title: "one" });
  expect(menu.entries().map(entry => entry.label)).toEqual(["Fold", "Review changes", "Close all agents for one"]);
  expect(menu.itemFor(c("f"))).toBe("fold");
  expect(menu.itemFor(c("e"))).toBe("review");
  expect(menu.itemFor(c("x"))).toBe("close-all");
  menu.highlightFirst();
  expect(menu.highlightedItem()).toBe("fold");
  menu.folded = true;
  expect(menu.entries()[0].label).toBe("Unfold");
  menu.off.add("close-all");
  expect(menu.itemFor(c("x"))).toBeNull();
});

test("crossed-out rows take no key, click or highlight", () => {
  const menu = new TabMenu({
    tab: 1,
    anchor_x: 0,
    agent: true,
    off: new Set(["rename", "fork", "copy-id", "mark-unread", "review"]),
  });
  expect(menu.itemFor(c("r"))).toBeNull();
  expect(menu.itemFor(c("f"))).toBeNull();
  expect(menu.itemFor(c("c"))).toBeNull();
  expect(menu.itemFor(c("u"))).toBeNull();
  expect(menu.highlightedItem()).toBeNull();
  // Close sits apart below a rule; the menu never opens on it.
  menu.highlightFirst();
  expect(menu.highlightedItem()).toBeNull();
  expect(menu.hit(80, 24, 5, 6)).toBeNull();
  expect(menu.hit(80, 24, 5, 7)).toBe(5);
  menu.move(true);
  expect(menu.highlightedItem()).toBe("close");
  menu.move(true);
  expect(menu.highlightedItem()).toBe("close");
  menu.off = new Set(["fork", "copy-id", "mark-unread", "review"]);
  menu.move(false);
  expect(menu.highlightedItem()).toBe("rename");
  menu.move(false);
  expect(menu.highlightedItem()).toBe("close");
  const w = new Writer();
  menu.draw(w, 80, 24);
  const struck = new Style({ fg: "faint", bg: "surface", strike: true }).sgr();
  expect(w.s).toContain(struck + "Fork");
  expect(w.s).not.toContain(struck + "Rename");
  expect(w.s).toContain(struck + "Mark as unread");
  expect(w.s).toContain("│  " + "─".repeat(18) + "  │");
  // Rows that run show their key as a cap; crossed-out ones show it flat.
  expect(w.s).toContain(keycap + " r ");
  expect(w.s).toContain(new Style({ fg: "faint", bg: "surface" }).sgr() + " f ");
  expect(w.s).toContain("╭" + "─".repeat(22) + "╮");
});

test("a row with a detail takes two lines, both of them its own", () => {
  const menu = new TabMenu({ tab: 1, anchor_x: 0, agent: true });
  const plain = menu.lines();
  menu.setDetail("review", [
    ["2 files  ", "faint"],
    ["+3", "accent"],
    [" −1", "hot"],
  ]);
  expect(menu.lines()).toBe(plain + 1);
  const review = menu.entries().findIndex(entry => entry.item === "review"),
    b = menu.bounds(80, 30),
    first = b.y + b.padding + review;
  expect(menu.hit(80, 30, b.x + 3, first)).toBe(review);
  expect(menu.hit(80, 30, b.x + 3, first + 1)).toBe(review);
  // Close sits past a rule, a line further down.
  expect(menu.hit(80, 30, b.x + 3, first + 3)).toBe(review + 1);
  const w = new Writer(),
    terminal = new Terminal(80, 30);
  try {
    menu.draw(w, 80, 30);
    terminal.feed(w.buffered());
    const rows = terminal.text().split("\n"),
      at = rows.findIndex(row => row.includes("Review changes"));
    expect(rows[at + 1]).toContain("2 files  +3 −1");
    expect(rows[at + 1].indexOf("2 files")).toBe(rows[at].indexOf("Review changes"));
  } finally {
    terminal.destroy();
  }
});

test("a detail shows placeholder bars until it arrives, then fades in over them", () => {
  const menu = new TabMenu({ tab: 1, anchor_x: 0, agent: true });
  const surface = palette.colors.surface,
    bar = palette.bgRgb(palette.mix(surface, palette.colors.faint, 30)),
    runs: dropdown.Run[] = [
      ["2 files  ", "faint"],
      ["+3", "accent"],
    ];
  const drawn = (now: number) => {
    const w = new Writer();
    menu.draw(w, 80, 30, now);
    return w.s;
  };
  menu.setDetail("review", null);
  const lines = menu.lines();
  expect(drawn(0)).toContain(bar + " ");
  // The menu keeps its size when the line arrives, and nothing shows at first.
  menu.setDetail("review", runs, 1000);
  expect(menu.lines()).toBe(lines);
  expect(drawn(1000)).toContain(palette.fgRgb(surface) + "+");
  expect(drawn(1000)).toContain(bar);
  const done = drawn(1000 + fade_ms);
  expect(done).toContain(palette.fgRgb(palette.colors.accent) + "+");
  expect(done).not.toContain(bar);
  // The same line again changes nothing; a different one fades in, with no bars.
  menu.setDetail("review", runs, 5000);
  expect(menu.details.get("review")!.since).toBe(1000);
  menu.setDetail("review", [["No changes", "faint"]], 5000);
  expect(drawn(5000)).toContain(palette.fgRgb(surface) + "N");
  expect(drawn(5000)).not.toContain(bar);
});
