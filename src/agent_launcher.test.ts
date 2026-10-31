// Mirrors the tests in agent_launcher.zig.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as accounts from "./accounts";
import { Menu, Row, commandEntry, keyAgent, preview, resolution, returned } from "./agent_launcher";
import { View as SidebarView } from "./sidebar";
import { analyze } from "./launch/command";
import { Terminal } from "./pane/terminal";
import { Writer, displayWidth } from "./text";
import { Provider, adapter, byProvider } from "./providers";

/** The providers these tests install; the rest are listed as not installed. */
const installed: Provider[] = ["codex", "claude", "pi"];
const others = Provider.all.filter(p => !installed.includes(p));
const menu = (fields: Partial<Menu> = {}) => {
  const value = new Menu({ workspace: 1, selected: "codex", last: "codex", pinned: true, ...fields });
  value.preview.installed = byProvider(p => installed.includes(p));
  return value;
};
const now = () => Math.floor(Date.now() / 1000);
// The user's saved accounts and launch options would change what rows show.
let state = "";
const base = process.env.CORGI_ENV_BASE;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "corgi-launcher-"));
  process.env.CORGI_ENV_BASE = state;
  accounts.reset();
});
afterEach(() => {
  if (base === undefined) delete process.env.CORGI_ENV_BASE;
  else process.env.CORGI_ENV_BASE = base;
  accounts.reset();
  rmSync(state, { recursive: true, force: true });
});
test("an explicit clone model uses its display name in the launcher", () => {
  const m = menu({
    profiles: [
      {
        id: "astra",
        provider: "codex",
        account: "",
        name: "Codex Astra",
        options: { flags: "", env: [], model: "gpt-6-astra" },
        yolo: false,
      },
    ],
  });
  expect(m.cells(Row.ofProfile("astra"))).toContain("GPT-6 Astra");
  expect(m.cells(Row.ofProfile("astra"))).not.toContain("gpt-6-astra");
});
test("each agent has a launcher key of its own, apart from the launcher's", () => {
  // The controller's own launcher keys: all, move, manage, terminal, usage, worktrees, YOLO, search, help.
  const taken = "aAjkmtuwy/?";
  const keys = Provider.all.map(p => adapter(p).launcher_key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const [i, key] of keys.entries()) {
    expect(taken).not.toContain(key);
    expect(keyAgent(key.charCodeAt(0))).toBe(Provider.all[i]);
  }
});
/** The screen `m` draws, as text. */
function screen(m: Menu, cols: number, rows: number, side: SidebarView): string[] {
  const w = new Writer();
  m.draw(w, cols, rows, side);
  const host = new Terminal(cols, rows);
  host.feed(w.s);
  const text = host.text();
  host.destroy();
  return text.split("\n");
}
const work = Row.of("claude", "/accounts/work");
const workAccount = (option: object = {}) => ({ provider: "claude", account: "/accounts/work", name: "work", option });

test("Pi's default and account rows do not offer a permission bypass", () => {
  const named = Row.of("pi", "/accounts/pi"),
    m = menu({ selected: named });
  m.preview = preview({ pending: false, accounts: [{ provider: "pi", account: "/accounts/pi", name: "work" }] });
  const side = SidebarView.init(120, 32, true, 0, 0),
    b = m.bounds(120, 32, side);
  for (const row of ["pi", named] as const) {
    expect(m.cells(row)[1]).toBe("—");
    const index = Array.from({ length: m.count() }, (_, i) => m.rowAt(i)).indexOf(row);
    expect(m.yoloHit(120, 32, side, b.x + 3 + m.columns(b.w)[0], b.y + 2 + index)).toBeNull();
  }
  expect(screen(m, 120, 32, side)[b.y + b.h - 2]).not.toContain("YOLO");
});

