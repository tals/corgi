import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Snapshot } from "./git";
import type { Usage } from "./harness_stream";
import type { Timing } from "./timings";
import { urlProblem, type PatchSource } from "./sources";

/** A patch merged into the build, as the report and the harness prompts name it. */
export type BuildPatch = { source: string; commit: string; description: string };
export type Patch = { source: PatchSource; description: string; added: string };
export type RetiredPatch = Patch & { retired: string; reason: string };
export const harnessKinds = ["claude", "codex"] as const;
/** Which agent CLI the harness runs, so its streamed output can be read. */
export type HarnessKind = (typeof harnessKinds)[number];
export type Harness = { command: string[]; timeoutSeconds?: number; attempts?: number; kind?: HarnessKind };
export const stepNames = ["install", "typecheck", "test", "build"] as const;
export type StepName = (typeof stepNames)[number];
export const rebaseModes = ["all", "conflicting", "off"] as const;
/** Which own patch branches get rebased onto upstream: those behind it, those that conflict, or none. */
export type RebaseMode = (typeof rebaseModes)[number];
export type Config = {
  version: 1;
  upstream: { repo: string; remote?: string; branch: string };
  branch: string;
  patches: Patch[];
  retired: RetiredPatch[];
  harness?: Harness;
  afterBuild?: string[];
  /** Default `all`. */
  rebase?: RebaseMode;
  /** Undocumented: replaces the verification commands, for tests. */
  steps?: Partial<Record<StepName, string[]>>;
};

/** `--dir` > `CORGI_CUSTOM_BUILD_DIR` > `<repo>/.custom-build`, relative paths from `cwd`. */
export function resolveDir(o: {
  dir?: string | null;
  env: Record<string, string | undefined>;
  repoRoot: string;
  cwd?: string;
}): string {
  const cwd = o.cwd ?? process.cwd();
  if (o.dir) return resolve(cwd, o.dir);
  if (o.env.CORGI_CUSTOM_BUILD_DIR) return resolve(cwd, o.env.CORGI_CUSTOM_BUILD_DIR);
  return join(o.repoRoot, ".custom-build");
}

export function defaults(): Config {
  return {
    version: 1,
    upstream: { repo: "tals/corgi", branch: "main" },
    branch: "custom-build",
    patches: [],
    retired: [],
  };
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === "string");

function source(value: unknown, where: string): PatchSource {
  const s = (value ?? {}) as Record<string, unknown>,
    text = (v: unknown) => typeof v === "string" && v.length > 0;
  switch (s.kind) {
    case "branch":
      if (text(s.name)) return { kind: "branch", name: s.name as string };
      break;
    case "pr":
      if (text(s.repo) && Number.isInteger(s.number) && (s.number as number) > 0)
        return { kind: "pr", repo: s.repo as string, number: s.number as number };
      break;
    case "fork-branch":
      if (text(s.url) && urlProblem(s.url as string)) throw Error(`${where}: ${urlProblem(s.url as string)}`);
      if (text(s.branch) && (text(s.repo) || text(s.url)))
        return {
          kind: "fork-branch",
          ...(text(s.repo) ? { repo: s.repo as string } : { url: s.url as string }),
          branch: s.branch as string,
        };
      break;
  }
  throw Error(`${where}: invalid source`);
}

function patch(value: unknown, where: string): Patch {
  const p = (value ?? {}) as Record<string, unknown>;
  if (typeof p.description !== "string" || /[\r\n]/.test(p.description))
    throw Error(`${where}: description must be a single line`);
  return { source: source(p.source, where), description: p.description, added: String(p.added ?? "") };
}

