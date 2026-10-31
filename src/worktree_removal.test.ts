import { expect, test } from "bun:test";
import * as palette from "./palette";
import { Grid } from "./cell_grid";
import * as removal from "./worktree_removal";
import { assumed_delay_ms, first_repeat_ms, repeat_gap_ms } from "./key_hold";
import { hold_ms, message_ms, finale_ms, Hold, type Target } from "./worktree_removal";
import { parseInventory } from "./trackers/worktrees";

const [, topic, next] = parseInventory(
  "worktree /repo\0branch refs/heads/main\0\0worktree /repo/.worktrees/topic\0branch refs/heads/topic\0\0" +
    "worktree /repo/.worktrees/next\0branch refs/heads/next\0\0",
);
const target = (fields: Partial<Target> = {}): Target => ({
  workspace: 1,
  path: "/repo/.worktrees/topic",
  name: "topic",
  branch: true,
  locked: null,
  holder: null,
  changes: 3,
  detached: 0,
  agents: 2,
  checkout: topic,
  index: 0,
  ...fields,
});
/** Presses at `from`, then key repeat every `every` ms until `until`; the
 * time of the press that completed the hold, or null. */
function hold(h: Hold, from: number, until: number, delay = 300, every = 50, t = target()): number | null {
  if (h.press(from, t, "dust")) return from;
  for (let now = from + delay; now <= until; now += every) if (h.press(now, t, "dust")) return now;
  return null;
}

test("a tap shows the start of the effect, then undoes it", () => {
  const h = new Hold();
  h.press(0, target(), "burn");
  h.advance(assumed_delay_ms + 100);
  expect(h.phase).toBe("held");
  // It went as far as the repeat delay, then waited for a repeat.
  expect(h.progress).toBeCloseTo(assumed_delay_ms / hold_ms, 5);
  h.advance(first_repeat_ms + 500);
  expect(h.phase).toBe("idle");
  expect(h.progress).toBe(0);
});
test("the hold completes on a repeat once the row is gone, not before", () => {
  const h = new Hold();
  const done = hold(h, 0, 5000);
  expect(done).not.toBeNull();
  // It fills from the press, through the repeat delay.
  expect(done!).toBeGreaterThanOrEqual(hold_ms);
  expect(done!).toBeLessThan(hold_ms + 100);
  expect(h.phase).toBe("removing");
  expect(h.committed()).toBe(true);
  expect(h.effect).toBe("dust");
});
test("the bar never stops while the key is down, whatever the repeat delay", () => {
  for (const delay of [225, 700]) {
    const h = new Hold(),
      t = target();
    // The first hold learns the delay; the second shouldn't wait on it.
    for (const from of [0, 10000]) {
      h.press(from, t, "dust");
      let last = 0,
        stalled = 0;
      for (let now = from + 16; now < from + 1200; now += 16) {
        if (now - from >= delay && (now - from - delay) % 48 < 16) h.press(now, t, "dust");
        h.advance(now);
        stalled = h.progress > last ? 0 : stalled + 16;
        last = h.progress;
        if (from > 0) expect(stalled).toBeLessThanOrEqual(48);
      }
      if (from > 0) expect(h.progress).toBeGreaterThan(0.75);
      h.advance(from + 5000);
    }
  }
});
test("letting go before the end undoes the hold", () => {
  const h = new Hold(),
    end = 300 + hold_ms * 0.8;
  expect(hold(h, 0, end)).toBeNull();
  const reached = h.progress;
  // Release shows a repeat gap later; until then the bar waits, no further.
  h.advance(end + repeat_gap_ms);
  expect(h.progress).toBeLessThanOrEqual(reached + 50 / hold_ms);
  h.advance(end + repeat_gap_ms + 100);
  expect(h.phase).toBe("held");
  expect(h.progress).toBeLessThan(reached);
  h.advance(10000);
  expect(h.phase).toBe("idle");
});
test("letting go at the very end does not remove", () => {
  const h = new Hold(),
    t = target();
  h.press(0, t, "dust");
  let now = 300;
  for (; h.progress < 0.98; now += 50) expect(h.press(now, t, "dust")).toBe(false);
  // No repeat arrives after the last one.
  for (let later = now; later < now + 2000; later += 16) h.advance(later);
  expect(h.committed()).toBe(false);
  expect(h.phase).toBe("idle");
});
test("the key still down after a removal doesn't start on the next worktree", () => {
  const h = new Hold();
  const done = hold(h, 0, 5000)!;
  const next = target({ path: "/repo/.worktrees/next", name: "next" });
  for (let now = done + 50; now < done + 3000; now += 50) {
    if (now === done + 1000) h.settle(now, null);
    expect(h.press(now, next, "dust")).toBe(false);
  }
  expect(h.phase).toBe("removed");
  expect(h.target?.name).toBe("topic");
  // Released, then pressed again: a new hold.
  h.press(done + 3000 + repeat_gap_ms + 10, next, "bury");
  expect(h.phase).toBe("held");
  expect(h.target?.name).toBe("next");
  expect(h.effect).toBe("bury");
});
const claudeLock = "claude session topic (pid 20579 start Sat Oct 31 20:02:56 2026)";
const footerText = (h: Hold) =>
  removal
    .footer(h)
    ?.map(s => s.text)
    .join("");