test("OpenCode stays manageable without offering unsupported account sign-in", () => {
  const m = menu({ selected: "opencode2" });
  m.preview = preview({ pending: false, options: { opencode2: { account: "OpenCode provider credentials" } } });
  expect(m.shown("opencode2")).toBe(true);
  expect(m.manageModel().offers.find(o => o.provider === "opencode2")).toEqual({
    provider: "opencode2",
    installed: true,
    signin: false,
  });
  expect(m.manageModel().agents.find(a => a.provider === "opencode2")).toMatchObject({
    shown: true,
    here: true,
    signed_out: false,
  });
  m.workspace_hidden = ["opencode2"];
  expect(m.shown("opencode2")).toBe(false);
  expect(m.manageModel().agents.find(a => a.provider === "opencode2")).toMatchObject({ shown: true, here: false });
  m.workspace_hidden = [];
  m.hidden.opencode2 = true;
  expect(m.manageModel().agents.find(a => a.provider === "opencode2")).toMatchObject({ shown: false, here: true });
  m.hidden.opencode2 = false;
  m.managing = true;
  expect(screen(m, 180, 40, SidebarView.init(180, 40, true, 0, 0)).join("\n")).toContain("OpenCode");
});

test("Enterprise accounts show their monthly spend in the picker and manager", () => {
  const at = now();
  const m = menu({ selected: work });
  m.preview = preview({
    pending: false,
    accounts: [
      workAccount({
        signed_in: true,
        plan: "Enterprise",
        limits: "metered",
        usage_fetched_at: at,
        spend: {
          used_minor: 59,
          limit_minor: 1000000,
          currency: "USD",
          exponent: 2,
          period_start: at - 60,
          reset_at: at + 86400,
        },
      }),
    ],
  });
  expect(m.usageCell(work).amount).toBe("$0.59 / $10k");
  expect(m.usageCell(work).windows[0]?.figure).toBe("<1%");
  expect(m.usageCell("claude").fallback).not.toContain("$0.59");
  expect(m.manageModel().agents.find(a => a.account === "/accounts/work")!.usage.amount).toBe("$0.59 / $10k");
  const rendered = screen(m, 150, 30, SidebarView.init(150, 30, true, 0, 0)).join("\n");
  expect(rendered).toMatch(/mo\s+─+\s+<1%\s+1d\s+\$0\.59 \/ \$10k/);
  const o = m.preview.accounts[0].option;
  o.spend!.limit_minor = null;
  expect(m.usageCell(work).amount).toBe("$0.59");
  expect(m.usageCell(work).windows[0]?.used).toBeNull();
  o.spend!.reset_at = at;
  expect(m.usageCell(work).fallback).toBe("—");
  o.spend!.reset_at = at + 86400;
  o.usage_fetched_at = at - 1200;
  expect(m.usageCell(work).fallback).toBe("—");
});

test("launcher menu bounds", () => {
  const side = SidebarView.init(80, 24, true, 0, 0);
  const m = menu();
  const b = m.bounds(80, 24, side);
  expect(b.x + b.w <= 80 && b.y + b.h <= 24).toBe(true);
  expect(m.hit(80, 24, side, b.x + 2, b.y + 2)).toBe("codex");
  expect(m.hit(80, 24, side, b.x + 2, b.y + 3)).toBe("claude");
  expect(m.hit(80, 24, side, b.x + 2, b.y + 5)).toBe("terminal");
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
        account: "",
        session: "a",
        title: "First",
        first: "",
        last: "",
        cwd: "/w",
        branch: "",
        updated_at: 5,
        interrupted: false,
        starred: false,
      },
      {
        provider: "codex",
        account: "",
        session: "b",
        title: "Second",
        first: "",
        last: "",
        cwd: "/w",
        branch: "",
        updated_at: 4,
        interrupted: false,
        starred: false,
      },
    ],
  };
  const b = m.bounds(120, 40, side);
  // Border, headings, three agent rows, a gap, then the Resume heading.
  const first_line = b.y + 8;
  expect(m.hit(120, 40, side, b.x + 2, first_line)).toBeNull();
  expect(m.resumeHit(120, 40, side, b.x + 2, first_line)).toEqual({ row: 0 });
  // "More" sits below a gap.
  expect(m.resumeHit(120, 40, side, b.x + 2, first_line + 2)).toBeNull();
  expect(m.resumeHit(120, 40, side, b.x + 2, first_line + 3)).toEqual({ row: 2 });
  expect(m.resumeHit(120, 40, side, b.x + 2, first_line - 1)).toBeNull();
  expect(b.h).toBeGreaterThanOrEqual(m.rowsHeight());
  m.resume_view.expand();
  expect(m.bounds(120, 40, side).w).toBe(b.w);
});

