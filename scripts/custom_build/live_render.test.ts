import { expect, test } from "bun:test";
import type { LiveEvent, Stage } from "./live_events";
import { card, frame, outcomeCard, problems, spinner, type TaskLine, taskFrame, timeline } from "./live_render";
import { apply, initial, type LiveState, rebaseItem, rebaseSummary } from "./live_state";
import * as term from "./term";
import type { Estimate, HistoryRun } from "./timings";

const s = (n: number) => n * 1000;
const patches = [
  "custom-build-tool",
  "001-voice-dictation",
  "005-voice-transcripts",
  "fix-jump-to-blocked",
  "tals/corgi#128",
  "tals/corgi#93",
  "tals/corgi#129",
  "tals/corgi#151",
];
const steps = ["install", "typecheck", "test", "build"];
const last: HistoryRun = {
  command: "rebuild",
  finishedAt: "2026-11-10T10:00:00.000Z",
  partial: false,
  activeMs: s(591),
  items: {
    fetch: s(7),
    "rebase:a": s(60),
    "rebase:b": s(60),
    ...Object.fromEntries(patches.map(p => [`merge:${p}`, s(15)])),
    "step:install": s(20),
    "step:typecheck": s(40),
    "step:test": s(200),
    "step:build": s(84),
  },
  harnessMs: [s(40)],
};
const estimate: Estimate = { totalMs: s(570), leftMs: s(318), aheadMs: s(21), last };
const none: Estimate = { totalMs: null, leftMs: null, aheadMs: null, last: null };

function begin(o: Partial<Extract<LiveEvent, { t: "begin" }>> = {}): LiveEvent {
  return {
    t: "begin",
    command: "rebuild",
    branch: "integration",
    upstream: { name: "upstream/main", tip: "170454d", newCommits: 7 },
    stages: ["fetch", "rebase", "merge", "verify"],
    items: { merge: patches, verify: steps },
    estimate,
    links: { "tals/corgi#93": "https://github.com/tals/corgi/pull/93" },
    harness: "claude",
    harnessMedianMs: null,
    elapsedMs: 0,
    ...o,
  };
}
const play = (events: [LiveEvent, number][], from: LiveState = initial()) =>
  events.reduce((state, [e, at]) => apply(state, e, at), from);
const harness = (state: "start" | "end", id: string, at: Partial<Extract<LiveEvent, { t: "harness" }>> = {}) =>
  ({ t: "harness", state, stage: "merge", id, attempt: 1, limit: 3, ...at }) as LiveEvent;
const item = (id: string, state: "start" | "done" | "failed", at: Partial<Extract<LiveEvent, { t: "item" }>> = {}) =>
  ({ t: "item", stage: "merge", id, state, ...at }) as LiveEvent;
const stage = (name: Stage, state: "start" | "done", at: Partial<Extract<LiveEvent, { t: "stage" }>> = {}) =>
  ({ t: "stage", stage: name, state, ...at }) as LiveEvent;

/** The run in the spec's running sketch, at 4:12. */
function running(o: Partial<Extract<LiveEvent, { t: "begin" }>> = {}): LiveState {
  return play([
    [begin(o), 0],
    [stage("fetch", "start"), 0],
    [stage("fetch", "done", { summary: "7 upstream commits, 8 patches" }), s(6)],
    [stage("rebase", "start"), s(6)],
    [stage("rebase", "done", { summary: "2 rebased · 6 in worktrees, left alone" }), s(118)],
    [stage("merge", "start"), s(118)],
    [item("custom-build-tool", "start"), s(118)],
    [item("custom-build-tool", "done", { outcome: "merged" }), s(125)],
    [item("001-voice-dictation", "start"), s(125)],
    [item("001-voice-dictation", "done", { outcome: "replayed" }), s(130)],
    [item("005-voice-transcripts", "start"), s(130)],
    [harness("start", "005-voice-transcripts", { files: ["a.ts", "b.ts"] }), s(132)],
    [harness("end", "005-voice-transcripts", { ok: true, usage: { input: 51000, output: 7400 } }), s(180)],
    [item("005-voice-transcripts", "done", { outcome: "agent-resolved" }), s(185)],
    [item("fix-jump-to-blocked", "start"), s(185)],
    [item("fix-jump-to-blocked", "done", { outcome: "replayed" }), s(190)],
    [item("tals/corgi#128", "start"), s(190)],
    [item("tals/corgi#128", "done", { outcome: "merged" }), s(200)],
    [item("tals/corgi#93", "start"), s(200)],
    [harness("start", "tals/corgi#93", { files: ["src/controller.ts"] }), s(214)],
    [
      {
        t: "harness",
        state: "activity",
        stage: "merge",
        id: "tals/corgi#93",
        attempt: 1,
        limit: 3,
        text: "claude: reading src/controller.ts; keeping both import blocks",
      },
      s(240),
    ],
  ]);
}
const now = s(252);
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

