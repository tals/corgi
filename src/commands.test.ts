// Mirrors the tests in commands.zig.
import { expect, test } from "bun:test";
import { Style, keycap } from "./palette";
import { TabMenu } from "./commands";
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
  expect(menu.entries().map(entry => entry.label)).toEqual(["Fold", "Close all agents for one"]);
  expect(menu.itemFor(c("f"))).toBe("fold");
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
    off: new Set(["rename", "fork", "copy-id", "mark-unread"]),
  });
  expect(menu.itemFor(c("r"))).toBeNull();
  expect(menu.itemFor(c("f"))).toBeNull();
  expect(menu.itemFor(c("c"))).toBeNull();
  expect(menu.itemFor(c("u"))).toBeNull();
  expect(menu.highlightedItem()).toBeNull();
  // Close sits apart below a rule; the menu never opens on it.
  menu.highlightFirst();
  expect(menu.highlightedItem()).toBeNull();
  expect(menu.hit(80, 24, 5, 5)).toBeNull();
  expect(menu.hit(80, 24, 5, 6)).toBe(4);
  menu.move(true);
  expect(menu.highlightedItem()).toBe("close");
  menu.move(true);
  expect(menu.highlightedItem()).toBe("close");
  menu.off = new Set(["fork", "copy-id", "mark-unread"]);
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