test("launcher clips long content and keeps usage hit targets aligned", () => {
  const m = menu({ selected: "claude" });
  const widths = m.columns(200);
  m.preview.pending = false;
  m.preview.options.codex.model = "a-long-model-name-that-needs-room";
  m.preview.options.claude.account = "person.with.a.long.name@example.com";
  m.preview.options.claude.usage_needs_consent = true;
  expect(m.columns(200)).toEqual(widths);
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
      if (/\* Claude/.test(line)) {
        found[1] += 1;
        rows[1] = line;
        for (const value of ["7d", "35%", "1d 15h", " │ 5h", "17%", "1h 39m"]) expect(line).toContain(value);
      }
      expect(displayWidth(line)).toBeLessThanOrEqual(cols);
    }
    expect(found).toEqual([1, 1]);
    // Codex reports only a weekly limit; it lines up with Claude's.
    for (const needles of [
      ["7d", "7d"],
      ["48%", "35%"],
      ["6d 18h", "1d 15h"],
    ]) {
      const columns = rows.map((line, i) => displayWidth(line.slice(0, line.lastIndexOf(needles[i]))));
      expect(columns[0]).toBe(columns[1]);
    }
    const b = m.bounds(cols, 24, side);
    const x = b.x + 3 + m.columns(b.w)[0];
    expect(m.yoloHit(cols, 24, side, x, b.y + 2)).toBe("codex");
  }
});

test("viewer expires a delivered usage reading after twenty minutes", () => {
  const m = menu();
  m.preview.pending = false;
  const o = m.preview.options.codex;
  o.limits = { windows: [null, { minutes: 10080, used: 48, reset_at: null }] } as any;
  o.usage_fetched_at = now() - 1190;
  expect(m.usageCell("codex").limited()).toBe(true);
  o.usage_fetched_at = now() - 1200;
  expect(m.usageCell("codex").fallback).toBe("—");
  o.limits = "metered";
  expect(m.usageCell("codex").fallback).toBe("Metered");
  o.limits = "rate_limited";
  o.usage_fetched_at = 0;
  o.usage_error = "server returned 429";
  expect(m.usageCell("codex").fallback).toBe("—");
});

test("launcher hides providers that are not installed", () => {
  const side = SidebarView.init(120, 24, true, 0, 0);
  const m = menu();
  m.preview.installed = byProvider(p => p === "claude");
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
  m.preview.installed = byProvider(() => false);
  m.normalize();
  expect(m.selected).toBe("terminal");
  expect(m.first()).toBe("terminal");
});

test("Manage agents lists the signed-out and hidden agents the picker leaves out", () => {
  const m = menu();
  m.preview.pending = false;
  m.preview.options.codex.signed_in = false;
  m.preview.options.claude.account = "me@example.com";
  m.hidden.claude = true;
  m.hidden.pi = true;
  m.normalize();
  expect(m.selected).toBe("terminal");
  expect(!m.shown("codex") && !m.shown("claude")).toBe(true);
  expect(m.manageModel().agents.map(a => [a.label, a.who, a.shown, a.signed_out])).toEqual([
    ["Codex", "Not signed in", true, true],
    ["Claude Code", "me@example.com", false, false],
    ["Pi", "Unavailable", false, false],
    ...others.map(p => [adapter(p).label, "Not installed", true, false]),
  ]);
  m.commands[0].set("FOO=123 claude --whatever");
  m.commands[0].hidden = true;
  expect(m.shown("custom0")).toBe(false);
  m.commands[0].hidden = false;
  expect(m.shown("custom0")).toBe(true);
  m.preview.options.codex.signed_in = null;
  expect(m.shown("codex")).toBe(true);
});

