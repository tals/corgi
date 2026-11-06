import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import * as configFile from "./config";
import type { Config, Harness, Patch, Planned, RunState, StepName } from "./config";
import * as git from "./git";
import * as github from "./github";
import * as harness from "./harness";
import * as report from "./report";
import * as sources from "./sources";
import * as steps from "./steps";

export type Context = {
  repo: string;
  dir: string;
  config: Config;
  env: Record<string, string | undefined>;
  /** The running tool's directory, copied into the config directory for the run. */
  tool: string;
  now: () => Date;
  progress: (line: string) => void;
  echo: (chunk: Uint8Array) => void;
};
export type Code = 0 | 1 | 2 | 3 | 4 | 5;
/** How a command ended; `lines` are the summary for stdout. */
export type Outcome = { code: Code; lines: string[] };

const work = (ctx: Context) => join(ctx.dir, "work");
const binary = (ctx: Context) => join(ctx.repo, "dist", "corgi-custom");
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "none");
/** build.ts stamps these subjects into `corgi --version --verbose`, so they say what each patch is. */
const mergeMessage = (p: Planned) => `Merge ${p.display}${p.description ? `: ${p.description}` : ""}`;
/** The config directory relative to the checkout, when it lies inside it. */
function insideRepo(ctx: Context): string | null {
  const rel = relative(ctx.repo, ctx.dir);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : null;
}
/** Copies `from` over `to` by renaming a sibling copy into place: a running
 * binary keeps its inode, and the copy may come from another file system. */
function replaceFile(from: string, to: string) {
  const temporary = `${to}.tmp-${process.pid}`;
  copyFileSync(from, temporary);
  renameSync(temporary, to);
}
function save(ctx: Context, run: RunState) {
  configFile.saveRun(ctx.dir, run);
}
function event(run: RunState, kind: string, fields: { patch?: string; step?: StepName; detail?: string } = {}) {
  run.events.push({ kind, ...fields });
}
/** `YYYYMMDD-HHMMSS` in UTC. */
export function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** Fetches one patch into a private ref (or picks the own branch) and decides whether to merge it. */
function fetchPatch(ctx: Context, patch: Patch, remote: string, upstream: string, run: RunState): Planned {
  const display = sources.display(patch.source),
    s = patch.source,
    planned = (commit: string, ref: string): Planned => ({
      display,
      description: patch.description,
      commit,
      ref,
      prLink: sources.prLink(s),
      skip: null,
    });
  switch (s.kind) {
    case "branch": {
      const local = git.revParse(ctx.repo, `refs/heads/${s.name}`),
        failed = git.hasRemote(ctx.repo, "origin")
          ? git.fetch(ctx.repo, "origin", `+refs/heads/${s.name}:refs/remotes/origin/${s.name}`)
          : null,
        stale = git.revParse(ctx.repo, `refs/remotes/origin/${s.name}`),
        // An unfetched origin copy may be old or deleted, so only a fresh fetch counts.
        pushed = failed ? null : stale;
      if (failed && !local) throw Error(`cannot fetch origin/${s.name} for ${display}: ${failed}`);
      if (failed && stale)
        event(run, "note", { patch: display, detail: `could not fetch origin/${s.name}; using the local branch` });
      if (!local && !pushed) throw Error(`cannot find ${display}: no such local branch or origin/${s.name}`);
      if (!local) {
        event(run, "note", { patch: display, detail: `no local branch; using origin/${s.name}` });
        return planned(pushed!, `refs/remotes/origin/${s.name}`);
      }
      if (pushed && pushed !== local) {
        if (git.isAncestor(ctx.repo, local, pushed)) {
          event(run, "note", {
            patch: display,
            detail: `local branch is behind origin/${s.name}; using origin/${s.name}`,
          });
          return planned(pushed, `refs/remotes/origin/${s.name}`);
        }
        if (!git.isAncestor(ctx.repo, pushed, local))
          event(run, "note", {
            patch: display,
            detail: `local branch and origin/${s.name} have diverged; using the local branch`,
          });
      }
      return planned(local, `refs/heads/${s.name}`);
    }
    case "pr":
    case "fork-branch": {
      const ref = sources.privateRef(s)!,
        from = s.kind === "pr" && s.repo === ctx.config.upstream.repo ? remote : sources.fetchUrl(s, ctx.env)!,
        failed = git.fetch(ctx.repo, from, `+${sources.remoteRef(s)}:${ref}`);
      if (failed) throw Error(`cannot fetch ${display}: ${failed}`);
      const p = planned(git.revParse(ctx.repo, ref)!, ref);
      if (s.kind === "pr") {
        // MERGED on another repository means merged there, not upstream; on upstream it
        // counts once the fetched branch has the merge (into another branch, or after the fetch, it doesn't).
        const info = github.prInfo(s.repo, s.number, ctx.env),
          mergedUpstream = s.repo === ctx.config.upstream.repo && info?.state === "MERGED",
          intoUpstream = mergedUpstream && !!info.mergeCommit && git.isAncestor(ctx.repo, info.mergeCommit, upstream);
        if (intoUpstream || git.isAncestor(ctx.repo, p.commit!, upstream)) p.skip = "skipped-merged";
        else if (mergedUpstream)
          event(run, "note", {
            patch: display,
            detail: `the PR is merged, but not into the fetched ${ctx.config.upstream.branch}; merging it`,
          });
        else if (info?.state === "CLOSED")
          event(run, "closed-warning", { patch: display, detail: "the PR was closed without merging" });
      }
      return p;
    }
  }
}

