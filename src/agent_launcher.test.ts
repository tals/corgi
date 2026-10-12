// Mirrors the tests in agent_launcher.zig.
import { expect, test } from "bun:test";
import { Menu } from "./agent_launcher";
import { View as SidebarView } from "./sidebar";
import { analyze } from "./launch/command";
import { Terminal } from "./pane/terminal";
import { Writer, displayWidth } from "./text";

const menu = (fields: Partial<Menu> = {}) =>
  new Menu({ workspace: 1, selected: "codex", last: "codex", pinned: true, ...fields });
const now = () => Math.floor(Date.now() / 1000);

test("launcher menu bounds", () => {
  const side = SidebarView.init(80, 24, true, 0, 0);
  const m = menu();
  const b = m.bounds(80, 24, side);
  expect(b.x + b.w <= 80 && b.y + b.h <= 24).toBe(true);
  expect(m.hit(80, 24, side, b.x + 2, b.y + 2)).toBe("codex");
  expect(m.hit(80, 24, side, b.x + 2, b.y + 3)).toBe("claude");
  expect(m.hit(80, 24, side, b.x + 2, b.y + 4)).toBe("terminal");
  expect(m.hit(80, 24, side, b.x + 2, b.y + 6)).toBeNull();
  // Manage is the title's button now.
  expect(m.manageHit(80, 24, side, b.x + b.w - 6, b.y)).toBe(true);
  expect(m.manageHit(80, 24, side, b.x + 4, b.y)).toBe(false);
});

test("conversations sit below the agents and their rows hit-test", () => {
  const side = SidebarView.init(120, 40, true, 0, 0);
  const m = menu({ cwd: "/w" });
  m.history = {
    pending: false,
    entries: [
      {
        provider: "claude",
        session: "a",
        title: "First",
        first: "",
        last: "",
        cwd: "/w",
        branch: "",
        updated_at: 5,
        interrupted: false,
      },
      {
        provider: "codex",
        session: "b",
        title: "Second",
        first: "",
        last: "",
        cwd: "/w",
        branch: "",
        updated_at: 4,
        interrupted: false,
      },
    ],
  };
  const b = m.bounds(120, 40, side);
  // Border, headings, three agent rows, a gap, then the Resume heading.
  const first_line = b.y + 7;
  expect(m.hit(120, 40, side, b.x + 2, first_line)).toBeNull();
  expect(m.resumeHit(120, 40, side, b.x + 2, first_line)).toEqual({ row: 0 });
  // "More" sits below a gap.
  expect(m.resumeHit(120, 40, side, b.x + 2, first_line + 2)).toBeNull();
  expect(m.resumeHit(120, 40, side, b.x + 2, first_line + 3)).toEqual({ row: 2 });
  expect(m.resumeHit(120, 40, side, b.x + 2, first_line - 1)).toBeNull();
  expect(b.h).toBeGreaterThanOrEqual(m.rowsHeight());
  m.resume_view.expand();
  expect(m.bounds(120, 40, side).w).toBe(104);
});