test("rows hidden in this workspace leave its picker but stay in Manage agents, unchecked", () => {
  const m = menu({ workspace_name: "corgi", workspace_hidden: ["claude", work, "custom0"] });
  m.preview = preview({ pending: false, accounts: [workAccount({ account: "work@example.com" })] });
  m.commands[0].set("claude --model opus");
  m.normalize();
  expect(["codex", "claude", work, "custom0", "terminal"].map(row => m.shown(row as Row))).toEqual([
    true,
    false,
    false,
    false,
    true,
  ]);
  const model = m.manageModel();
  expect(model.workspace).toBe("corgi");
  expect(model.agents.map(a => [a.label, a.shown, a.here])).toEqual([
    ["Codex", true, true],
    ["Claude Code", true, false],
    ["Claude Code · work", true, false],
    ["Pi", true, true],
    ...others.map(p => [adapter(p).label, true, true]),
  ]);
  expect([model.here(0), model.here(1)]).toEqual([false, true]);
  expect(["codex", "claude:/a", "custom5", "terminal", "claude:work", "custom6", ""].map(Row.parse)).toEqual([
    "codex",
    "claude:/a",
    "custom5",
    null,
    null,
    null,
    null,
  ]);
});

test("digit shortcuts enumerate visible agents and exclude terminal and management", () => {
  const m = menu();
  const c = (s: string) => s.charCodeAt(0);
  expect(m.shortcutRow(c("0"))).toBe("codex");
  expect(m.shortcutRow(c("1"))).toBe("claude");
  expect(m.shortcutRow(c("2"))).toBe("pi");
  m.hidden.pi = true;
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
  expect(m.customCells(1)[2]).toBe("Sonnet (1M)");
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
    holder: null,
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
  const rows = text.split("\n");
  let bx = m.worktreeBox(100, 30, side)!;
  expect(rows[bx.branch]).toContain("Branch  search or create");
  expect(bx.branch).toBeLessThan(bx.list);
  expect(rows[bx.from]).not.toContain("From");
  expect(rows[bx.folder]).toContain("Folder  ../app-topic");
  expect(m.worktreeHit(100, 30, side, bx.label_x, bx.list)).toEqual({ checkout: 0 });
  expect(m.worktreeHit(100, 30, side, bx.label_x, bx.list + 1)).toEqual({ checkout: 1 });
  expect(m.worktreeHit(100, 30, side, bx.field_x, bx.branch)).toBe("branch");
  expect(m.worktreeHit(100, 30, side, bx.field_x, bx.from)).toBeNull();
  m.worktree.move(m.worktrees, 1);
  expect(render()).toContain("↵ switch");
  expect(render().split("\n")[bx.folder]).toContain("Folder  ./");
  m.worktree.edit(field => field.key(21));
  for (const byte of Buffer.from("top")) m.worktree.edit(field => field.key(byte));
  bx = m.worktreeBox(100, 30, side)!;
  text = render();
  expect(text).toContain("+ Create “top”");
  expect(text).toContain("hold ↵ to create");
  expect(text.split("\n")[bx.from]).toContain("From    main");
  expect(text.split("\n")[bx.folder]).toContain("Folder  ./.worktrees/top");
  expect(m.worktreeHit(100, 30, side, bx.field_x, bx.from)).toBe("from");
  // From's branches open right under its field, as wide as it.
  m.worktree.branches = [
    { ref: "refs/heads/main", name: "main", at: 0 },
    { ref: "refs/heads/topic", name: "topic", at: 0 },
  ];
  m.worktree.focusFrom();
  bx = m.worktreeBox(100, 30, side)!;
  const pick = m.worktreePickRect(100, 30, side)!;
  expect([pick.x, pick.y, pick.w]).toEqual([bx.field_x, bx.from + 1, bx.field_w]);
  expect(pick.y + pick.h).toBeLessThanOrEqual(bx.folder);
  expect(
    render()
      .split("\n")
      [bx.from + 1].slice(bx.field_x, bx.field_x + 4),
  ).toBe("main");
  expect(m.worktreeHit(100, 30, side, pick.x, pick.y + 1)).toEqual({ pick: 1 });
});

