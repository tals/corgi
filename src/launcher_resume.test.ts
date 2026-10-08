// Mirrors the tests in launcher_resume.zig.
import { expect, test } from "bun:test";
import {
  Context,
  View,
  merge,
  startsRun,
  dayStart,
  dayLabel,
  ageLabel,
  collapsed_rows,
  type Entry,
} from "./launcher_resume";

const testEntry = (session: string, cwd: string, title: string, updated_at: number): Entry => ({
  provider: "claude",
  session,
  title,
  first: title,
  last: "last",
  cwd,
  branch: "",
  updated_at,
  interrupted: false,
});

test("collapsed shows this folder's newest closed conversations, then more", () => {
  const entries = [..."abcdefghi"].map((name, i) => testEntry(name, "/w/corgi", "Work", 900 - i));
  entries[2].cwd = "/w/other";
  const c = new Context(
    { pending: false, entries },
    "/w/corgi",
    "/w",
    [{ provider: "claude", session: "d", pane: 4 }],
    1000,
  );
  const v = new View();
  const rows = v.lines(c);
  // a, b, e, f, g, h and i are listed; c is in another folder of the
  // workspace, d is open.
  expect(rows.length).toBe(collapsed_rows + 1);
  expect(rows[0]).toEqual({ entry: 0 });
  expect(rows[2]).toEqual({ entry: 4 });
  // The search starts on the workspace, so c counts too.
  expect(rows[collapsed_rows]).toEqual({ more: 8 });
  // A gap sits above the "more" row.
  expect(v.collapsedHit(c, collapsed_rows - 1)).toBe(collapsed_rows - 1);
  expect(v.collapsedHit(c, collapsed_rows)).toBeNull();
  expect(v.collapsedHit(c, collapsed_rows + 1)).toBe(collapsed_rows);
  expect(v.collapsedHit(c, collapsed_rows + 2)).toBeNull();
  expect(v.move(c, rows, 10)).toBe(true);
  expect(v.entry(c, rows)).toBeNull();
  expect(v.move(c, rows, -10)).toBe(true);
  expect(v.entry(c, rows)!.session).toBe("a");
  // At the top, moving up leaves the list.
  expect(v.move(c, rows, -1)).toBe(false);
});

test("expanded groups by day and widens; search finds open conversations and counts the rest", () => {
  const entries = [
    testEntry("a", "/w/corgi", "Sidebar flicker fix", 900),
    testEntry("b", "/w/other", "Sidebar width", 800),
    testEntry("c", "/w/corgi", "Sidebar scroll", 700),
  ];
  const c = new Context(
    { pending: false, entries },
    "/w/corgi",
    "/w/corgi",
    [{ provider: "claude", session: "c", pane: 4 }],
    1000,
  );
  const v = new View();
  v.expand();
  expect(v.scope).toBe("workspace");
  let rows = v.lines(c);
  expect(rows.length).toBe(2);
  expect("day" in rows[0]).toBe(true);
  v.nextScope(true);
  rows = v.lines(c);
  expect(rows.length).toBe(3);
  v.nextScope(true);
  v.startSearch();
  for (const ch of "sidebar") v.query.key(ch.charCodeAt(0));
  rows = v.lines(c);
  expect(rows.length).toBe(5);
  expect(rows[0]).toEqual({ heading: "open" });
  expect(rows[1]).toEqual({ open: 2 });
  expect(rows[2]).toEqual({ heading: "results" });
  expect(rows[3]).toEqual({ entry: 0 });
  expect(rows[4]).toEqual({ elsewhere: 1 });
  // The open match comes first, so it is what Enter jumps to.
  expect(v.entry(c, rows)!.title).toBe("Sidebar scroll");
  for (const ch of " fix") v.query.key(ch.charCodeAt(0));
  rows = v.lines(c);
  expect(rows.length).toBe(2);
  expect(v.entry(c, rows)!.title).toBe("Sidebar flicker fix");
  v.collapse();
  expect(!v.expanded && !v.searching).toBe(true);
  expect(v.scope).toBe("workspace");
});

test("a run of one agent names it once", () => {
  const entries = [
    testEntry("a", "/w/corgi", "Sticky agent", 900),
    testEntry("b", "/w/corgi", "Unread hotkey", 800),
    testEntry("c", "/w/corgi", "CPU check", 700),
    testEntry("d", "/w/corgi", "Compacting", 600),
    testEntry("e", "/w/corgi", "Review", 500),
  ];
  entries[2].provider = "codex";
  entries[3].provider = "codex";
  const c = new Context({ pending: false, entries }, "/w/corgi", "/w/corgi", [], 1000);
  const rows = new View().lines(c);
  expect(Array.from({ length: collapsed_rows }, (_, i) => startsRun(c, rows, i, 0))).toEqual([
    true,
    false,
    true,
    false,
    true,
  ]);
  // A list scrolled past a run's first row names it again.
  expect(startsRun(c, rows, 1, 1)).toBe(true);
  // Show more.
  expect(startsRun(c, rows, rows.length - 1, 0)).toBe(false);
});

test("day headings and ages", () => {
  const now = dayStart(1_790_000_000) + 12 * 3600;
  expect(dayLabel(now - 3600, now)).toBe("Today");
  expect(dayLabel(now - 86400, now)).toBe("Yesterday");
  expect(ageLabel(36 * 60)).toBe("36m");
  expect(ageLabel(3 * 86400 + 5)).toBe("3d");
  expect(ageLabel(35 * 86400)).toBe("5w");
});

test("a conversation closed here comes first, under the name the sidebar showed", () => {
  const entries = [..."abcdefg"].map((name, i) => testEntry(name, "/w/corgi", "Busy", 900 - i));
  // "review" last wrote its transcript long before it was closed.
  entries[6].title = "5b5101b6 review";
  entries[6].updated_at = 100;
  const merged = merge(entries, [
    { provider: "claude", session: "g", name: "Review of 5b5101b6", at: 500 },
    { provider: "claude", session: "g", name: "", at: 1000 },
  ]);
  const c = new Context({ pending: false, entries: merged }, "/w/corgi", "/w", [], 1000);
  const v = new View();
  const rows = v.lines(c);
  expect(v.entry(c, rows)!.title).toBe("Review of 5b5101b6");
  expect(v.entry(c, rows)!.updated_at).toBe(1000);
});