/** Starts a full run: preflight, fetch everything, reset the custom branch to upstream, merge, verify. */
export async function rebuild(ctx: Context, o: { push?: boolean } = {}): Promise<Outcome> {
  const { repo, config } = ctx;
  git.requireVersion(repo);
  if (configFile.loadRun(ctx.dir))
    throw Error("a run is stopped or in progress; resume it with `continue` or undo it with `rollback`");
  if (!git.isClean(repo)) throw Error("tracked files have uncommitted changes; commit or stash them first");
  if (config.branch === config.upstream.branch || !git.validBranchName(repo, config.branch))
    throw Error(`${config.branch} can't be the custom build branch`);
  const elsewhere = git.worktreeWith(repo, config.branch);
  if (elsewhere)
    throw Error(`${config.branch} is checked out in another worktree (${elsewhere}); switch it away first`);
  // The run resets the custom branch and replaces its backup, so neither may be a patch.
  const owned = [config.branch, `${config.branch}-prev`],
    taken = config.patches.find(p => p.source.kind === "branch" && owned.includes(p.source.name));
  if (taken)
    throw Error(
      `the patch ${sources.display(taken.source)} is a branch the tool resets (${owned.join(", ")}); rename it or set another branch`,
    );
  const remote = git.resolveUpstreamRemote(repo, config);
  if (!git.hasRemote(repo, remote)) throw Error(`no ${remote} remote to fetch upstream from`);
  if (
    o.push &&
    (remote === "origin" ||
      !git.hasRemote(repo, "origin") ||
      git.remoteTarget(repo, "origin", "push") === git.remoteTarget(repo, remote, "fetch"))
  )
    throw Error("--push needs an origin remote of your own, apart from upstream; nothing was changed");

  const run: RunState = {
    startedAt: ctx.now().toISOString(),
    startTip: git.revParse(repo, `refs/heads/${config.branch}`),
    startBinary: null,
    startHead: git.must(repo, ["rev-parse", "HEAD"]),
    startBranch: git.currentBranch(repo),
    upstream: "",
    reportDir: "",
    phase: "merge",
    cursor: 0,
    step: null,
    attempts: 0,
    calls: 0,
    plan: [],
    merged: [],
    events: [],
    conflicts: [],
    fixes: [],
    stopped: null,
    push: !!o.push,
  };
  ctx.progress(`fetching ${remote} ${config.upstream.branch}`);
  run.upstream = git.fetchRemote(repo, remote, config.upstream.branch);
  for (const patch of config.patches) {
    ctx.progress(`fetching ${sources.display(patch.source)}`);
    run.plan.push(fetchPatch(ctx, patch, remote, run.upstream, run));
  }

  mkdirSync(work(ctx), { recursive: true });
  if (existsSync(binary(ctx))) {
    run.startBinary = join(work(ctx), "corgi-custom.start");
    copyFileSync(binary(ctx), run.startBinary);
  }
  const reports = join(ctx.dir, "reports"),
    base = stamp(ctx.now());
  let name = base;
  for (let n = 2; existsSync(join(reports, name)); n++) name = `${base}-${n}`;
  run.reportDir = join(reports, name);
  mkdirSync(run.reportDir, { recursive: true });
  copyTool(ctx);
  exclude(ctx);
  save(ctx, run);
  ctx.progress(`resetting ${config.branch} to ${remote}/${config.upstream.branch} (${short(run.upstream)})`);
  try {
    git.must(repo, ["checkout", "--quiet", "-B", config.branch, run.upstream]);
  } catch (error) {
    // Nothing was reset: forget the run so the checkout is as it was.
    if (run.startBinary) rmSync(run.startBinary, { force: true });
    configFile.clearRun(ctx.dir);
    throw error;
  }
  return proceed(ctx, run);
}

/** Copies the tool into the config directory, so continue and rollback work
 * after the reset even when upstream lacks it. */
function copyTool(ctx: Context) {
  const target = join(work(ctx), "tool");
  if (resolve(ctx.tool) === resolve(target)) return;
  rmSync(target, { recursive: true, force: true });
  cpSync(ctx.tool, target, { recursive: true });
}
/** Keeps a config directory inside the checkout out of `git status`. */
export function exclude(ctx: Context) {
  const rel = insideRepo(ctx);
  if (!rel) return;
  // The reset to upstream may drop a .gitignore entry, so check the exclude file itself.
  const path = join(git.commonDir(ctx.repo), "info", "exclude"),
    line = `/${rel.replaceAll("\\", "/")}/`;
  if (existsSync(path) && readFileSync(path, "utf8").split("\n").includes(line)) return;
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, `\n${line}\n`);
}

async function proceed(ctx: Context, run: RunState): Promise<Outcome> {
  if (run.phase === "merge") {
    const stop = await mergeLoop(ctx, run);
    if (stop) return stop;
    run.phase = "verify";
    run.step = null;
    save(ctx, run);
  }
  if (run.phase === "verify") {
    const stop = await verifyLoop(ctx, run);
    if (stop) return stop;
    run.phase = "report";
    save(ctx, run);
  }
  return finish(ctx, run);
}

