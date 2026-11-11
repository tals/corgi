import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, StepName } from "./config";
import * as git from "./git";

const defaults: Record<StepName, string[]> = {
  install: ["bun", "install", "--frozen-lockfile"],
  typecheck: ["bun", "typecheck.ts"],
  test: ["bun", "test", "src"],
  build: ["bun", "build.ts", "--outfile", "{outfile}"],
};
export type Vars = { outfile: string };

/** A step's command, from `config.steps` when it overrides it. */
export function command(step: StepName, config: Config, vars: Vars): string[] {
  return (config.steps?.[step] ?? defaults[step]).map(arg => arg.replaceAll("{outfile}", vars.outfile));
}

/** What a step runs: unit tests need the native layer built first, which a
 * fresh worktree lacks and a patch may change. */
export function commands(step: StepName, config: Config, vars: Vars): string[][] {
  const main = command(step, config, vars);
  return step === "test" && !config.steps?.test ? [["bun", "build.ts", "--native-only"], main] : [main];
}

/** Whether `bun install` must run: nothing is installed yet (a fresh clone), or
 * bun.lock or package.json changed since `since`. */
export function installNeeded(repo: string, since: string): boolean {
  return (
    !existsSync(join(repo, "node_modules")) ||
    git.git(repo, ["diff", "--quiet", since, "HEAD", "--", "bun.lock", "package.json"]).code !== 0
  );
}

export type Run = {
  cwd: string;
  log: string;
  env: Record<string, string | undefined>;
  echo?: (chunk: Uint8Array) => void;
};
/** Runs commands in order until one fails, copying their output to the log
 * and `echo`; true when all passed. */
export async function runStep(cmds: string[] | string[][], o: Run): Promise<boolean> {
  const list = (Array.isArray(cmds[0]) ? cmds : [cmds]) as string[][];
  mkdirSync(dirname(o.log), { recursive: true });
  writeFileSync(o.log, "");
  for (const cmd of list) if (!(await runOne(cmd, o))) return false;
  return true;
}
/** Runs a step, and once more when it fails, so a flaky failure isn't taken
 * for a broken step; the first failure's output is kept at `keep`. `flaky`
 * means only the second run passed. */
export async function runWithRetry(
  cmds: string[] | string[][],
  o: Run & { keep: string; onRetry?: () => void },
): Promise<{ ok: boolean; flaky: boolean }> {
  if (await runStep(cmds, o)) return { ok: true, flaky: false };
  copyFileSync(o.log, o.keep);
  o.onRetry?.();
  if (await runStep(cmds, o)) return { ok: true, flaky: true };
  rmSync(o.keep, { force: true });
  return { ok: false, flaky: false };
}
async function runOne(cmd: string[], o: Run): Promise<boolean> {
  appendFileSync(o.log, `$ ${cmd.join(" ")}\n`);
  let child;
  try {
    child = Bun.spawn(cmd, { cwd: o.cwd, env: o.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (error) {
    appendFileSync(o.log, `${(error as Error).message}\n`);
    return false;
  }
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      appendFileSync(o.log, chunk);
      o.echo?.(chunk);
    }
  };
  await Promise.all([pump(child.stdout), pump(child.stderr)]);
  return (await child.exited) === 0;
}

export type Isolated = "passed" | "failed";
/** Runs `step` in a throwaway worktree of `base` with `merges` merged in,
 * never touching the checkout (blame-first and attribution). A merge that
 * doesn't apply there counts as a failure. */
export async function runIsolated(o: {
  repo: string;
  workDir: string;
  name: string;
  step: StepName;
  base: string;
  merges: string[];
  config: Config;
  logDir: string;
  env: Record<string, string | undefined>;
  echo?: (chunk: Uint8Array) => void;
}): Promise<Isolated> {
  const path = join(o.workDir, `isolated-${o.name}`);
  git.removeWorktree(o.repo, path);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(o.workDir, { recursive: true });
  git.addWorktree(o.repo, path, o.base);
  try {
    for (const ref of o.merges)
      if (git.git(path, ["merge", "--no-ff", "--no-edit", "-m", `custom-build: isolated merge ${ref}`, ref]).code !== 0)
        return "failed";
    const vars = { outfile: join(path, "dist", "corgi-isolated") },
      run = (step: StepName) =>
        runStep(commands(step, o.config, vars), {
          cwd: path,
          log: join(o.logDir, `${o.name}-${step}.log`),
          env: o.env,
          echo: o.echo,
        });
    if (o.step !== "install" && !(await run("install"))) return "failed";
    return (await run(o.step)) ? "passed" : "failed";
  } finally {
    git.removeWorktree(o.repo, path);
    rmSync(path, { recursive: true, force: true });
  }
}

/** The failing output without the commands the tool logged and without lines
 * that hold nothing but a path, such as the file headers a test runner prints
 * for every file it runs, so only files the failure itself names remain. */
export function failureText(log: string): string {
  return log
    .split("\n")
    .filter(line => !line.startsWith("$ ") && !/^\s*[^\s:()]+:?\s*$/.test(line))
    .join("\n");
}

export type Merged = { display: string; ref: string; merge: string };
export type Attribution = { kind: "build-drift" | "build-clash"; patch: string; others: string[] };
/** Who an agent fix for `step` answered: the implicated patches (touching a
 * file the fix changed or the failure names), each run merged alone onto
 * upstream. Those that fail alone drifted from upstream; if none does, the
 * implicated patches clash with each other. With no implicated patch, nothing
 * points at a patch and nothing is run. */
export async function attribute(o: {
  repo: string;
  workDir: string;
  step: StepName;
  upstream: string;
  merged: Merged[];
  fixFiles: string[];
  log: string;
  config: Config;
  logDir: string;
  env: Record<string, string | undefined>;
  echo?: (chunk: Uint8Array) => void;
  progress?: (line: string) => void;
}): Promise<Attribution[]> {
  const text = existsSync(o.log) ? failureText(readFileSync(o.log, "utf8")) : "",
    implicated = o.merged.filter(m =>
      git.filesTouchedByMerge(o.repo, m.merge).some(file => o.fixFiles.includes(file) || text.includes(file)),
    ),
    failing: string[] = [];
  if (!implicated.length) {
    o.progress?.(`no merged patch touches what the ${o.step} fix changed or the failure names; not attributed`);
    return [];
  }
  for (const [i, m] of implicated.entries()) {
    o.progress?.(`running ${o.step} with ${m.display} alone on upstream (${i + 1} of ${implicated.length})`);
    const alone = await runIsolated({
      repo: o.repo,
      workDir: o.workDir,
      name: `attribute-${m.merge.slice(0, 7)}`,
      step: o.step,
      base: o.upstream,
      merges: [m.ref],
      config: o.config,
      logDir: o.logDir,
      env: o.env,
      echo: o.echo,
    });
    if (alone !== "passed") failing.push(m.display);
  }
  if (failing.length) return failing.map(patch => ({ kind: "build-drift", patch, others: [] }));
  // A clash needs two sides: a lone implicated patch clashes with the rest merged.
  const sides = implicated.length > 1 ? implicated : o.merged;
  return implicated.map(m => ({
    kind: "build-clash",
    patch: m.display,
    others: sides.filter(other => other !== m).map(other => other.display),
  }));
}