test("an account's row reads its own account and has its own YOLO and launcher membership", () => {
  const m = menu({ selected: work });
  m.preview = preview({ accounts: [workAccount()] });
  m.normalize();
  expect(m.selected).toBe(work);
  expect(m.rows().slice(0, 3)).toEqual(["codex", "claude", work]);
  expect(m.cells(work)).toEqual(["Claude Code · work", "·", "Reading…", "Reading…", "…"]);
  // Narrow, the provider's name gives way to the account's.
  expect([m.label(work, 13), m.label(work, 11)]).toEqual(["Claude · work", "Cla… · work"]);
  expect(m.usageCell(work).fallback).toBe("Reading…");
  m.preview.pending = false;
  expect(m.cells(work).slice(2)).toEqual(["Default", "Unavailable", "Unknown"]);
  expect(m.usageCell(work).fallback).toBe("—");
  const o = m.accountOf(work)!.option;
  o.usage_needs_consent = true;
  expect([m.trackable(work), m.trackable("claude")]).toEqual([true, false]);
  expect(m.usageCell(work).fallback).toBe("Track usage");
  o.usage_needs_consent = false;
  // Its own model, account, plan, limits and YOLO.
  Object.assign(o, { model: "opus", model_name: "Opus", account: "work@example.com", plan: "Team" });
  o.limits = { windows: [{ minutes: 300, used: 17, reset_at: now() + 99 * 60 }, null] } as any;
  o.usage_fetched_at = now();
  m.yolo.claude = true;
  expect([m.yoloOf("claude"), m.yoloOf(work)]).toEqual([true, false]);
  m.yolo.claude = false;
  m.account_yolo = ["/accounts/work"];
  expect([m.yoloOf("claude"), m.yoloOf(work)]).toEqual([false, true]);
  expect(m.cells(work)).toEqual(["Claude Code · work", "✓", "Opus", "work@example.com", "Team"]);
  const side = SidebarView.init(120, 24, true, 0, 0);
  const b = m.bounds(120, 24, side);
  const line = screen(m, 120, 24, side)[b.y + 4];
  // The brand mark says whose account it is, beside the account's own name.
  for (const value of [" 2 ", "* work ", "✓", "Opus", "work@example.com", "Team", "5h", "17%"])
    expect(line).toContain(value);
  expect(m.hit(120, 24, side, b.x + 2, b.y + 4)).toBe(work);
  const widths = m.columns(b.w);
  expect(m.yoloHit(120, 24, side, b.x + 3 + widths[0], b.y + 4)).toBe(work);
  const usage_x = b.x + 3 + widths[0] + widths[1] + widths[2] + widths[3] + widths[4];
  expect(m.usageHit(120, 24, side, usage_x, b.y + 4)).toBe(work);
  // Hidden on its own, or when its agent isn't installed.
  m.hidden.claude = true;
  expect([m.shown("claude"), m.shown(work)]).toEqual([false, true]);
  m.hidden.claude = false;
  m.account_hidden = ["/accounts/work"];
  expect([m.shown("claude"), m.shown(work), m.hiddenOf(work)]).toEqual([true, false, true]);
  m.account_hidden = [];
  m.preview.installed.claude = false;
  expect(m.shown(work)).toBe(false);
  expect(m.manageModel().agents.find(a => a.account === "/accounts/work")?.who).toBe("Not installed");
  m.preview.installed.pi = false;
  m.preview.outdated.pi = "0.84.2";
  expect(m.manageModel().agents.find(a => a.provider === "pi" && !a.account)?.who).toBe(
    "0.84.2 · needs 1.0.0 or newer",
  );
});

test("a completed account stops reading in both screens while other rows are pending", () => {
  const m = menu();
  m.preview = preview({ pending: true, accounts: [workAccount({ pending: false, account: "work@example.com" })] });
  expect(m.cells(work).slice(2)).toEqual(["Default", "work@example.com", "Unknown"]);
  expect(m.usageCell(work).fallback).toBe("—");
  expect(m.cells("codex")).toContain("Reading…");
  const managed = m.manageModel().agents.find(a => a.account === "/accounts/work")!;
  expect(managed.who).toBe("work@example.com");
  expect(managed.usage.fallback).toBe("—");
});