/** The config in `dir`, or the defaults when there is none yet. */
export function load(dir: string): Config {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return defaults();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw Error(`${path}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw Error(`${path}: expected an object`);
  if (typeof raw.version === "number" && raw.version > 1)
    throw Error(`${path}: version ${raw.version} is newer than this tool understands (1)`);
  const base = defaults(),
    upstream = (raw.upstream ?? {}) as Record<string, unknown>,
    config: Config = {
      version: 1,
      upstream: {
        repo: typeof upstream.repo === "string" && upstream.repo ? upstream.repo : base.upstream.repo,
        ...(typeof upstream.remote === "string" && upstream.remote ? { remote: upstream.remote } : {}),
        branch: typeof upstream.branch === "string" && upstream.branch ? upstream.branch : base.upstream.branch,
      },
      branch: typeof raw.branch === "string" && raw.branch ? raw.branch : base.branch,
      patches: Array.isArray(raw.patches) ? raw.patches.map((p, i) => patch(p, `${path}: patches[${i}]`)) : [],
      retired: Array.isArray(raw.retired)
        ? raw.retired.map((p, i) => {
            const r = p as Record<string, unknown>;
            return {
              ...patch(p, `${path}: retired[${i}]`),
              retired: String(r.retired ?? ""),
              reason: String(r.reason ?? ""),
            };
          })
        : [],
    };
  if (raw.harness !== undefined) {
    const h = raw.harness as Record<string, unknown>;
    if (!h || !strings(h.command) || h.command.length === 0)
      throw Error(`${path}: harness.command must be a non-empty array of strings`);
    const positive = (v: unknown, name: string) => {
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !(v > 0)) throw Error(`${path}: harness.${name} must be a positive number`);
      return v;
    };
    const timeoutSeconds = positive(h.timeoutSeconds, "timeoutSeconds"),
      attempts = positive(h.attempts, "attempts");
    if (h.kind !== undefined && !harnessKinds.includes(h.kind as HarnessKind))
      throw Error(`${path}: harness.kind must be one of ${harnessKinds.join(", ")}`);
    config.harness = {
      command: h.command,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(attempts !== undefined ? { attempts: Math.floor(attempts) } : {}),
      ...(h.kind !== undefined ? { kind: h.kind as HarnessKind } : {}),
    };
  }
  if (raw.afterBuild !== undefined) {
    if (!strings(raw.afterBuild) || raw.afterBuild.length === 0)
      throw Error(`${path}: afterBuild must be a non-empty array of strings`);
    config.afterBuild = raw.afterBuild;
  }
  if (raw.rebase !== undefined) {
    if (!rebaseModes.includes(raw.rebase as RebaseMode))
      throw Error(`${path}: rebase must be one of ${rebaseModes.join(", ")}`);
    config.rebase = raw.rebase as RebaseMode;
  }
  if (raw.steps !== undefined) {
    const steps = raw.steps as Record<string, unknown>;
    config.steps = {};
    for (const [name, command] of Object.entries(steps ?? {})) {
      if (!stepNames.includes(name as StepName) || !strings(command) || command.length === 0)
        throw Error(`${path}: steps.${name} must be a known step with a non-empty command`);
      config.steps[name as StepName] = command;
    }
  }
  return config;
}

function writeJSON(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, path);
}

export function save(dir: string, config: Config): void {
  mkdirSync(dir, { recursive: true });
  writeJSON(join(dir, "config.json"), config);
}

export type Event = { kind: string; patch?: string; step?: StepName; detail?: string };
/** A patch as the run fetched it: what to merge and how it was resolved. */
export type Planned = {
  display: string;
  description: string;
  /** The commit to merge, or null for a patch skipped before merging. */
  commit: string | null;
  ref: string;
  prLink: string | null;
  skip: "skipped-merged" | null;
  /** Its merge commit on the custom branch, once merged. */
  merge?: string | null;
};
/** A merge that conflicted, and who resolved it. */
export type Conflict = { patch: string; files: string[]; by: "user" | "harness" | "rerere" | null };
/** A fix commit on top of the merges; `log` keeps the failing output it answered. */
export type Fix = {
  step: StepName;
  commit: string;
  by: "agent" | "user";
  files: string[];
  log?: string;
  /** Which patches an agent fix answered, worked out once for the report. */
  attribution?: { kind: "build-drift" | "build-clash"; patch: string; others: string[] }[];
};
export type HarnessCall = {
  kind: "conflict" | "build";
  /** The conflicting patch, for a conflict call. */
  patch?: string;
  /** The failing step, for a build call. */
  step?: StepName;
  attempt: number;
  head: string;
  snapshot: Snapshot;
  /** The conflicted files the harness was given. */
  files?: string[];
  /** The failing output a build fix answers, for attribution. */
  log?: string;
};
/** One finished harness call, for the report and the live view: what it was
 * asked, whether its result was accepted, how long it took and its tokens
 * (null when the harness has no kind or its output named none). */
export type HarnessUse = {
  call: number;
  kind: "conflict" | "build" | "rebase-conflict";
  /** The conflicting patch, for a conflict call. */
  patch?: string;
  /** The failing step, for a build call. */
  step?: StepName;
  /** The branch being rebased, for a rebase conflict call. */
  branch?: string;
  attempt: number;
  ok: boolean;
  reason?: string;
  seconds: number;
  usage: Usage | null;
};
/** What happened to one own patch branch in a rebase phase or run. */
export type RebaseResult = {
  patch: string;
  branch: string;
  /** The tip the rebase started from, and the one it moved the branch to. */
  from: string;
  to: string | null;
  /** The pushed copy's tip when it was fetched; "" when the branch was never pushed. */
  lease: string;
  outcome: "rebased" | "current" | "skipped" | "failed";
  how?: "clean" | "rerere" | "harness" | "user";
  reason?: string;
  /** For a failed check: the step and its log. */
  step?: StepName;
  log?: string;
  /** Checks that passed only when run again, with the first failure's log. */
  flaky?: { step: StepName; log: string }[];
  /** Rebased by an earlier run and not pushed yet: `to` is its tip. */
  pending?: boolean;
  /** Skipped because it is checked out there; `rebasableThere` when `--in-worktree` would rebase it. */
  worktree?: string;
  rebasableThere?: boolean;
  /** Skipped because the local branch and origin's copy have diverged. */
  diverged?: boolean;
  /** The local branch didn't exist before; undoing deletes it. */
  created?: boolean;
  push?: "pushed" | "refused" | null;
  /** Where git's output of a refused push is kept. */
  pushDetail?: string;
};
/** A branch the rebase phase will rebase. */
export type RebaseTarget = {
  patch: string;
  branch: string;
  from: string;
  lease: string;
  /** The local branch's tip when chosen (null: none yet); it moves only from there. */
  local: string | null;
  /** Whether it conflicts with upstream, besides being behind. */
  conflicts: boolean;
  /** The branch's own worktree it is checked out in: with `--in-worktree`, the
   * rebase runs there, moving the checkout and the branch together. */
  worktree?: string;
  /** Rebased by an earlier run and not pushed yet: its backup stays until it is rebased again. */
  pending?: boolean;
};
/** Where a `rebase` run stopped: the branch, its worktree and the commit being replayed. */
export type RebaseStop = {
  target: RebaseTarget;
  worktree: string;
  commit: string;
  files: string[];
  /** Why the rebase can't go on, beyond the conflicted files. */
  problem?: string;
};
export type RunState = {
  /** Absent means `rebuild`. */
  kind?: "rebuild" | "rebase";
  startedAt: string;
  startTip: string | null;
  startBinary: string | null;
  /** HEAD of the checkout before the run, for the install step and a first-run rollback. */
  startHead: string;
  startBranch: string | null;
  upstream: string;
  reportDir: string;
  phase: "rebase" | "merge" | "verify" | "report" | "rollback";
  cursor: number;
  step: StepName | null;
  attempts: number;
  /** Harness calls made, numbering the prompt files. */
  calls: number;
  plan: Planned[];
  merged: BuildPatch[];
  events: Event[];
  conflicts: Conflict[];
  fixes: Fix[];
  /** Set while stopped: the exit code and the working tree at the stop, so
   * `continue` commits only what changed since. */
  stopped: { code: number; snapshot: Snapshot } | null;
  push: boolean;
  /** Set while a harness call runs: what it was asked and the tree before it,
   * so `continue` after an interruption checks what it left like a finished result. */
  harnessCall?: HarnessCall | null;
  /** Every harness call made so far, in order. */
  harnessUsage?: HarnessUse[];
  /** The run's timings so far; absent in a run state from an older tool. */
  timing?: Timing;
  /** Own patch branches handled by the rebase phase or run. */
  rebased?: RebaseResult[];
  /** `rebase` runs: the branches to rebase, the next one, and where it stopped. */
  rebaseTargets?: RebaseTarget[];
  rebaseCursor?: number;
  rebaseStop?: RebaseStop | null;
};

export const runPath = (dir: string) => join(dir, "run.json");
export function loadRun(dir: string): RunState | null {
  const path = runPath(dir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RunState;
}
export function saveRun(dir: string, run: RunState): void {
  mkdirSync(dir, { recursive: true });
  writeJSON(runPath(dir), run);
}
export function clearRun(dir: string): void {
  rmSync(runPath(dir), { force: true });
}