test("the running frame shows header, timeline, stages and footer", () => {
  const lines = frame(running(), { width: 100, nowMs: now, color: false, verbose: false });
  expect(lines).toContain("custom-build rebuild · integration · upstream/main @ 170454d (+7)");
  expect(lines.some(l => l.startsWith(" now ") && l.endsWith("4:12 / ~9:30"))).toBe(true);
  expect(lines.some(l => l.startsWith(" last ") && l.includes("▲ 0:21 ahead · ~5m 18s left"))).toBe(true);
  expect(lines.some(l => l.startsWith(" ✓ fetch") && l.includes("7 upstream commits, 8 patches"))).toBe(true);
  expect(lines.some(l => l.includes("merge") && l.includes("6/8"))).toBe(true);
  expect(lines.some(l => l.includes("✦ claude resolving src/controller.ts · try 1/3 · 0:38"))).toBe(true);
  expect(
    lines.some(l => l.includes("005-voice-transcripts") && l.includes("✦ agent-resolved 2 files · 58.4k tok")),
  ).toBe(true);
  expect(lines).toContain(" ✦ harness  2 calls · 1 running · 58.4k tokens (in 51.0k / out 7.4k)");
  expect(lines).toContain(" ↻ retries  none yet");
  expect(lines.some(l => l.startsWith(" ▏ ") && l.includes("keeping both import blocks"))).toBe(true);
});

test("without history the timeline shows elapsed only", () => {
  const state = running({ estimate: none }),
    lines = frame(state, { width: 100, nowMs: now, color: false, verbose: false });
  expect(lines.some(l => l.startsWith(" now ") && l.endsWith(" 4:12"))).toBe(true);
  expect(lines.some(l => l.startsWith(" last "))).toBe(false);
  expect(timeline(state, 100, false).last).toBeNull();
});

test("frame lines never exceed the width", () => {
  const states = [initial(), running(), running({ estimate: none }), stopped(), finished()];
  for (const state of states)
    for (const width of [1, 10, 30, 40, 60, 100, 200])
      for (const color of [false, true]) {
        for (const line of frame(state, { width, nowMs: now, color, verbose: false }))
          expect(term.width(line)).toBeLessThanOrEqual(width);
        for (const line of card(state, { width, color })) expect(term.width(line)).toBeLessThanOrEqual(width);
        const t = timeline(state, width, color);
        for (const line of [t.now, t.last ?? "", t.legend]) expect(term.width(line)).toBeLessThanOrEqual(width);
      }
});

test("verbose leaves out the activity line", () => {
  const lines = frame(running(), { width: 100, nowMs: now, color: false, verbose: true });
  expect(lines.some(l => l.startsWith(" ▏"))).toBe(false);
});

const endLines = [
  "  merged custom-build-tool 1a2b3c4 the tool",
  "  agent resolved the conflict in 005-voice-transcripts",
  "  warning: test failed once and passed when run again; it may be flaky (steps/test-flaky-1.log)",
  "  report: .custom-build/reports/20261111-104849/report.md",
  "  push it: git push origin integration",
];
function finished(): LiveState {
  const done = (id: string, outcome: string) => item(id, "done", { outcome, ms: s(10) });
  return play([
    [begin(), 0],
    [stage("fetch", "start"), 0],
    [stage("fetch", "done", { ms: s(6), summary: "7 upstream commits, 8 patches" }), s(6)],
    [stage("rebase", "start"), s(6)],
    [stage("rebase", "done", { ms: s(112) }), s(118)],
    [stage("merge", "start"), s(118)],
    [done("custom-build-tool", "merged"), 0],
    [done("001-voice-dictation", "replayed"), 0],
    [harness("start", "005-voice-transcripts", { files: ["src/a.ts", "src/b.ts"] }), 0],
    [harness("end", "005-voice-transcripts", { ok: true, usage: { input: 36000, output: 5200 } }), 0],
    [done("005-voice-transcripts", "agent-resolved"), 0],
    [done("fix-jump-to-blocked", "replayed"), 0],
    [done("tals/corgi#128", "merged"), 0],
    [harness("start", "tals/corgi#93"), 0],
    [harness("end", "tals/corgi#93", { ok: true, usage: { input: 50000, output: 6400 } }), 0],
    [done("tals/corgi#93", "agent-resolved"), 0],
    [done("tals/corgi#129", "merged"), 0],
    [done("tals/corgi#151", "replayed"), 0],
    [stage("merge", "done", { ms: s(118) }), s(236)],
    [stage("verify", "start"), s(236)],
    [{ t: "retry", stage: "verify", id: "test", why: "flaky", detail: "test failed once" }, s(300)],
    [{ t: "item", stage: "verify", id: "test", state: "done", outcome: "flaky" }, s(400)],
    [stage("verify", "done", { ms: s(312) }), s(548)],
    [
      {
        t: "end",
        ok: true,
        code: 0,
        headline: "built dist/corgi-custom with 8 patches",
        lines: endLines,
        report: ".custom-build/reports/20261111-104849/report.md",
        activeMs: s(548),
      },
      s(548),
    ],
  ]);
}

