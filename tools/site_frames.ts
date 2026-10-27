/**
 * Site frames: renders the landing page's terminal screens with Corgi's own
 * renderer and writes them to site/frames.json, which the page imports.
 *
 *   bun tools/site_frames.ts            render and update the page
 *   bun tools/site_frames.ts --check    compare with the page, change nothing
 *   bun tools/site_frames.ts --show NAME [--all]   print a frame as text
 *   bun tools/site_frames.ts --tally    count every changed cell by what changed
 *   bun tools/site_frames.ts --dump DIR also write each screen as .ansi
 *
 * The page draws these as cell grids: each frame is rows of [text, style]
 * runs, and a style is [fg, bg, bold, underline, underline color] with
 * Corgi's palette tokens by name. The workspaces, agents and numbers below
 * are the page's story; the drawing is Corgi's.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drawRestoring, frame, ui as uiOf, type Restoring, type Ui } from "../src/render";
import { adapter } from "../src/providers";
import { Model, Rect, Selection, View as LayoutView } from "../src/layout";
import * as sidebar from "../src/sidebar";
import * as subagentTooltip from "../src/subagent_tooltip";
import * as worktreeAgents from "../src/worktree_agents";
import type * as worktrees from "../src/worktrees";
import type { FileDiff } from "../src/review/diff";
import * as reviewGit from "../src/review/git";
import * as reviewPanel from "../src/review/panel";
import { Menu as LauncherMenu, option, type Row } from "../src/agent_launcher";
import { historyEntry } from "../src/launcher_resume";
import { Snapshot as PortsSnapshot } from "../src/trackers/ports";
import * as resourceSamples from "../site/resource_samples";
import { View as ContextView } from "../src/usage/context_window";
import { Writer } from "../src/text";
import { codepointWidths } from "../src/viewer_native";
import { microTimestamp, milliTimestamp } from "../src/clock";
import { blankCell, grid, unknown, type Cell } from "../site/terminal";

const root = join(import.meta.dir, "..");
const FRAMES = join(root, "site", "frames.json");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dumpDir = arg("--dump");
const checkOnly = process.argv.includes("--check");
// --show and --tally only look, as --check does.
const writes = !["--check", "--show", "--tally"].some(flag => process.argv.includes(flag));
// One moment for every frame, so a rerun changes only what Corgi draws differently.
const PINNED = new Date(2026, 9, 5, 10, 21, 0).getTime();
Date.now = () => PINNED;

// ---------------------------------------------------------------- the page
const data = JSON.parse(readFileSync(FRAMES, "utf8")) as {
  styles: unknown[][];
  /** Ghostty's codepoint widths, for the page's text.ts. */
  widths: unknown;
  /** What git answered about each of moonlander's checkouts, for the page's review panel. */
  review: unknown;
  /** corgi's and moonlander's worktrees, for the page's worktree overviews. */
  worktrees: unknown;
  frames: Record<string, any>;
};
const styleIndex = new Map(data.styles.map((s, i) => [JSON.stringify(s), i]));
function sid(style: unknown[]): number {
  const key = JSON.stringify(style);
  let i = styleIndex.get(key);
  if (i === undefined) {
    i = data.styles.length;
    styleIndex.set(key, i);
    data.styles.push(style);
  }
  return i;
}
type Runs = [string, number][][];
function encode(rows: Cell[][]): Runs {
  return rows.map(row => {
    const runs: [string, number][] = [];
    for (const [ch, ...style] of row) {
      const s = sid(style);
      const last = runs[runs.length - 1];
      if (last && last[1] === s) last[0] += ch;
      else runs.push([ch, s]);
    }
    return runs;
  });
}
const made = new Map<string, Runs | Runs[]>();
function keep(name: string, cells: Cell[][] | Cell[][][], ansi?: string) {
  const list = Array.isArray(cells[0]?.[0]?.[0]);
  made.set(name, list ? (cells as Cell[][][]).map(encode) : encode(cells as Cell[][]));
  if (dumpDir && ansi !== undefined) writeFileSync(join(dumpDir, `${name}.ansi`), ansi);
}

// ---------------------------------------------------------------- the story
const ms = milliTimestamp(),
  us = microTimestamp(),
  secs = Math.floor(ms / 1000),
  minute = 60_000,
  day = 86_400,
  MiB = 1 << 20;
type Usage = { known: true; tokens?: { input: number; cached_input: number; output: number } };
const tokens = (input: number, cached: number, output: number): Usage => ({
  known: true,
  tokens: { input, cached_input: cached, output },
});
type Provider = "claude" | "codex";
type Demo = {
  id: number;
  name: string;
  provider: Provider;
  state: sidebar.State;
  attention: sidebar.Attention;
  activity: string;
};
const demo = (
  id: number,
  name: string,
  provider: Provider,
  state: sidebar.State,
  attention: sidebar.Attention,
  activity: string,
): Demo => ({ id, name, provider, state, attention, activity });
// corgi's agents, then moonlander's.
const CORGI: Demo[] = [
  demo(1, "Fix sidebar flicker", "claude", "working", "none", "Running sidebar tests"),
  demo(2, "Audit the install script", "codex", "working", "none", "Checking release checksums"),
  demo(3, "Release notes", "claude", "blocked", "needs_input", ""),
  demo(4, "Refactor the viewer", "claude", "working", "none", "Editing src/viewer.zig"),
  demo(5, "Ghostty keybindings", "codex", "idle", "finished", ""),
];
const MOON: Demo[] = [
  demo(11, "Tune the thruster physics", "claude", "working", "none", "Tuning lunar gravity"),
  demo(12, "Draw the lander sprite", "claude", "idle", "none", ""),
];
// The Codex agent running two subagents, the one about to compact, the unread one.
const AUDIT = 1,
  COMPACTOR = 3,
  UNREAD = [4];
type Phase = [minutes_ago: number, activity: string, usage: Usage];
type Story = { phases: Phase[]; pending: Usage; total: Usage; context: number; phone?: string[] };
/** Each agent's phases, what's still pending, its total and its context; on
 * a phone, shorter phase names. */
