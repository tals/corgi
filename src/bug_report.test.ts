import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bugReport from "./bug_report";
import { Collector } from "./terminal_probe";
import { status } from "./corgi_setup";
import type { Rgb } from "./palette";

const rgb = (s: string): Rgb => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)) as Rgb;
const palette = (fg: string, bg: string, ansi: string[]) => ({
  foreground: rgb(fg),
  background: rgb(bg),
  ansi: ansi.map(rgb),
});
/** Ghostty's colors without a theme. */
const ordinary = palette("#ffffff", "#282c34", [
  "#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
  "#666666", "#d54e53", "#b9ca4a", "#e7c547", "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea",
]); // prettier-ignore
/** Gray on gray, red and blue swapped, brights the same as normals. */
const modded = palette("#777777", "#555555", [
  "#000000", "#3355ff", "#888888", "#8a8a8a", "#ff3333", "#999999", "#909090", "#cccccc",
  "#444444", "#3355ff", "#888888", "#8a8a8a", "#ff3333", "#999999", "#909090", "#cccccc",
]); // prettier-ignore

function terminal(over: Partial<bugReport.Terminal> = {}): bugReport.Terminal {
  const probe = new Collector();
  probe.start(40, 0);
  for (const reply of [
    "\x1b[40;3R",
    "\x1b[40;2R",
    "\x1b[40;3R",
    "\x1b[40;3R",
    "\x1b[40;3R",
    "\x1b[40;2R",
    "\x1b[40;2R",
    "\x1b[40;2R",
    "\x1b[?2026;2$y",
    "\x1b[?2027;2$y",
    "\x1b[?1004;1$y",
    "\x1b[?1006;1$y",
    "\x1b[?2004;1$y",
    "\x1b[?2031;1$y",
    "\x1b[?1u",
    "\x1b[4;720;1080t",
    "\x1bP1+r536d756c78=1b5b343a25703125647e\x1b\\",
    "\x1b[?62;22;52c",
  ])
    // prettier-ignore
    expect(probe.accept(reply)).toBe(true);
  return {
    source: "this viewer",
    name: "kitty(0.39.1)",
    env: { TERM: "xterm-kitty", COLORTERM: "truecolor", LANG: "en_US.UTF-8" },
    cols: 120,
    rows: 40,
    measured: true,
    pty: { cols: 120, rows: 40, width: 1080, height: 720 },
    used: { width: 9, height: 18 },
    graphics: true,
    badge: "image",
    colors: ordinary,
    tmux: null,
    ssh: false,
    answers: probe.answers,
    ...over,
  };
}
function session(
  provider: string,
  state: string,
  hooked_ms: number | null,
  over: Partial<bugReport.Session> = {},
): bugReport.Session {
  return { provider, state, attention: "none", hooked_ms, tool: false, paused: false, compacting: false, ...over };
}
function report(over: Partial<bugReport.Report> = {}): bugReport.Report {
  return {
    corgi: "1.2.3 (abc1234), linux-x64",
    install: { path: "/home/me/.local/bin/corgi", auto_update: true },
    system: {
      os: "Debian GNU/Linux 12 (bookworm)",
      os_timed_out: false,
      kernel: "Linux 6.1.0-26-amd64 x86_64",
      locale: "C",
      shell: { path: "/bin/bash", version: "GNU bash, version 5.2.15(1)-release" },
      agents: [
        {
          name: "Codex",
          version: "codex-cli 0.46.0",
          path: "/home/me/.local/bin/codex",
          old: false,
          unanswered: false,
          hooks: "installed",
        },
        { name: "Pi", version: "0.84.2", path: "", old: true, unanswered: false, hooks: null },
      ],
    },
    daemon: {
      pid: 41234,
      same_build: true,
      release: "1.2.3",
      uptime_ms: (3 * 60 + 12) * 60000,
      staged: "",
      extended: true,
      layout: { workspaces: 3, tabs: 7, panes: 12 },
      sessions: [
        session("Codex", "idle", 60000),
        session("Codex", "working", 4000, { tool: true }),
        session("Codex", "idle", null),
        session("Claude", "idle", 9000, { attention: "needs_input" }),
      ],
      others: [],
    },
    slow: { daemon: false, sessions: false, report: false },
    terminal: terminal(),
    overrides: [],
    logs: { server: "/home/me/.local/state/corgi/server.log", crashes: 0 },
    warnings: ["warning(hooks): hook from pane 9 dropped (×3)"],
    inference: null,
    ...over,
  };
}
const settings: bugReport.Settings = {
  theme: "Corgi (automatic)",
  keymap: "Corgi (prefix Ctrl+B)",
  clever_corgi: "Claude · claude-haiku (auto)",
};
function withHome<T>(home: string, run: () => T): T {
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    return run();
  } finally {
    process.env.HOME = was;
  }
}