test("the finished card leads with the result and keeps every outcome line", () => {
  const lines = card(finished(), { width: 100, color: false });
  expect(lines[0]).toBe("✓ built dist/corgi-custom with 8 patches in 9:08  ▲ 0:43 faster");
  expect(lines.some(l => l.includes("fetch 0:06 · rebase 1:52 · merge 1:58 · verify 5:12"))).toBe(true);
  expect(lines).toContain(" ✦ tokens  97.6k  005-voice-transcripts 41.2k · tals/corgi#93 56.4k");
  for (const line of endLines) expect(lines).toContain(line);
});

test("faster or slower compares the active times of both runs", () => {
  const state = finished(),
    first = (o: { last?: Partial<HistoryRun>; end?: Partial<NonNullable<LiveState["ended"]>> }) =>
      card(
        {
          ...state,
          estimate: { ...state.estimate, last: { ...last, ...o.last } },
          ended: { ...state.ended!, ...o.end },
        },
        { width: 100, color: false },
      )[0];
  expect(first({ last: { activeMs: s(600) } })).toEndWith("in 9:08  ▲ 0:52 faster");
  expect(first({ last: { activeMs: s(500) } })).toEndWith("in 9:08  ▼ 0:48 slower");
  // History's merge items leave out their harness calls, the stage clocks don't:
  // only the active times compare like with like.
  expect(first({ last: { activeMs: s(560), items: { "merge:a": s(200) } } })).toEndWith("in 9:08  ▲ 0:12 faster");
  expect(first({ end: { activeMs: s(550) }, last: { activeMs: s(560) } })).toEndWith("in 9:10  ▲ 0:10 faster");
});

test("no comparison without both active times or after a failure", () => {
  const state = finished(),
    first = (o: { last?: Partial<HistoryRun>; end?: Partial<NonNullable<LiveState["ended"]>> }) =>
      card(
        {
          ...state,
          estimate: { ...state.estimate, last: { ...last, ...o.last } },
          ended: { ...state.ended!, ...o.end },
        },
        { width: 100, color: false },
      )[0];
  // Without its own active time, the card shows the stage times' sum.
  expect(first({ end: { activeMs: undefined } })).toBe("✓ built dist/corgi-custom with 8 patches in 9:08");
  expect(first({ end: { activeMs: 0 } })).toBe("✓ built dist/corgi-custom with 8 patches in 9:08");
  expect(first({ last: { activeMs: 0 } })).toBe("✓ built dist/corgi-custom with 8 patches in 9:08");
  expect(first({ end: { ok: false, code: 1 } })).toBe("✗ built dist/corgi-custom with 8 patches in 9:08");
  expect(
    card(
      { ...state, estimate: { ...state.estimate, last: null }, base: { ...state.base, last: null } },
      {
        width: 100,
        color: false,
      },
    )[0],
  ).toBe("✓ built dist/corgi-custom with 8 patches in 9:08");
});