function advance(ctx: Context, run: RunState, p: Planned, kind: string) {
  if (kind !== "skipped-merged" && kind !== "already-contained") {
    run.merged.push({ source: p.display, commit: p.commit!, description: p.description });
    p.merge = git.must(ctx.repo, ["rev-parse", "HEAD"]);
  }
  event(run, kind, { patch: p.display });
  run.cursor++;
  run.attempts = 0;
  save(ctx, run);
}

async function mergeLoop(ctx: Context, run: RunState): Promise<Outcome | null> {
  const { repo } = ctx;
  while (run.cursor < run.plan.length) {
    const p = run.plan[run.cursor];
    if (p.skip) {
      ctx.progress(`skipping ${p.display}: merged upstream`);
      advance(ctx, run, p, p.skip);
      continue;
    }
    if (git.isAncestor(repo, p.commit!, "HEAD")) {
      ctx.progress(`skipping ${p.display}: already contained`);
      advance(ctx, run, p, "already-contained");
      continue;
    }
    ctx.progress(`merging ${p.display}`);
    const out = git.mergeNoFF(repo, p.commit!, mergeMessage(p));
    if (out.code === 0) {
      advance(ctx, run, p, "merged");
      continue;
    }
    if (!git.mergeInProgress(repo)) throw Error(`merging ${p.display} failed: ${(out.stderr || out.stdout).trim()}`);
    const unmerged = git.unmergedFiles(repo);
    if (unmerged.length === 0) {
      // rerere replayed a recorded resolution for every conflict.
      run.conflicts.push({ patch: p.display, files: replayedFiles(repo, p.commit!), by: "rerere" });
      git.commitMerge(repo, mergeMessage(p));
      advance(ctx, run, p, "replayed");
      continue;
    }
    run.conflicts.push({ patch: p.display, files: unmerged, by: null });
    run.attempts = 0;
    save(ctx, run);
    const h = harnessFor(ctx);
    if (h) {
      if (await resolveWithHarness(ctx, run, p, unmerged, h)) {
        commitAgentMerge(ctx, run, p);
        continue;
      }
      return stop(
        ctx,
        run,
        5,
        [
          `the harness could not resolve the conflict in ${p.display} in ${run.attempts} attempts`,
          `files: ${unmerged.join(", ")}`,
        ],
        ["resolve the conflicts yourself, `git add` the files, then continue"],
      );
    }
    return stop(
      ctx,
      run,
      2,
      [`merge conflict in ${p.display}`, `files: ${unmerged.join(", ")}`],
      ["resolve the conflicts, `git add` the files, then continue"],
    );
  }
  return null;
}
/** Commits a harness resolution the checks accepted, and moves on. */
function commitAgentMerge(ctx: Context, run: RunState, p: Planned) {
  resolved(run, p, "harness");
  git.commitMerge(ctx.repo, `${mergeMessage(p)}\n\nResolved-By: harness`);
  run.harnessCall = null;
  advance(ctx, run, p, "agent-resolved");
}
/** Commits a harness build fix the checks accepted as its own fix commit. */
function commitAgentFix(ctx: Context, run: RunState, step: StepName, files: string[], log: string) {
  const { repo } = ctx;
  git.must(repo, ["add", "-A", "--", ...files]);
  git.must(repo, ["commit", "--no-verify", "-q", "-m", `custom-build: fix ${step} (agent)\n\nFixed-By: harness`]);
  const sha = git.must(repo, ["rev-parse", "HEAD"]);
  run.fixes.push({ step, commit: sha, by: "agent", files, log });
  event(run, "agent-fix", { step, detail: sha });
  run.harnessCall = null;
  save(ctx, run);
}
/** The paths rerere replayed: what conflicts when merging the patch onto the
 * branch, worked out without touching the merge in progress. */
function replayedFiles(repo: string, commit: string): string[] {
  return git.mergeTreeCheck(repo, "HEAD", commit).files;
}