test("launcher fits long content and keeps usage hit targets aligned", () => {
  const m = menu({ selected: "claude" });
  m.preview.pending = false;
  m.preview.options.codex.model = "a-long-model-name-that-needs-room";
  m.preview.options.claude.account = "person.with.a.long.name@example.com";
  m.preview.options.claude.usage_needs_consent = true;
  const widths = m.columns(200);
  expect(widths[2]).toBe(35);
  expect(widths[3]).toBe(37);
  for (const cols of [24, 40, 64, 80, 120, 200]) {
    const side = SidebarView.init(cols, 24, true, 0, 0);
    const b = m.bounds(cols, 24, side);
    expect(b.x + b.w).toBeLessThanOrEqual(cols);
    const fitted = m.columns(b.w);
    expect(4 + fitted.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(b.w);
    const usage_x = b.x + 3 + fitted[0] + fitted[1] + fitted[2] + fitted[3] + fitted[4];
    expect(m.usageHit(cols, 24, side, usage_x, b.y + 3)).toBe("claude");
  }
});

test("single-line limit groups survive narrow terminal rendering", () => {
  const m = menu();
  m.preview.pending = false;
  const at = now();
  m.preview.options.codex.limits = {
    windows: [null, { minutes: 10080, used: 48, reset_at: at + 6 * 86400 + 18 * 3600 }],
  } as any;
  m.preview.options.claude.limits = {
    windows: [
      { minutes: 300, used: 17, reset_at: at + 99 * 60 },
      { minutes: 10080, used: 35, reset_at: at + 86400 + 15 * 3600 },
    ],
  } as any;
  for (const o of [m.preview.options.codex, m.preview.options.claude]) {
    o.usage_fetched_at = at;
    o.account = "toasty.tal@gmail.com";
    o.model = "gpt-6-astra";
    o.plan = "pro";
  }
  for (const cols of [60, 80, 100, 124]) {
    const side = SidebarView.init(cols, 24, true, 0, 0);
    const w = new Writer();
    m.draw(w, cols, 24, side);
    const host = new Terminal(cols, 24);
    host.feed(w.s);
    const rendered = host.text();
    host.destroy();
    const found = [0, 0];
    const rows: string[] = ["", ""];
    for (const line of rendered.split("\n")) {
      if (line.includes("Codex")) {
        found[0] += 1;
        rows[0] = line;
        expect(line).toContain("7d");
        expect(line).toContain("48%");
        expect(line).toContain("6d 18h");
        expect(line).not.toContain("5h");
      }
      if (line.includes("Claude Code")) {
        found[1] += 1;
        rows[1] = line;
        for (const value of ["5h", "17%", "1h 39m", " │ 7d", "35%", "1d 15h"]) expect(line).toContain(value);
      }
      expect(displayWidth(line)).toBeLessThanOrEqual(cols);
    }
    expect(found).toEqual([1, 1]);
    // Codex reports only a weekly limit; it sits under Claude's.
    for (const needle of ["7d", "·"]) {
      const columns = rows.map(line => displayWidth(line.slice(0, line.lastIndexOf(needle))));
      expect(columns[0]).toBe(columns[1]);
    }
    const b = m.bounds(cols, 24, side);
    const x = b.x + 3 + m.columns(b.w)[0];
    expect(m.yoloHit(cols, 24, side, x, b.y + 2)).toBe("codex");
  }
});

test("viewer expires a delivered usage reading after ten minutes", () => {
  const m = menu();
  m.preview.pending = false;
  const o = m.preview.options.codex;
  o.limits = { windows: [null, { minutes: 10080, used: 48, reset_at: null }] } as any;
  o.usage_fetched_at = now() - 590;
  expect(m.usageCell("codex").limited()).toBe(true);
  o.usage_fetched_at = now() - 600;
  expect(m.usageCell("codex").fallback).toBe("Unavailable · last success 10m+ ago");
  o.limits = "metered";
  expect(m.usageCell("codex").fallback).toBe("Metered");
  o.limits = "rate_limited";
  o.usage_fetched_at = 0;
  o.usage_error = "server returned 429";
  expect(m.usageCell("codex").fallback).toBe("Unavailable · server returned 429");
});

test("launcher hides providers that are not installed", () => {
  const side = SidebarView.init(120, 24, true, 0, 0);
  const m = menu();
  m.preview.installed = { codex: false, claude: true };
  m.normalize();
  expect(m.selected).toBe("claude");
  const b = m.bounds(120, 24, side);
  // Border, headings, two rows, a gap, footer and border.
  expect(b.h).toBe(7);
  expect(m.hit(120, 24, side, b.x + 2, b.y + 2)).toBe("claude");
  expect(m.hit(120, 24, side, b.x + 2, b.y + 3)).toBe("terminal");
  m.move(true, true);
  expect(m.selected).toBe("terminal");
  m.move(true, true);
  expect(m.selected).toBe("claude");
  m.preview.installed = { codex: false, claude: false };
  m.normalize();
  expect(m.selected).toBe("terminal");
  expect(m.first()).toBe("terminal");
});

test("signed-out and hidden agents remain editable in management", () => {
  const m = menu();
  m.preview.options.codex.signed_in = false;
  m.hidden.claude = true;
  m.normalize();
  expect(m.selected).toBe("terminal");
  expect(!m.shown("codex") && !m.shown("claude")).toBe(true);
  m.managing = true;
  expect(m.shown("codex") && m.shown("claude") && m.shown("add")).toBe(true);
  m.commands[0].set("FOO=123 claude --whatever");
  m.commands[0].hidden = true;
  expect(m.shown("custom0")).toBe(true);
  m.managing = false;
  expect(m.shown("custom0")).toBe(false);
  m.commands[0].hidden = false;
  expect(m.shown("custom0")).toBe(true);
  m.preview.options.codex.signed_in = null;
  expect(m.shown("codex")).toBe(true);
});

test("digit shortcuts enumerate visible agents and exclude terminal and management", () => {
  const m = menu();
  const c = (s: string) => s.charCodeAt(0);
  expect(m.shortcutRow(c("0"))).toBe("codex");
  expect(m.shortcutRow(c("1"))).toBe("claude");
  expect(m.shortcutRow(c("2"))).toBeNull();
  m.hidden.codex = true;
  m.commands[3].set("claude --model opus");
  expect(m.shortcutRow(c("0"))).toBe("claude");
  expect(m.shortcutRow(c("1"))).toBe("custom3");
  m.preview.options.claude.signed_in = false;
  expect(m.shortcutRow(c("0"))).toBe("custom3");
  m.commands[3].hidden = true;
  expect(m.shortcutRow(c("0"))).toBeNull();
  m.managing = true;
  expect(m.shortcutRow(c("0"))).toBeNull();
});

test("custom picker cells preserve account scope and permission state", () => {
  const m = menu({ selected: "custom0", last: "claude" });
  m.preview.pending = false;
  m.preview.options.claude.account = "personal@example.com";
  m.preview.options.claude.plan = "Max";
  m.preview.options.claude.model = "opus";
  m.preview.options.claude.model_name = "Opus";
  m.commands[0].set("claude --dangerously-skip-permissions");
  m.commands[0].semantics = analyze(m.commands[0].text(), "/tmp");
  let values = m.customCells(0);
  expect(values[2]).toBe("Opus");
  expect(values[3]).toBe("personal@example.com");
  expect(values[1]).toBe("✓");
  expect(values[4]).toBe("Max");
  m.commands[0].semantics.default_account = false;
  m.commands[0].semantics.account = "work@example.com (cached)";
  values = m.customCells(0);
  expect(values[3]).toBe("work@example.com (cached)");
  expect(values[4]).toBe("—");
  expect(m.usageCell("custom0").fallback).toBe("—");
  m.commands[1].set("claude --model sonnet[1m]");
  m.commands[1].semantics = analyze(m.commands[1].text(), "/tmp");
  expect(m.customCells(1)[2]).toBe("Sonnet (1M context)");
});

test("the title names the worktree once, on a button that drops the checkouts and the new-worktree form", () => {
  const checkout = (path: string, branch: string, primary: boolean) => ({
    path,
    head: "4f1c2a9e0b",
    branch: `refs/heads/${branch}`,
    primary,
    bare: false,
    detached: false,
    locked: null,
    prunable: null,
    available: true,
    comparison: null,
    changes: null,
    created: null,
    edited: null,
    stale: false,
  });
  const m = menu({ cwd: "/src/app-topic" });
  m.worktrees = {
    common_dir: "/src/app/.git",
    base: { ref: "refs/heads/main", name: "main", head: "4f1c2a9e0b" },
    entries: [checkout("/src/app", "main", true), checkout("/src/app-topic", "topic", false)],
    agents: [],
    stale: false,
  };
  const side = SidebarView.init(100, 30, true, 0, 0);
  const render = () => {
    const w = new Writer();
    m.draw(w, 100, 30, side);
    const host = new Terminal(100, 30);
    host.feed(w.s);
    const text = host.text();
    host.destroy();
    return text;
  };
  let text = render();
  expect(text).toContain("New agent  in    w  ⌥ topic ▾");
  expect(text).not.toContain("app-topic");
  const b = m.bounds(100, 30, side);
  const button = m.worktreeButton(100, 30, side)!;
  expect(button.y).toBe(b.y);
  m.worktree.open(m.worktrees, m.cwd);
  text = render();
  expect(text).toContain("⌥ topic ▴");
  expect(text).toContain("✓ topic");
  // A blank row, then the form under a rule carrying n.
  const rows = text.split("\n"),
    rule = rows.findIndex(row => row.includes("├─  n  New worktree ─"));
  expect(rows[rule - 1]).toMatch(/│ +│/);
  expect(rows[rule + 1]).toContain("Branch  branch name");
  expect(rows[rule + 3]).toContain("From    main");
  expect(rows[rule + 4]).toContain("Folder  ./.worktrees/…");
  const bx = m.worktreeBox(100, 30, side)!;
  expect(m.worktreeHit(100, 30, side, bx.label_x, bx.list)).toEqual({ checkout: 0 });
  expect(m.worktreeHit(100, 30, side, bx.label_x, bx.list + 1)).toEqual({ checkout: 1 });
  expect(m.worktreeHit(100, 30, side, bx.field_x, bx.branch)).toBe("branch");
  expect(m.worktreeHit(100, 30, side, bx.field_x, bx.from)).toBe("from");
  // From's branches open right under its field, as wide as it.
  m.worktree.branches = [
    { ref: "refs/heads/main", name: "main", at: 0 },
    { ref: "refs/heads/topic", name: "topic", at: 0 },
  ];
  m.worktree.focusFrom();
  const pick = m.worktreePickRect(100, 30, side)!;
  expect([pick.x, pick.y, pick.w]).toEqual([bx.field_x, bx.from + 1, bx.field_w]);
  expect(
    render()
      .split("\n")
      [bx.from + 1].slice(bx.field_x, bx.field_x + 4),
  ).toBe("main");
  expect(m.worktreeHit(100, 30, side, pick.x, pick.y + 1)).toEqual({ pick: 1 });
});