const stopLines = [
  "  files: src/controller.ts",
  "  report: .custom-build/reports/20261111-104849/report.md",
  "  resolve the conflicts yourself, `git add` the files, then continue",
  "  continue: scripts/custom-build continue",
  "  undo the run: scripts/custom-build rollback",
];
function stopped(): LiveState {
  const what = "the harness could not resolve the conflict in tals/corgi#93 in 3 attempts";
  return play(
    [
      [item("tals/corgi#93", "start"), s(300)],
      [harness("start", "tals/corgi#93", { files: ["src/controller.ts"] }), s(301)],
      [
        harness("end", "tals/corgi#93", {
          ok: false,
          reason: "conflict markers remain in src/controller.ts",
          usage: { input: 30000, output: 4000 },
        }),
        s(320),
      ],
      [harness("start", "tals/corgi#93", { attempt: 2 }), s(321)],
      [
        harness("end", "tals/corgi#93", {
          attempt: 2,
          ok: false,
          reason: "it changed files outside the conflict: src/render.ts",
          usage: { input: 35000, output: 4500 },
        }),
        s(340),
      ],
      [harness("start", "tals/corgi#93", { attempt: 3 }), s(341)],
      [
        harness("end", "tals/corgi#93", {
          attempt: 3,
          ok: false,
          reason: "timed out after 900s",
          usage: { input: 35000, output: 4400 },
        }),
        s(360),
      ],
      [item("tals/corgi#93", "failed", { outcome: "stopped", detail: what }), s(362)],
      [
        {
          t: "end",
          ok: false,
          code: 5,
          headline: `stopped: ${what}`,
          lines: stopLines,
          report: ".custom-build/reports/20261111-104849/report.md",
        },
        s(362),
      ],
    ],
    // Up to the patch before, as in the running sketch.
    play(
      [
        [stage("merge", "start"), 0],
        ...patches.slice(0, 5).flatMap((id): [LiveEvent, number][] => [
          [item(id, "start"), s(100)],
          [item(id, "done", { outcome: "merged" }), s(110)],
        ]),
      ],
      play([
        [begin(), 0],
        [stage("fetch", "done", { ms: s(6) }), 0],
        [stage("rebase", "done", { ms: s(112) }), 0],
      ]),
    ),
  );
}

test("the stop card lists each failed try and the next steps", () => {
  const lines = card(stopped(), { width: 100, color: false });
  expect(lines[0]).toStartWith("✗ stopped after ");
  expect(lines[0]).toContain(" at merge 6/8: the harness could not resolve the conflict");
  expect(lines).toContain(" tals/corgi#93  src/controller.ts · 3 tries · 112.9k tok");
  const tries = lines.filter(l => l.trimStart().startsWith("try "));
  expect(tries.map(l => l.trim())).toEqual([
    "try 1 ✗ conflict markers remain in src/controller.ts",
    "try 2 ✗ it changed files outside the conflict: src/render.ts",
    "try 3 ✗ timed out after 900s",
  ]);
  for (const line of stopLines) expect(lines).toContain(line);
});

test("long outcome lines on a card are wrapped, not cut", () => {
  const long = `  handoff: ${"x".repeat(70)}/handoff.md`,
    state = apply(finished(), { t: "end", ok: true, code: 0, headline: "built", lines: [long], report: null }, 0),
    lines = card(state, { width: 40, color: false });
  expect(lines.join("").replaceAll(" ", "")).toContain(long.replaceAll(" ", ""));
});

test("color adds escape codes but not width", () => {
  for (const state of [running(), running({ estimate: none })])
    for (const verbose of [false, true]) {
      const o = { width: 100, nowMs: now, verbose };
      expect(frame(state, { ...o, color: true }).map(plain)).toEqual(frame(state, { ...o, color: false }));
    }
  for (const state of [finished(), stopped()])
    expect(card(state, { width: 100, color: true }).map(plain)).toEqual(card(state, { width: 100, color: false }));
  const colored = frame(running(), { width: 100, nowMs: now, color: true, verbose: false });
  expect(colored.join("\n")).toContain("\x1b[38;2;");
  expect(colored.join("\n")).toContain("\x1b]8;;https://github.com/tals/corgi/pull/93\x1b\\");
});

test("the spinner turns every 80 ms", () => {
  expect(spinner(0)).toBe(spinner(79));
  expect(spinner(80)).not.toBe(spinner(0));
  expect(spinner(800)).toBe(spinner(0));
  expect(term.width(spinner(-5))).toBe(1);
  expect(term.width(spinner(Number.NaN))).toBe(1);
});

test("gradient and rgb color each grapheme and leave the text", () => {
  expect(term.rgb("ab", "#7dcfff", false)).toBe("ab");
  expect(term.rgb("ab", "#7dcfff", true)).toBe("\x1b[38;2;125;207;255mab\x1b[0m");
  const g = term.gradient("abc", "#000000", "#ffffff", true);
  expect(plain(g)).toBe("abc");
  expect(g).toContain("\x1b[38;2;0;0;0ma");
  expect(g).toContain("\x1b[38;2;255;255;255mc");
  expect(term.paint("x", "cyan", true)).toBe("\x1b[36mx\x1b[0m");
});