test("a locked worktree's hold ends on its band, which Enter removes", () => {
  const h = new Hold();
  const locked = target({ locked: claudeLock, holder: "exited" });
  expect(hold(h, 0, 5000, 300, 50, locked)).toBeNull();
  expect(h.phase).toBe("confirm");
  expect(h.covers(locked.path)).toBe(true);
  expect(h.committed()).toBe(false);
  // The keys are in the band; the footer keeps the hold's line.
  expect(footerText(h)).toBe("Removing topic · locked · 3 uncommitted files lost · 2 agents close · branch kept");
  // It waits, still once settled, and the key let go and pressed again leaves it.
  h.advance(60000);
  expect(h.phase).toBe("confirm");
  expect(h.animating(60000)).toBe(false);
  expect(h.press(60000, locked, "dust")).toBe(false);
  expect(h.phase).toBe("confirm");
  expect(h.confirm(60010)).toBe(true);
  expect(h.phase).toBe("removing");
  expect(h.confirm(60020)).toBe(false);
});
test("keeping a locked worktree puts its row back the way letting go does", () => {
  const h = new Hold();
  hold(h, 0, 5000, 300, 50, target({ locked: "on a USB disk" }));
  const done = 5000;
  expect(h.progress).toBe(1);
  h.cancel(done);
  expect(h.phase).toBe("held");
  h.advance(done + removal.heal_ms / 2);
  expect(h.progress).toBeGreaterThan(0);
  expect(h.progress).toBeLessThan(1);
  h.advance(done + removal.heal_ms + 10);
  expect(h.phase).toBe("idle");
});
test("a locked worktree's columns clear for its band, never under dirt", () => {
  const h = new Hold();
  h.press(0, target({ locked: "on a USB disk" }), "bury");
  expect(h.effect).toBe("dust");
  h.reset();
  h.press(0, target(), "bury");
  expect(h.effect).toBe("bury");
  h.reset();
  h.press(0, target({ locked: "on a USB disk" }), "burn");
  expect(h.effect).toBe("burn");
});
/** The band's lines over a 100-cell card's columns, from 42 to 97. */
function bandText(fields: Partial<Target>, lines = 2, left = 42) {
  const g = removal.underlay(100, 8, { y: 2, lines, left, right: 97 }, target(fields));
  return Array.from({ length: lines }, (_, i) =>
    row(g, 2 + i)
      .slice(left, 98)
      .trimEnd(),
  );
}
test("a locked worktree's band: the pill and its keys, then who holds the lock", () => {
  expect(bandText({ locked: claudeLock, holder: "exited" })).toEqual([
    "▎  LOCKED           Enter  remove anyway  │   Esc  keep",
    "▎  claude session topic · exited",
  ]);
  expect(bandText({ locked: claudeLock, holder: "running" })[1]).toBe("▎  claude session topic · still running");
  expect(bandText({ locked: claudeLock, holder: null })[1]).toBe("▎  claude session topic");
  expect(bandText({ locked: "on a USB disk" })[1]).toBe("▎  on a USB disk");
  expect(bandText({ locked: "" })[1]).toBe("▎  no reason given");
  // On one line, who holds it goes between the pill and the keys, cut to keep whether they run.
  expect(bandText({ locked: claudeLock, holder: "exited" }, 1, 30)).toEqual([
    "▎  LOCKED   claude … · exited   Enter  remove anyway  │   Esc  keep",
  ]);
  // A narrow band closes up the gap before it gives up Esc.
  expect(bandText({ locked: "on a USB disk" }, 2, 58)[0]).toBe("▎  LOCKED    Enter  remove │  Esc  keep");
  // A narrow band gives up "anyway", then Esc.
  expect(bandText({ locked: "on a USB disk" }, 2, 54)[0]).toBe("▎  LOCKED      Enter  remove  │   Esc  keep");
  expect(bandText({ locked: "on a USB disk" }, 2, 60)[0]).toBe("▎  LOCKED               Enter  remove");
  // The band is tinted warm; the pill is warm, Enter's pair bold, Esc's not.
  const c = palette.colors,
    g = removal.underlay(100, 8, { y: 2, lines: 2, left: 42, right: 97 }, target({ locked: claudeLock }));
  expect(g.at(42, 3)?.bg).toEqual(palette.mix(c.selected, c.warm, 16));
  expect(g.at(45, 2)).toMatchObject({ ch: "L", bg: c.warm, bold: true });
  expect(g.at(row(g, 2).indexOf("remove") + 1, 2)?.bold).toBe(true);
  expect(g.at(row(g, 2).indexOf("Esc"), 2)?.bold).toBe(false);
  expect(g.at(20, 2)?.bg).toBeNull();
});
/** A 100-cell card with one two-line row at `y` 2: its name, its columns, and its brief. */
function wide() {
  const g = new Grid(100, 8, palette.colors.text);
  g.text(1, 2, "› topic", palette.colors.strong, true);
  g.text(43, 2, "0        ↑2 ↓4     1h    50m ago    1 file", palette.colors.text);
  g.text(3, 3, "╰ Track Claude cd past edits", palette.colors.faint);
  g.text(3, 5, "other-row", palette.colors.text);
  return g;
}
test("the columns come apart onto the band, then the whole row once confirmed", () => {
  const t = target({ locked: claudeLock, holder: "exited" }),
    band = { y: 2, lines: 2, left: 42, right: 97 },
    held = { ...band, right: 98, top: 1, bottom: 6 },
    whole = { ...held, left: 1 };
  for (const effect of ["dust", "burn"] as const) {
    const under = removal.underlay(100, 8, band, t);
    const early = wide();
    removal.paint(early, held, effect, 0.3, 0, 1000, under);
    expect(row(early, 2)).toContain("› topic");
    expect(row(early, 2)).toContain("↑2 ↓4");
    expect(row(early, 2)).not.toContain("1 file");
    const settled = wide();
    removal.paint(settled, held, effect, 1, 0, 5000, under, 1);
    expect(row(settled, 2)).toBe(
      " › topic                                  ▎  LOCKED           Enter  remove anyway  │   Esc  keep   ",
    );
    expect(row(settled, 3)).toContain("╰ Track Claude cd past edits");
    expect(row(settled, 3)).toContain("▎  claude session topic · exited");
    expect(row(settled, 5)).toContain("other-row");
    const gone = wide();
    removal.paint(gone, whole, effect, 1, 1, 6000, under);
    expect(row(gone, 2).trim()).toBe("");
    expect(row(gone, 3).trim()).toBe("");
    // The band's tint is gone with it.
    expect(gone.at(60, 3)?.bg).toEqual(palette.colors.surface);
  }
});
test("the other worktrees fade with a locked worktree's hold, and come back as it goes", () => {
  const h = new Hold(),
    locked = target({ locked: claudeLock });
  expect(h.dimming(0)).toBe(0);
  h.press(0, locked, "dust");
  h.advance(300);
  expect(h.dimming(300)).toBeGreaterThan(0);
  hold(h, 300, 5000, 300, 50, locked);
  expect(h.dimming(5000)).toBe(1);
  h.confirm(6000);
  expect(h.dimming(6000)).toBeCloseTo(1);
  expect(h.dimming(6000 + finale_ms.dust)).toBe(0);
  // Not for a worktree without a lock.
  const plain = new Hold();
  plain.press(0, target(), "dust");
  plain.advance(500);
  expect(plain.dimming(500)).toBe(0);
});
test("the footer says what goes and what stays", () => {
  const h = new Hold();
  expect(removal.footer(h)).toBeNull();
  h.press(0, target(), "dust");
  const text = () =>
    removal
      .footer(h)
      ?.map(s => s.text)
      .join("");
  expect(text()).toBe("Removing topic · 3 uncommitted files lost · 2 agents close · branch kept");
  expect(removal.footer(h)?.find(s => s.text.includes("lost"))?.color).toBe("hot");
  h.reset();
  h.press(0, target({ changes: 0, agents: 0, branch: false, detached: 1, name: "4f1c2a9e" }), "dust");
  expect(text()).toBe("Removing 4f1c2a9e · 1 detached commit lost");
  // A removal that worked leaves the usual footer.
  h.settle(10, null);
  expect(removal.footer(h)).toBeNull();
  h.settle(10, "git couldn't remove it");
  expect(text()).toBe("Couldn't remove 4f1c2a9e · git couldn't remove it");
  expect(h.committed()).toBe(false);
});
test("the effect is random but never the same twice running", () => {
  for (const last of removal.effects)
    for (const r of [0, 0.3, 0.6, 0.999]) expect(removal.pick(last, () => r)).not.toBe(last);
  expect(new Set([0, 0.5, 0.99].map(r => removal.pick(null, () => r)))).toEqual(new Set(removal.effects));
});