function stepVars(ctx: Context): steps.Vars {
  return { outfile: binary(ctx) };
}
async function verifyLoop(ctx: Context, run: RunState): Promise<Outcome | null> {
  const { repo } = ctx;
  for (let i = configFile.stepNames.indexOf(run.step ?? "install"); i < configFile.stepNames.length; i++) {
    const step = configFile.stepNames[i];
    run.step = step;
    save(ctx, run);
    if (step === "install" && !steps.installNeeded(repo, run.startHead)) continue;
    ctx.progress(`running ${step}`);
    const cmds = steps.commands(step, ctx.config, stepVars(ctx)),
      cmd = cmds[cmds.length - 1],
      log = join(run.reportDir, "steps", `${step}.log`);
    if (await steps.runStep(cmds, { cwd: repo, log, env: ctx.env, echo: ctx.echo })) {
      event(run, "passed", { step });
      save(ctx, run);
      continue;
    }
    // A flaky failure would otherwise cost an upstream run and an agent fix.
    const flaky = join(
      run.reportDir,
      "steps",
      `${step}-flaky-${run.events.filter(e => e.kind === "flaky").length + 1}.log`,
    );
    copyFileSync(log, flaky);
    ctx.progress(`${step} failed; running it once more in case the failure is flaky`);
    if (await steps.runStep(cmds, { cwd: repo, log, env: ctx.env, echo: ctx.echo })) {
      event(run, "flaky", { step, detail: flaky });
      event(run, "passed", { step });
      save(ctx, run);
      continue;
    }
    rmSync(flaky, { force: true });
    ctx.progress(`${step} failed again; trying it on plain upstream`);
    const alone = await isolated(ctx, run, step, "upstream", []);
    if (alone !== "passed") {
      event(run, "upstream-broken", { step });
      save(ctx, run);
      return stop(
        ctx,
        run,
        4,
        [`${step} fails on plain upstream ${short(run.upstream)} too: upstream is broken`, `log: ${log}`],
        ["roll back, then rebuild once upstream is fixed"],
      );
    }
    const h = harnessFor(ctx);
    if (h) {
      // Fixes that keep breaking each other stop the run instead of looping; a
      // tree the fixes repaired never gets here, so it isn't stopped.
      const agentFixes = run.fixes.filter(f => f.by === "agent").length;
      if (agentFixes >= (h.attempts ?? 3) * configFile.stepNames.length)
        return stop(
          ctx,
          run,
          5,
          [`${step} fails again after the harness's ${agentFixes} fixes`, `log: ${log}`],
          ["fix it in the working tree (or commit the fix), then continue"],
        );
      if (await fixWithHarness(ctx, run, step, cmds, log, h)) {
        // A fix can break a step that passed before it, so everything runs again.
        i = -1;
        continue;
      }
      return stop(
        ctx,
        run,
        5,
        [`the harness could not fix ${step} in ${run.attempts} attempts`, `command: ${cmd.join(" ")}`, `log: ${log}`],
        ["fix it in the working tree (or commit the fix), then continue"],
      );
    }
    return stop(
      ctx,
      run,
      3,
      [`${step} failed`, `command: ${cmd.join(" ")}`, `log: ${log}`],
      ["fix it in the working tree (or commit the fix), then continue"],
    );
  }
  return null;
}
/** The configured harness when it can run; a missing executable warns and counts as none. */
function harnessFor(ctx: Context): Harness | null {
  const h = ctx.config.harness;
  if (!h) return null;
  if (harness.executable(h, ctx.repo, ctx.env)) return h;
  ctx.progress(`warning: harness ${h.command[0]} is not executable; continuing without it`);
  return null;
}
const templates = (ctx: Context) => [join(work(ctx), "tool"), ctx.tool];
const upstreamLine = (ctx: Context, run: RunState) => git.must(ctx.repo, ["log", "-1", "--format=%h %s", run.upstream]);

/** Asks the harness to resolve the conflict in progress until a result passes
 * the tool's checks or the attempts run out, the conflict restored after each rejection. */
async function resolveWithHarness(ctx: Context, run: RunState, p: Planned, files: string[], h: Harness) {
  const { repo } = ctx,
    limit = h.attempts ?? 3;
  while (run.attempts < limit) {
    run.attempts++;
    run.calls++;
    save(ctx, run);
    const head = git.must(repo, ["rev-parse", "HEAD"]),
      before = git.snapshot(repo),
      text = harness.fill(harness.template("conflict", templates(ctx)), {
        patch: p.display,
        description: p.description,
        prLink: p.prLink,
        files,
        upstream: upstreamLine(ctx, run),
        mergedSoFar: run.merged.map(m => `${m.source}: ${m.description}`),
      });
    run.harnessCall = { kind: "conflict", patch: p.display, attempt: run.attempts, head, snapshot: before, files };
    save(ctx, run);
    ctx.progress(`asking the harness to resolve ${p.display} (attempt ${run.attempts} of ${limit})`);
    const call = await harness.invoke(h, "conflict", text, {
      repo,
      reportDir: run.reportDir,
      number: run.calls,
      env: ctx.env,
      echo: ctx.echo,
    });
    const verdict: harness.Verdict = call.timedOut
      ? { ok: false, reason: `it timed out after ${h.timeoutSeconds ?? 900}s` }
      : harness.acceptConflict(repo, files, head, before, excluded(ctx));
    if (verdict.ok) return true;
    ctx.progress(`rejected the harness's resolution: ${verdict.reason}`);
    harness.discard(repo, head, before, excluded(ctx));
    git.remerge(repo, p.commit!, mergeMessage(p), files);
    run.harnessCall = null;
    save(ctx, run);
  }
  return false;
}

/** Asks the harness to fix a failing step, committing each accepted change as
 * its own fix commit, until the step passes or the attempts run out. */
