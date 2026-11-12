import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, lstatSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HarnessUse, RunState, StepName } from "./config";
import { stepNames } from "./config";
import * as harness from "./harness";
import type { Usage } from "./harness_stream";
import * as rebaseLines from "./rebase";
import * as sources from "./sources";

export type Rebase = { display: string; clean: boolean | null; files: string[] };
export type Handoff = {
  kind: "rebase" | "rebase-checks" | "build-drift" | "build-clash";
  patch: string;
  description: string;
  link: string;
  upstream: string;
  problem: string;
  cause: string;
  fix: string;
  checkout: string;
  task: string;
};
export type Results = {
  /** The exit code (0 for success) and, for a stop, why. */
  outcome: { code: number; reason: string[] };
  upstream: string;
  /** Upstream commits new since the custom branch the run started from. */
  pulled: { sha: string; subject: string }[];
  rebase: Rebase[];
  handoffs: string[];
};

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "none");
const section = (title: string, lines: string[], empty = "none") => [
  `## ${title}`,
  "",
  ...(lines.length ? lines : [empty]),
  "",
];

/** Clash notes: conflicts during the run on patches that are clean against upstream alone. */
export function clashes(run: RunState, rebase: Rebase[]): string[] {
  return run.conflicts
    .filter(c => rebase.find(r => r.display === c.patch)?.clean === true)
    .map(
      c =>
        `- ${c.patch} conflicted with patches merged before it in ${c.files.join(", ") || "some files"}` +
        ` (resolved by ${c.by ?? "nobody yet"}); it merges cleanly onto upstream alone`,
    );
}

/** A token count: `51.0k` from 1000 on, the plain number below. */
export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
const inOut = (u: Usage) => `${tokens(u.input)} in / ${tokens(u.output)} out`;
const kindWord: Record<HarnessUse["kind"], string> = {
  conflict: "conflict",
  build: "fix",
  "rebase-conflict": "rebase conflict",
  "rebase-fix": "rebased-branch fix",
};

/** The harness calls: a totals line, then one line per call. Tokens of calls
 * whose usage is unknown are left out of the total, which says how many those are. */
export function harnessLines(uses: HarnessUse[]): string[] {
  const known = uses.flatMap(u => (u.usage ? [u.usage] : [])),
    unknown = uses.length - known.length,
    total = known.reduce((sum, u) => ({ input: sum.input + u.input, output: sum.output + u.output }), {
      input: 0,
      output: 0,
    }),
    accepted = uses.filter(u => u.ok).length,
    totals = !known.length
      ? "tokens unknown"
      : `tokens ${inOut(total)}${unknown ? ` (${unknown} ${unknown === 1 ? "call" : "calls"} unknown)` : ""}`;
  return [
    `- ${uses.length} ${uses.length === 1 ? "call" : "calls"}, ${accepted} accepted, ${totals}`,
    ...uses.map(u => {
      const what =
        u.kind === "build"
          ? u.step
          : u.kind === "rebase-conflict"
            ? u.branch
            : u.kind === "rebase-fix"
              ? `${u.branch} ${u.step}`
              : u.patch;
      return (
        `- ${what} ${kindWord[u.kind]} try ${u.attempt}: ${u.ok ? "accepted" : `rejected: ${u.reason}`}, ` +
        (u.usage ? inOut(u.usage) : "tokens unknown")
      );
    }),
  ];
}
const harnessSection = (run: RunState) =>
  run.harnessUsage?.length ? section("Harness", harnessLines(run.harnessUsage)) : [];

function stepResults(run: RunState, code: number): string[] {
  return stepNames.map((step: StepName) => {
    const events = run.events.filter(e => e.step === step),
      last = events.at(-1)?.kind;
    if (last === "upstream-broken") return `- ${step}: fails on plain upstream too`;
    if (run.step === step && code !== 0 && run.phase === "verify") return `- ${step}: failed`;
    if (last === "passed") return `- ${step}: passed`;
    if (step === "install" && (run.phase !== "merge" || code === 0)) return `- ${step}: not needed`;
    return `- ${step}: not run`;
  });
}

