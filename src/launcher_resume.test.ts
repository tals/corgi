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
  around,
  mentionsOf,
  type Account,
  type Location,
  type Entry,
} from "./launcher_resume";
import * as sim from "./providers/sim";
import * as palette from "./palette";
import * as i18n from "./i18n";
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

test("translated history headings, empty states and search hints stay inside the list", () => {
  const previous = i18n.language();
  try {
    for (const language of ["en", "zh", "ja", "ko", "ru"] as const) {
      i18n.setLanguage(language);
      for (const width of [32, 44, 80]) {
        const now = 1_700_000_000;
        const entries = Array.from({ length: 9 }, (_, i) => testEntry(String(i), "/w/corgi", "Work", now - 86400 * i));
        for (const mode of ["empty", "collapsed", "search", "days"] as const) {
          const c = new Context(
            { pending: false, entries: mode === "empty" ? [] : entries },
            "/w/corgi",
            "/w",
            [{ provider: "claude", session: "0", pane: 1, folder: "/w/corgi" }],
            now,
          );
          const view = new View(),
            w = new Writer(),
            terminal = new Terminal(100, 18);
          const left = "####",
            right = "#".repeat(100 - (4 + width - 1));
          try {
            for (let row = 1; row <= 18; row++) terminal.feed(`\x1b[${row};1H${left}${" ".repeat(width - 1)}${right}`);
            if (mode === "collapsed") view.drawCollapsed(w, c, 4, 1, width);
            else {
              view.expand();
              if (mode === "search") {
                view.startSearch();
                for (const ch of "work") view.query.key(ch.charCodeAt(0));
              }
              view.draw(w, c, new Area(4, 1, width, 16));
            }
            terminal.feed(w.buffered());
            for (const row of terminal.text().split("\n").slice(0, 18)) {
              expect(row.startsWith(left)).toBe(true);
              expect(row.endsWith(right)).toBe(true);
            }
            expect(terminal.text()).toContain(i18n.t`Last active`);
          } finally {
            terminal.destroy();
          }
        }
      }
    }
  } finally {
    i18n.setLanguage(previous);
  }
});