async function fixWithHarness(ctx: Context, run: RunState, step: StepName, cmds: string[][], log: string, h: Harness) {
  const cmd = cmds[cmds.length - 1];
  const { repo } = ctx,
    limit = h.attempts ?? 3;
  run.attempts = 0;
  const failedLog = join(run.reportDir, "steps", `${step}-failed-${run.fixes.length + 1}.log`);
  copyFileSync(log, failedLog);
  while (run.attempts < limit) {
    run.attempts++;
    run.calls++;
    save(ctx, run);
    const head = git.must(repo, ["rev-parse", "HEAD"]),
      before = git.snapshot(repo),
      text = harness.fill(harness.template("build", templates(ctx)), {
        step,
        command: cmd.join(" "),
        logExcerpt: readFileSync(log, "utf8").split("\n").slice(-200).join("\n"),
        patches: run.merged.map(m => `${m.source}: ${m.description}`),
        attempt: `${run.attempts} of ${limit}`,
      });
    run.harnessCall = { kind: "build", step, attempt: run.attempts, head, snapshot: before, log: failedLog };
    save(ctx, run);
    ctx.progress(`asking the harness to fix ${step} (attempt ${run.attempts} of ${limit})`);
    const call = await harness.invoke(h, "build", text, {
      repo,
      reportDir: run.reportDir,
      number: run.calls,
      env: ctx.env,
      echo: ctx.echo,
    });
    const verdict: harness.Verdict = call.timedOut
      ? { ok: false, reason: `it timed out after ${h.timeoutSeconds ?? 900}s` }
      : harness.acceptFix(repo, head, before, excluded(ctx));
    if (!verdict.ok) {
      ctx.progress(`rejected the harness's fix: ${verdict.reason}`);
      if (call.timedOut) harness.discard(repo, head, before, excluded(ctx));
      run.harnessCall = null;
      save(ctx, run);
      continue;
    }
    commitAgentFix(ctx, run, step, verdict.files, failedLog);
    ctx.progress(`running ${step} again`);
    if (await steps.runStep(cmds, { cwd: repo, log, env: ctx.env, echo: ctx.echo })) {
      event(run, "passed", { step });
      save(ctx, run);
      return true;
    }
  }
  return false;
}
function isolated(ctx: Context, run: RunState, step: StepName, name: string, merges: string[]) {
  return steps.runIsolated({
    repo: ctx.repo,
    workDir: work(ctx),
    name,
    step,
    base: run.upstream,
    merges,
    config: ctx.config,
    logDir: join(run.reportDir, "isolated"),
    env: ctx.env,
    echo: ctx.echo,
  });
}

/** How to run the tool again when the reset checkout lacks it. */
function toolCommand(ctx: Context, command: string): string {
  return `bun ${join(work(ctx), "tool", "main.ts")} --dir ${ctx.dir} ${command}`;
}
async function stop(ctx: Context, run: RunState, code: Code, what: string[], next: string[]): Promise<Outcome> {
  run.stopped = { code, snapshot: git.snapshot(ctx.repo) };
  save(ctx, run);
  const handoffs = await writeReport(ctx, run, code, what);
  return {
    code,
    lines: [
      `custom-build stopped: ${what[0]}`,
      ...what.slice(1).map(line => `  ${line}`),
      `  report: ${join(run.reportDir, "report.md")}`,
      ...handoffs.map(path => `  handoff: ${path}`),
      ...next.map(line => `  ${line}`),
      // Upstream breakage isn't fixed by continuing the pinned run.
      ...(code === 4 ? [] : [`  continue: scripts/custom-build continue`]),
      `  undo the run: scripts/custom-build rollback`,
      `  (without the tool in this checkout: ${toolCommand(ctx, code === 4 ? "rollback" : "continue")})`,
    ],
  };
}