test("the header's title is the same gradient list and status use", () => {
  const lines = frame(running(), { width: 100, nowMs: now, color: true, verbose: false });
  expect(lines.some(l => l.includes(`${term.title(true)}\x1b[1m rebuild`))).toBe(true);
  expect(term.title(true).startsWith("\x1b[38;2;125;207;255mc")).toBe(true);
  expect(term.title(true)).toContain("\x1b[38;2;187;154;247md\x1b[0m");
  expect(term.title(false)).toBe("custom-build");
});

const many = [...patches, "extra-1", "extra-2", "extra-3", "extra-4"];
/** A rebuild of 12 patches, merging the one at `at` with a harness call on its second try, a retry behind it. */
function crowded(at: number): LiveState {
  const id = many[at];
  return play([
    [begin({ items: { merge: many, verify: steps } }), 0],
    [stage("fetch", "start"), 0],
    [stage("fetch", "done", { summary: "7 upstream commits, 12 patches" }), s(6)],
    [stage("rebase", "start"), s(6)],
    [stage("rebase", "done", { summary: "2 rebased" }), s(20)],
    [stage("merge", "start"), s(20)],
    ...many.slice(0, at).flatMap((done, i): [LiveEvent, number][] => [
      [item(done, "start"), s(20 + i * 5)],
      [item(done, "done", { outcome: "merged" }), s(25 + i * 5)],
    ]),
    [item(id, "start"), s(100)],
    [harness("start", id, { files: ["src/a.ts"] }), s(101)],
    [harness("end", id, { ok: false, reason: "conflict markers remain", usage: { input: 1000, output: 100 } }), s(120)],
    [{ t: "retry", stage: "merge", id, why: "harness", detail: "conflict markers remain" }, s(120)],
    [harness("start", id, { attempt: 2, files: ["src/a.ts"] }), s(121)],
    [{ t: "harness", state: "activity", stage: "merge", id, attempt: 2, limit: 3, text: "claude: reading" }, s(130)],
  ]);
}

test("a frame taller than its rows keeps header, timeline, footer and the running item", () => {
  // 24 rows: inline draws 23, a pinned --verbose view 19.
  for (const [rows, verbose] of [
    [23, false],
    [19, true],
  ] as const)
    for (const at of [0, 5, 11]) {
      const lines = frame(crowded(at), { width: 100, nowMs: s(140), color: false, verbose, rows }),
        where = `${rows} rows, item ${at}`;
      expect([where, lines.length <= rows]).toEqual([where, true]);
      expect(lines[0]).toStartWith("custom-build rebuild");
      expect(lines.some(l => l.startsWith(" now "))).toBe(true);
      expect(lines.some(l => l.startsWith(" last "))).toBe(true);
      expect(lines.some(l => l.trimStart().startsWith("fetch"))).toBe(true);
      expect(lines.some(l => l.includes(`${many[at]}`) && l.includes("✦ claude resolving src/a.ts · try 2/3"))).toBe(
        true,
      );
      expect(lines.some(l => l.startsWith(" ✦ harness  2 calls · 1 running"))).toBe(true);
      expect(lines.some(l => l.startsWith(" ↻ retries  1"))).toBe(true);
      if (at > 0) expect(lines.some(l => /^ {5}✓ \d+ done$/.test(l))).toBe(true);
      if (at < 11) expect(lines.some(l => /^ {5}· \d+ pending$/.test(l))).toBe(true);
      // Folded or shown, every patch is counted once.
      const shown = many.filter(p => lines.some(l => l.includes(` ${p} `) || l.endsWith(` ${p}`))).length,
        folded = lines
          .map(l => /^ {5}[✓·] (\d+) (?:done|pending)$/.exec(l))
          .reduce((n, m) => n + Number(m?.[1] ?? 0), 0);
      expect([where, shown + folded]).toEqual([where, many.length]);
    }
});

test("a frame that fits its rows is drawn whole", () => {
  const state = running(),
    o = { width: 100, nowMs: now, color: false, verbose: false };
  expect(frame(state, { ...o, rows: 40 })).toEqual(frame(state, o));
});

test("the card's report link is a file URL, spaces and all", () => {
  const state = apply(
      finished(),
      { t: "end", ok: true, code: 0, headline: "built", lines: [], report: "/tmp/my builds/report.md" },
      0,
    ),
    lines = card(state, { width: 100, color: true });
  expect(lines.join("\n")).toContain("\x1b]8;;file:///tmp/my%20builds/report.md\x1b\\");
});

