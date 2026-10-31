// Mirrors the tests in launcher_resume.zig.
import { expect, test } from "bun:test";
import {
  Context,
  Area,
  View,
  merge,
  startsRun,
  dayStart,
  dayLabel,
  ageLabel,
  collapsed_rows,
  type Account,
  type Entry,
} from "./launcher_resume";
import * as sim from "./providers/sim";
import * as palette from "./palette";
import { Terminal } from "./pane/terminal";
import { Writer } from "./text";

const testEntry = (session: string, cwd: string, title: string, updated_at: number): Entry => ({
  provider: "claude",
  account: "",
  session,
  title,
  first: title,
  last: "last",
  cwd,
  branch: "",
  updated_at,
  interrupted: false,
  starred: false,
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
  const view = new View(),
    rows = view.lines(c);
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
  // Day headings do not repeat a provider's name.
  entries.forEach((e, i) => (e.updated_at = 900 - i * 86400));
  view.expand();
  const expanded = view.lines(c),
    conversations = expanded.flatMap((line, i) => ("entry" in line ? [i] : []));
  expect(expanded.filter(line => "day" in line)).toHaveLength(5);
  expect(conversations.map(i => startsRun(c, expanded, i, 0))).toEqual([true, false, true, false, true]);
  // The first visible conversation carries the label, whether a day heading
  // is at the top or the original label has scrolled away.
  for (const i of conversations) {
    expect(startsRun(c, expanded, i, i)).toBe(true);
    expect(startsRun(c, expanded, i, i - 1)).toBe(true);
  }
  // Open and closed search results still have separate provider runs.
  expect(startsRun(c, [{ open: 0 }, { heading: "results" }, { entry: 1 }], 2, 0)).toBe(true);
});