/** The run's report, rebase check and handoffs; returns the handoff paths. */
async function writeReport(ctx: Context, run: RunState, code: Code, reason: string[]): Promise<string[]> {
  const { repo } = ctx,
    active = run.plan.filter(p => !p.skip),
    // The commits this run built, not the refs: a patch branch may have moved on during a stop.
    rebase = rebaseCheck(
      ctx,
      run.upstream,
      active.map(p => ({ display: p.display, ref: p.commit })),
    ),
    pulled = run.startTip
      ? git
          .must(repo, ["log", "--no-merges", "--format=%H %s", `${run.startTip}..${run.upstream}`])
          .split("\n")
          .filter(Boolean)
          .map(line => ({ sha: line.slice(0, 40), subject: line.slice(41) }))
      : [];
  for (const fix of run.fixes)
    if (fix.by === "agent" && !fix.attribution) {
      ctx.progress(`working out which patches the ${fix.step} fix answered`);
      fix.attribution = await steps.attribute({
        repo,
        workDir: work(ctx),
        step: fix.step,
        upstream: run.upstream,
        merged: active
          .filter(p => p.merge && run.merged.some(m => m.source === p.display))
          .map(p => ({ display: p.display, ref: p.commit!, merge: p.merge! })),
        fixFiles: fix.files,
        log: fix.log ?? "",
        config: ctx.config,
        logDir: join(run.reportDir, "isolated"),
        env: ctx.env,
        echo: ctx.echo,
        progress: ctx.progress,
      });
      save(ctx, run);
    }
  const template = harness.template("handoff", templates(ctx)),
    upstream = upstreamLine(ctx, run),
    handoffs: string[] = [];
  // A stopped and continued run writes its report again: one set of handoffs, the latest.
  rmSync(join(run.reportDir, "handoffs"), { recursive: true, force: true });
  for (const r of rebase.filter(r => r.clean === false))
    handoffs.push(
      report.writeHandoff(run.reportDir, template, {
        ...handoffBase(ctx, run, r.display, upstream),
        kind: "rebase",
        problem: `Merging it alone onto upstream main conflicts in:\n\n${r.files.map(f => `- ${f}`).join("\n")}`,
        cause: "upstream main moved on",
        fix: "none",
        task: `Rebase this branch onto the latest upstream main and resolve the conflicts in ${r.files.join(", ")}, keeping the change's intent. Check that the repository's typecheck, tests and build still pass.`,
      }),
    );
  for (const fix of run.fixes)
    for (const a of fix.attribution ?? []) {
      const command = steps.command(fix.step, ctx.config, stepVars(ctx)).join(" "),
        excerpt = fix.log && existsSync(fix.log) ? readFileSync(fix.log, "utf8").trimEnd().split("\n").slice(-40) : [],
        stat = git.git(repo, ["show", "--stat", "--format=", fix.commit]).stdout.trimEnd();
      handoffs.push(
        report.writeHandoff(run.reportDir, template, {
          ...handoffBase(ctx, run, a.patch, upstream),
          kind: a.kind,
          problem: `\`${command}\` (${fix.step}) failed in the custom build:\n\n\`\`\`text\n${excerpt.join("\n")}\n\`\`\``,
          cause:
            a.kind === "build-drift"
              ? "upstream main moved on"
              : a.others.length
                ? `clashes with: ${a.others.join(", ")}`
                : "clashes with the other changes in this build",
          fix: `${fix.commit.slice(0, 7)} custom-build: fix ${fix.step} (agent)\n\n\`\`\`text\n${stat}\n\`\`\``,
          task:
            a.kind === "build-drift"
              ? `With this branch merged alone onto the latest upstream main, \`${command}\` fails. Update the branch onto upstream main and fix it; the fix the custom build applied is shown above as a hint.`
              : `This branch and ${a.others.join(", ")} each pass \`${command}\` alone on upstream main but fail together. Decide with their authors which side adapts, or wait until one of them is merged upstream, then update this branch if it is the one to change.`,
        }),
      );
    }
  report.writeReport(run, { outcome: { code, reason }, upstream: run.upstream, pulled, rebase, handoffs });
  const reports = join(ctx.dir, "reports");
  report.linkLatest(reports, run.reportDir);
  report.prune(reports);
  return handoffs;
}
function handoffBase(ctx: Context, run: RunState, display: string, upstream: string) {
  const p = run.plan.find(p => p.display === display),
    source = ctx.config.patches.find(c => sources.display(c.source) === display)?.source,
    checkout =
      source?.kind === "branch"
        ? `branch ${source.name}`
        : source?.kind === "fork-branch"
          ? `branch ${source.branch} of ${source.repo ?? source.url}`
          : `the head branch of ${display}`;
  return { patch: display, description: p?.description ?? "", link: p?.prLink ?? checkout, upstream, checkout };
}

async function finish(ctx: Context, run: RunState): Promise<Outcome> {
  const { repo, config } = ctx,
    handoffs = await writeReport(ctx, run, 0, []),
    lines = [...summary(run), ...handoffs.map(path => `  handoff: ${path}`)];
  // The backups are the run's start, both halves, so a rollback never mixes builds.
  if (run.startTip) git.must(repo, ["branch", "-f", `${config.branch}-prev`, run.startTip]);
  else if (git.branchExists(repo, `${config.branch}-prev`)) git.must(repo, ["branch", "-D", `${config.branch}-prev`]);
  // Copy, clear the run, then drop the start copy: dying in between leaves a
  // run whose `continue` makes the same backup again.
  if (run.startBinary && existsSync(run.startBinary)) replaceFile(run.startBinary, `${binary(ctx)}.prev`);
  else if (!run.startBinary) rmSync(`${binary(ctx)}.prev`, { force: true });
  configFile.clearRun(ctx.dir);
  if (run.startBinary) rmSync(run.startBinary, { force: true });
  let code: Code = 0;
  if (config.afterBuild) {
    ctx.progress(`running after-build command: ${config.afterBuild.join(" ")}`);
    const ok = await steps.runStep(config.afterBuild, {
      cwd: repo,
      log: join(run.reportDir, "steps", "after-build.log"),
      env: ctx.env,
      echo: ctx.echo,
    });
    lines.push(ok ? "after-build command: passed" : "after-build command failed; the build itself succeeded");
  }
  if (run.push) {
    ctx.progress(`pushing ${config.branch} to origin`);
    const out = git.git(repo, ["push", "--force-with-lease", "origin", `${config.branch}:${config.branch}`]);
    if (out.code === 0) lines.push(`pushed ${config.branch} to origin`);
    else {
      lines.push(`push to origin failed: ${(out.stderr || out.stdout).trim()}`);
      code = 1;
    }
  }
  return { code, lines };
}
function summary(run: RunState): string[] {
  const of = (kind: string) => run.events.filter(e => e.kind === kind).map(e => e.patch ?? e.step ?? "");
  return [
    `custom-build: built dist/corgi-custom on upstream ${short(run.upstream)} with ${run.merged.length} ${run.merged.length === 1 ? "patch" : "patches"}`,
    ...run.merged.map(p => `  merged ${p.source} ${p.commit.slice(0, 7)} ${p.description}`),
    ...of("skipped-merged").map(p => `  skipped ${p}: merged upstream, it can be removed from the list`),
    ...of("already-contained").map(p => `  skipped ${p}: already contained`),
    ...of("agent-resolved").map(p => `  agent resolved the conflict in ${p}`),
    ...run.fixes.map(f => `  ${f.by === "agent" ? "agent" : "user"} fix ${f.commit.slice(0, 7)} for ${f.step}`),
    ...run.events
      .filter(e => e.kind === "flaky")
      .map(e => `  warning: ${e.step} failed once and passed when run again; it may be flaky (${e.detail})`),
    ...run.events.filter(e => e.kind === "closed-warning").map(e => `  warning: ${e.patch} ${e.detail}`),
    ...run.events.filter(e => e.kind === "note").map(e => `  note: ${e.patch}: ${e.detail}`),
    `  report: ${join(run.reportDir, "report.md")}`,
  ];
}