const longDetail =
  "checked out in /Users/someone/Development/context-engineering/corgi/.claude/worktrees/004-workspace-section-tint";
/** A merge with a long detail on its first patch and the second running. */
function wordy(): LiveState {
  return play([
    [begin(), 0],
    [stage("fetch", "start"), 0],
    [stage("fetch", "done", { summary: "7 upstream commits, 8 patches" }), s(6)],
    [stage("merge", "start"), s(6)],
    [item(patches[0], "start"), s(6)],
    [item(patches[0], "done", { outcome: "left-alone", detail: longDetail }), s(7)],
    [item(patches[1], "start"), s(7)],
    [{ t: "log", text: `(pass) ${"a long test name ".repeat(8)}[1166.59ms]\n` }, s(8)],
  ]);
}

test("a long item text wraps under itself instead of being cut", () => {
  for (const width of [80, 100, 160]) {
    const lines = frame(wordy(), { width, nowMs: s(20), color: false, verbose: false }),
      at = lines.findIndex(l => l.includes("left alone:")),
      col = lines[at].indexOf("left alone:"),
      text = [
        lines[at].slice(col),
        ...lines
          .slice(at + 1)
          .filter(l => /^ +\S/.test(l) && l.search(/\S/) === col)
          .map(l => l.trim()),
      ]
        .join(" ")
        .replace(/\/ /g, "/");
    expect([width, text]).toEqual([width, `left alone: ${longDetail}`]);
    // Paths break after a slash, never inside a name.
    expect(lines.some(l => /\w\/$/.test(l) || l.endsWith(" in"))).toBe(width < 120);
  }
});

test("a pending stage's list wraps between its parts", () => {
  for (const width of [72, 100, 160]) {
    const lines = frame(running(), { width, nowMs: now, color: false, verbose: false }),
      at = lines.findIndex(l => l.startsWith(" · verify")),
      list = lines[at].replace(/\s+~\d+:\d+$/, "").replace(/^ · verify\s+/, "");
    expect(list).toBe(steps.join(" · "));
    // Where the text fits its wrap limits, nothing is cut.
    const head = frame(wordy(), { width, nowMs: s(20), color: false, verbose: false });
    if (width >= 100) expect([width, head.filter(l => l.includes("…"))]).toEqual([width, []]);
  }
  // Too many for three lines: the last says how many are left.
  const narrow = frame(play([[begin({ items: { merge: many, verify: steps } }), 0]]), {
    width: 50,
    nowMs: 0,
    color: false,
    verbose: false,
  });
  const merge = narrow.findIndex(l => l.startsWith(" · merge")),
    shown = narrow.slice(merge, merge + 3).join(" "),
    more = /\+(\d+) more/.exec(shown);
  expect(more).not.toBeNull();
  expect(many.filter(p => shown.includes(p)).length + Number(more![1])).toBe(many.length);
  expect(narrow[merge + 3].startsWith(" · verify")).toBe(true);
});

test("the timeline names every stage whole", () => {
  for (const width of [40, 60, 100, 160, 200]) {
    const legend = timeline(
      running({ stages: ["fetch", "rebase", "merge", "verify", "after-build"] }),
      width,
      false,
    ).legend;
    for (const name of ["fetch", "rebase", "merge", "verify", "after-build"])
      expect([width, legend.split(/\s+/).includes(name)]).toEqual([width, true]);
    expect(term.width(legend)).toBeLessThanOrEqual(width);
  }
});

test("wrapped items still fit the frame's rows", () => {
  for (const rows of [14, 16, 19, 23])
    for (const width of [50, 80]) {
      const lines = frame(wordy(), { width, nowMs: s(20), color: false, verbose: false, rows });
      expect([rows, width, lines.length <= rows]).toEqual([rows, width, true]);
      expect(lines.some(l => l.includes(patches[1]))).toBe(true);
      expect(lines.some(l => l.startsWith(" ↻ retries"))).toBe(true);
    }
});