/** Writes `report.md` into the run's directory and returns its text. */
export function writeReport(run: RunState, r: Results): string {
  const of = (kind: string) => run.events.filter(e => e.kind === kind),
    merged = run.merged.map(p => {
      const how = run.events.find(e => e.patch === p.source && e.kind !== "note" && e.kind !== "closed-warning")?.kind;
      return `- ${p.source} ${short(p.commit)} ${p.description}${how && how !== "merged" ? ` (${how})` : ""}`;
    }),
    rebased = run.rebased
      ? section(
          "Rebased branches",
          rebaseLines.lines(run.rebased, { current: true }).map(line => `- ${line}`),
          "no own branch needed a rebase",
        )
      : [],
    notes = of("rebase-note").map(e => `- ${e.detail}`),
    stopped = `Result: stopped (exit ${r.outcome.code}): ${r.outcome.reason.join("; ")}`;
  if (run.kind === "rebase") {
    const text = [
      `# Custom build rebase report, ${run.startedAt}`,
      "",
      r.outcome.code === 0 ? `Result: rebased own branches onto upstream ${short(r.upstream)}.` : stopped,
      "",
      ...rebased,
      ...harnessSection(run),
      ...section("Notes", notes),
      ...section(
        "Handoffs",
        r.handoffs.map(path => `- ${join("handoffs", basename(path))}`),
      ),
    ].join("\n");
    mkdirSync(run.reportDir, { recursive: true });
    writeFileSync(join(run.reportDir, "report.md"), text);
    return text;
  }
  const text = [
    `# Custom build report, ${run.startedAt}`,
    "",
    r.outcome.code === 0
      ? `Result: built dist/corgi-custom with ${run.merged.length} ${run.merged.length === 1 ? "patch" : "patches"}.`
      : stopped,
    "",
    ...section("Upstream", [
      `Reset to ${short(r.upstream)}${run.startTip ? `; ${r.pulled.length} new upstream commits since the last build` : ""}.`,
      ...r.pulled.slice(0, 20).map(c => `- ${short(c.sha)} ${c.subject}`),
      ...(r.pulled.length > 20 ? [`- and ${r.pulled.length - 20} more`] : []),
    ]),
    ...rebased,
    ...section("Merged patches", merged),
    ...section("Skipped", [
      ...of("skipped-merged").map(e => `- ${e.patch}: merged upstream; remove it from the list`),
      ...of("already-contained").map(e => `- ${e.patch}: already contained in the branch`),
    ]),
    ...section("Warnings and notes", [
      ...of("closed-warning").map(e => `- ${e.patch}: ${e.detail}`),
      ...of("note").map(e => `- ${e.patch}: ${e.detail}`),
      ...notes,
      ...of("flaky").map(
        e =>
          `- ${e.step} failed once and passed when run again; it may be flaky (log: steps/${basename(e.detail ?? "")})`,
      ),
    ]),
    ...section(
      "Agent-resolved merges",
      of("agent-resolved").map(
        e => `- ${e.patch}: ${run.conflicts.findLast(c => c.patch === e.patch)?.files.join(", ")}`,
      ),
    ),
    ...section(
      "Fix commits",
      run.fixes.map(
        f =>
          `- ${short(f.commit)} ${f.step} (${f.by}): ${f.files.join(", ")}` +
          (f.by === "agent" && f.attribution?.length === 0
            ? " (no merged patch touches these files or the files the failure names; no handoff)"
            : ""),
      ),
    ),
    ...harnessSection(run),
    ...section("Verification", stepResults(run, r.outcome.code)),
    ...section(
      "Needs a rebase onto upstream",
      r.rebase.filter(p => p.clean === false).map(p => `- ${p.display}: ${p.files.join(", ")}`),
    ),
    ...section("Clashes between patches", clashes(run, r.rebase)),
    ...section(
      "Handoffs",
      r.handoffs.map(path => `- ${join("handoffs", basename(path))}`),
    ),
    ...section("Rollback", [
      r.outcome.code === 0
        ? "`scripts/custom-build rollback` returns to the previous build (`<branch>-prev`, `dist/corgi-custom.prev`)."
        : "`scripts/custom-build rollback` returns to the branch and binary this run started from.",
    ]),
  ].join("\n");
  mkdirSync(run.reportDir, { recursive: true });
  writeFileSync(join(run.reportDir, "report.md"), text);
  return text;
}

/** Writes a handoff for one patch from the shipped template; returns its path. */
export function writeHandoff(reportDir: string, template: string, h: Handoff): string {
  const dir = join(reportDir, "handoffs");
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${sources.slug(h.patch)}.md`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${sources.slug(h.patch)}-${n}.md`);
  writeFileSync(path, harness.fill(template, h));
  return path;
}

/** Points `reports/latest` at the newest run. */
export function linkLatest(reportsDir: string, runDir: string): void {
  const link = join(reportsDir, "latest");
  try {
    if (lstatSync(link)) unlinkSync(link);
  } catch {}
  symlinkSync(basename(runDir), link, "dir");
}

/** Deletes all but the `keep` newest run directories, and all but the `keep`
 * newest logs of rollbacks made without a stopped run. */
export function prune(reportsDir: string, keep = 10): void {
  const entries = readdirSync(reportsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const prefix of ["", "rollback-"]) {
    const pattern = new RegExp(`^${prefix}\\d{8}-\\d{6}(-\\d+)?$`),
      dirs = entries
        .filter(e => pattern.test(e.name))
        .map(e => e.name)
        .sort((a, b) => order(a.slice(prefix.length)) - order(b.slice(prefix.length)) || a.localeCompare(b));
    for (const name of dirs.slice(0, Math.max(0, dirs.length - keep)))
      rmSync(join(reportsDir, name), { recursive: true, force: true });
  }
}
/** Sorts `20261104-100000-2` after `20261104-100000`. */
function order(name: string): number {
  const [day, time, n] = name.split("-");
  return Number(day) * 1e8 + Number(time) * 100 + Number(n ?? 1);
}