test("the report covers the build, daemon, system, terminal, colors, agents, sessions and settings", () => {
  expect(withHome("/home/me", () => bugReport.text(report(), settings))).toBe(
    [
      "- Corgi: 1.2.3 (abc1234), linux-x64",
      "- Daemon: same build, pid 41234, up 3h 12m",
      "- Install: ~/.local/bin/corgi, auto-update on",
      "- OS: Debian GNU/Linux 12 (bookworm)",
      "- Kernel: Linux 6.1.0-26-amd64 x86_64",
      "- Shell: GNU bash, version 5.2.15(1)-release (/bin/bash)",
      "- Locale: en_US.UTF-8",
      "- Terminal: this viewer",
      "  - Name: kitty(0.39.1)",
      "  - Env: TERM=xterm-kitty, COLORTERM=truecolor",
      "  - Size: 120×40 cells",
      "  - PTY: 120×40 cells, 1080×720 px",
      "  - Queried: cell no answer, window 1080×720 px",
      "  - Corgi used: 9×18 px per cell",
      "  - Widths: match; emoji presentation 2, flag 2, joined emoji 2; grapheme clusters off",
      "  - Keyboard: kitty protocol (flags 1), bracketed paste",
      "  - Output: synchronized updates, SGR mouse, focus events, color scheme reports, undercurl",
      "  - Images: Kitty graphics, badge drawn as image",
      "- Colors: dark, fg #ffffff, bg #282c34",
      "  - normal: #1d1f21 #cc6666 #b5bd68 #f0c674 #81a2be #b294bb #8abeb7 #c5c8c6",
      "  - bright: #666666 #d54e53 #b9ca4a #e7c547 #7aa6da #c397d8 #70c0b1 #eaeaea",
      "- Agents:",
      "  - Codex: codex-cli 0.46.0 (~/.local/bin/codex), hooks installed",
      "  - Pi: 0.84.2, too old for Corgi",
      "- Sessions: 4 running: Codex 3 (2 idle, 1 working), Claude 1 (1 idle); last hook 4s ago, 1 without hooks since start",
      "- Layout: 3 workspaces, 7 tabs, 12 panes",
      "- Settings: theme Corgi (automatic), keymap Corgi (prefix Ctrl+B), Clever Corgi Claude · claude-haiku (auto)",
      "- Logs: ~/.local/state/corgi/server.log",
      "- Recent warnings:",
      "  - warning(hooks): hook from pane 9 dropped (×3)",
      "",
    ].join("\n"),
  );
});

test("the issue leaves out paths and logs, and rows with nothing to say", () => {
  const issue = withHome("/home/me", () => bugReport.text(report(), settings, true));
  for (const local of ["Recent warnings", "hook from pane 9"]) expect(issue).not.toContain(local);
  expect(issue).toContain("- Sessions: 4 running: ");
  // Nothing between, no other viewers, no overrides, no crash reports.
  for (const quiet of ["Between", "Other viewers", "Overrides", "crash report"]) expect(issue).not.toContain(quiet);
  const busy = bugReport.text(
    report({
      terminal: terminal({
        tmux: { version: "tmux 3.4", passthrough: "off", clipboard: "external", timed_out: false },
        ssh: true,
      }),
      overrides: ["CORGI_CLAUDE_BIN=~/bin/claude-dev"],
      logs: { server: "/s/server.log", crashes: 1 },
    }),
    settings,
    true,
  );
  expect(busy).toContain("  - Between: tmux 3.4 (allow-passthrough off, set-clipboard external), SSH\n");
  expect(busy).toContain("- Overrides: CORGI_CLAUDE_BIN=~/bin/claude-dev\n");
  expect(busy).toContain("- Logs: /s/server.log, 1 crash report pending\n");
});