test("a branch that couldn't be rebased is kept, not failed", () => {
  const result = (branch: string, outcome: "rebased" | "failed") => ({
      patch: branch,
      branch,
      from: "1234567890",
      to: outcome === "rebased" ? "abcdef0123" : null,
      lease: "",
      outcome,
      ...(outcome === "failed" ? { reason: "test fails on the rebased branch" } : {}),
    }),
    results = [result("a", "rebased"), result("b", "failed"), result("c", "failed")];
  expect(rebaseSummary(results)).toBe("1 rebased · 2 kept as they were");
  expect(rebaseSummary(results.slice(0, 2))).toBe("1 rebased · 1 kept as it was");
  const state = play([
      [begin({ stages: ["fetch", "rebase", "merge"], items: { rebase: ["a", "b"], merge: patches } }), 0],
      [stage("fetch", "start"), 0],
      [stage("fetch", "done"), s(1)],
      [stage("rebase", "start"), s(1)],
      [{ t: "item", stage: "rebase", id: "a", state: "start" }, s(1)],
      [rebaseItem(results[0]), s(2)],
      [{ t: "item", stage: "rebase", id: "b", state: "start" }, s(2)],
      [rebaseItem(results[1]), s(3)],
    ]),
    lines = frame(state, { width: 120, nowMs: s(4), color: false, verbose: false });
  expect(lines.some(l => l.includes(" b ") && l.includes("not rebased, kept as it was: test fails"))).toBe(true);
  // Nothing failed: the stage keeps running, not red.
  expect(lines.some(l => l.includes("✗"))).toBe(false);
});

test("an outcome card lines up its labels and wraps under them", () => {
  const lines = outcomeCard(
    {
      ok: false,
      headline: "a run is stopped or in progress",
      lines: ["  stopped: while verifying (typecheck)", "  report: /tmp/my builds/r", "  a line without a label"],
    },
    { width: 60, color: false, command: "rebuild" },
  );
  expect(lines).toEqual([
    "✗ custom-build rebuild: a run is stopped or in progress",
    "   stopped  while verifying (typecheck)",
    "   report   /tmp/my builds/r",
    "   a line without a label",
  ]);
  expect(
    outcomeCard({ ok: true, headline: "rolled back", lines: [] }, { width: 60, color: false, tookMs: s(3) }),
  ).toEqual(["✓ rolled back in 0:03"]);
  const linked = outcomeCard(
    { ok: true, headline: "x", lines: ["  report: /tmp/my builds/r"] },
    { width: 60, color: true },
  ).join("\n");
  expect(linked).toContain("\x1b]8;;file:///tmp/my%20builds/r\x1b\\");
  for (const width of [1, 10, 30, 60])
    for (const line of outcomeCard(
      { ok: false, headline: "a long headline ".repeat(5), lines: [`  report: /${"dir/".repeat(20)}`] },
      { width, color: true, command: "rollback" },
    ))
      expect(term.width(line)).toBeLessThanOrEqual(width);
});

test("a task frame shows each task with its mark, what it did and its time", () => {
  const tasks: TaskLine[] = [
    { id: "undo", state: "done", detail: "integration back at 3b35a04", startedMs: 0, ms: 100 },
    { id: "binary", state: "skipped", detail: "no saved binary", startedMs: 100, ms: 0 },
    { id: "install", state: "running", detail: "restoring dependencies", startedMs: 100, ms: null },
  ];
  const lines = taskFrame(
    { command: "rollback", branch: "integration", tasks },
    { width: 80, nowMs: s(2), color: false },
  );
  expect(lines[0]).toBe("custom-build rollback · integration");
  expect(lines[1]).toMatch(/^ ✓ undo {6}integration back at 3b35a04 +0:00$/);
  expect(lines[2]).toMatch(/^ ↷ binary {4}no saved binary +0:00$/);
  expect(lines[3]).toMatch(new RegExp(`^ ${spinner(s(2))} install {3}restoring dependencies +0:01$`));
  for (const width of [1, 10, 40])
    for (const line of taskFrame({ command: "rollback", tasks }, { width, nowMs: 0, color: true }))
      expect(term.width(line)).toBeLessThanOrEqual(width);
});

/** A `rebase` run: two branches rebased, one that couldn't be, one left alone. */
function rebaseRun(o: { failed?: boolean; leftAlone?: boolean } = {}): LiveState {
  const branch = (id: string, outcome: string, state: "done" | "skipped" = "done") =>
    ({ t: "item", stage: "rebase", id, state, outcome, ms: s(30) }) as LiveEvent;
  return play([
    [begin({ command: "rebase", stages: ["fetch", "rebase"], items: {} }), 0],
    [stage("fetch", "start"), 0],
    [stage("fetch", "done", { ms: s(5) }), s(5)],
    [stage("rebase", "start"), s(5)],
    [branch("fix-jump-to-blocked", "rebased"), 0],
    [{ t: "retry", stage: "rebase", id: "fix-jump-to-blocked", why: "flaky", detail: "test failed once" }, s(30)],
    [branch("sidebar-teammates", "rebased"), 0],
    ...(o.failed ? [[branch("001-voice-dictation", "not-rebased", "skipped"), 0] as [LiveEvent, number]] : []),
    ...(o.leftAlone ? [[branch("tals/corgi#93", "left-alone", "skipped"), 0] as [LiveEvent, number]] : []),
    [stage("rebase", "done", { ms: s(120) }), s(125)],
    [
      { t: "end", ok: true, code: 0, headline: "rebased own branches onto upstream c29ecae", lines: [], report: null },
      s(125),
    ],
  ]);
}