test("a signed-out account's row stays listed and offers to sign in", () => {
  const m = menu({ selected: work });
  m.preview = preview({ pending: false, accounts: [workAccount({ signed_in: false, usage_needs_consent: true })] });
  // A signed-out default's row is still left out.
  m.preview.options.claude.signed_in = false;
  m.normalize();
  expect([m.shown("claude"), m.shown(work), m.selected]).toEqual([false, true, work]);
  expect([m.signsIn(work)?.name, m.signsIn("claude"), m.signsIn("codex")]).toEqual(["work", null, null]);
  expect(m.cells(work).slice(3)).toEqual(["—", "—"]);
  expect([m.usageCell(work).fallback, m.trackable(work)]).toEqual(["Sign in", false]);
  const side = SidebarView.init(120, 24, true, 0, 0);
  const b = m.bounds(120, 24, side);
  const lines = screen(m, 120, 24, side);
  expect(lines[b.y + 3]).toMatch(/ 1 +\* work .* — +— +Sign in +│/);
  expect(lines[b.y + b.h - 2]).toMatch(/a +sign in +y +YOLO/);
  m.account_hidden = ["/accounts/work"];
  expect(m.shown(work)).toBe(false);
});

test("digits count account rows like the agents'", () => {
  const m = menu();
  const side = Row.of("codex", "/accounts/side");
  m.preview = preview({ accounts: [workAccount(), { provider: "codex", account: "/accounts/side", name: "side" }] });
  m.commands[0].set("claude --model opus");
  const c = (s: string) => s.charCodeAt(0);
  const rows: Row[] = ["codex", side, "claude", work, ...Provider.all.slice(2), "custom0"];
  expect(rows.map((_, digit) => m.shortcutRow(c(String(digit))))).toEqual(rows);
  m.hidden.codex = true;
  expect([m.shortcutRow(c("0")), m.shortcutRow(c("1"))]).toEqual([side, "claude"]);
  m.account_hidden = ["/accounts/side"];
  expect([m.shortcutRow(c("0")), m.shortcutRow(c("1"))]).toEqual(["claude", work]);
});

test("a default account that has a name shows it on its row", () => {
  const m = menu();
  m.preview = preview({ pending: false, names: { claude: "acme" }, accounts: [workAccount()] });
  m.accounts = [{ provider: "claude", account: "/accounts/work", name: "work" }];
  expect([m.label("claude"), m.label("codex"), m.label(work)]).toEqual([
    "Claude Code · acme",
    "Codex",
    "Claude Code · work",
  ]);
  expect(m.manageModel().agents.find(a => a.provider === "claude" && !a.account)?.name).toBe("acme");
  // Conversations name it once there's another account to tell it from.
  const entry = { provider: "claude", account: "", session: "s" } as any;
  expect(m.resumeContext().accountName(entry)).toBe("acme");
  m.accounts = [];
  expect(m.resumeContext().accountName(entry)).toBe("");
});

test("a row whose account went away leaves its provider's selected", () => {
  const m = menu({ selected: work });
  m.preview = preview({ accounts: [workAccount()] });
  m.normalize();
  expect(m.selected).toBe(work);
  m.preview = preview();
  m.normalize();
  expect(m.selected).toBe("claude");
  m.selected = work;
  m.hidden.claude = true;
  m.normalize();
  expect(m.selected).toBe("codex");
});

test("Manage agents takes the card with its own selection", () => {
  const m = menu({ selected: work });
  m.preview = preview({ pending: false, accounts: [workAccount({ account: "work@example.com" })] });
  m.commands[0].set("claude --model opus");
  const before = m.bounds(120, 40, SidebarView.init(120, 40, true, 0, 0));
  m.manage();
  expect(m.managing).toBe(true);
  expect(m.manager.focus).toBe("list");
  const side = SidebarView.init(120, 40, true, 0, 0),
    b = m.bounds(120, 40, side),
    lines = screen(m, 120, 40, side);
  expect(b.w).toBe(before.w);
  expect(lines[b.y]).toMatch(/╭─ ← New tab ─ Manage agents ─+ +esc +close ─╮/);
  expect(lines[b.y + 7]).toMatch(/│› ≡ † Codex /);
  expect(lines[b.y + 9]).toMatch(/│  ≡ \* work +work@example.com +▾ Auto \(last chosen\) +│/);
  // The picker's rows don't answer clicks under it.
  expect(m.hit(120, 40, side, b.x + 6, b.y + 8)).toBeNull();
  expect(lines[b.y + b.h - 2].replaceAll("│", "").trim()).toBe("");
  m.back();
  expect(m.selected).toBe(work);
});

