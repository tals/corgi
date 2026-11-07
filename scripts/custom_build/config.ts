import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Snapshot } from "./git";
import { urlProblem, type PatchSource } from "./sources";

/** What the binary is stamped with (src/custom_build.ts); kept here so the tool
 * runs from its copy under the config directory. */
export type BuildPatch = { source: string; commit: string; description: string };
export type Patch = { source: PatchSource; description: string; added: string };
export type RetiredPatch = Patch & { retired: string; reason: string };
export type Harness = { command: string[]; timeoutSeconds?: number; attempts?: number };
export const stepNames = ["install", "typecheck", "test", "build"] as const;
export type StepName = (typeof stepNames)[number];
export type Config = {
  version: 1;
  upstream: { repo: string; remote?: string; branch: string };
  branch: string;
  patches: Patch[];
  retired: RetiredPatch[];
  harness?: Harness;
  afterBuild?: string[];
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
    config.harness = {
      command: h.command,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(attempts !== undefined ? { attempts: Math.floor(attempts) } : {}),
    };
  }
  if (raw.afterBuild !== undefined) {
    if (!strings(raw.afterBuild) || raw.afterBuild.length === 0)
      throw Error(`${path}: afterBuild must be a non-empty array of strings`);
    config.afterBuild = raw.afterBuild;
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
export type RunState = {
  startedAt: string;
  startTip: string | null;
  startBinary: string | null;
  /** HEAD of the checkout before the run, for the install step and a first-run rollback. */
  startHead: string;
  startBranch: string | null;
  upstream: string;
  reportDir: string;
  phase: "merge" | "verify" | "report" | "rollback";
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