const STORY: Record<number, Story> = {
  1: {
    phases: [
      [41, "Reading the sidebar renderer", tokens(48_200, 31_000, 1_900)],
      [33, "Tracing the redraw order", tokens(62_400, 51_000, 2_600)],
      [24, "Reproducing the flicker", tokens(39_800, 30_100, 1_200)],
      [15, "Drawing each row in one write", tokens(71_000, 58_300, 6_400)],
      [4, "Running sidebar tests", tokens(22_900, 19_000, 800)],
    ],
    phone: ["Reading the renderer", "Tracing the redraw", "Reproducing it", "Drawing rows once", "Running tests"],
    pending: tokens(9_400, 7_100, 300),
    total: tokens(266_000, 198_500, 13_600),
    context: 118_000,
  },
  2: {
    phases: [
      [18, "Reading install.sh", tokens(21_000, 12_000, 900)],
      [11, "Splitting the audit", tokens(9_400, 7_000, 1_400)],
      [3, "Checking release checksums", tokens(6_100, 4_800, 300)],
    ],
    phone: ["Reading install.sh", "Splitting the audit", "Checking checksums"],
    pending: tokens(2_100, 1_600, 200),
    total: tokens(41_000, 26_000, 2_900),
    context: 52_000,
  },
  3: {
    phases: [
      [26, "Reading the log since 0.8", tokens(33_000, 20_000, 1_100)],
      [19, "Drafting release notes", tokens(18_400, 15_200, 3_900)],
      [9, "Asking to tag the release", tokens(4_200, 3_900, 200)],
    ],
    phone: ["Reading the log", "Drafting the notes", "Asking to tag"],
    pending: tokens(1_200, 1_000, 100),
    total: tokens(55_600, 39_100, 5_200),
    context: 61_000,
  },
  4: {
    phases: [
      [52, "Mapping the viewer state", tokens(88_000, 61_000, 2_200)],
      [37, "Moving input into its own file", tokens(102_000, 84_000, 9_700)],
      [21, "Editing src/viewer.zig", tokens(64_000, 55_000, 7_100)],
      [1, "Compacting context", { known: true }],
    ],
    phone: ["Mapping viewer state", "Moving input out", "Editing viewer.zig", "Compacting context"],
    pending: tokens(3_200, 2_000, 100),
    total: tokens(254_000, 200_000, 19_000),
    context: 171_000,
  },
  5: {
    phases: [
      [70, "Reading the Ghostty config", tokens(14_000, 9_000, 600)],
      [61, "Writing the managed block", tokens(19_500, 15_000, 2_400)],
      [55, "Binding Cmd+1–9 to tabs", tokens(8_800, 7_700, 900)],
    ],
    phone: ["Reading the config", "Writing the block", "Binding Cmd+1–9"],
    pending: tokens(3_000, 2_500, 300),
    total: tokens(42_300, 31_700, 3_900),
    context: 30_000,
  },
  11: {
    phases: [
      [22, "Reading the lander physics", tokens(24_000, 15_000, 1_100)],
      [12, "Plotting the burn curve", tokens(17_500, 13_000, 2_900)],
      [2, "Tuning lunar gravity", tokens(5_800, 4_400, 400)],
    ],
    phone: ["Reading the physics", "Plotting the burn", "Tuning lunar gravity"],
    pending: tokens(1_900, 1_400, 150),
    total: tokens(47_300, 32_400, 4_400),
    context: 64_000,
  },
  12: {
    phases: [
      [95, "Sketching the lander", tokens(9_000, 5_500, 1_800)],
      [84, "Shading the sprite", tokens(6_200, 4_900, 1_100)],
    ],
    pending: tokens(700, 500, 60),
    total: tokens(15_900, 10_900, 2_960),
    context: 21_000,
  },
};
/** Phones draw shorter names and activities. */
const PHONE_NAMES: Record<number, [string, string]> = {
  1: ["Fix sidebar flicker", "Running tests"],
  2: ["Audit install.sh", "Checking sums"],
  3: ["Release notes", ""],
  4: ["Refactor viewer", "Editing viewer.zig"],
  5: ["Ghostty keys", ""],
  11: ["Tune the thrusters", "Tuning lunar gravity"],
  12: ["Draw the lander", ""],
};
const COMMITS: sidebar.GitCommit[] = [
  {
    timestamp: secs - 25 * 60,
    hash: "8ae5085",
    subject: "sidebar: mark the selected agent with the workspace's green bar",
    author: "Tal Shiri",
    date: "2026-10-05 12:41",
    diff: { files: 0, insertions: 0, deletions: 0 },
  },
  {
    timestamp: secs - 3 * 3600,
    hash: "d901fd0",
    subject: "launcher: date Claude conversations by their last prompt or reply",
    author: "Tal Shiri",
    date: "2026-10-05 10:06",
    diff: { files: 0, insertions: 0, deletions: 0 },
  },
];
/** moonlander's `bun --hot` dev server, named after its page. */
const PORTS = Object.assign(new PortsSnapshot(), {
  workspaces: [
    {
      id: 2,
      background: 0,
      endpoints: [
        {
          label: "Game",
          label_pending: false,
          pid: 52803,
          pane: 11,
          name: "bun",
          transport: "tcp" as const,
          bind_address: "127.0.0.1",
          port: 3000,
          ipv6: false,
          interfaces: [],
          scheme: "http" as const,
          http_status: 200,
          probed_at: 0,
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------- processes
/** The sidebar's resource rows, from the first second of the samples the
 * page loops; it patches the figures as the loop runs. */
const sidebarResources = (host: resourceSamples.Host) =>
  resourceSamples.snapshot(host, 0).workspaces.map(w => sidebar.work({ ...w, processes: [], history: [] }));
const FIRST = sidebarResources("laptop");

// ---------------------------------------------------------------- state
function layoutView(): LayoutView {
  const model = new Model(),
    selection = new Selection();
  const only = model.newTab("");
  selection.reconcile(model);
  selection.tabs[0].focus = only;
  return new LayoutView(model, selection);
}
const view = layoutView();
type Shown = {
  demo: Demo;
  name: string;
  activity: string;
  focused: boolean;
  attention: sidebar.Attention;
  compacting: boolean;
};
function entryOf(s: Shown): sidebar.Entry {
  const e = sidebar.entry({
    target: { pane: s.demo.id },
    conversation: s.demo.id,
    name: s.name,
    provider: s.demo.provider,
    state: s.demo.state,
    attention: s.attention,
    activity: s.activity,
    focused: s.focused,
    compacting: s.compacting,
  });
  if (s.demo.id === CORGI[AUDIT].id) {
    e.subagents = { running: 2, blocked: 0, waiting: false };
    e.children = 2;
  }
  if (s.demo.id === CORGI[COMPACTOR].id) e.context = new ContextView({ used: 171_000n, window: 200_000n, at: 1 });
  return e;
}
function agentOf(e: sidebar.Entry) {
  return {
    provider: e.provider,
    state: e.state,
    attention: e.attention,
    name: e.name,
    session: "s",
    activity: e.activity,
    cwd: "/Users/me/dev/corgi",
    tool_active: false,
    compacting: e.compacting,
    subagents: e.subagents,
  };
}
type Watch = {
  phone: boolean;
  corgi: boolean;
  unread: number;
  ahead: boolean;
  focused: boolean;
  read: boolean;
  /** Before "Refactor the viewer" compacts. */
  early?: boolean;
};
function scene(w: Watch) {
  const demos = w.corgi ? CORGI : MOON;
  const shown: Shown[] = demos.map((d, n) => ({
    demo: d,
    name: w.phone ? PHONE_NAMES[d.id][0] : d.name,
    activity: w.phone ? PHONE_NAMES[d.id][1] : d.activity,
    focused: w.focused,
    attention: w.corgi && w.read && UNREAD.includes(n) ? "none" : d.attention,
    compacting: w.corgi && n === COMPACTOR && !w.early,
  }));
  const entries = shown.map(entryOf);
  const conversations = entries.map((e, n) => {
    const story = STORY[e.conversation];
    let phases = story.phases.map(([ago, activity, usage], j) => ({
      at: ms - ago * minute,
      activity: w.phone && story.phone ? story.phone[j] : activity,
      usage,
    }));
    if (w.early && e.conversation === CORGI[COMPACTOR].id) phases = phases.slice(0, 3);
    return subagentTooltip.conversation({
      id: e.conversation,
      agent: agentOf(e),
      model_name: e.provider === "codex" ? "GPT-6 Astra" : "Opus 5.5",
      children_observed_at: w.corgi && n === AUDIT ? us : 0,
      timeline: { points: phases, pending: story.pending },
      usage: story.total,
      context: { used: story.context, window: e.provider === "codex" ? 272_000 : 200_000, at: 1 },
    });
  });
  const child = { ...agentOf(entries[0]), ...agentOf(sidebar.entry({ target: { pane: 0 } })) };
  if (w.corgi) {
    const audit = agentOf(entryOf({ ...shown[AUDIT], demo: CORGI[AUDIT] }));
    const base = { ...audit, subagents: { running: 0, blocked: 0, waiting: false }, name: "" };
    conversations.push(
      subagentTooltip.conversation({
        id: 8,
        parent: CORGI[AUDIT].id,
        role: "Explorer",
        agent: { ...base, activity: "Reading install.sh", session: "7c1e09ab-52d3-4f60-a1c8-3e9b0d7f2a14" },
        observed_at: us,
        usage: tokens(12_400, 8_000, 600),
      }),
      subagentTooltip.conversation({
        id: 9,
        parent: CORGI[AUDIT].id,
        role: "Verifier",
        agent: { ...base, activity: "Fetching SHA256SUMS", session: "b2f4d871-0e6a-4c39-9f15-a8c2e5d3b7f0" },
        observed_at: us,
        usage: tokens(7_900, 5_100, 400),
      }),
    );
  }
  void child;
  const workspaces = [
    sidebar.workspaceEntry({
      id: 1,
      name: "corgi",
      cwd: "/Users/me/dev/corgi",
      active: w.corgi,
      git_ahead: w.ahead ? 2 : null,
      git_commits: COMMITS,
      working: 3,
      attention: 1,
      unread: w.unread,
      agents: 5,
      stats: { tools: 214, input: 0, output: 0, tokens_known: true },
      resources: FIRST[0],
    }),
    sidebar.workspaceEntry({
      id: 2,
      name: "moonlander",
      cwd: "/Users/me/dev/moonlander",
      active: !w.corgi,
      working: 1,
      agents: 2,
      stats: { tools: 38, input: 0, output: 0, tokens_known: true },
      resources: FIRST[1],
      ports: PORTS,
    }),
  ];
  return { entries, conversations, workspaces };
}
function uiFor(s: ReturnType<typeof scene>, width: number, fields: Partial<Ui> = {}): Ui {
  const u = uiOf({
    message: "",
    copy_mode: false,
    corgi_badge: "image",
    supports_kitty_graphics: true,
    scope_label: "corgi",
    agents: s.entries,
    workspaces: s.workspaces,
    conversations: s.conversations,
    ...fields,
  });
  u.prefs.sidebar_width = width;
  return u;
}
/** The row an agent's card opens from, as the sidebar hit-tests it. */
function entryRow(s: ReturnType<typeof scene>, win: number, rows: number, width: number, i: number): number {
  const side = sidebar.View.init(win, rows, true, 0, s.entries.length)
    .withWidth(width)
    .withWorkspaces(s.workspaces.length, 0)
    .withEntries(s.entries);
  for (let y = 0; y < rows; y++) {
    const hit = side.hit(6, y);
    if (hit.tag === "entry" && hit.entry === i) return y;
  }
  return rows;
}
const alone = "\x1b[0m\x1b[H\x1b[2J";

// ---------------------------------------------------------------- keeps watch
// The window, its agent list's first row, and the sidebar's widths. Phones
// draw a 64-column window, corgi's narrowest with a sidebar; the page crops
// it to 54, and cards and the commit tooltip stand alone at 54.
const COLS = 124,
  ROWS = 24,
  AGENT_TOP = 13,
  CARD_LEFT = 30,
  WIDTHS = [26, 30, 34, 38, 42],
  PHONE = { win: 64, cards: 54, width: 26 };
function watchFrames() {
  for (const phone of [false, true])
    for (const corgi of [true, false])
      for (const unread of [0, 1])
        for (const ahead of [true, false])
          for (const focused of [false, true])
            for (const read of [false, true]) {
              if ((focused || read) && !(unread === 1 && ahead)) continue;
              if (!corgi && read) continue;
              const w: Watch = { phone, corgi, unread, ahead, focused, read };
              const win = phone ? PHONE.win : COLS,
                pre = phone ? "p" : "",
                tag = corgi ? "C" : "M",
                cardWidth = phone ? PHONE.width : 34;
              const s = scene(w);
              for (const width of phone ? [PHONE.width] : WIDTHS) {
                const plain = frame(view, [], win, ROWS, uiFor(s, width));
                const g = grid(plain, win, ROWS);
                // The top (workspaces) and the agent list, each cropped to the sidebar.
                if (!focused && !read)
                  keep(
                    `${pre}w${width}_${tag}${unread}${Number(ahead)}`,
                    g.slice(0, AGENT_TOP).map(r => r.slice(0, width)),
                    plain,
                  );
                if (unread === 1 && ahead)
                  keep(
                    `${pre}w${width}_e${tag}${Number(focused)}${Number(read)}`,
                    g.slice(AGENT_TOP).map(r => r.slice(0, width)),
                    plain,
                  );
                // "Refactor the viewer" before it starts compacting: its rows, and its card.
                if (corgi && unread === 1 && ahead && !read) {
                  const e = scene({ ...w, early: true });
                  const working = frame(view, [], win, ROWS, uiFor(e, width));
                  keep(
                    `${pre}w${width}_eC${Number(focused)}0p`,
                    grid(working, win, ROWS)
                      .slice(AGENT_TOP)
                      .map(r => r.slice(0, width)),
                    working,
                  );
                  if (width === cardWidth && !focused) {
                    const out = new Writer();
                    out.write(phone ? alone : working);
                    subagentTooltip.draw(
                      out,
                      e.conversations,
                      e.entries[COMPACTOR],
                      phone ? PHONE.cards : COLS,
                      ROWS,
                      width - 4,
                      entryRow(e, win, ROWS, width, COMPACTOR),
                    );
                    keep(`${pre}card_C3_0p`, cardCells(out.buffered(), phone), out.buffered());
                  }
                }
                // The shared URL chip, with the pointer on moonlander's link.
                if (!phone && corgi && width === WIDTHS[0] && unread === 1 && ahead && !focused && !read) {
                  const side = sidebar.View.init(win, ROWS, true, 0, s.entries.length)
                    .withWidth(width)
                    .withWorkspaces(s.workspaces.length, 0)
                    .withEntries(s.entries);
                  let x = 0;
                  while (x < width && sidebar.portLink(side, s.workspaces, x, 5) === null) x += 1;
                  const linked = frame(view, [], win, ROWS, uiFor(s, width, { pointer: { x: x + 1, y: 5 } }));
                  keep(`${pre}wl${width}_${tag}`, [grid(linked, win, ROWS)[ROWS - 1]], linked);
                }
                // Cards and the commit tooltip once, at the default width.
                if (width !== cardWidth || focused || !(unread === 1 && ahead)) continue;
                s.entries.forEach((e, i) => {
                  if (read && !UNREAD.includes(i)) return;
                  const out = new Writer();
                  out.write(phone ? alone : plain);
                  subagentTooltip.draw(
                    out,
                    s.conversations,
                    e,
                    phone ? PHONE.cards : COLS,
                    ROWS,
                    width - 4,
                    entryRow(s, win, ROWS, width, i),
                  );
                  keep(`${pre}card_${tag}${i}_${Number(read)}`, cardCells(out.buffered(), phone), out.buffered());
                });
                if (corgi && !read) {
                  const out = new Writer();
                  out.write(phone ? alone : plain);
                  sidebar.drawGitTooltip(out, s.workspaces[0], phone ? PHONE.cards : COLS, ROWS, width - 3, 2);
                  keep(`${pre}git`, cardCells(out.buffered(), phone), out.buffered());
                }
              }
            }
}
/** A card over the window from CARD_LEFT on, or alone at the phone's 54 columns. */
function cardCells(ansi: string, phone: boolean): Cell[][] {
  const g = grid(ansi, phone ? PHONE.cards : COLS, ROWS);
  return phone ? g : g.map(r => r.slice(CARD_LEFT));
}
// ---------------------------------------------------------------- the picker
const PICK = { cols: 150, rows: 21 };
const HISTORY = [
  ["claude", "s1", "Fix sidebar flicker", "the sidebar flickers when an agent finishes", "commit it", 720],
  ["claude", "s2", "Name dev server links", "links just say Open Link", "use the page title when there is one", 3000],
  [
    "claude",
    "s3",
    "Slow down the herd animation",
    "the compacting herd feels rushed",
    "slower, the letters blur",
    2 * 3600,
  ],
  ["codex", "s5", "Static Linux build", "build a static linux binary", "strip it before upload", 5 * 3600],
  ["claude", "s6", "Ghostty keybindings", "bind cmd+1-9 to tabs", "does Cmd+W close the whole tab?", day],
  [
    "claude",
    "s7",
    "Faster session restore",
    "restore takes two seconds",
    "measure it again after the cache",
    day + 3600,
  ],
  ["claude", "s8", "Usage bars in the picker", "show usage next to each agent", "show when it resets", day + 2 * 3600],
  [
    "claude",
    "s9",
    "Date resume rows by reply",
    "resume dates look wrong",
    "date by the last reply instead",
    day + 3 * 3600,
  ],
  ["codex", "s10", "Onboarding copy", "rewrite the onboarding text", "fewer words", day + 4 * 3600],
].map(([provider, session, title, first, last, ago]) =>
  historyEntry({
    provider,
    session,
    title,
    first,
    last,
    cwd: "/Users/me/dev/corgi",
    branch: "main",
    updated_at: secs - (ago as number),
  }),
);
// The page has no YOLO toggle, so the picker lays out without its column.
class SiteLauncher extends LauncherMenu {
  columns(width: number): number[] {
    const widths = super.columns(width);
    widths[1] = 0;
    return widths;
  }
}
function launcher(selected: Row): LauncherMenu {
  const menu = new SiteLauncher({
    workspace: 1,
    selected,
    last: "claude",
    pinned: true,
    cwd: "/Users/me/dev/corgi",
    workspace_cwd: "/Users/me/dev/corgi",
  });
  menu.history = { pending: false, entries: HISTORY };
  menu.preview.pending = false;
  menu.preview.installed = { codex: true, claude: true, pi: true, opencode: false, omp: false };
  menu.preview.options.claude = option({
    model: "claude-opus-5-5",
    model_name: "Opus 5.5",
    account: "you@example.com",
    plan: "Max",
    usage_fetched_at: secs,
    limits: {
      windows: [
        { minutes: 300, used: 23, reset_at: secs + 2 * 3600 + 10 * 60 },
        { minutes: 10080, used: 41, reset_at: secs + 3 * day + 4 * 3600 },
      ],
    },
  });
  menu.preview.options.codex = option({
    model: "gpt-6-astra",
    model_name: "GPT-6 Astra",
    account: "you@example.com",
    plan: "Pro",
    usage_fetched_at: secs,
    limits: { windows: [null, { minutes: 10080, used: 18, reset_at: secs + 5 * day }] },
  });
  // Pi, signed in to the company's ChatGPT Enterprise seat, which Corgi
  // reads its limits from.
  menu.preview.names.pi = "slopcorp";
  menu.preview.options.pi = option({
    model: "gpt-6-astra",
    model_name: "GPT-6 Astra",
    account: "you@slopcorp.ai",
    plan: "Enterprise",
    usage_fetched_at: secs,
    limits: {
      windows: [
        { minutes: 300, used: 12, reset_at: secs + 3 * 3600 + 40 * 60 },
        { minutes: 10080, used: 33, reset_at: secs + 2 * day + 6 * 3600 },
      ],
    },
  });
  return menu;
}
function pickerFrames() {
  const ws = [
    sidebar.workspaceEntry({
      id: 1,
      name: "corgi",
      cwd: "/Users/me/dev/corgi",
      active: true,
      agents: 3,
      working: 1,
      attention: 1,
    }),
  ];
  const entries = [
    sidebar.entry({
      target: { pane: 1 },
      conversation: 1,
      name: "Fix sidebar flicker",
      provider: "claude",
      state: "working",
      activity: "Running sidebar tests",
    }),
    sidebar.entry({
      target: { pane: 2 },
      name: "Release notes",
      provider: "codex",
      state: "blocked",
      attention: "needs_input",
    }),
    sidebar.entry({ target: { pane: 3 }, name: "Docs pass", provider: "claude", state: "idle" }),
  ];
  const draw = (menu: LauncherMenu, name: string) => {
    const u = uiOf({
      message: "",
      copy_mode: false,
      corgi_badge: "image",
      supports_kitty_graphics: true,
      scope_label: "corgi",
      agents: entries,
      workspaces: ws,
      agent_launcher: menu,
    });
    u.prefs.sidebar_width = 30;
    u.prefs.resources.enabled = false;
    const out = frame(view, [], PICK.cols, PICK.rows, u);
    keep(name, grid(out, PICK.cols, PICK.rows), out);
  };
  (["codex", "claude", "pi", "terminal"] as Row[]).forEach((row, i) => draw(launcher(row), `launcher${i}`));
  for (const [i, query] of [
    [0, ""],
    [1, "fl"],
    [3, ""],
  ] as const) {
    const menu = launcher("claude");
    if (i === 3) menu.resume_view.focused = true;
    else menu.resume_view.startSearch();
    for (const ch of query) menu.resume_view.query.key(ch.charCodeAt(0));
    draw(menu, `search${i}`);
  }
  // The restoring card each conversation opens behind, centered on the
  // picker's pane, wide and on a phone, as its dig ends. The dig is the one row
  // that moves; the page plays it over the card from a flipbook per card width.
  const models: Record<string, string> = { claude: "Opus 5.5", codex: "GPT-6 Astra" };
  for (const [pre, w, h] of [
    ["", 112, 18],
    ["p", 48, 19],
  ] as const) {
    const card = (n: number, t: number) => {
      const e = HISTORY[n],
        id = (((n + 1) * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0") + "-4e1b-4c8e-9d2a-51b0e6f3a7c" + n;
      return restoringCard(
        {
          command: e.provider === "claude" ? `claude --resume ${id}` : `codex resume ${id}`,
          name: e.title,
          meta: `${e.provider} · ${models[e.provider]} · ~/dev/corgi`,
          dig: "restoring",
        },
        w,
        h,
        t,
      );
    };
    const digs = new Set<number>();
    HISTORY.forEach((_, n) => {
      const last = card(n, 3600),
        width = last[0].filter(([ch]) => ch !== " ").length;
      keep(`${pre}rest${n}`, last);
      if (digs.has(width)) return;
      digs.add(width);
      keep(
        `${pre}dig${width}`,
        digRows(t => card(n, t)),
      );
    });
  }
}
/** corgi's restoring card centered on a `w` by `h` pane, `t` ms into its
 * dig: the pane's rows from the card's top border to its bottom. */
function restoringCard(band: Restoring, w: number, h: number, t: number): Cell[][] {
  const out = new Writer();
  out.write("\x1b[0m\x1b[H\x1b[J");
  drawRestoring(out, new Rect(0, 0, w, h), band, t);
  const rows = grid(out.buffered(), w, h);
  return rows.slice(
    rows.findIndex(row => row.some(([ch]) => ch === "╭")),
    rows.findIndex(row => row.some(([ch]) => ch === "╰")) + 1,
  );
}
/** The card's one row that moves, every 80 ms of its dig. */
function digRows(card: (t: number) => Cell[][]): Cell[][][] {
  const first = card(0),
    row = card(3600).findIndex((cells, r) => cells.some(([ch], c) => ch !== first[r][c][0]));
  const frames: Cell[][][] = [];
  for (let t = 0; t <= 3600; t += 80) frames.push([card(t)[row]]);
  return frames;
}

// ---------------------------------------------------------------- tab tricks
// Ghostty keybindings' restoring card as Ctrl-Shift-T reopens its tab, on
// the pane the page gives it under the tab bar: 90 columns beside the
// sidebar, or a phone's 56 alone.
function reopenFrames() {
  const band: Restoring = {
    command: "codex resume 0199f3c2-7b4e-7d10-9c3a-5e2b8f61d4a7",
    name: CORGI[4].name,
    meta: `${adapter("codex").name} · GPT-6 Astra · ~/dev/corgi`,
    dig: "restoring",
  };
  for (const [pre, w] of [
    ["", 90],
    ["p", 56],
  ] as const) {
    const card = (t: number) => restoringCard(band, w, ROWS - 1, t);
    keep(`${pre}reopen`, card(3600));
    keep(`${pre}reopen_dig`, digRows(card));
  }
}

// ---------------------------------------------------------------- top for your tokens
/** The corgi badge hovered: every agent ranked by spend as usage ticks up. */
function overviewFrames() {
  const rows = 22,
    steps = 8;
  type Step = [input: number, cached: number, output: number];
  // What each step adds: the working agents move; the compacting one waits.
  // Tune the thruster physics passes Release notes at step 3.
  const fix: Step[] = [
    [0, 0, 0],
    [2_400, 1_900, 300],
    [1_800, 1_500, 200],
    [900, 700, 400],
    [2_000, 1_600, 350],
    [1_100, 900, 150],
    [1_600, 1_200, 300],
    [900, 700, 200],
  ];
  const tune: Step[] = [
    [0, 0, 0],
    [1_400, 900, 300],
    [1_200, 800, 300],
    [1_900, 1_300, 400],
    [0, 0, 0],
    [1_000, 700, 200],
    [800, 600, 150],
    [1_100, 800, 250],
  ];
  const system: Step[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [3_200, 2_000, 150],
    [0, 0, 0],
    [0, 0, 0],
    [2_900, 1_800, 140],
    [0, 0, 0],
  ];
  // Corgi's summarizer is mid-summary on the step before its usage lands.
  const summarizing = [false, false, true, false, false, true, false, false];
  const upTo = (base: Usage, add: Step[], step: number): Usage => {
    const t = { ...base.tokens! };
    for (const [i, c, o] of add.slice(0, step + 1)) {
      t.input += i;
      t.cached_input += c;
      t.output += o;
    }
    return { known: true, tokens: t };
  };
  const s = scene({ phone: false, corgi: true, unread: 1, ahead: false, focused: false, read: false });
  // One account: the Claude agents of both workspaces.
  const listed = [CORGI[0], CORGI[2], CORGI[3], MOON[0], MOON[1]];
  const accounts = new subagentTooltip.Accounts({ system: "claude", now: secs });
  accounts.options.claude = option({
    account: "you@example.com",
    plan: "Max",
    usage_fetched_at: secs,
    limits: {
      windows: [
        { minutes: 300, used: 23, reset_at: secs + 2 * 3600 + 10 * 60 },
        { minutes: 10080, used: 41, reset_at: secs + 3 * day + 4 * 3600 },
      ],
    },
    history: [
      [3, 6, 8, 11, 14, 17, 20, null, null, null, null, null, null, null],
      [5, 9, 14, 19, 24, 29, 35, null, null, null, null, null, null, null],
    ],
  });
  const frames: Cell[][][] = [];
  for (let step = 0; step < steps; step++) {
    const all = listed.map((d, n) => {
      let used = STORY[d.id].total;
      if (n === 0) used = upTo(used, fix, step);
      if (n === 3) used = upTo(used, tune, step);
      const e = entryOf({
        demo: d,
        name: d.name,
        activity: d.activity,
        focused: false,
        attention: d.attention,
        compacting: d.id === CORGI[COMPACTOR].id,
      });
      return subagentTooltip.conversation({
        id: d.id,
        agent: agentOf(e),
        attachments: 1,
        model: "claude-opus-5-5",
        model_name: "Opus 5.5",
        usage: used,
      });
    });
    const u = uiFor({ ...s, conversations: all }, 34, {
      link_tooltip: true,
      pointer: { x: 2, y: 0 },
      system_model: "claude-haiku-4-5-20251001",
      system_model_name: "Haiku 4.5",
      system_working: summarizing[step],
      system_usage: subagentTooltip.usageView(upTo(tokens(84_000, 52_000, 3_100), system, step)),
      release: { running: "20261002T183012Z-5c1d9e2f7a40" },
      accounts,
    });
    for (const ws of u.workspaces) ws.git_ahead = null;
    const g = grid(frame(view, [], COLS, rows, u), COLS, rows);
    // The window's top two rows, with the badge, and the card below them.
    const bottom = g.findLastIndex(row => row.some(([ch]) => ch === "╯"));
    const card = g.slice(0, bottom + 1);
    // Above the card, only the sidebar's header with the badge; beside it, only the screen's ground.
    const edge = card[0].findIndex(([ch]) => ch === "│");
    const buttons = card[0]
      .map(([ch]) => ch)
      .join("")
      .indexOf("[ + ]");
    if (buttons > 0) for (let c = buttons; c < edge; c++) card[0][c] = [" ", ...card[0][buttons - 1].slice(1)] as Cell;
    for (let r = 0; r < 2; r++) for (let c = edge; c < COLS; c++) card[r][c] = blankCell();
    for (const row of card.slice(2)) for (const c of [0, COLS - 1]) row[c] = blankCell();
    frames.push(card);
  }
  keep("ov_card", frames);
}

// ---------------------------------------------------------------- worktrees
/** A checkout at `path`, as the daemon reports it. */
function checkout(path: string, branch: string, fields: Partial<worktrees.Checkout>): worktrees.Checkout {
  return {
    path,
    head: "",
    branch: `refs/heads/${branch}`,
    primary: false,
    bare: false,
    detached: false,
    locked: null,
    prunable: null,
    available: true,
    comparison: { ahead: 0n, behind: 0n },
    changes: null,
    created: null,
    edited: null,
    stale: false,
    ...fields,
  };
}
const edits = (total: number, added: number, removed: number): worktrees.Changes => ({
  total,
  staged: 0,
  modified: total,
  untracked: 0,
  conflicted: 0,
  added,
  removed,
});
/** What the page draws each workspace's overview from with Corgi's own
 * code: the worktrees as the daemon sends them, bigints as numbers and times
 * as of `at`, their briefs and agents, the badge it opens from after each
 * set of removals, and what each heading's menu says Review changes shows,
 * once the review's checkouts are made. */
const overviews: Record<string, unknown> = {};
function keepOverview(
  name: string,
  cwd: string,
  snapshot: worktrees.Snapshot,
  briefs: Map<string, worktrees.Brief>,
  agents: Map<string, sidebar.Tally>,
  badges: (Rect | null)[],
  key = name,
) {
  overviews[key] = JSON.parse(
    JSON.stringify(
      { at: ms, name, cwd, snapshot, briefs: [...briefs.values()], agents: [...agents], badges, reviews: [] },
      (_, value) => (typeof value === "bigint" ? Number(value) : value),
    ),
  );
}
// moonlander's two agents, each in a worktree of its own, for Clever Corgi.
const MOON_ROOT = "/Users/me/dev/moonlander";
const moonPath = (name: string) => `${MOON_ROOT}/.claude/worktrees/${name}`;
const MOON_TREES: worktrees.Snapshot = {
  common_dir: `${MOON_ROOT}/.git`,
  base: { ref: "refs/heads/main", name: "main", head: "3f1c2d4" },
  entries: [
    checkout(MOON_ROOT, "main", { primary: true }),
    checkout(moonPath("thrusters"), "feat/thrusters", {
      comparison: { ahead: 4n, behind: 0n },
      changes: edits(2, 96, 21),
      created: ms - 2 * 60 * minute,
      edited: ms - 2 * minute,
    }),
    checkout(moonPath("sprite"), "art/lander-sprite", {
      comparison: { ahead: 2n, behind: 1n },
      changes: edits(0, 0, 0),
      created: ms - 5 * 60 * minute,
      edited: ms - 40 * minute,
    }),
  ],
  agents: [
    { target: { pane: MOON[0].id }, path: moonPath("thrusters"), source: "write", stale: false },
    { target: { pane: MOON[1].id }, path: moonPath("sprite"), source: "write", stale: false },
  ],
  stale: false,
};
/** What Clever Corgi wrote about moonlander's. */
const MOON_BRIEFS = new Map<string, worktrees.Brief>(
  [
    ["thrusters", "Adds thrust and lunar gravity"],
    ["sprite", "Draws the lander as pixel art"],
  ].map(([name, label]) => [moonPath(name), { path: moonPath(name), label, phase: "ready" }]),
);
/** The sidebar with moonlander alone, its agents under their worktrees, and
 * again after each set of removals the overview can make (bit k for the
 * k-th linked worktree), their agents closed with them. While the overview
 * browses the j-th, only its agents are lit, as Corgi lights them. */
const WT_ROWS = ROWS;
function worktreeFrames() {
  const linked = MOON_TREES.entries.filter(e => !e.primary),
    badges: (Rect | null)[] = [];
  let agents = new Map<string, sidebar.Tally>();
  for (let mask = 0; mask < 1 << linked.length; mask++) {
    const gone = new Set(linked.filter((_, k) => mask & (1 << k)).map(e => e.path)),
      closed = new Set(MOON_TREES.agents.flatMap(a => (gone.has(a.path) && "pane" in a.target ? [a.target.pane] : []))),
      trees = {
        ...MOON_TREES,
        entries: MOON_TREES.entries.filter(e => !gone.has(e.path)),
        agents: MOON_TREES.agents.filter(a => !gone.has(a.path)),
      };
    const s = scene({ phone: false, corgi: false, unread: 0, ahead: false, focused: false, read: false });
    s.workspaces = s.workspaces.filter(w => w.id === 2);
    s.entries[0].focused = true;
    const shut = s.entries.filter(e => "pane" in e.target && closed.has(e.target.pane));
    const ws = s.workspaces[0];
    ws.working -= shut.filter(e => e.state === "working").length;
    ws.agents -= shut.length;
    ws.worktrees = trees;
    s.entries = worktreeAgents.grouped(
      trees,
      2,
      s.entries.filter(e => !shut.includes(e)),
      new worktreeAgents.State(),
    );
    const draw = (name: string, spot: sidebar.Spotlight | null) => {
      const out = frame(view, [], COLS, WT_ROWS, uiFor(s, 34, { worktree_spotlight: spot }));
      keep(
        name,
        grid(out, COLS, WT_ROWS).map(r => r.slice(0, 34)),
        out,
      );
    };
    draw(`wt34_${mask}`, null);
    linked.forEach((e, k) => !gone.has(e.path) && draw(`wt34_${mask}_${k}`, { workspace: 2, path: e.path }));
    const side = sidebar.View.init(COLS, WT_ROWS, true, 0, s.entries.length)
      .withWidth(34)
      .withWorkspaces(s.workspaces.length, 0);
    badges.push(sidebar.worktreeBadge(side, s.workspaces, 2));
    if (!mask) agents = worktreeAgents.counts(trees, s.entries);
  }
  keepOverview("moonlander", MOON_ROOT, MOON_TREES, MOON_BRIEFS, agents, badges, "moonlander alone");
}
/** The sidebar beside moonlander's dev server: its agents under their
 * worktrees, the rule dragged up under the workspaces. Its worktree badge
 * opens moonlander's overview. */
function cleverFrame() {
  const s = scene({ phone: false, corgi: false, unread: 1, ahead: true, focused: false, read: false });
  s.workspaces[1].worktrees = MOON_TREES;
  s.entries = worktreeAgents.grouped(MOON_TREES, 2, s.entries, new worktreeAgents.State());
  const u = uiFor(s, 34);
  u.prefs.sidebar_split = 9;
  const plain = frame(view, [], COLS, ROWS, u);
  keep(
    "clever34",
    grid(plain, COLS, ROWS).map(r => r.slice(0, 34)),
    plain,
  );
  const side = sidebar.View.init(COLS, ROWS, true, 0, s.entries.length)
    .withWidth(34)
    .withWorkspaces(s.workspaces.length, 0);
  keepOverview("moonlander", MOON_ROOT, MOON_TREES, MOON_BRIEFS, worktreeAgents.counts(MOON_TREES, s.entries), [
    sidebar.worktreeBadge(side, s.workspaces, 2),
  ]);
}
/** The sidebar beside the resource band's card, on the GPU host: tall enough
 * for the card's GPU graphs, with a GPU reading in each workspace's row, and
 * corgi's first agent focused before "Refactor the viewer" compacts. */
function resourceFrame() {
  const rows = 38,
    s = scene({ phone: false, corgi: true, unread: 1, ahead: true, focused: false, read: false, early: true });
  s.entries.forEach((e, i) => (e.focused = i === 0));
  sidebarResources("gpus").forEach((work, i) => (s.workspaces[i].resources = work));
  const u = uiFor(s, 34, { resources: resourceSamples.snapshot("gpus", 0) });
  // The agents start where keeps watch has them.
  u.prefs.sidebar_split = 11;
  const plain = frame(view, [], COLS, rows, u);
  keep(
    "res34",
    grid(plain, COLS, rows).map(r => r.slice(0, 34)),
    plain,
  );
}
/** The narrow sidebar beside the review panel: moonlander's agents under
 * their worktrees, the thruster tuning idle now its turn is over, with no
 * tool counts to crowd the workspaces. */
function reviewFrame() {
  const s = scene({ phone: false, corgi: false, unread: 0, ahead: true, focused: false, read: false });
  Object.assign(s.entries[0], { focused: true, state: "idle", attention: "none", activity: "" });
  Object.assign(s.workspaces[1], { working: 0, attention: 0, worktrees: MOON_TREES });
  for (const ws of s.workspaces) Object.assign(ws, { stats: { ...ws.stats, tools: 0 } });
  s.entries = worktreeAgents.grouped(MOON_TREES, 2, s.entries, new worktreeAgents.State());
  const plain = frame(view, [], COLS, ROWS, uiFor(s, 24));
  keep(
    "review24",
    grid(plain, COLS, ROWS).map(r => r.slice(0, 24)),
    plain,
  );
}

// ---------------------------------------------------------------- review
// moonlander's two worktrees, made for real: the thruster tuning's, with the
// gravity fix and its test not committed yet, and the sprite's, each written
// when the story says. The page runs Corgi's review panel on what git
// answers about them here. Their lines fit the panel's 52 columns of code.
const LANDER_TS = `/** Where the lander is and how fast it moves,
 * in metres and m/s, y down. */
export interface Lander {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export const spawn = (x: number): Lander => ({
  x,
  y: 0,
  vx: 0,
  vy: 0,
});
`;
const LANDER_ENGINE = LANDER_TS.replace(
  `  vy: number;
}`,
  `  vy: number;
  /** Tilt from upright, in radians. */
  angle: number;
  /** Fuel left, in kg. */
  fuel: number;
  /** The main engine is on. */
  burning: boolean;
}`,
).replace(
  `  vy: 0,
});`,
  `  vy: 0,
  angle: 0,
  fuel: 800,
  burning: false,
});`,
);
const PHYSICS_TS = `import type { Lander } from "./lander";

/** Earth's pull, in m/s². */
export const GRAVITY = 9.81;

/** One step of flight: the lander falls. */
export function step(l: Lander, dt: number) {
  l.vy += GRAVITY * dt;
  l.x += l.vx * dt;
  l.y += l.vy * dt;
}

/** Down gently enough to stay on its legs. */
export const safe = (l: Lander) =>
  l.vy < 2 && Math.abs(l.vx) < 1;
`;
const PHYSICS_THRUST = PHYSICS_TS.replace(
  `export const GRAVITY = 9.81;
`,
  `export const GRAVITY = 9.81;
/** The main engine's push, in m/s². */
export const THRUST = 4.2;
`,
).replace(
  `/** One step of flight: the lander falls. */
export function step(l: Lander, dt: number) {
  l.vy += GRAVITY * dt;`,
  `/** One step of flight: the lander falls, slowed
 * while its engine burns. */
export function step(l: Lander, dt: number) {
  let ay = GRAVITY;
  if (l.burning) ay -= THRUST;
  l.vy += ay * dt;`,
);
const PHYSICS_FUEL = PHYSICS_THRUST.replace(
  `export const THRUST = 4.2;
`,
  `export const THRUST = 4.2;
/** Fuel the engine burns, in kg/s. */
export const BURN = 12;
`,
).replace(
  `  if (l.burning) ay -= THRUST;
`,
  `  if (l.burning && l.fuel > 0) {
    ay -= THRUST;
    l.fuel = Math.max(0, l.fuel - BURN * dt);
  }
`,
);
const PHYSICS_TILT = PHYSICS_FUEL.replace(
  `/** One step of flight: the lander falls, slowed
 * while its engine burns. */
export function step(l: Lander, dt: number) {
  let ay = GRAVITY;
  if (l.burning && l.fuel > 0) {
    ay -= THRUST;`,
  `/** One step of flight: the lander falls, and its
 * engine pushes it along its tilt. */
export function step(l: Lander, dt: number) {
  let ax = 0,
    ay = GRAVITY;
  if (l.burning && l.fuel > 0) {
    ax += Math.sin(l.angle) * THRUST;
    ay -= Math.cos(l.angle) * THRUST;`,
).replace(
  `  l.vy += ay * dt;`,
  `  l.vx += ax * dt;
  l.vy += ay * dt;`,
);
const PHYSICS_MOON = PHYSICS_TILT.replace(
  `/** Earth's pull, in m/s². */
export const GRAVITY = 9.81;`,
  `/** The moon's pull, in m/s². */
export const GRAVITY = 1.62;`,
);
/** The lander as the sprite's checkout draws it. */
const SPRITE_TS = `/** The lander as pixel art, a row a line:
 * # hull, o window, / and \\ legs. */
export const sprite = [
  "   ####   ",
  "  #o  o#  ",
  "  ######  ",
  " ##    ## ",
  " /      \\ ",
];
export const width = sprite[0].length;
export const height = sprite.length;
`;
const LANDER_SPRITE = `import { sprite } from "./sprite";

${LANDER_TS}
/** The lander's rows, to draw at its place. */
export const rows = (): readonly string[] => sprite;
`;
const PHYSICS_TEST = `import { expect, test } from "bun:test";
import { spawn } from "./lander";
import { GRAVITY, safe, step } from "./physics";

test("falls at the moon's pull", () => {
  const l = spawn(0);
  step(l, 1);
  expect(l.vy).toBeCloseTo(GRAVITY);
});

test("touches down without bouncing", () => {
  const l = spawn(0);
  while (l.y < 120) {
    l.burning = l.vy > 1.5;
    step(l, 0.05);
  }
  expect(safe(l)).toBe(true);
});
`;
/** A diff as the patch git gives for it, the whole file as context. */
const patch = (d: FileDiff) =>
  [
    "@@ -1 +1 @@",
    ...d.rows.map(row => (row.kind === "insertion" ? "+" : row.kind === "deletion" ? "-" : " ") + d.text(row)),
  ].join("\n");
const sourceKey = (s: reviewGit.Source) => (s.kind === "worktree" ? `w:${s.against}` : `c:${s.hash}`);
type Tools = {
  git: (...args: string[]) => void;
  put: (path: string, text: string) => void;
  later: (minutes: number) => void;
  commit: (subject: string) => void;
};
/** A checkout `build` makes for real, from `hours` ago, and what git
 * answers the panel about it, for every scope and file it can show:
 * site/browser/git.ts answers the same on the page, for the checkout the
 * page names `root`. */
async function checkoutFixture(root: string, hours: number, build: (tools: Tools) => void) {
  const repo = join(tmpdir(), "corgi-site", "moonlander");
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  let clock = secs - hours * 3600;
  const git = (...args: string[]) => {
    const when = `${clock} -0400`;
    const r = spawnSync("git", ["-C", repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Tal Shiri",
        GIT_AUTHOR_EMAIL: "tal@example.com",
        GIT_COMMITTER_NAME: "Tal Shiri",
        GIT_COMMITTER_EMAIL: "tal@example.com",
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    if (r.status !== 0) throw Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const put = (path: string, text: string) => {
    const file = join(repo, path);
    writeFileSync(file, text);
    utimesSync(file, clock, clock);
  };
  const later = (minutes: number) => (clock += minutes * 60);
  const commit = (subject: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };
  try {
    git("init", "-q", "-b", "main");
    build({ git, put, later, commit });
    const [head, branch, base] = await Promise.all([
      reviewGit.head(repo),
      reviewGit.branch(repo),
      reviewGit.base(repo),
    ]);
    const commits = await reviewGit.commits(repo, base);
    // The "all", "uncommitted" and each commit's scope.
    const sources: reviewGit.Source[] = [
      { kind: "worktree", against: base?.merge_base ?? reviewGit.empty_tree },
      { kind: "worktree", against: head ?? reviewGit.empty_tree },
      ...commits.map(c => ({ kind: "commit" as const, hash: c.hash })),
    ];
    const fixture = {
      at: secs,
      root,
      head,
      branch,
      base,
      commits,
      listings: {} as Record<string, reviewGit.Change[]>,
      edited: {} as Record<string, number>,
      diffs: {} as Record<string, string | reviewGit.Loaded>,
    };
    for (const source of sources) {
      const key = sourceKey(source),
        changes = await reviewGit.changes(repo, source);
      fixture.listings[key] = changes;
      for (const change of changes) {
        const loaded = await reviewGit.fileDiff(repo, source, change);
        fixture.diffs[`${key}\0${change.path}`] = loaded.kind === "diff" ? patch(loaded.diff) : loaded;
      }
      if (source.kind === "worktree")
        for (const [path, ms] of await reviewGit.edited(
          repo,
          changes.map(c => c.path),
        ))
          fixture.edited[path] = ms;
    }
    return fixture;
  } finally {
    rmSync(join(tmpdir(), "corgi-site"), { recursive: true, force: true });
  }
}
/** The thruster tuning's checkout: main, the branch's four commits, then the
 * gravity fix and its test. */
const thrustersFixture = () =>
  checkoutFixture("~/moonlander", 3, ({ git, put, later, commit }) => {
    put("src/lander.ts", LANDER_TS);
    put("src/physics.ts", PHYSICS_TS);
    commit("physics: let the lander fall");
    git("checkout", "-q", "-b", "feat/thrusters");
    later(65);
    put("src/lander.ts", LANDER_ENGINE);
    commit("lander: carry fuel, a tilt and an engine");
    later(25);
    put("src/physics.ts", PHYSICS_THRUST);
    commit("physics: fire the main engine");
    later(30);
    put("src/physics.ts", PHYSICS_FUEL);
    commit("physics: burn fuel while the engine runs");
    later(38);
    put("src/physics.ts", PHYSICS_TILT);
    commit("physics: push along the lander's tilt");
    later(18);
    put("src/physics.ts", PHYSICS_MOON);
    later(2);
    put("src/physics.test.ts", PHYSICS_TEST);
  });
/** The sprite's checkout: one commit on main since it branched, then its
 * two drawing the lander, all committed. Git rewrites what a checkout
 * changes, so the branch's own files are written after it. */
const spriteFixture = () =>
  checkoutFixture("~/moonlander/.claude/worktrees/sprite", 6, ({ git, put, later, commit }) => {
    put("src/lander.ts", LANDER_TS);
    put("src/physics.ts", PHYSICS_TS);
    commit("physics: let the lander fall");
    git("branch", "art/lander-sprite");
    later(10);
    put("src/physics.ts", PHYSICS_THRUST);
    commit("physics: fire the main engine");
    git("checkout", "-q", "art/lander-sprite");
    later(50);
    put("src/sprite.ts", SPRITE_TS);
    commit("sprite: draw the lander as pixel art");
    later(260);
    put("src/lander.ts", LANDER_SPRITE);
    commit("lander: draw from the sprite");
  });
/** Ghostty's width of every codepoint, as the ranges whose width isn't 1. */
function widthRanges(): [number, number, number][] {
  const table = codepointWidths(),
    out: [number, number, number][] = [];
  for (let from = 0, cp = 1; cp <= table.length; cp++)
    if (cp === table.length || table[cp] !== table[from]) {
      if (table[from] !== 1) out.push([from, cp - 1, table[from]]);
      from = cp;
    }
  return out;
}

// ---------------------------------------------------------------- run
if (dumpDir) mkdirSync(dumpDir, { recursive: true });
watchFrames();
pickerFrames();
reopenFrames();
overviewFrames();
worktreeFrames();
cleverFrame();
resourceFrame();
reviewFrame();
const review = [await thrustersFixture(), await spriteFixture()];
// What each worktree's Review changes would show, as its heading's menu says
// it: what the panel lists for its "all" scope.
(overviews["moonlander alone"] as { reviews: unknown }).reviews = [
  [moonPath("thrusters"), review[0]],
  [moonPath("sprite"), review[1]],
].map(([path, f]: any) => [
  path,
  reviewPanel.summaryRuns(f.listings[sourceKey({ kind: "worktree", against: f.base?.merge_base ?? "" })], f.base),
]);
if (unknown.size) console.log("unhandled sequences:", [...unknown].join(", "));

/** How a new frame differs from the page's: cells whose text or style changed. */
function changes(name: string, next: Runs | Runs[]): string {
  const old = data.frames[name];
  if (!old) return "new";
  const flat = (f: Runs) =>
    f.map(row =>
      row.flatMap(([text, s]) => Array.from(text).map(ch => ch + "\u0000" + JSON.stringify(data.styles[s]))),
    );
  const list = (f: any): Runs[] => (Array.isArray(f[0]?.[0]?.[0]) ? f : [f]);
  const a = list(old).map(flat),
    b = list(next).map(flat);
  if (a.length !== b.length) return `${a.length} → ${b.length} frames`;
  let cells = 0,
    text = 0,
    sample = "";
  a.forEach((fa, k) => {
    const fb = b[k];
    if (fa.length !== fb.length || fa[0]?.length !== fb[0]?.length) {
      cells = -1;
      sample ||= `size ${fa[0]?.length}x${fa.length} → ${fb[0]?.length}x${fb.length}`;
      return;
    }
    fa.forEach((ra, r) =>
      ra.forEach((ca, c) => {
        if (ca === fb[r][c]) return;
        cells += 1;
        if (ca.split("\u0000")[0] !== fb[r][c].split("\u0000")[0]) {
          text += 1;
          sample ||= `row ${r}: ${JSON.stringify(
            ra
              .map(x => x[0])
              .join("")
              .trimEnd(),
          )} → ${JSON.stringify(
            fb[r]
              .map(x => x[0])
              .join("")
              .trimEnd(),
          )}`;
        }
      }),
    );
  });
  if (cells === 0) return "";
  return cells < 0 ? sample : `${cells} cells (${text} text)${sample ? ": " + sample : ""}`;
}
// --show NAME prints a frame's text (every one of a list, with --all).
const show = arg("--show");
if (show) {
  const f = made.get(show);
  const list: Runs[] = f && Array.isArray(f[0]?.[0]?.[0]) ? (f as Runs[]) : f ? [f as Runs] : [];
  const picks = process.argv.includes("--all") ? list : list.slice(0, 1);
  for (const [k, rows] of picks.entries()) {
    if (picks.length > 1) console.log(`--- ${show}[${k}]`);
    for (const row of rows) console.log("|" + row.map(([text]) => text).join("") + "|");
  }
}
// --tally counts every differing cell by what changed, across all frames.
if (process.argv.includes("--tally")) {
  const tally = new Map<string, Set<string>>();
  const flat = (f: Runs) =>
    f.map(row => row.flatMap(([text, s]) => Array.from(text).map(ch => [ch, JSON.stringify(data.styles[s])])));
  const list = (f: any): Runs[] => (Array.isArray(f[0]?.[0]?.[0]) ? f : [f]);
  for (const [name, next] of made) {
    const old = data.frames[name];
    if (!old) continue;
    const a = list(old).map(flat),
      b = list(next).map(flat);
    if (a.length !== b.length) continue;
    a.forEach((fa, k) =>
      fa.forEach((ra, r) =>
        ra.forEach(([ch, st], c) => {
          const nb = b[k][r]?.[c];
          if (!nb || (nb[0] === ch && nb[1] === st)) return;
          const key =
            nb[0] === ch
              ? `style of ${JSON.stringify(ch)}: ${st} → ${nb[1]}`
              : `${JSON.stringify(ch)} → ${JSON.stringify(nb[0])}`;
          if (!tally.has(key)) tally.set(key, new Set());
          tally.get(key)!.add(name);
        }),
      ),
    );
  }
  for (const [key, names] of [...tally].sort((x, y) => y[1].size - x[1].size))
    console.log(`${names.size}\t${key}\t${[...names].slice(0, 4).join(" ")}`);
}
let changed = 0;
for (const [name, frames] of made) {
  const diff = changes(name, frames);
  if (!diff) continue;
  changed += 1;
  if (checkOnly || process.argv.includes("--verbose")) console.log(`${name}: ${diff}`);
}
const missing = Object.keys(data.frames).filter(k => !made.has(k));
console.log(`${made.size} frames, ${changed} changed${missing.length ? `; not made here: ${missing.join(", ")}` : ""}`);
if (writes) {
  data.frames = Object.fromEntries(made);
  data.widths = widthRanges();
  data.review = review;
  data.worktrees = overviews;
  // One frame per line, so a re-recording diffs by frame.
  const frames = Object.entries(data.frames).map(([name, f]) => `    ${JSON.stringify(name)}: ${JSON.stringify(f)}`);
  writeFileSync(
    FRAMES,
    [
      "{",
      `  "styles": ${JSON.stringify(data.styles)},`,
      `  "widths": ${JSON.stringify(data.widths)},`,
      `  "review": ${JSON.stringify(data.review)},`,
      `  "worktrees": ${JSON.stringify(data.worktrees)},`,
      `  "frames": {`,
      frames.join(",\n"),
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  console.log(`wrote ${FRAMES}`);
}