test("whatever timed out says so where it's shown, and once more at the end", () => {
  const r = report({
    terminal: terminal({ tmux: { version: "tmux 3.4", passthrough: "", clipboard: "", timed_out: true } }),
  });
  r.slow = { daemon: false, sessions: true, report: false };
  r.system.shell.version = null;
  r.system.agents = [
    { name: "Codex", version: null, path: "/x/codex", old: false, unanswered: false, hooks: "timeout" },
    { name: "Claude", version: "", path: "/x/claude", old: false, unanswered: true, hooks: null },
  ];
  const text = bugReport.text(r, settings);
  expect(text).toContain("- Shell: /bin/bash, --version timed out after 5s\n");
  expect(text).toContain("  - Between: tmux 3.4 (options timed out after 5s)\n");
  expect(text).toContain("  - Codex: --version timed out after 5s (/x/codex), hooks check timed out after 5s\n");
  expect(text).toContain("  - Claude: found (/x/claude) but it didn't answer --version\n");
  expect(text).toContain("- Sessions: timed out after 5s\n");
  expect(text).not.toContain("Layout");
  expect(text).toContain(
    "- Timed out: daemon session list, tmux options, shell --version, Codex --version, Codex hooks\n",
  );
  // The report request alone timing out isn't taken for an older daemon.
  const partial = report({ terminal: null, slow: { daemon: false, sessions: false, report: true } });
  partial.daemon!.extended = false;
  const shown = bugReport.text(partial, settings);
  expect(shown).toContain("- Daemon: same build, pid 41234, up 3h 12m (the report request timed out after 5s)\n");
  expect(shown).toContain("- Terminal: unknown, the daemon didn't answer in 5s\n");
  expect(shown).toContain("- Timed out: daemon report request\n");
  expect(bugReport.text(report(), settings)).not.toContain("Timed out");
});

test("other viewers say where their details came from", () => {
  const r = report();
  r.daemon!.others = [terminal({ source: "from viewer 3", name: "WezTerm 20240203" })];
  expect(bugReport.text(r, settings)).toContain("- Other viewers: 1 (from viewer 3: WezTerm, 120×40)\n");
});

test("an older daemon that can't say when hooks came leaves that out", () => {
  const old = report();
  old.daemon!.extended = false;
  expect(bugReport.text({ ...old, terminal: null }, settings)).toContain(
    "- Terminal: unknown, the daemon is an older build\n",
  );
  expect(bugReport.text(old, settings)).toContain(
    "- Sessions: 4 running: Codex 3 (2 idle, 1 working), Claude 1 (1 idle)\n",
  );
  const quiet = report();
  quiet.daemon!.sessions = [session("Pi", "idle", null)];
  quiet.daemon!.layout = { workspaces: 1, tabs: 1, panes: 1 };
  const one = bugReport.text(quiet, settings);
  expect(one).toContain("- Sessions: 1 running: Pi 1 (1 idle); no hooks since start\n");
  expect(one).toContain("- Layout: 1 workspace, 1 tab, 1 pane\n");
});

test("without a daemon or a viewer, the report says so", () => {
  const text = bugReport.text(report({ daemon: null, terminal: null }), settings);
  expect(text).toContain("- Daemon: not running\n");
  expect(text).toContain("- Terminal: unknown, Corgi isn't running\n");
  const stuck = bugReport.text(
    report({ daemon: null, terminal: null, slow: { daemon: true, sessions: false, report: false } }),
    settings,
  );
  expect(stuck).toContain("- Daemon: not answering (no reply in 5s)\n");
  expect(stuck).toContain("- Terminal: unknown, the daemon didn't answer in 5s\n");
  expect(stuck).toContain("- Timed out: daemon\n");
  expect(bugReport.text(report({ terminal: null }), settings)).toContain("- Terminal: no viewer attached\n");
  expect(text).not.toContain("Sessions");
  expect(text).not.toContain("Layout");
});

