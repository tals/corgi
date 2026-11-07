import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, lstatSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunState, StepName } from "./config";
import { stepNames } from "./config";
import * as harness from "./harness";
import * as sources from "./sources";

export type Rebase = { display: string; clean: boolean | null; files: string[] };
export type Handoff = {
  kind: "rebase" | "build-drift" | "build-clash";
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
    text = [
      `# Custom build report, ${run.startedAt}`,
      "",
      r.outcome.code === 0
        ? `Result: built dist/corgi-custom with ${run.merged.length} ${run.merged.length === 1 ? "patch" : "patches"}.`
        : `Result: stopped (exit ${r.outcome.code}): ${r.outcome.reason.join("; ")}`,
      "",
      ...section("Upstream", [
        `Reset to ${short(r.upstream)}${run.startTip ? `; ${r.pulled.length} new upstream commits since the last build` : ""}.`,
        ...r.pulled.slice(0, 20).map(c => `- ${short(c.sha)} ${c.subject}`),
        ...(r.pulled.length > 20 ? [`- and ${r.pulled.length - 20} more`] : []),
      ]),
      ...section("Merged patches", merged),
      ...section("Skipped", [
        ...of("skipped-merged").map(e => `- ${e.patch}: merged upstream; remove it from the list`),
        ...of("already-contained").map(e => `- ${e.patch}: already contained in the branch`),
      ]),
      ...section("Warnings and notes", [
        ...of("closed-warning").map(e => `- ${e.patch}: ${e.detail}`),
        ...of("note").map(e => `- ${e.patch}: ${e.detail}`),
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

/** Deletes all but the `keep` newest run directories. */
export function prune(reportsDir: string, keep = 10): void {
  const runs = readdirSync(reportsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  for (const name of runs.slice(0, Math.max(0, runs.length - keep)))
    rmSync(join(reportsDir, name), { recursive: true, force: true });
}
/** Sorts `20261104-100000-2` after `20261104-100000`. */
function order(name: string): number {
  const [day, time, n] = name.split("-");
  return Number(day) * 1e8 + Number(time) * 100 + Number(n ?? 1);
}
