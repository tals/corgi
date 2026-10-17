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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drawRestoring, frame, ui as uiOf, type Ui } from "../src/render";
import { Model, Rect, Selection, View as LayoutView } from "../src/layout";
import * as sidebar from "../src/sidebar";
import * as subagentTooltip from "../src/subagent_tooltip";
import * as resourceTooltip from "../src/resource_tooltip";
import { Menu as LauncherMenu, option, type Row } from "../src/agent_launcher";
import { historyEntry } from "../src/launcher_resume";
import { Snapshot as PortsSnapshot } from "../src/trackers/ports";
import { Process, Work, cpuText, memoryText, type Point } from "../src/trackers/resources";
import { View as ContextView } from "../src/usage/context_window";
import { Writer } from "../src/text";
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
  resTotals: unknown;
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
/** Frames the page can't take yet, and why: they stay as the page has them. */
const HELD: Record<string, string> = {};
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
  GiB = 1 << 30,
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
  },
  {
    timestamp: secs - 3 * 3600,
    hash: "d901fd0",
    subject: "launcher: date Claude conversations by their last prompt or reply",
    author: "Tal Shiri",
    date: "2026-10-05 10:06",
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
/** The resource card samples once a second; the page loops these samples. */
const SAMPLES = 12;
type Proc = {
  pid: number;
  name: string;
  provider?: Provider;
  cpu: (number | null)[];
  /** MiB. */
  memory: number[];
  /** MB/s. */
  read?: number[];
  written?: number[];
};
const same = (n: number) => Array<number>(SAMPLES).fill(n);
/** corgi: "Fix sidebar flicker" edits (samples 2-3, zls re-reads the file),
 * runs `./scripts/zig build test -Dtest-filter=sidebar` (compile 4-7, link
 * writes the test binary, tests 8-1), and reads the result. Codex's verifier
 * downloads the release to check its checksums (1-3). The rest idle along. */
const CORGI_PROCS: Proc[] = [
  // Fix sidebar flicker, and the zls its LSP tool started.
  {
    pid: 51536,
    name: "claude",
    provider: "claude",
    cpu: [7.1, 7.8, 9.6, 6.9, 7.4, 6.6, 6.2, 6.8, 7.6, 7.2, 6.9, 7.3],
    memory: [406, 407, 409, 410, 404, 404, 405, 405, 406, 406, 406, 406],
    written: [0.2, 0.3, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.1, 0.2],
  },
  {
    pid: 51544,
    name: "zls",
    cpu: [1.3, 1.4, 1.2, 5.2, 1.6, 1.3, 1.2, 1.4, 1.3, 1.2, 1.4, 1.3],
    memory: [347, 347, 347, 352, 351, 350, 350, 349, 349, 348, 348, 348],
    read: [0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  // Its Bash tool's shell, the zig build, the build runner, the compiler and the test binary.
  { pid: 53975, name: "zsh", cpu: [0.0, 0.0, null, null, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], memory: same(3.1) },
  {
    pid: 53977,
    name: "zig",
    cpu: [0.2, 0.6, null, null, 0.9, 0.3, 0.2, 0.4, 0.3, 0.2, 0.2, 0.2],
    memory: [41, 42, 0, 0, 38, 40, 40, 41, 41, 41, 41, 41],
    read: [0, 0, 0, 0, 1.2, 0, 0, 0, 0, 0, 0, 0],
    written: [0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    pid: 53984,
    name: "build",
    cpu: [0.4, 0.8, null, null, 1.1, 0.4, 0.3, 0.5, 0.6, 0.4, 0.4, 0.4],
    memory: [66, 66, 0, 0, 58, 63, 64, 64, 65, 65, 66, 66],
    read: [0, 0, 0, 0, 2.6, 0.3, 0, 0, 0, 0, 0, 0],
    written: [0, 0.2, 0, 0, 0.1, 0, 0, 0.1, 0, 0, 0, 0],
  },
  {
    pid: 53989,
    name: "zig",
    cpu: [null, null, null, null, 41.3, 72.6, 66.1, 28.4, null, null, null, null],
    memory: [0, 0, 0, 0, 412, 596, 758, 823, 0, 0, 0, 0],
    read: [0, 0, 0, 0, 18.2, 6.4, 2.2, 1.1, 0, 0, 0, 0],
    written: [0, 0, 0, 0, 2.1, 9.8, 21.5, 46.8, 0, 0, 0, 0],
  },
  {
    pid: 53996,
    name: "test",
    cpu: [31.2, 12.4, null, null, null, null, null, null, 36.8, 44.1, 41.5, 38.0],
    memory: [86, 88, 0, 0, 0, 0, 0, 0, 48, 72, 80, 84],
    read: [0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0],
    written: [0.4, 0.2, 0, 0, 0, 0, 0, 0, 0.3, 0.8, 0.5, 0.6],
  },
  // Audit the install script: Codex runs both subagents; the verifier's curl.
  {
    pid: 52926,
    name: "codex",
    provider: "codex",
    cpu: [4.4, 4.8, 4.6, 4.5, 4.8, 4.2, 4.0, 4.3, 4.6, 4.9, 4.5, 4.1],
    memory: [133, 134, 135, 135, 134, 134, 133, 133, 132, 132, 133, 133],
    written: [0.1, 0.1, 0.1, 0.1, 0.1, 0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
  },
  {
    pid: 53958,
    name: "zsh",
    cpu: [null, 0.0, 0.0, 0.0, null, null, null, null, null, null, null, null],
    memory: same(3.0),
  },
  {
    pid: 53961,
    name: "curl",
    cpu: [null, 1.1, 2.6, 2.2, null, null, null, null, null, null, null, null],
    memory: same(9.0),
    written: [0, 3.1, 12.6, 8.9, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  // Release notes, waiting for permission.
  {
    pid: 52431,
    name: "claude",
    provider: "claude",
    cpu: [0.3, 0.2, 0.3, 0.3, 0.2, 0.3, 0.3, 0.2, 0.3, 0.3, 0.2, 0.3],
    memory: same(268),
  },
  // Refactor the viewer, compacting a long context.
  {
    pid: 50873,
    name: "claude",
    provider: "claude",
    cpu: [3.6, 3.9, 3.7, 3.9, 3.6, 3.4, 3.3, 3.5, 3.6, 3.8, 3.7, 3.5],
    memory: [509, 510, 511, 512, 513, 513, 514, 514, 515, 515, 516, 516],
    written: [0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0],
  },
  // Ghostty keybindings, finished.
  {
    pid: 49817,
    name: "codex",
    provider: "codex",
    cpu: [0.1, 0.0, 0.0, 0.1, 0.0, 0.0, 0.1, 0.0, 0.0, 0.1, 0.0, 0.0],
    memory: same(74),
  },
];
/** moonlander, a Bun site: "Tune the thruster physics" saves physics.ts (2),
 * the `bun --hot` dev server reloads and its `bun test --watch` reruns
 * (3-7), the e2e suite driving the game in its headless browser. */
const MOON_PROCS: Proc[] = [
  // Draw the lander sprite, idle.
  {
    pid: 48297,
    name: "claude",
    provider: "claude",
    cpu: [0.3, 0.3, 0.4, 0.3, 0.3, 0.3, 0.4, 0.3, 0.3, 0.3, 0.4, 0.3],
    memory: same(188),
  },
  // Tune the thruster physics, and the dev server and tests it left running.
  {
    pid: 52677,
    name: "claude",
    provider: "claude",
    cpu: [7.4, 8.6, 6.9, 6.2, 8.1, 8.8, 8.6, 7.9, 7.8, 8.2, 7.6, 7.1],
    memory: [278, 279, 281, 282, 281, 283, 283, 282, 281, 280, 279, 278],
    written: [0.1, 0.2, 0.2, 0.1, 0.1, 0.2, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1],
  },
  { pid: 52801, name: "zsh", cpu: same(0.0), memory: same(3.1) },
  {
    pid: 52803,
    name: "bun",
    cpu: [0.5, 0.6, 3.4, 1.1, 0.6, 0.5, 0.5, 0.5, 0.5, 0.6, 0.5, 0.5],
    memory: [62, 62, 66, 65, 64, 64, 63, 63, 63, 62, 62, 62],
    read: [0, 0, 1.4, 0.2, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  { pid: 53088, name: "zsh", cpu: same(0.0), memory: same(3.0) },
  {
    pid: 53090,
    name: "bun",
    cpu: [0.2, 0.2, 0.3, 24.3, 58.7, 63.9, 41.2, 12.8, 0.2, 0.2, 0.2, 0.2],
    memory: [74, 74, 74, 96, 118, 126, 128, 104, 76, 74, 74, 74],
    read: [0, 0, 0, 6.2, 1.1, 0.2, 0, 0, 0, 0, 0, 0],
    written: [0, 0, 0, 0, 0.3, 0.4, 0.2, 0.1, 0, 0, 0, 0],
  },
  {
    pid: 53097,
    name: "chrome-headless-shell",
    cpu: [1.1, 1.0, 1.2, 1.3, 2.4, 3.1, 2.8, 1.6, 1.2, 1.1, 1.0, 1.1],
    memory: same(72),
    written: [0, 0, 0, 0, 0.1, 0.3, 0.2, 0, 0, 0, 0, 0],
  },
  {
    pid: 53102,
    name: "chrome-headless-shell",
    cpu: [4.6, 4.9, 4.7, 5.1, 5.4, 7.9, 7.2, 5.6, 4.8, 4.6, 4.5, 4.7],
    memory: [121, 121, 122, 124, 131, 134, 133, 126, 122, 121, 121, 121],
    written: [0, 0, 0, 0, 0.2, 0.6, 0.4, 0.1, 0, 0, 0, 0],
  },
];
/** Sample `s` of a workspace: its running processes and their sums. */
function sampleWork(id: number, procs: Proc[], s: number): Work {
  const work = Object.assign(new Work(), { id, known: true, cpu: 0, memory: 0n, read: 0n, written: 0n, count: 0 });
  for (const p of procs) {
    const cpu = p.cpu[s];
    if (cpu === null) continue;
    const proc = Object.assign(new Process(), {
      pid: p.pid,
      start: 1n,
      name: p.name,
      provider: p.provider ?? null,
      cpu,
      memory: BigInt(Math.trunc(p.memory[s] * MiB)),
      read: BigInt(Math.trunc((p.read?.[s] ?? 0) * 1e6)),
      written: BigInt(Math.trunc((p.written?.[s] ?? 0) * 1e6)),
    });
    work.cpu! += cpu;
    work.memory! += proc.memory;
    work.read! += proc.read!;
    work.written! += proc.written!;
    work.processes.push(proc);
    work.count += 1;
  }
  return work;
}
const WORKSPACE_PROCS = [CORGI_PROCS, MOON_PROCS];
/** Each workspace's totals at every sample, as the card's history. */
const POINTS: Point[][] = WORKSPACE_PROCS.map((procs, wi) =>
  Array.from({ length: SAMPLES }, (_, s) => {
    const work = sampleWork(wi + 1, procs, s);
    return { at: 0, cpu: work.cpu, memory: work.memory, io: work.read! + work.written! };
  }),
);
/** The sidebar rows show the first sample; the page patches them from RES_TOTALS as the cards loop. */
const FIRST = WORKSPACE_PROCS.map((procs, wi) => Object.assign(sampleWork(wi + 1, procs, 0), { processes: [] }));

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
                // The pointer on moonlander's link: only the URL chip on the bottom row differs.
                if (unread === 1 && ahead && !focused && !read) {
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
                // Each workspace's resource card, one frame a second; corgi needs
                // 68 columns for it, so phones have none.
                if (!phone && corgi && !read) resourceFrames(s, width);
              }
            }
}
/** A card over the window from CARD_LEFT on, or alone at the phone's 54 columns. */
function cardCells(ansi: string, phone: boolean): Cell[][] {
  const g = grid(ansi, phone ? PHONE.cards : COLS, ROWS);
  return phone ? g : g.map(r => r.slice(CARD_LEFT));
}
const totals: Record<string, [string, string][]> = { C: [], M: [] };
function resourceFrames(s: ReturnType<typeof scene>, width: number) {
  for (let f = 0; f < SAMPLES; f++) {
    // Sample f is the latest point, after the 20 before it.
    const works = WORKSPACE_PROCS.map((procs, wi) => {
      const work = sampleWork(wi + 1, procs, f);
      work.history = Array.from({ length: 21 }, (_, i) => POINTS[wi][(f + i + 2 * SAMPLES - 20) % SAMPLES]);
      return work;
    });
    const busy = works.reduce((n, w) => n + w.cpu!, 0);
    works.forEach((work, wi) => {
      const tag = wi === 0 ? "C" : "M";
      totals[tag][f] = [cpuText(work.cpu), memoryText(work.memory)];
      const state = new resourceTooltip.State({ anchor: wi === 0 ? 4 : 7 });
      state.update(work, false);
      const out = frame(
        view,
        [],
        COLS,
        ROWS,
        uiFor(s, width, {
          link_tooltip: true,
          pointer: { x: 14, y: state.anchor },
          resource_hover: work.id,
          resource_card: state,
          resources: {
            interval_ms: 1000,
            host_cpu: Math.round(24 + busy / 12),
            cores: 12,
            memory_pressure: "normal",
            memory_kind: "footprint",
            workspaces: works,
            workspace: (id: number) => works.find(w => w.id === id) ?? new Work(),
          },
        }),
      );
      keep(
        `res_${tag}_${f}`,
        grid(out, COLS, ROWS).map(r => r.slice(CARD_LEFT)),
        out,
      );
    });
  }
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
function launcher(selected: Row): LauncherMenu {
  const menu = new LauncherMenu({
    workspace: 1,
    selected,
    last: "claude",
    pinned: true,
    cwd: "/Users/me/dev/corgi",
    workspace_cwd: "/Users/me/dev/corgi",
  });
  menu.history = { pending: false, entries: HISTORY };
  menu.preview.pending = false;
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
  // A second Codex account, saved as its own command.
  const work = menu.commands[0];
  work.set("CODEX_HOME=~/.codex-slopcorp codex");
  work.name = "Codex";
  Object.assign(work.semantics, {
    provider: "codex",
    account: "you@slopcorp.ai",
    model: "gpt-6-astra",
    model_name: "GPT-6 Astra",
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
  (["codex", "claude", "custom0", "terminal"] as Row[]).forEach((row, i) => draw(launcher(row), `launcher${i}`));
  ["", "fl", "zzz", ""].forEach((query, i) => {
    const menu = launcher("claude");
    if (i === 3) menu.resume_view.focused = true;
    else menu.resume_view.startSearch();
    for (const ch of query) menu.resume_view.query.key(ch.charCodeAt(0));
    draw(menu, `search${i}`);
  });
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
        id = (((n + 1) * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0") + "-4e1b-4c8e-9d2a-51b0e6f3a7c" + n,
        out = new Writer();
      out.write("\x1b[0m\x1b[H\x1b[J");
      drawRestoring(
        out,
        new Rect(0, 0, w, h),
        {
          command: e.provider === "claude" ? `claude --resume ${id}` : `codex resume ${id}`,
          name: e.title,
          meta: `${e.provider} · ${models[e.provider]} · ~/dev/corgi`,
          dig: "restoring",
        },
        t,
      );
      const rows = grid(out.buffered(), w, h);
      return rows.slice(
        rows.findIndex(row => row.some(([ch]) => ch === "╭")),
        rows.findIndex(row => row.some(([ch]) => ch === "╰")) + 1,
      );
    };
    const digs = new Set<number>();
    HISTORY.forEach((_, n) => {
      const last = card(n, 3600),
        width = last[0].filter(([ch]) => ch !== " ").length;
      keep(`${pre}rest${n}`, last);
      if (digs.has(width)) return;
      digs.add(width);
      const row = last.findIndex((cells, r) => cells.some(([ch], c) => ch !== card(n, 0)[r][c][0]));
      const frames: Cell[][][] = [];
      for (let t = 0; t <= 3600; t += 80) frames.push([card(n, t)[row]]);
      keep(`${pre}dig${width}`, frames);
    });
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
      [3, 7, 10, 14, 17, 20, null, null, null, null, null],
      [5, 11, 17, 24, 30, 36, null, null, null, null, null],
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

// ---------------------------------------------------------------- run
if (dumpDir) mkdirSync(dumpDir, { recursive: true });
watchFrames();
pickerFrames();
overviewFrames();
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
  // Frames this run no longer makes go, unless held.
  data.frames = Object.fromEntries([
    ...[...made].filter(([name]) => !HELD[name]),
    ...Object.keys(HELD).map(name => [name, data.frames[name]]),
  ]);
  for (const [name, why] of Object.entries(HELD)) console.log(`kept the page's ${name}: ${why}`);
  data.resTotals = totals;
  // One frame per line, so a re-recording diffs by frame.
  const frames = Object.entries(data.frames).map(([name, f]) => `    ${JSON.stringify(name)}: ${JSON.stringify(f)}`);
  writeFileSync(
    FRAMES,
    [
      "{",
      `  "styles": ${JSON.stringify(data.styles)},`,
      `  "resTotals": ${JSON.stringify(data.resTotals)},`,
      `  "frames": {`,
      frames.join(",\n"),
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  console.log(`wrote ${FRAMES}`);
}