test("Manage agents shows hidden accounts' own usage, keeps zero, and omits missing readings", () => {
  const m = menu({ selected: work });
  const at = now();
  m.preview = preview({
    pending: false,
    accounts: [
      workAccount({
        account: "work@example.com",
        usage_fetched_at: at,
        limits: {
          windows: [
            { minutes: 300, used: 0, reset_at: at + 3600 },
            { minutes: 10080, used: 82, reset_at: at + 86400 },
          ],
        },
      }),
    ],
  });
  m.workspace_hidden = [work];
  m.preview.options.codex.usage_error = "no usage returned";
  m.manage();
  const a = m.manageModel().agents.find(a => a.account === "/accounts/work")!;
  expect(a.here).toBe(false);
  expect(a.usage.windows.map(w => w?.used)).toEqual([82, 0]);
  const side = SidebarView.init(150, 40, true, 0, 0);
  const text = screen(m, 150, 40, side).join("\n");
  expect(text).toContain("Usage · resets in");
  expect(text).toContain("0%");
  expect(text).toContain("82%");
  expect(text).not.toContain("no usage returned");
  m.preview.accounts[0].option.usage_fetched_at = at - 1200;
  expect(m.manageModel().agents.find(a => a.account === "/accounts/work")!.usage.fallback).toBe("—");
});

test("both cards keep the same width with expanded history and on narrow terminals", () => {
  const m = menu();
  m.history.entries = [
    {
      provider: "claude",
      account: "",
      session: "a",
      title: "First",
      first: "",
      last: "",
      cwd: "/w",
      branch: "",
      updated_at: 5,
      interrupted: false,
      starred: false,
    },
  ];
  m.resume_view.expand();
  for (const cols of [40, 80, 120, 180]) {
    const side = SidebarView.init(cols, 40, true, 0, 0);
    const before = m.bounds(cols, 40, side);
    m.manage();
    expect(m.bounds(cols, 40, side).w).toBe(before.w);
    m.back();
    expect(m.resume_view.expanded).toBe(true);
  }
});

test("Removing and restoring keeps both cards and their columns the same width", () => {
  const m = menu(),
    at = now();
  m.preview = preview({
    pending: false,
    accounts: [workAccount({ account: "work@example.com", model: "a-long-account-model-name" })],
    options: {
      claude: {
        account: "personal@example.com",
        model: "a-long-claude-model-name",
        usage_fetched_at: at,
        limits: {
          windows: [
            { minutes: 300, used: 3, reset_at: at + 3 * 3600 },
            { minutes: 10080, used: 67, reset_at: at + 3 * 86400 },
          ],
        },
      },
    },
  });
  m.commands[0].set("claude --model an-even-longer-saved-command-model-name");
  for (const cols of [80, 120, 200]) {
    const side = SidebarView.init(cols, 40, true, 0, 0);
    m.hidden.claude = false;
    m.account_hidden = [];
    m.commands[0].hidden = false;
    const expected = m.bounds(cols, 40, side),
      widths = m.columns(expected.w);
    for (const hidden of [true, false, true]) {
      m.hidden.claude = hidden;
      m.account_hidden = hidden ? ["/accounts/work"] : [];
      m.commands[0].hidden = hidden;
      for (const managing of [true, false]) {
        m.managing = managing;
        const actual = m.bounds(cols, 40, side);
        expect([actual.x, actual.w]).toEqual([expected.x, expected.w]);
        expect(m.columns(actual.w)).toEqual(widths);
      }
    }
  }
});