test("each size says where it came from, so a PTY without pixels never reads like one with", () => {
  const direct = terminal({ source: "asked directly", pty: { cols: 120, rows: 40, width: 0, height: 0 }, used: null });
  direct.answers.cell = { width: 10, height: 20 };
  direct.answers.keyboard = 0;
  const text = bugReport.text(report({ terminal: direct }), settings);
  expect(text).toContain("- Terminal: asked directly\n");
  expect(text).toContain("  - PTY: 120×40 cells, no pixel size\n");
  expect(text).toContain("  - Queried: cell 10×20 px, window 1080×720 px\n");
  expect(text).not.toContain("Corgi used");
  expect(text).toContain("  - Keyboard: kitty protocol (off), bracketed paste\n");
  expect(bugReport.text(report({ terminal: terminal({ pty: null, used: null }) }), settings)).toContain(
    "  - PTY: didn't say\n  - Queried: cell no answer, window 1080×720 px\n  - Corgi used: no cell size\n",
  );
  // A viewer from before sizes were reported says so, rather than reading as one that measured nothing.
  const old = bugReport.wireTerminal({ source: "from viewer 2", name: "kitty", cols: 80, rows: 24, answers: {} })!;
  expect(old.measured).toBe(false);
  expect(bugReport.text(report({ terminal: old }), settings)).toContain(
    "  - PTY: not reported by this viewer's build\n",
  );
  // The theory this guards: a PTY that gives no pixels, while the terminal
  // answers for itself, must leave a different full report than one that does.
  const answered = (pty: bugReport.Pty) => {
    const t = terminal({ source: "asked directly", pty, used: null, colors: modded });
    t.answers.cell = { width: 16, height: 34 };
    return bugReport.full(report({ terminal: t }), settings, extras, new Date(0));
  };
  const missing = answered({ cols: 120, rows: 40, width: 0, height: 0 }),
    valid = answered({ cols: 120, rows: 40, width: 1920, height: 1360 });
  expect(missing).not.toBe(valid);
  expect(missing).toContain("pty       120×40 cells, no pixel size\n");
  expect(valid).toContain("pty       120×40 cells, 1920×1360 px\n");
  expect(valid).toContain("queried   cell 16×34 px, window 1080×720 px\nused      not a viewer\n");
});

test("a terminal that never answered says so instead of listing what it can do", () => {
  const silent = new Collector();
  silent.start(40, 0);
  silent.expire(5000);
  expect(silent.done).toBe(true);
  const text = bugReport.text(report({ terminal: terminal({ answers: silent.answers, colors: null }) }), settings);
  expect(text).toContain("  - Replies: none; it didn't answer Corgi's questions in 5s\n");
  expect(text).toContain("- Timed out: terminal\n");
  expect(text).toContain("- Colors: not reported\n");
  expect(text).not.toContain("Keyboard");
  expect(bugReport.flagged(report({ terminal: terminal({ answers: silent.answers }) }).terminal)).toBe(true);
});

test("the issue link fills in the report, and gives up past GitHub's limit", () => {
  const url = bugReport.issueUrl(report(), settings)!;
  expect(url.startsWith("https://github.com/tals/corgi/issues/new?body=")).toBe(true);
  const body = new URL(url).searchParams.get("body")!;
  expect(body.startsWith("### What happened?\n")).toBe(true);
  expect(body).toContain("### Environment\n\n- Corgi: 1.2.3 (abc1234), linux-x64\n");
  expect(body).not.toContain("full_bug_report.txt");
  expect(new URL(bugReport.issueUrl(report(), settings, true)!).searchParams.get("body")).toContain(
    "Please attach full_bug_report.txt",
  );
  const huge = report({ overrides: ["CORGI_X=" + "x".repeat(9000)] });
  expect(bugReport.issueUrl(huge, settings)).toBeNull();
  expect(bugReport.footer(null, true)).toBe("Paste this into a new issue: https://github.com/tals/corgi/issues/new\n");
});