test("a run is named after its provider", () => {
  const remove = sim.register();
  try {
    const entries = [
      testEntry("a", "/w/corgi", "Sticky agent", 900),
      testEntry("b", "/w/corgi", "Review", 800),
      testEntry("c", "/w/corgi", "OpenCode title", 700),
    ];
    entries[1].provider = sim.sim;
    entries[2].provider = "opencode2";
    const c = new Context({ pending: false, entries }, "/w/corgi", "/w/corgi", [], 1000);
    const w = new Writer();
    new View().drawCollapsed(w, c, 0, 1, 100);
    // Each run starts with its brand mark (here its glyph), then its name.
    expect(w.buffered()).toMatch(/\x1b\[2;3H[^*]*\* \x1b\[2;5H\x1b\[[\d;]*mClaude/);
    expect(w.buffered()).toMatch(/\x1b\[3;3H[^§]*§ \x1b\[3;5H\x1b\[[\d;]*mSim/);
    expect(w.buffered()).not.toContain("Codex");
    for (const width of [44, 100]) {
      const writer = new Writer(),
        terminal = new Terminal(width, 10);
      try {
        new View().drawCollapsed(writer, c, 0, 1, width);
        terminal.feed(writer.s);
        const row = terminal.text().split("\n")[3];
        expect(row).toContain("o OpenCode OpenCode title");
        expect(row).not.toContain("OpenC…");
      } finally {
        terminal.destroy();
      }
    }
  } finally {
    remove();
  }
});

test("the pinned provider and date follow the first visible conversation without stealing its hit target", () => {
  const entries = Array.from({ length: 10 }, (_, i) =>
    testEntry(String(i), "/w/corgi", `Conversation ${i}`, 900 - Math.floor(i / 2) * 86400),
  );
  entries[6].provider = "codex";
  const c = new Context({ pending: false, entries }, "/w/corgi", "/w/corgi", [], 1000),
    view = new View({ expanded: true, focused: true }),
    area = new Area(0, 1, 100, 6),
    rows = view.lines(c);
  for (const entry of [0, 4, 5, 6]) {
    const at = rows.findIndex(line => "entry" in line && line.entry === entry);
    view.select(c, at);
    view.scroll = at;
    view.reveal(c, area);
    const writer = new Writer(),
      terminal = new Terminal(100, 10);
    try {
      view.draw(writer, c, area);
      terminal.feed(writer.s);
      const lines = terminal.text().split("\n"),
        provider = entry === 6 ? "Codex" : "Claude",
        heading = lines[area.listTop() - 1],
        date = dayLabel(entries[entry].updated_at, c.now);
      expect(heading).toContain(provider);
      expect(heading).not.toContain("·");
      expect(heading.indexOf(provider)).toBe(4);
      expect(heading.indexOf(date)).toBe(lines[area.listTop()].indexOf(`Conversation ${entry}`));
      expect(lines[area.listTop()]).toContain(`│          Conversation ${entry}`);
      expect(view.hit(c, area, 20, area.listTop())).toBeNull();
      expect(view.hit(c, area, 20, area.listTop() + 1)).toEqual({ row: at });
    } finally {
      terminal.destroy();
    }
  }
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

test('stars sit inside history titles without moving columns or changing order; search finds them by "star"', () => {
  const entries = [testEntry("a", "/w/corgi", "Fix login", 900), testEntry("b", "/w/corgi", "Review", 800)];
  entries[1].starred = true;
  const context = new Context({ pending: false, entries }, "/w/corgi", "/w", [], 1000);
  for (const width of [44, 100]) {
    const view = new View(),
      writer = new Writer(),
      terminal = new Terminal(width, 10);
    try {
      view.drawCollapsed(writer, context, 0, 1, width);
      terminal.feed(writer.s);
      const rows = terminal.text().split("\n");
      expect(rows[1]).toContain("Fix login");
      expect(rows[2]).toContain("★ Review");
      expect(rows[2].indexOf("★")).toBe(rows[1].indexOf("Fix login"));
      expect(rows[2].indexOf("3m")).toBe(rows[1].indexOf("1m"));
      view.startSearch();
      for (const ch of "review") view.query.key(ch.charCodeAt(0));
      expect(view.entry(context, view.lines(context))?.session).toBe("b");
      for (const query of ["Star", "starred", "star review"]) {
        view.query.clear();
        for (const ch of query) view.query.key(ch.charCodeAt(0));
        expect(view.lines(context).filter(line => "entry" in line)).toEqual([{ entry: 1 }]);
      }
    } finally {
      terminal.destroy();
    }
  }
});

test("a conversation from another account ends its title with the account's name, dimmed", () => {
  const entries = [testEntry("a", "/w/corgi", "Fix login", 900), testEntry("b", "/w/corgi", "Review", 800)];
  entries[0].account = "/accounts/claude-work";
  const work: Account = { provider: "claude", account: "/accounts/claude-work", name: "work" };
  const context = (accounts: Account[]) =>
    new Context({ pending: false, entries }, "/w/corgi", "/w", [], 1000, accounts);
  // Only once Corgi knows an account besides the defaults.
  expect(context([]).accountName(entries[0])).toBe("");
  expect(context([work]).accountName(entries[0])).toBe("work");
  expect(context([work]).accountName(entries[1])).toBe("");
  // One it no longer knows goes by its folder.
  expect(context([{ ...work, account: "/accounts/other" }]).accountName(entries[0])).toBe("claude-work");
  const v = new View();
  const w = new Writer();
  v.drawCollapsed(w, context([work]), 0, 1, 100);
  expect(w.buffered()).toContain(palette.fg("faint") + "work");
  const host = new Terminal(100, 10);
  host.feed(w.s);
  const lines = host.text().split("\n");
  host.destroy();
  // At the end of the title's column, where a branch goes.
  expect(lines[1]).toContain("Fix login");
  expect(lines[1].indexOf("work") + 4).toBe(13 + v.columns(96).title);
  expect(lines[2]).not.toContain("work");
});