test("both cards keep their bounds and columns as account details and usage arrive", () => {
  for (const cols of [60, 80, 120, 180]) {
    const m = menu(),
      side = SidebarView.init(cols, 40, true, 0, 0);
    m.preview = preview({ accounts: [workAccount()] });
    const before = m.bounds(cols, 40, side),
      widths = m.columns(before.w);
    m.manage();
    const managing = m.bounds(cols, 40, side);
    m.back();
    const stages = [
      { account: "person.with.a.long.name@example.com", model: "a-long-model-name-that-needs-room", plan: "Pro" },
      {
        usage_fetched_at: now(),
        limits: {
          windows: [
            { minutes: 300, used: 3, reset_at: now() + 2 * 3600 },
            { minutes: 10080, used: 67, reset_at: now() + 3 * 86400 },
          ],
        },
      },
    ];
    for (const stage of stages) {
      Object.assign(m.preview.options.claude, stage);
      Object.assign(m.preview.accounts[0].option, stage);
      m.preview.pending = false;
      expect(m.bounds(cols, 40, side)).toEqual(before);
      expect(m.columns(before.w)).toEqual(widths);
      m.manage();
      expect(m.bounds(cols, 40, side)).toEqual(managing);
      m.back();
    }
  }
});
test("a command for a provider this viewer doesn't know runs no provider", () => {
  const semantics = { provider: "future", suggested_name: "Future" };
  expect(commandEntry({ command: "future", semantics }).semantics.provider).toBeNull();
  const resolved = resolution({ semantics, command: { command: "future", semantics } });
  expect([resolved.semantics.provider, resolved.command.semantics.provider]).toEqual([null, null]);
  expect(resolved.semantics.suggested_name).toBe("Future");
  // Sending them back would erase the provider, so they stay with the daemon.
  expect([returned(resolved.semantics), returned(resolved.command.semantics)]).toEqual([null, null]);
  for (const provider of ["codex", null]) {
    const known = commandEntry({ command: "x", semantics: { provider } }).semantics;
    expect(returned(known)).toBe(known);
  }
});

test("launcher leaves room for model and compact effort without an ellipsis", () => {
  const m = menu({
    profiles: [
      {
        id: "astra",
        provider: "codex",
        account: "",
        name: "Codex Astra",
        options: { flags: "", env: [], model: "gpt-6-astra", effort: "xhigh" },
        yolo: false,
      },
      {
        id: "sol",
        provider: "codex",
        account: "",
        name: "Codex Sol",
        options: { flags: "", env: [], model: "gpt-6.1-sol", effort: "xhigh" },
        yolo: false,
      },
    ],
  });
  for (const cols of [120, 146, 160]) {
    const rows = screen(m, cols, 30, SidebarView.init(cols, 30, true, 0, 0));
    expect(rows.some(row => row.includes("GPT-6 Astra XHigh"))).toBe(true);
    expect(rows.some(row => row.includes("GPT-6.1 Sol XHigh"))).toBe(true);
  }
});

/** Conversations in `cwd`, alternating agents, newest first. */
function conversations(cwd: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    provider: (i % 3 === 2 ? "codex" : "claude") as Provider,
    account: "",
    session: `s${i}`,
    title: `Conversation ${i}`,
    first: "",
    last: "said something",
    cwd,
    branch: "",
    updated_at: now() - i * 3600,
    interrupted: false,
    starred: false,
  }));
}

test("each agent and conversation row leads with its brand mark", () => {
  const side = SidebarView.init(120, 40, true, 0, 0),
    m = menu({ cwd: "/w", workspace_cwd: "/w" });
  m.history = { pending: false, entries: conversations("/w", 3) };
  const placed: [Provider, number, number][] = [];
  m.marks = (provider, col, row) => {
    placed.push([provider, col, row]);
    return "<mark>";
  };
  const b = m.bounds(120, 40, side);
  m.draw(new Writer(), 120, 40, side);
  // The agent rows: Codex, Claude Code and Pi, in the name column.
  expect(placed.filter(([, , row]) => row < b.y + 2 + m.count())).toEqual([
    ["codex", b.x + 7, b.y + 2],
    ["claude", b.x + 7, b.y + 3],
    ["pi", b.x + 7, b.y + 4],
  ]);
  // The conversations: a mark wherever a run of one agent starts.
  const resume = placed.filter(([, , row]) => row >= b.y + 2 + m.count());
  expect(resume.map(([provider]) => provider)).toEqual(["claude", "codex"]);
  expect(new Set(resume.map(([, col]) => col))).toEqual(new Set([b.x + 3]));
  // Without image support, each shows its glyph in the same cells.
  m.marks = null;
  const lines = screen(m, 120, 40, side);
  expect(lines[b.y + 3].slice(b.x + 7, b.x + 9)).toBe("* ");
});