/** A card-sized grid with one row at `y` 2: a name on the left, numbers on the right, and a path below. */
function card() {
  const g = new Grid(40, 8, palette.colors.text);
  g.text(1, 2, "› topic", palette.colors.strong, true);
  g.text(30, 2, "2   6  3", palette.colors.text);
  g.text(3, 3, "~/repo/.worktrees/topic", palette.colors.faint);
  g.text(3, 5, "other-row", palette.colors.text);
  return g;
}
const area = { y: 2, lines: 2, left: 1, right: 38, top: 1, bottom: 6 };
const row = (g: Grid, y: number) => g.rows[y].map(c => c.ch || "").join("");
test("every effect runs right to left and ends with the row gone", () => {
  for (const effect of removal.effects) {
    const before = card();
    const g = card();
    removal.paint(g, area, effect, 0, 0, 0);
    expect(row(g, 2)).toBe(row(before, 2));
    const half = card();
    removal.paint(half, area, effect, 0.5, 0, 1000);
    // The name on the left is still there; the numbers on the right are not.
    expect(row(half, 2)).toContain("topic");
    expect(row(half, 2)).not.toContain("2   6  3");
    // Other rows keep their text.
    expect(row(half, 5)).toContain("other-row");
    const gone = card();
    removal.paint(gone, area, effect, 1, 1, 5000);
    expect(row(gone, 2).trim()).toBe("");
    expect(row(gone, 3).trim()).toBe("");
    expect(row(gone, 5)).toContain("other-row");
  }
});
test("bury's corgi walks the row from the right", () => {
  const early = card(),
    late = card();
  removal.paint(early, area, "bury", 0.3, 0, 0);
  removal.paint(late, area, "bury", 0.8, 0, 0);
  expect(row(early, 2).indexOf("‹o[")).toBeGreaterThan(row(late, 2).indexOf("‹o["));
  expect(row(late, 3)).toContain("⣿");
});
test("a frame drawn twice at the same moment matches", () => {
  for (const effect of removal.effects) {
    const a = card(),
      b = card();
    removal.paint(a, area, effect, 0.6, 0, 1234);
    removal.paint(b, area, effect, 0.6, 0, 1234);
    expect(a.rows).toEqual(b.rows);
  }
});
test("a removed row stays until its ending has played, then closes a line at a time", () => {
  const h = new Hold();
  const done = hold(h, 0, 5000)!;
  h.effect = "bury";
  // While the list still has it, it is drawn as listed, and holds the cursor.
  expect(h.shown([topic, next], done + 50)).toEqual({ entries: [topic, next], removing: topic.path, closed: 0 });
  h.settle(done + 100, null);
  // Git is done and the list no longer has it; the row stays in its place.
  const at = (now: number) => {
    const s = h.shown([next], now);
    return [s.entries.map(e => e.path), s.removing, s.closed];
  };
  const end = done + finale_ms.bury;
  expect(at(done + 200)).toEqual([[topic.path, next.path], topic.path, 0]);
  expect(at(end - 10)).toEqual([[topic.path, next.path], topic.path, 0]);
  expect(at(end)).toEqual([[topic.path, next.path], topic.path, 1]);
  expect(at(end + removal.close_step_ms)).toEqual([[next.path], null, 0]);
  // Not for a hold that wasn't completed.
  const open = new Hold();
  open.press(0, target(), "bury");
  expect(open.shown([next], 100)).toEqual({ entries: [next], removing: null, closed: 0 });
});
test("a one-line row closes in one step, and its deleting bar follows the words", () => {
  const h = new Hold();
  const done = hold(h, 0, 5000)!;
  h.effect = "dust";
  h.settle(done + 100, null);
  const end = done + finale_ms.dust;
  expect(h.shown([next], end - 10, 1).closed).toBe(0);
  expect(h.shown([next], end, 1)).toEqual({ entries: [next], removing: null, closed: 0 });
  const g = card();
  removal.progress(g, { ...area, lines: 1 }, 0);
  expect(row(g, 2)).toMatch(/Deleting\.\.\. +[━─]+ *$/);
  expect(row(g, 3)).toContain("~/repo/.worktrees/topic");
});
test("a removal Git finishes after the ending still closes its row a line at a time", () => {
  const h = new Hold();
  const done = hold(h, 0, 5000)!;
  h.effect = "dust";
  const late = done + finale_ms.dust + 500;
  expect(h.shown([topic, next], late - 10).closed).toBe(0);
  h.settle(late, null);
  expect(h.shown([next], late).closed).toBe(1);
  expect(h.shown([next], late + removal.close_step_ms).entries).toEqual([next]);
});
test("bury's corgi sits a while after the row is buried, then trots off", () => {
  const at = (finale: number) => {
    const g = card();
    removal.paint(g, area, "bury", 1, finale, 0);
    return row(g, 2);
  };
  expect(at(0.1)).toContain("ᐱ•ᴥ•ᐱ");
  for (const finale of [0.25, 0.4, 0.5]) expect(at(finale)).toContain("ᐯ•ᴥ•ᐯ");
  expect(at(0.7)).toContain("ᐯ◡ᴥ◡ᐯ");
  expect(at(0.9)).not.toContain("ᴥ");
  expect(at(1).trim()).toBe("");
  expect(finale_ms.bury).toBeLessThanOrEqual(2000);
});