test("an ordinary palette goes without notes, a heavily modified one says what stands out", () => {
  expect(bugReport.colorNotes(ordinary)).toEqual([]);
  // Solarized Light is low in contrast by design, not broken.
  expect(
    bugReport.colorNotes(
      palette("#657b83", "#fdf6e3", [
        "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
        "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
      ]), // prettier-ignore
    ),
  ).toEqual([]);
  expect(bugReport.colorNotes(modded)).toEqual([
    "bright = normal (7 of 8)",
    "text 1.7:1 on the background",
    "low contrast: bright black 1.3:1, red 1.4:1, bright red 1.4:1",
    "red slot is blue",
    "blue slot is red",
    "no usable red, yellow or green (Animal Style uses its own)",
  ]);
  const text = bugReport.text(report({ terminal: terminal({ colors: modded }) }), settings);
  expect(text).toContain("  - notes: bright = normal (7 of 8), text 1.7:1 on the background, ");
});

const extras: bugReport.Extras = {
  discovery: [
    {
      name: "Codex",
      chosen: "/home/me/.local/bin/codex",
      candidates: [
        { path: "/home/me/.local/bin/codex", version: "codex-cli 0.46.0", ok: true },
        { path: "/usr/bin/codex", version: "codex-cli 0.1.0", ok: false },
      ],
    },
    { name: "Pi", chosen: "", candidates: [] },
  ],
  path: "~/.local/bin:/usr/bin",
  hooks: ["✓ Codex  hooks  in ~/.codex/hooks.json"],
  updates: ["Automatic updates: on", "current: 1.2.3"],
  settings: '{\n  "shell": "/bin/zsh"\n}\n',
  preferences: "",
  warnings: ["error: b", "warn(ports): a (×2)"],
};