test("a rebase that left branches undone ends amber, with what happened to each branch", () => {
  const lines = card(rebaseRun({ failed: true, leftAlone: true }), { width: 100, color: false });
  expect(lines[0]).toStartWith("◐ rebased own branches onto upstream c29ecae, with problems in 2:05");
  expect(lines).toContain(" branches  ■■ 2 rebased  ■ 1 not rebased  ■ 1 left alone");
  // A retry names the branch it was for.
  expect(lines).toContain(" ↻ retried fix-jump-to-blocked: test failed once, passed on retry: may be flaky");
  expect(card(rebaseRun(), { width: 100, color: false })[0]).toStartWith(
    "✓ rebased own branches onto upstream c29ecae in",
  );
  // A branch left alone is a problem only when rebasing was the whole run:
  // a rebase kind, even one that finished through `continue`.
  expect(problems(rebaseRun({ leftAlone: true }))).toBe(true);
  expect(problems({ ...rebaseRun({ leftAlone: true }), command: "continue" as const })).toBe(true);
  const rebuild = { ...rebaseRun({ leftAlone: true }), command: "rebuild" as const, rebaseRun: false };
  expect(problems(rebuild)).toBe(false);
  expect(problems({ ...rebuild, ...rebaseRun({ failed: true }), command: "rebuild" as const, rebaseRun: false })).toBe(
    true,
  );
});

test("a finished run's card with a brief lists what needs a look and points at the report", () => {
  const detail = (id: string, outcome: string, text: string) =>
    ({ t: "item", stage: "rebase", id, state: "skipped", outcome, detail: text, ms: s(30) }) as LiveEvent;
  const state = play([
    [begin({ command: "rebase", stages: ["fetch", "rebase"], items: {} }), 0],
    [stage("rebase", "start"), 0],
    [{ t: "item", stage: "rebase", id: "sidebar-teammates", state: "done", outcome: "rebased", ms: s(30) }, 0],
    [detail("001-voice-dictation", "not-rebased", "test fails on the rebased branch: 2 tests fail"), 0],
    [detail("tals/corgi#93", "left-alone", "checked out in /w/004"), 0],
    [stage("rebase", "done", { ms: s(60) }), s(60)],
    [
      {
        t: "end",
        ok: true,
        code: 0,
        headline: "rebased own branches onto upstream c29ecae",
        lines: ["  rebased sidebar-teammates: 4e220cd to 4e14fa0 (clean); pushed", "  handoff: /r/handoffs/001.md"],
        brief: ["  review sidebar-teammates: the harness fixed its checks in abc1234"],
        handoffs: 2,
        report: "/r/report.md",
      },
      s(60),
    ],
  ]);
  const lines = card(state, { width: 100, color: false });
  expect(lines).toContain(" ✗ 001-voice-dictation  test fails on the rebased branch: 2 tests fail");
  expect(lines).toContain(" – tals/corgi#93        checked out in /w/004");
  expect(lines).toContain("  review sidebar-teammates: the harness fixed its checks in abc1234");
  expect(lines.at(-1)).toBe(" report    /r/report.md  · 2 handoffs");
  // The full lines are for plain output and the report.
  expect(lines.some(l => l.includes("4e220cd to 4e14fa0"))).toBe(false);
  expect(lines.some(l => l.includes("/r/handoffs/001.md"))).toBe(false);
});

test("a frame with very few rows keeps the footer: the fold lines give way first", () => {
  for (const [rows, verbose] of [
    [15, true],
    [13, true],
    [12, false],
    [11, false],
  ] as const) {
    const lines = frame(crowded(5), { width: 80, nowMs: s(140), color: false, verbose, rows }),
      where = `${rows} rows, verbose ${verbose}, ${lines.length} lines`;
    expect([where, lines.length <= rows]).toEqual([where, true]);
    expect(lines.some(l => l.startsWith(" ✦ harness"))).toBe(true);
    expect(lines.some(l => l.startsWith(" ↻ retries"))).toBe(true);
  }
});