/** Resumes a stopped run once the user resolved the conflict or fixed the step. */
export async function resume(ctx: Context): Promise<Outcome> {
  const { repo } = ctx,
    run = configFile.loadRun(ctx.dir);
  if (!run) throw Error("there is no stopped run to continue");
  // Merging or committing onto any other branch would change a branch the run doesn't own.
  if (git.currentBranch(repo) !== ctx.config.branch || !git.isAncestor(repo, run.upstream, "HEAD"))
    throw Error(
      `${ctx.config.branch} is not checked out at this run's upstream ${short(run.upstream)}; check it out to continue, or undo the run with \`rollback\``,
    );
  if (run.harnessCall) {
    const outcome = await resumeHarnessCall(ctx, run, run.harnessCall);
    if (outcome) return outcome;
  } else if (run.phase === "merge") {
    const p = run.plan[run.cursor];
    if (git.mergeInProgress(repo)) {
      const left = git.unmergedFiles(repo);
      if (left.length)
        return {
          code: 2,
          lines: [
            `custom-build: ${p.display} still has unmerged files: ${left.join(", ")}`,
            "  resolve them and `git add` them, then continue",
          ],
        };
      git.commitMerge(repo, mergeMessage(p));
      resolved(run, p, "user");
      advance(ctx, run, p, "user-resolved");
    } else if (p && git.revParse(repo, "HEAD^2") === p.commit) {
      resolved(run, p, "user");
      advance(ctx, run, p, "user-resolved");
    }
  } else if (run.phase === "verify" && run.step) {
    // Without a stop (an interrupted run), only tracked changes count as the fix.
    const changed = (
      run.stopped
        ? git.changedSince(repo, run.stopped.snapshot, excluded(ctx))
        : git.must(repo, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean)
    )
      .filter(path => !harness.buildLeftover(path))
      .filter(path => existsSync(join(repo, path)) || git.git(repo, ["cat-file", "-e", `HEAD:${path}`]).code === 0);
    if (changed.length) {
      git.must(repo, ["add", "-A", "--", ...changed]);
      git.must(repo, ["commit", "--no-verify", "-q", "-m", `custom-build: fix ${run.step} (user)`]);
      run.fixes.push({ step: run.step, commit: git.must(repo, ["rev-parse", "HEAD"]), by: "user", files: changed });
      event(run, "user-fix", { step: run.step });
    }
  }
  // A fix may break a step that passed before it: verify from the first step again.
  if (run.phase === "verify") run.step = null;
  run.stopped = null;
  save(ctx, run);
  return proceed(ctx, run);
}
/** A run interrupted during a harness call: what the harness left is checked
 * like a finished result. Accepted, it is committed as the agent's; rejected,
 * the run stops with the conflict or failing step in place. */
async function resumeHarnessCall(ctx: Context, run: RunState, call: configFile.HarnessCall): Promise<Outcome | null> {
  const { repo } = ctx;
  ctx.progress(`checking what the interrupted harness call (attempt ${call.attempt}) left`);
  if (call.kind === "conflict") {
    const p = run.plan[run.cursor],
      files = call.files ?? [],
      verdict = harness.acceptConflict(repo, files, call.head, call.snapshot, excluded(ctx));
    if (verdict.ok) {
      commitAgentMerge(ctx, run, p);
      return null;
    }
    run.harnessCall = null;
    return stop(
      ctx,
      run,
      2,
      [
        `the interrupted harness resolution of ${p.display} was rejected: ${verdict.reason}`,
        `files: ${files.join(", ")}`,
      ],
      ["resolve the conflicts yourself, `git add` the files, then continue"],
    );
  }
  const step = call.step ?? run.step!,
    verdict = harness.acceptFix(repo, call.head, call.snapshot, excluded(ctx));
  if (verdict.ok) {
    commitAgentFix(ctx, run, step, verdict.files, call.log ?? "");
    return null;
  }
  run.harnessCall = null;
  return stop(
    ctx,
    run,
    3,
    [`the interrupted harness fix for ${step} was rejected: ${verdict.reason}`],
    ["fix it in the working tree (or commit the fix), then continue"],
  );
}
function resolved(run: RunState, p: Planned, by: "user" | "harness") {
  const conflict = run.conflicts.findLast(c => c.patch === p.display);
  if (conflict) conflict.by = by;
}
/** Paths a fix never includes: the config directory when it is inside the checkout. */
function excluded(ctx: Context): string[] {
  const rel = insideRepo(ctx);
  return rel ? [rel] : [];
}