test("the full report goes with a terminal that needs a closer look", () => {
  expect(bugReport.flagged(terminal())).toBe(false);
  expect(bugReport.flagged(terminal({ colors: modded }))).toBe(true);
  const skewed = terminal();
  skewed.answers.widths[1].got = 2;
  expect(bugReport.flagged(skewed)).toBe(true);
  expect(bugReport.text(report({ terminal: skewed }), settings)).toContain(
    "Widths: text symbol is 2 wide here, Corgi expects 1;",
  );
  const full = bugReport.full(report({ terminal: terminal({ colors: modded }) }), settings, extras, new Date(0));
  expect(full).toContain("# Corgi bug report, 1.2.3 (abc1234), linux-x64, 1970-01-01T00:00:00.000Z\n");
  expect(full).toContain("TERM=xterm-kitty\n");
  const remote = terminal({ env: { TERM: "xterm-ghostty", SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" } });
  expect(bugReport.full(report({ terminal: remote }), settings, extras)).toContain("SSH_CONNECTION=(set)\n");
  expect(full).toContain("\\e[?62;22;52c\n");
  expect(full).toContain('flag               -  2  "🇺🇸"\n');
  expect(full).toContain(
    "### Sizes, by where they came from\nlaid out  120×40 cells\npty       120×40 cells, 1080×720 px\n" +
      "queried   cell no answer, window 1080×720 px\nused      9×18 px per cell\n",
  );
  expect(full).toContain(" 1 red            #3355ff  1.4:1\n");
  expect(full).toContain("### Colors, as Animal Style derives them\n");
  expect(full).toContain("### Notes\nbright = normal (7 of 8)\n");
});

test("the full report holds the whole report and what it leaves out", () => {
  const r = report({ terminal: terminal({ colors: modded }) });
  r.daemon!.others = [terminal({ name: "WezTerm 20240203" })];
  const full = withHome("/home/me", () => bugReport.full(r, settings, extras, new Date(0)));
  // The report itself, local rows too.
  expect(full).toContain("## Report\n\n- Corgi: 1.2.3 (abc1234), linux-x64\n");
  expect(full).toContain("- Recent warnings:\n");
  expect(full).toContain("## Other viewer 1\n\n### Environment\n");
  expect(full).toContain("XTVERSION WezTerm 20240203\n");
  expect(full).toContain(
    "## Sessions\n\nCodex     idle      attention none  last hook 1m ago\n" +
      "Codex     working   attention none  last hook 4s ago  tool running\n" +
      "Codex     idle      attention none  no hooks since start\n" +
      "Claude    idle      attention needs_input  last hook 9s ago\n",
  );
  expect(full).toContain(
    "## Agents\n\nCodex:\n  ~/.local/bin/codex  codex-cli 0.46.0  ← chosen\n" +
      "  /usr/bin/codex  codex-cli 0.1.0  turned down\nPi:\n  none found\nPATH=~/.local/bin:/usr/bin\n",
  );
  expect(full).toContain("## Hooks\n\n✓ Codex  hooks  in ~/.codex/hooks.json\n");
  expect(full).toContain("## Updates\n\nAutomatic updates: on\ncurrent: 1.2.3\n");
  expect(full).toContain('## settings.json\n\n{\n  "shell": "/bin/zsh"\n}\n');
  expect(full).toContain("## viewer.json\n\n(none)\n");
  expect(full.endsWith("## Warnings and errors\n\nerror: b\nwarn(ports): a (×2)\n")).toBe(true);
});

test("a terminal reported to the daemon comes back as it was, and junk comes back empty", () => {
  const t = terminal({ tmux: { version: "tmux 3.4", passthrough: "on", clipboard: "on", timed_out: false } });
  expect(bugReport.wireTerminal(JSON.parse(JSON.stringify(t)))).toEqual(t);
  expect(bugReport.wireTerminal(null)).toBeNull();
  const junk = bugReport.wireTerminal({
    name: 3,
    cols: "x",
    colors: { foreground: [1, 2] },
    answers: { widths: [{}] },
  })!;
  expect(junk.name).toBe("");
  expect(junk.colors).toBeNull();
  expect(junk.answers.widths).toEqual([{ kind: "", text: "", expected: null, got: null }]);
});

test("overrides leave out what panes set themselves", () => {
  expect(
    bugReport.overrides(
      { CORGI_PANE: "3", CORGI_SOCKET: "/s", CORGI_BIN: "/b", CORGI_CLAUDE_BIN: "/x/claude", PATH: "/bin" },
      { shell: "/bin/zsh", smart_links: false },
    ),
  ).toEqual(["CORGI_CLAUDE_BIN=/x/claude", "settings.json shell=/bin/zsh", "settings.json smart_links=false"]);
  expect(bugReport.overrides({ CORGI_SOCKET: "/s" }, {})).toEqual(["CORGI_SOCKET=/s"]);
});

test("a log too big to read whole is read from its end", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-bugreport-")),
    log = join(dir, "server.log");
  try {
    writeFileSync(log, "x".repeat(100_000) + "\nerror: last\n");
    expect(bugReport.tail(log, 20)).toBe("xxxxxxx\nerror: last\n");
    expect(bugReport.warnings(bugReport.tail(log))).toEqual(["error: last"]);
    expect(bugReport.tail(join(dir, "missing"))).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recent warnings keep the last few distinct ones, repeats counted", () => {
  const log = [
    "info(x): ok",
    "warn(ports): a",
    "error: b",
    "warn(ports): a",
    'info(activity_summary): {"failed":0}',
    "error(git): c",
  ].join("\n");
  expect(bugReport.warnings(log)).toEqual(["error: b", "warn(ports): a (×2)", "error(git): c"]);
  expect(bugReport.warnings(log, 1)).toEqual(["error(git): c"]);
});

test("os-release names the distribution, with its build when the name lacks it", () => {
  expect(
    bugReport.osRelease('NAME="Ubuntu"\nVERSION="24.04.1 LTS (Noble Numbat)"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'),
  ).toBe("Ubuntu 24.04.1 LTS");
  expect(bugReport.osRelease("NAME='Arch Linux'\nPRETTY_NAME=\"Arch Linux\"\nBUILD_ID=rolling\n")).toBe(
    "Arch Linux (rolling)",
  );
  expect(bugReport.osRelease("NAME=Fedora\nVERSION=40\n")).toBe("Fedora 40");
  expect(bugReport.osRelease("")).toBeNull();
});

test("a version line drops escapes and controls, and a runaway one is cut short", () => {
  expect(bugReport.firstLine("\n  2.1.0 (Claude Code)\r\nmore\n")).toBe("2.1.0 (Claude Code)");
  expect(bugReport.firstLine("\x1b[2J\x1b[H\x1b]0;title\x07\x1b[1mv1\x1b[0m\x07")).toBe("v1");
  expect(bugReport.firstLine("x".repeat(500))).toHaveLength(120);
  expect(bugReport.firstLine("")).toBe("");
});

test("paths under the home folder start with ~, and spans read in their largest units", () => {
  expect(bugReport.tilde("/home/me/bin/claude", "/home/me")).toBe("~/bin/claude");
  expect(bugReport.tilde("/home/meow/bin", "/home/me")).toBe("/home/meow/bin");
  expect(bugReport.tilde("/usr/bin/fish", "")).toBe("/usr/bin/fish");
  expect([40e3, 5 * 60e3, 3 * 3600e3 + 12 * 60e3, 50 * 3600e3].map(bugReport.span)).toEqual([
    "40s",
    "5m",
    "3h 12m",
    "2d 2h",
  ]);
});

test("the settings say how they were chosen", () => {
  expect(bugReport.theme("animal_style", "corgi")).toBe("Animal Style");
  expect(bugReport.theme(undefined, "animal_style")).toBe("Animal Style (automatic)");
  expect(bugReport.theme(undefined, null)).toBe("automatic");
  expect(bugReport.automatic(ordinary)).toBe("corgi");
  expect(bugReport.automatic(palette("#000000", "#ffffff", ordinary.ansi.map(bugReport.hex)))).toBe("animal_style");
  expect(bugReport.cleverCorgi(status({ choice: "auto", provider: "claude", model: "claude-haiku" }))).toBe(
    "Claude · claude-haiku (auto)",
  );
  expect(bugReport.cleverCorgi(status({ choice: "codex", provider: "codex", model: "gpt" }))).toBe(
    "Codex · gpt (chosen)",
  );
  expect(bugReport.cleverCorgi(status({ choice: "auto", loading: true }))).toBe("finding a model (auto)");
  expect(bugReport.cleverCorgi(status({ uses: { activity: false, worktrees: false } }))).toBe("Off");
});

test("the printed report sits between rules that say to attach it", () => {
  const box = bugReport.boxed("- Corgi: 1.2.3\n").split("\n");
  expect(box[0]).toBe("-------------------- please attach to bug report --------------------");
  expect(box[1]).toBe("- Corgi: 1.2.3");
  expect(box[2]).toBe("-".repeat(box[0].length));
  expect(box[3]).toBe("");
});

test("the line naming the full report is bold in a terminal, plain when piped", () => {
  expect(
    withHome("/home/me", () => bugReport.attachLine("/home/me/.local/state/corgi/full_bug_report.txt", true)),
  ).toBe("\x1b[1mWrote ~/.local/state/corgi/full_bug_report.txt; please attach it to the issue.\x1b[22m\n");
  expect(bugReport.attachLine("/s/full_bug_report.txt", false)).toBe(
    "Wrote /s/full_bug_report.txt; please attach it to the issue.\n",
  );
});

test("the CLI links the prefilled issue where the terminal takes links, else names the new-issue page", () => {
  const url = "https://github.com/tals/corgi/issues/new?body=x";
  expect(bugReport.footer(url, true)).toBe(
    `Open an issue with this filled in: \x1b]8;;${url}\x1b\\\x1b[4mgithub.com/tals/corgi/issues/new\x1b[24m\x1b]8;;\x1b\\\n`,
  );
  expect(bugReport.footer(url, false)).toBe("Paste this into a new issue: https://github.com/tals/corgi/issues/new\n");
  expect(bugReport.hyperlinks({ TERM_PROGRAM: "ghostty" }, true)).toBe(true);
  expect(bugReport.hyperlinks({ TERM: "xterm-kitty" }, true)).toBe(true);
  expect(bugReport.hyperlinks({ CORGI_PANE: "3" }, true)).toBe(true);
  expect(bugReport.hyperlinks({ VTE_VERSION: "7600" }, true)).toBe(true);
  expect(bugReport.hyperlinks({ TERM_PROGRAM: "ghostty" }, false)).toBe(false);
  expect(bugReport.hyperlinks({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false);
  expect(bugReport.hyperlinks({ TERM_PROGRAM: "tmux", TERM: "tmux-256color" }, true)).toBe(false);
  expect(bugReport.hyperlinks({ FORCE_HYPERLINK: "1" }, false)).toBe(true);
  expect(bugReport.hyperlinks({ FORCE_HYPERLINK: "0", TERM_PROGRAM: "ghostty" }, true)).toBe(false);
});