test("collapsed shows this folder's newest closed conversations, then more", () => {
  const entries = [..."abcdefghi"].map((name, i) => testEntry(name, "/w/corgi", "Work", 900 - i));
  entries[2].cwd = "/w/other";
  const c = new Context(
    { pending: false, entries },
    "/w/corgi",
    "/w",
    [{ provider: "claude", session: "d", pane: 4, folder: "/w/corgi" }],
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
    [{ provider: "claude", session: "c", pane: 4, folder: "/w/corgi" }],
    1000,
  );
  const v = new View();
  // Titles alone, as from a daemon that can't search conversations' text.
  v.mentions.unsupported = true;
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
  entries[0].branch = "fix/rendering";
  entries[1].branch = "feature/rendering";
  entries[2].branch = "fix/rendering";
  v.query.clear();
  for (const ch of "RENDER") v.query.key(ch.charCodeAt(0));
  expect(v.lines(c)).toEqual([
    { heading: "open" },
    { open: 2 },
    { heading: "results" },
    { entry: 0 },
    { elsewhere: 1 },
  ]);
  for (const ch of " flicker") v.query.key(ch.charCodeAt(0));
  expect(v.lines(c)).toEqual([{ heading: "results" }, { entry: 0 }]);
  for (const ch of " missing") v.query.key(ch.charCodeAt(0));
  expect(v.lines(c)).toEqual([{ heading: "results" }]);
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

test("Where marks branches, and a title still names the branch a conversation ran on", () => {
  const entries = [
    testEntry("a", "/w/corgi", "On main", 900),
    testEntry("b", "/w/corgi", "On feature", 800),
    testEntry("c", "/w/corgi-wt", "In the worktree", 700),
    testEntry("e", "/w/corgi-wt", "Before the worktree", 650),
    testEntry("d", "/x/plain", "Outside git", 600),
  ];
  entries[0].branch = "main";
  entries[1].branch = "feature";
  // Where drops the worktree- prefix the branch keeps.
  entries[2].branch = "main";
  entries[3].branch = "worktree-wt";
  const places: Record<string, Location> = {
    "/w/corgi": { label: "main", branch: "main" },
    "/w/corgi-wt": { label: "wt", branch: "worktree-wt" },
  };
  const c = new Context(
      { pending: false, entries },
      "/w/corgi",
      "/w",
      [],
      1000,
      [],
      {},
      cwd => places[cwd] ?? { label: "plain", branch: null },
    ),
    view = new View({ expanded: true, focused: true }),
    area = new Area(0, 1, 140, 10);
  view.scope = "everywhere";
  const w = new Writer(),
    host = new Terminal(140, 12);
  view.draw(w, c, area);
  host.feed(w.s);
  const lines = host.text().split("\n");
  host.destroy();
  const line = (title: string) => lines.find(l => l.includes(title))!;
  expect(line("On main")).toContain("⌥ main");
  expect(line("On main")).not.toContain("feature");
  expect(line("On feature")).toMatch(/On feature +feature +⌥ main/);
  expect(line("In the worktree")).toMatch(/In the worktree +⌥ wt/);
  expect(line("Before the worktree")).toMatch(/Before the worktree +⌥ wt/);
  expect(line("Before the worktree")).not.toContain("worktree-wt");
  expect(line("Outside git")).toContain(" plain");
  expect(line("Outside git")).not.toContain("⌥");
});

test("an open conversation's Where and search follow the worktree its agent moved to", () => {
  // Started on main in /w/corgi; its pane's agent now works in /w/corgi-wt.
  const entries = [testEntry("a", "/w/corgi", "Translate the site", 900)];
  entries[0].branch = "main";
  const places: Record<string, Location> = {
    "/w/corgi": { label: "main", branch: "main" },
    "/w/corgi-wt": { label: "wt", branch: "site/wt" },
  };
  const c = new Context(
      { pending: false, entries },
      "/w/corgi",
      "/w",
      [{ provider: "claude", session: "a", pane: 4, folder: "/w/corgi-wt" }],
      1000,
      [],
      {},
      cwd => places[cwd] ?? { label: "plain", branch: null },
    ),
    view = new View({ expanded: true, focused: true }),
    area = new Area(0, 1, 140, 10);
  view.mentions.unsupported = true;
  view.startSearch();
  for (const ch of "site/wt") view.query.key(ch.charCodeAt(0));
  expect(view.lines(c)).toEqual([{ heading: "open" }, { open: 0 }, { heading: "results" }]);
  const w = new Writer(),
    host = new Terminal(140, 12);
  view.draw(w, c, area);
  host.feed(w.s);
  const row = host
    .text()
    .split("\n")
    .find(l => l.includes("Translate the site"))!;
  host.destroy();
  expect(row).toMatch(/Translate the site +⌥ wt/);
  // The branch it started on still finds it.
  view.query.clear();
  for (const ch of "main") view.query.key(ch.charCodeAt(0));
  expect(view.lines(c)).toContainEqual({ open: 0 });
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

/** A `conversation.grep` line for a Claude conversation's first hit. */
const said = (session: string, text: string) => ({
  source: { provider: "claude", session, cwd: "/w/corgi", updated_at: 1 },
  hits: [{ text, context: false, role: "user" }],
});

test("conversations whose text holds the search follow the title matches, as the daemon finds them", () => {
  const entries = [
    testEntry("a", "/w/corgi", "Sidebar flicker fix", 900),
    testEntry("b", "/w/corgi", "Release notes", 800),
    testEntry("c", "/w/other", "Docs pass", 700),
    testEntry("d", "/w/corgi", "Theme work", 600),
  ];
  const c = new Context(
    { pending: false, entries },
    "/w/corgi",
    "/w/corgi",
    [{ provider: "claude", session: "d", pane: 2, folder: "/w/corgi" }],
    1000,
  );
  const v = new View();
  v.expand();
  v.startSearch();
  const type = (text: string) => {
    for (const ch of text) v.query.key(ch.charCodeAt(0));
  };
  // Too short to look for in what was said.
  type("si");
  expect(v.mentionQuery()).toBe("");
  expect(v.lines(c)).toEqual([{ heading: "results" }, { entry: 0 }]);
  type("debar ");
  expect(v.mentionQuery()).toBe("sidebar");
  expect(v.lines(c)).toEqual([{ heading: "results" }, { entry: 0 }, { note: "searching" }]);
  const search = v.searchMentions("sidebar");
  v.addMentions(search, [said("b", "move the Sidebar rule"), said("a", "a title match already"), said("c", "x")]);
  v.addMentions(search, [said("d", "the open one"), said("b", "a later hit stays out")]);
  // An earlier search's matches don't count.
  v.addMentions(search - 1, [said("d", "theme")]);
  expect(v.lines(c)).toEqual([
    { heading: "open" },
    { open: 3 },
    { heading: "results" },
    { entry: 0 },
    { heading: "mentions" },
    { mention: 1 },
    { note: "searching" },
    { elsewhere: 1 },
  ]);
  expect(v.mention(entries[1])).toBe("move the Sidebar rule");
  v.endMentions(search, false);
  expect(v.lines(c)).not.toContainEqual({ note: "searching" });
  v.home();
  v.move(c, v.lines(c), 2);
  expect(v.entry(c, v.lines(c))!.title).toBe("Release notes");
  v.endMentions(search, true);
  expect(v.lines(c).at(-2)).toEqual({ note: "cut" });
  // The excerpt shows where the search was said, in the last message's place.
  const w = new Writer(),
    host = new Terminal(120, 14);
  v.mentions.hits.set("claude:b", "x".repeat(90) + " move the Sidebar rule");
  v.draw(w, c, new Area(0, 1, 120, 12));
  host.feed(w.s);
  const text = host.text();
  host.destroy();
  expect(text).toContain("Mentioned in 1 more");
  expect(text.split("\n").find(l => l.includes("Release notes"))).toMatch(/… ?[a-z ]*the Sidebar rule/);
  // Typing on waits for the next search; leaving the search forgets it.
  type("x");
  expect(v.lines(c)).toEqual([{ heading: "results" }, { entry: 0 }, { note: "searching" }]);
  v.leaveSearch();
  expect(v.mentions.query).toBe("");
});

test("a failed text search is tried again a few times, keeping what it found, then says so", () => {
  const entries = [testEntry("a", "/w/corgi", "Release notes", 900), testEntry("b", "/w/corgi", "Docs pass", 800)];
  const c = new Context({ pending: false, entries }, "/w/corgi", "/w/corgi", [], 1000);
  const v = new View();
  v.expand();
  v.startSearch();
  for (const ch of "deploy") v.query.key(ch.charCodeAt(0));
  let search = v.searchMentions("deploy");
  v.addMentions(search, [said("a", "deploy it")]);
  v.failMentions(search, 10_000);
  // Waiting to try again, it shows what came and still says it's searching.
  expect(v.mentions.retry_at).toBe(12_000);
  expect(v.lines(c)).toEqual([{ heading: "results" }, { heading: "mentions" }, { mention: 0 }, { note: "searching" }]);
  search = v.searchMentions("deploy");
  expect(v.mention(entries[0])).toBe("deploy it");
  v.failMentions(search, 20_000);
  expect(v.mentions.retry_at).toBe(24_000);
  search = v.searchMentions("deploy");
  v.failMentions(search, 30_000);
  expect(v.mentions.retry_at).toBe(0);
  expect(v.lines(c).at(-1)).toEqual({ note: "failed" });
  // A search that gets through starts the count over.
  search = v.searchMentions("deploy");
  v.endMentions(search, false);
  expect(v.mentions.failures).toBe(0);
  expect(v.lines(c)).not.toContainEqual({ note: "failed" });
});

test("an answer to a search left behind can't end the next search for the same text", () => {
  const v = new View();
  v.expand();
  v.startSearch();
  for (const ch of "deploy") v.query.key(ch.charCodeAt(0));
  const first = v.searchMentions("deploy");
  v.leaveSearch();
  v.startSearch();
  for (const ch of "deploy") v.query.key(ch.charCodeAt(0));
  const second = v.searchMentions("deploy");
  expect(second).toBeGreaterThan(first);
  // The first search's late Cancelled arrives.
  v.endMentions(first, false);
  expect(v.mentions.searching).toBe(true);
});

test("grep lines become conversations and first hits; anything else is skipped", () => {
  expect(
    mentionsOf([
      said("a", "tab\there"),
      { source: { provider: "claude", session: "b" }, hits: [{ text: "before", context: true }, { text: "match" }] },
      { source: { provider: "nope", session: "c" }, hits: [{ text: "x" }] },
      { source: { provider: "claude" }, hits: [{ text: "x" }] },
      { source: { provider: "claude", session: "d" }, count: 3 },
      null,
    ]),
  ).toEqual([
    { key: "claude:a", text: "tab here" },
    { key: "claude:b", text: "match" },
  ]);
  expect(mentionsOf({ not: "lines" })).toEqual([]);
});

test("an excerpt starts a little before the search when it would end out of sight", () => {
  expect(around("short Sidebar line", "sidebar", 40)).toBe("short Sidebar line");
  const long = "a".repeat(50) + " Sidebar rule";
  const shown = around(long, "sidebar", 20);
  expect(shown.startsWith("…")).toBe(true);
  expect(shown.indexOf("Sidebar")).toBeLessThan(20);
  expect(shown.indexOf("Sidebar")).toBeGreaterThan(1);
  expect(around(long, "missing", 20)).toBe(long);
  // Case folds as the daemon's search does, without shifting where the match is.
  const turkish = "İstanbul " + "a".repeat(40) + " Deploy now";
  expect(around(turkish, "deploy", 20)).toMatch(/^…a* Deploy now$/);
  // The lead-in starts on a whole character.
  const emoji = "🙂".repeat(30) + " Deploy";
  const cut = around(emoji, "deploy", 16);
  expect(cut).toMatch(/^…(🙂)+ Deploy$/u);
});