/** Returns to the last successful build: the start of a stopped run, else the backups. */
export async function rollback(ctx: Context): Promise<Outcome> {
  const { repo, config } = ctx,
    run = configFile.loadRun(ctx.dir);
  if (run) {
    // The forced checkout below discards the run's half-done work, which lives
    // only on the custom branch; edits anywhere else are someone else's.
    const current = git.currentBranch(repo);
    if (current !== config.branch && !git.isClean(repo))
      throw Error(
        `${current ?? "the detached HEAD"} has uncommitted changes, and rollback would discard them; commit or stash them first`,
      );
    if (git.mergeInProgress(repo)) git.git(repo, ["merge", "--abort"]);
    if (run.startTip) git.must(repo, ["checkout", "--quiet", "-f", "-B", config.branch, run.startTip]);
    else {
      git.must(repo, ["checkout", "--quiet", "-f", run.startBranch ?? run.startHead]);
      if (run.startBranch !== config.branch && git.branchExists(repo, config.branch))
        git.must(repo, ["branch", "-D", config.branch]);
    }
    if (run.startBinary && existsSync(run.startBinary)) {
      mkdirSync(join(repo, "dist"), { recursive: true });
      replaceFile(run.startBinary, binary(ctx));
      rmSync(run.startBinary, { force: true });
    } else if (!run.startBinary) rmSync(binary(ctx), { force: true });
    configFile.clearRun(ctx.dir);
    return {
      code: 0,
      lines: [
        run.startTip
          ? `custom-build: rolled back to ${config.branch} at ${short(run.startTip)}, as before the run`
          : `custom-build: rolled back to ${run.startBranch ?? short(run.startHead)}; there was no custom build before the run`,
      ],
    };
  }
  const prev = git.revParse(repo, `refs/heads/${config.branch}-prev`),
    prevBinary = `${binary(ctx)}.prev`;
  if (!prev && !existsSync(prevBinary)) throw Error("nothing to roll back to: no stopped run and no earlier build");
  if (!git.isClean(repo)) throw Error("tracked files have uncommitted changes; commit or stash them first");
  if (prev) git.must(repo, ["checkout", "--quiet", "-B", config.branch, prev]);
  if (existsSync(prevBinary)) {
    mkdirSync(join(repo, "dist"), { recursive: true });
    replaceFile(prevBinary, binary(ctx));
  }
  return {
    code: 0,
    lines: [`custom-build: rolled back to ${config.branch}-prev (${short(prev)}) and dist/corgi-custom.prev`],
  };
}

/** Each active patch test-merged alone onto upstream, from refs already fetched. */
export function rebaseCheck(
  ctx: Context,
  upstream: string,
  plan: { display: string; ref: string | null }[],
): { display: string; clean: boolean | null; files: string[] }[] {
  return plan.map(p => {
    if (!p.ref || !git.revParse(ctx.repo, p.ref)) return { display: p.display, clean: null, files: [] };
    const check = git.mergeTreeCheck(ctx.repo, upstream, p.ref);
    return { display: p.display, clean: check.clean, files: check.files };
  });
}
/** Where each configured patch was last fetched to, without fetching. */
export function knownRefs(ctx: Context): { display: string; ref: string | null }[] {
  return ctx.config.patches.map(p => {
    const s = p.source,
      display = sources.display(s);
    if (s.kind !== "branch") return { display, ref: sources.privateRef(s) };
    if (git.revParse(ctx.repo, `refs/heads/${s.name}`)) return { display, ref: `refs/heads/${s.name}` };
    return { display, ref: `refs/remotes/origin/${s.name}` };
  });
}

/** The stopped run, if any, and which patches need a rebase onto upstream. */
export async function status(ctx: Context): Promise<Outcome> {
  const lines: string[] = [],
    run = configFile.loadRun(ctx.dir);
  if (run) {
    const where =
      run.phase === "merge"
        ? `merging ${run.plan[run.cursor]?.display ?? "patches"} (${run.cursor + 1} of ${run.plan.length})`
        : run.phase === "verify"
          ? `verifying (${run.step ?? "install"})`
          : "writing the report";
    lines.push(`custom-build: a run started ${run.startedAt} is stopped while ${where}`);
    lines.push(
      `  report: ${run.reportDir}`,
      run.stopped?.code === 4
        ? "  next: scripts/custom-build rollback, then rebuild once upstream is fixed"
        : "  next: scripts/custom-build continue, or scripts/custom-build rollback",
    );
  } else lines.push("custom-build: no run in progress");
  const remote = git.resolveUpstreamRemote(ctx.repo, ctx.config),
    upstream = git.revParse(ctx.repo, `refs/remotes/${remote}/${ctx.config.upstream.branch}`);
  if (!upstream) lines.push(`  ${remote}/${ctx.config.upstream.branch} not fetched yet; rebuild to check patches`);
  else
    for (const r of rebaseCheck(ctx, upstream, knownRefs(ctx)))
      lines.push(
        r.clean === null
          ? `  ${r.display}: not fetched yet`
          : r.clean
            ? `  ${r.display}: merges cleanly onto upstream`
            : `  ${r.display}: needs a rebase onto upstream (${r.files.join(", ")})`,
      );
  return { code: 0, lines };
}
