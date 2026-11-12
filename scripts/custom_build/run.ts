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
import { pathToFileURL } from "node:url";
import * as configFile from "./config";
import type { Config, Harness, Patch, Planned, RebaseMode, RebaseResult, RunState, StepName } from "./config";
import * as git from "./git";
import * as github from "./github";
import * as harness from "./harness";
import * as live from "./live_events";
import type { LiveEvent, Sink, Stage } from "./live_events";
import * as liveState from "./live_state";
import * as rebase from "./rebase";
import * as report from "./report";
import * as sources from "./sources";
import * as listView from "./list_view";
import * as statusView from "./status_view";
import * as steps from "./steps";
import * as timings from "./timings";

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
  /** Asks a question on a terminal; absent or null without one. */
  ask?: (question: string) => string | null;
  /** Whether stdout is a terminal that takes colors. */
  color?: boolean;
  /** Receives the live events of `rebuild`, `rebase` and `continue`; plain output stays as it is. */
  signal?: Sink;
  /** Receives `rollback`'s tasks as they start and end, for its checklist on a terminal. */
  task?: (id: string, state: "running" | "done" | "skipped" | "failed", detail?: string) => void;
};
/** An error with lines that explain it, shown below its message; a card
 * leads with the shorter `headline` when there is one. */
export class Explained extends Error {
  constructor(
    message: string,
    readonly lines: string[],
    readonly headline?: string,
  ) {
    super(message);
  }
}
export type Code = 0 | 1 | 2 | 3 | 4 | 5;
/** How a command ended; `lines` are the summary for stdout. */
export type Outcome = { code: Code; lines: string[] };

const work = (ctx: Context) => join(ctx.dir, "work");
const binary = (ctx: Context) => join(ctx.repo, "dist", "corgi-custom");
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "none");
/** A readable merge commit per patch, so the custom branch's log and the run's report say what each patch is. */
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
  timings.tick(run, ms(ctx));
  configFile.saveRun(ctx.dir, run);
}
const ms = (ctx: Context) => ctx.now().getTime();
const startItem = (ctx: Context, run: RunState, key: string) => timings.startItem(run, key, ms(ctx));
const endItem = (ctx: Context, run: RunState, key: string, exceptMs = 0) =>
  timings.endItem(run, key, ms(ctx), exceptMs);
/** Adds a finished run to the timings history; a rolled-back one isn't recorded.
 * A history that can't be written is a warning: the run's outcome stands. */
function recordTimings(ctx: Context, run: RunState) {
  try {
    timings.tick(run, ms(ctx));
    timings.record(ctx.dir, timings.historyRun(run, run.kind ?? "rebuild", false, ctx.now()));
  } catch (error) {
    ctx.progress(`warning: could not record timings: ${(error as Error).message}`);
  }
}
function event(run: RunState, kind: string, fields: { patch?: string; step?: StepName; detail?: string } = {}) {
  run.events.push({ kind, ...fields });
}
/** What the live events of a run need beyond its state, kept while a sink listens. */
type Live = { history: timings.History; planning: liveState.Planning };
const lives = new WeakMap<RunState, Live>();
function liveOf(ctx: Context, run: RunState): Live {
  let l = lives.get(run);
  if (!l) lives.set(run, (l = { history: timings.loadHistory(ctx.dir), planning: {} }));
  return l;
}
const send = (ctx: Context, e: LiveEvent) => live.signal(ctx.signal, e);
const stage = (ctx: Context, name: Stage, state: "start" | "done", summary?: string) =>
  send(ctx, { t: "stage", stage: name, state, ...(summary === undefined ? {} : { summary }) });
/** Sends the run's estimate as it stands now. */
function sendEstimate(ctx: Context, run: RunState) {
  if (!ctx.signal) return;
  const l = liveOf(ctx, run);
  timings.tick(run, ms(ctx));
  send(ctx, { t: "estimate", estimate: liveState.liveEstimate(run, ctx.config, l.history, l.planning) });
}
/** Sends an item's end, then the estimate it changed. */
function itemEnd(ctx: Context, run: RunState, e: LiveEvent) {
  if (!ctx.signal) return;
  send(ctx, e);
  sendEstimate(ctx, run);
}
/** The upstream as the view's header names it: how many commits it has beyond the last build. */
function upstreamOf(ctx: Context, run: RunState, remote: string, tip: string): live.Upstream {
  const base = run.startTip ?? git.revParse(ctx.repo, `refs/heads/${ctx.config.branch}`),
    count = base && tip ? git.git(ctx.repo, ["rev-list", "--count", "--no-merges", `${base}..${tip}`]).stdout : "0";
  return { name: `${remote}/${ctx.config.upstream.branch}`, tip, newCommits: Number(count) || 0 };
}
/** Each patch's page, as `list` links it. */
function patchLinks(ctx: Context): Record<string, string> {
  const fork = git.hasRemote(ctx.repo, "origin") ? git.remoteTarget(ctx.repo, "origin", "push") : null,
    links: Record<string, string> = {};
  for (const p of ctx.config.patches) {
    const url = listView.patchLink(p.source, fork);
    if (url) links[sources.display(p.source)] = url;
  }
  return links;
}
/** Each step's log, for its name in the view; none before the report has a directory. */
function stepLinks(run: RunState): Record<string, string> {
  if (!run.reportDir) return {};
  return Object.fromEntries(
    configFile.stepNames.map(step => [step, pathToFileURL(resolve(run.reportDir, "steps", `${step}.log`)).href]),
  );
}
/** Starts the live events of a new run, before its fetch. */
function begin(ctx: Context, run: RunState, remote: string, stages: Stage[]) {
  if (!ctx.signal) return;
  const { config } = ctx,
    l = liveOf(ctx, run),
    command = run.kind ?? "rebuild",
    known = git.revParse(ctx.repo, `refs/remotes/${remote}/${config.upstream.branch}`) ?? "";
  send(ctx, {
    t: "begin",
    command,
    branch: config.branch,
    upstream: upstreamOf(ctx, run, remote, known),
    stages,
    items:
      command === "rebuild"
        ? { merge: config.patches.map(p => sources.display(p.source)), verify: [...configFile.stepNames] }
        : {},
    estimate: liveState.liveEstimate(run, config, l.history),
    links: patchLinks(ctx),
    harness: config.harness?.kind ?? null,
    harnessMedianMs: timings.harnessMedian(l.history, command),
    elapsedMs: 0,
  });
  stage(ctx, "fetch", "start");
}
/** Ends the fetch stage with the upstream it fetched: `7 upstream commits, 8 patches`. */
function fetched(ctx: Context, run: RunState, remote: string, patches: number | null) {
  if (!ctx.signal) return;
  const upstream = upstreamOf(ctx, run, remote, run.upstream),
    commits = plural(upstream.newCommits, "upstream commit");
  send(ctx, {
    t: "stage",
    stage: "fetch",
    state: "done",
    summary: patches === null ? commits : `${commits}, ${plural(patches, "patch", "patches")}`,
    upstream,
  });
  sendEstimate(ctx, run);
}
/** Replays a stopped run's events before it goes on. */
function replay(ctx: Context, run: RunState, command: "continue" | "rebase") {
  if (!ctx.signal) return;
  const remote = git.resolveUpstreamRemote(ctx.repo, ctx.config);
  for (const e of liveState.fromRun(run, ctx.config, {
    history: liveOf(ctx, run).history,
    command,
    upstream: upstreamOf(ctx, run, remote, run.upstream),
    links: { ...patchLinks(ctx), ...(run.kind === "rebase" ? {} : stepLinks(run)) },
  }))
    send(ctx, e);
}
/** Sends the outcome as the run's end and returns it. */
function ended(ctx: Context, run: RunState, outcome: Outcome): Outcome {
  if (!ctx.signal) return outcome;
  // The active time up to now, for the card's comparison with the last run.
  if (run.timing) timings.tick(run, ms(ctx));
  send(ctx, live.end(outcome, run.reportDir ? join(run.reportDir, "report.md") : null, run.timing?.activeMs));
  return outcome;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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
export async function rebuild(
  ctx: Context,
  o: { push?: boolean; rebase?: RebaseMode; inWorktree?: boolean } = {},
): Promise<Outcome> {
  const { repo, config } = ctx;
  git.requireVersion(repo);
  const busy = configFile.loadRun(ctx.dir);
  if (busy) throw inProgress(ctx, busy);
  if (!git.isClean(repo)) throw Error("tracked files have uncommitted changes; commit or stash them first");
  if (config.branch === config.upstream.branch || !git.validBranchName(repo, config.branch))
    throw Error(`${config.branch} can't be the custom build branch`);
  const elsewhere = git.worktreeWith(repo, config.branch);
  if (elsewhere)
    throw Error(`${config.branch} is checked out in another worktree (${elsewhere}); switch it away first`);
  const remote = preflight(ctx, o);

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
  const mode = o.rebase ?? config.rebase ?? "all";
  timings.resume(run, ms(ctx));
  begin(ctx, run, remote, liveState.stagesOf(run, config, mode !== "off"));
  startItem(ctx, run, "fetch");
  ctx.progress(`fetching ${remote} ${config.upstream.branch}`);
  run.upstream = git.fetchRemote(repo, remote, config.upstream.branch);
  for (const patch of config.patches) {
    ctx.progress(`fetching ${sources.display(patch.source)}`);
    run.plan.push(fetchPatch(ctx, patch, remote, run.upstream, run));
  }
  endItem(ctx, run, "fetch");
  fetched(ctx, run, remote, run.plan.length);

  mkdirSync(work(ctx), { recursive: true });
  if (existsSync(binary(ctx))) {
    run.startBinary = join(work(ctx), "corgi-custom.start");
    copyFileSync(binary(ctx), run.startBinary);
  }
  run.reportDir = newReportDir(ctx);
  copyTool(ctx);
  exclude(ctx);
  // Before the run is recorded: a rebase never stops it, and an interrupted one leaves each branch at a checked tip.
  rebase.cleanLeftovers({ repo, workDir: work(ctx) });
  if (mode !== "off") await rebasePhase(ctx, run, remote, mode, !!o.inWorktree);
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

/** The checks `rebuild` and `rebase` share; returns the upstream remote. */
function preflight(ctx: Context, o: { push?: boolean }): string {
  const { repo, config } = ctx;
  // The run resets the custom branch and replaces its backup, so neither may be a patch.
  const owned = [config.branch, `${config.branch}-prev`],
    taken = config.patches.find(p => p.source.kind === "branch" && owned.includes(p.source.name));
  if (taken)
    throw Error(
      `the patch ${sources.display(taken.source)} is a branch the tool resets (${owned.join(", ")}); rename it or set another branch`,
    );
  const remote = git.resolveUpstreamRemote(repo, config);
  if (!git.hasRemote(repo, remote)) throw Error(`no ${remote} remote to fetch upstream from`);
  // The destinations decide, not the names: origin may fetch upstream and push to the fork.
  if (o.push && rebase.forkProblem({ repo, config, upstreamRemote: remote }))
    throw Error("--push needs an origin remote of your own, apart from upstream; nothing was changed");
  return remote;
}

/** A new `reports/<timestamp>` directory for a run. */
function newReportDir(ctx: Context): string {
  const reports = join(ctx.dir, "reports"),
    base = stamp(ctx.now());
  let name = base;
  for (let n = 2; existsSync(join(reports, name)); n++) name = `${base}-${n}`;
  mkdirSync(join(reports, name), { recursive: true });
  return join(reports, name);
}

function rebaseEnv(
  ctx: Context,
  o: {
    upstream: string;
    remote: string;
    reportDir: string;
    nextCall: () => number;
    onUse: (use: configFile.HarnessUse) => void;
  },
): rebase.Env {
  return {
    repo: ctx.repo,
    workDir: work(ctx),
    config: ctx.config,
    env: ctx.env,
    echo: ctx.echo,
    progress: ctx.progress,
    upstream: o.upstream,
    upstreamRemote: o.remote,
    reportDir: o.reportDir,
    templates: templates(ctx),
    nextCall: o.nextCall,
    onUse: o.onUse,
    harness: harnessFor(ctx),
    signal: ctx.signal,
  };
}
const runEnv = (ctx: Context, run: RunState) =>
  rebaseEnv(ctx, {
    upstream: run.upstream,
    remote: git.resolveUpstreamRemote(ctx.repo, ctx.config),
    reportDir: run.reportDir,
    nextCall: () => ++run.calls,
    onUse: use => recordUse(ctx, run, use),
  });

/** Rebuild's rebase phase: rebases the own patches and merges their new tips;
 * a branch that can't be rebased keeps its old tip and gets a handoff. */
async function rebasePhase(ctx: Context, run: RunState, remote: string, mode: RebaseMode, inWorktree: boolean) {
  const e = rebaseEnv(ctx, {
    upstream: run.upstream,
    remote,
    reportDir: run.reportDir,
    nextCall: () => ++run.calls,
    onUse: use => recordUse(ctx, run, use),
  });
  stage(ctx, "rebase", "start");
  const skip = new Set(run.plan.filter(p => p.skip).map(p => p.display)),
    chosen = rebase.select(e, mode, { skip, fetch: true, inWorktree });
  if (chosen.note) event(run, "rebase-note", { detail: chosen.note });
  run.rebased = chosen.results;
  for (const r of chosen.results) send(ctx, liveState.rebaseItem(r));
  const planning = ctx.signal ? liveOf(ctx, run).planning : {};
  planning.rebasing = chosen.targets.map(t => t.branch);
  sendEstimate(ctx, run);
  for (const t of chosen.targets) {
    startItem(ctx, run, `rebase:${t.branch}`);
    send(ctx, { t: "item", stage: "rebase", id: t.branch, state: "start" });
    const r = await rebase.rebaseTarget(e, t, { stopOnConflict: false });
    endItem(ctx, run, `rebase:${t.branch}`);
    if (!("result" in r)) throw Error(`the rebase of ${t.branch} stopped inside rebuild, which never stops`);
    run.rebased.push(r.result);
    planning.rebasing = planning.rebasing.filter(b => b !== t.branch);
    itemEnd(ctx, run, liveState.rebaseItem(r.result));
  }
  stage(ctx, "rebase", "done", liveState.rebaseSummary(run.rebased));
  // Build what the own branches now hold: rebased in this run, or in an earlier
  // one and not pushed yet; every patch naming the branch gets its new tip.
  for (const r of run.rebased) {
    const p = run.plan.find(p => p.display === r.patch),
      moved = run.rebased.find(m => m.branch === r.branch && m.to && (m.outcome === "rebased" || m.pending));
    if (p && moved) {
      p.commit = moved.to!;
      p.ref = `refs/heads/${r.branch}`;
    }
  }
}

/** Pushes the branches this run rebased when `--push` or a yes on the terminal
 * says so, otherwise prints how. */
function offerPush(ctx: Context, run: RunState): { lines: string[]; refused: boolean } {
  const moved = (run.rebased ?? []).filter(r => (r.outcome === "rebased" || r.pending) && r.to && !r.push);
  if (!moved.length) return { lines: [], refused: false };
  const names = moved.map(r => r.branch).join(", "),
    n = moved.length,
    answer = run.push
      ? "y"
      : ask(ctx, run, `Force-push ${n} rebased branch${n === 1 ? "" : "es"} to origin (${names})? [y/N] `);
  if (!/^y(es)?$/i.test(answer?.trim() ?? ""))
    return { lines: moved.map(r => `  push: ${rebase.pushCommand(r)}`), refused: false };
  startItem(ctx, run, "push");
  stage(ctx, "push", "start");
  ctx.progress(`pushing ${names} to origin`);
  const lines = rebase.push(ctx.repo, run.reportDir, moved);
  endItem(ctx, run, "push");
  stage(ctx, "push", "done", `${plural(moved.filter(r => r.push === "pushed").length, "branch", "branches")} pushed`);
  return { lines, refused: moved.some(r => r.push === "refused") };
}

/** Asks on the terminal; the wait for the answer isn't the run's time. */
function ask(ctx: Context, run: RunState, question: string): string | null | undefined {
  if (!ctx.ask) return undefined;
  timings.pause(run, ms(ctx));
  try {
    return ctx.ask(question);
  } finally {
    timings.resume(run, ms(ctx));
  }
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
  // The merge's own time: the harness calls resolving its conflict are timed apart.
  const harnessMs = (run.harnessUsage ?? [])
    .filter(u => u.kind === "conflict" && u.patch === p.display)
    .reduce((total, u) => total + u.seconds * 1000, 0);
  endItem(ctx, run, `merge:${p.display}`, harnessMs);
  if (kind !== "skipped-merged" && kind !== "already-contained") {
    run.merged.push({ source: p.display, commit: p.commit!, description: p.description });
    p.merge = git.must(ctx.repo, ["rev-parse", "HEAD"]);
  }
  event(run, kind, { patch: p.display });
  run.cursor++;
  run.attempts = 0;
  save(ctx, run);
  itemEnd(ctx, run, {
    t: "item",
    stage: "merge",
    id: p.display,
    state: kind === "skipped-merged" || kind === "already-contained" ? "skipped" : "done",
    outcome: kind,
  });
}

async function mergeLoop(ctx: Context, run: RunState): Promise<Outcome | null> {
  const { repo } = ctx;
  stage(ctx, "merge", "start");
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
    startItem(ctx, run, `merge:${p.display}`);
    send(ctx, { t: "item", stage: "merge", id: p.display, state: "start" });
    ctx.progress(`merging ${p.display}`);
    const out = git.mergeNoFF(repo, p.commit!, mergeMessage(p));
    if (out.code === 0) {
      advance(ctx, run, p, "merged");
      continue;
    }
    if (!git.mergeInProgress(repo)) throw Error(`merging ${p.display} failed: ${(out.stderr || out.stdout).trim()}`);
    // A merge the user aborted is merged again here; its unresolved clash is replaced, not listed twice.
    run.conflicts = run.conflicts.filter(c => c.patch !== p.display || c.by !== null);
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
      const resolution = await resolveWithHarness(ctx, run, p, unmerged, h);
      if (resolution === true) {
        commitAgentMerge(ctx, run, p);
        continue;
      }
      const what = resolution
        ? `the harness failed to run on the conflict in ${p.display}: ${resolution.reason}`
        : `the harness could not resolve the conflict in ${p.display} in ${run.attempts} attempts`;
      send(ctx, { t: "item", stage: "merge", id: p.display, state: "failed", outcome: "stopped", detail: what });
      return stop(
        ctx,
        run,
        5,
        [what, `files: ${unmerged.join(", ")}`, ...(resolution ? [`harness log: ${resolution.log}`] : [])],
        ["resolve the conflicts yourself, `git add` the files, then continue"],
      );
    }
    send(ctx, {
      t: "item",
      stage: "merge",
      id: p.display,
      state: "failed",
      outcome: "stopped",
      detail: `merge conflict in ${unmerged.join(", ")}`,
    });
    return stop(
      ctx,
      run,
      2,
      [`merge conflict in ${p.display}`, `files: ${unmerged.join(", ")}`],
      ["resolve the conflicts, `git add` the files, then continue"],
    );
  }
  stage(ctx, "merge", "done");
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
async function restoreDependencies(ctx: Context, log: string) {
  ctx.progress("restoring dependencies after rollback");
  ctx.task?.("install", "running", "restoring dependencies");
  const ok = await steps.runStep(steps.commands("install", ctx.config, stepVars(ctx)), {
    cwd: ctx.repo,
    log,
    env: ctx.env,
    echo: ctx.echo,
  });
  if (!ok) {
    ctx.task?.("install", "failed", `failed; see ${log}`);
    throw Error(`dependency restore failed after rollback; see ${log}`);
  }
  ctx.task?.("install", "done", "dependencies restored");
}
/** Puts back the binary saved as `from` (moved away unless `keep`); without
 * one, the run's binary goes since there was none before. */
function restoreBinary(ctx: Context, from: string | null, keep: boolean) {
  const target = binary(ctx),
    shown = relative(ctx.repo, target);
  ctx.task?.("binary", "running");
  if (from && existsSync(from)) {
    mkdirSync(join(ctx.repo, "dist"), { recursive: true });
    replaceFile(from, target);
    if (!keep) rmSync(from, { force: true });
    ctx.task?.("binary", "done", `${shown} restored`);
  } else if (!from && existsSync(target)) {
    rmSync(target, { force: true });
    ctx.task?.("binary", "done", `${shown} removed; there was none before`);
  } else ctx.task?.("binary", "skipped", "no saved binary");
}
async function verifyLoop(ctx: Context, run: RunState): Promise<Outcome | null> {
  const { repo } = ctx;
  send(ctx, { t: "stage", stage: "verify", state: "start", links: stepLinks(run) });
  // Sends the step's failure, for the stops below.
  const failed = (step: StepName, detail: string) =>
    send(ctx, { t: "item", stage: "verify", id: step, state: "failed", outcome: "failed", detail });
  for (let i = configFile.stepNames.indexOf(run.step ?? "install"); i < configFile.stepNames.length; i++) {
    const step = configFile.stepNames[i];
    run.step = step;
    save(ctx, run);
    if (step === "install" && !steps.installNeeded(repo, run.startHead)) {
      if (ctx.signal) {
        liveOf(ctx, run).planning.skipped = ["step:install"];
        itemEnd(ctx, run, {
          t: "item",
          stage: "verify",
          id: step,
          state: "skipped",
          outcome: "skipped",
          detail: "dependencies unchanged",
        });
      }
      continue;
    }
    ctx.progress(`running ${step}`);
    const cmds = steps.commands(step, ctx.config, stepVars(ctx)),
      cmd = cmds[cmds.length - 1],
      log = join(run.reportDir, "steps", `${step}.log`);
    startItem(ctx, run, `step:${step}`);
    send(ctx, { t: "item", stage: "verify", id: step, state: "start" });
    // A flaky failure would otherwise cost an upstream run and an agent fix.
    const keep = join(
        run.reportDir,
        "steps",
        `${step}-flaky-${run.events.filter(e => e.kind === "flaky").length + 1}.log`,
      ),
      tried = await steps.runWithRetry(cmds, {
        cwd: repo,
        log,
        env: ctx.env,
        echo: ctx.echo,
        keep,
        again: failedLog => steps.failedAgain(step, ctx.config, stepVars(ctx), failedLog),
        onRetry: () => {
          ctx.progress(`${step} failed; running what failed once more in case it is flaky`);
          send(ctx, { t: "retry", stage: "verify", id: step, why: "flaky", detail: `${step} failed once` });
        },
      });
    endItem(ctx, run, `step:${step}`);
    if (tried.ok) {
      if (tried.flaky) event(run, "flaky", { step, detail: keep });
      event(run, "passed", { step });
      save(ctx, run);
      const fixed = run.fixes.some(f => f.step === step && f.by === "agent");
      itemEnd(ctx, run, {
        t: "item",
        stage: "verify",
        id: step,
        state: "done",
        outcome: tried.flaky ? "flaky" : fixed ? "fixed" : "passed",
      });
      continue;
    }
    ctx.progress(`${step} failed again; trying it on plain upstream`);
    send(ctx, { t: "retry", stage: "verify", id: step, why: "upstream", detail: `${step} failed twice` });
    const alone = await onUpstream(ctx, run, step);
    if (alone !== "passed") {
      event(run, "upstream-broken", { step });
      save(ctx, run);
      failed(step, `fails on plain upstream ${short(run.upstream)} too`);
      return stop(
        ctx,
        run,
        4,
        [`${step} fails on plain upstream ${short(run.upstream)} too: upstream is broken`, `log: ${log}`],
        ["roll back, then rebuild once upstream is fixed"],
      );
    }
    const failure: StepFailure = { step, command: cmd.join(" "), log },
      h = harnessFor(ctx);
    if (h) {
      // Fixes that keep breaking each other stop the run instead of looping; a
      // tree the fixes repaired never gets here, so it isn't stopped.
      const agentFixes = run.fixes.filter(f => f.by === "agent").length;
      if (agentFixes >= (h.attempts ?? 3) * configFile.stepNames.length) {
        failed(step, `fails again after the harness's ${agentFixes} fixes`);
        return stop(
          ctx,
          run,
          5,
          [`${step} fails again after the harness's ${agentFixes} fixes`, `log: ${log}`],
          ["fix it in the working tree (or commit the fix), then continue"],
          failure,
        );
      }
      const fix = await fixWithHarness(ctx, run, step, cmds, log, h);
      if (fix === true) {
        // A fix can break a step that passed before it, so everything runs again.
        i = -1;
        continue;
      }
      failed(
        step,
        fix ? `the harness failed to run: ${fix.reason}` : `the harness could not fix it in ${run.attempts} attempts`,
      );
      return stop(
        ctx,
        run,
        5,
        [
          fix
            ? `the harness failed to run on ${step}: ${fix.reason}`
            : `the harness could not fix ${step} in ${run.attempts} attempts`,
          `command: ${cmd.join(" ")}`,
          `log: ${log}`,
          ...(fix ? [`harness log: ${fix.log}`] : []),
        ],
        [
          fix
            ? "fix the harness, then continue to let it try again; or fix the step yourself, then continue"
            : "fix it in the working tree (or commit the fix), then continue",
        ],
        failure,
      );
    }
    failed(step, "it passes on plain upstream: a patch breaks it");
    return stop(
      ctx,
      run,
      3,
      [`${step} failed`, `command: ${cmd.join(" ")}`, `log: ${log}`],
      ["fix it in the working tree (or commit the fix), then continue"],
      failure,
    );
  }
  stage(ctx, "verify", "done");
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

/** Keeps a finished harness call in the run state, for `continue` and the report. */
function recordUse(ctx: Context, run: RunState, use: configFile.HarnessUse) {
  (run.harnessUsage ??= []).push(use);
  // A rejected call, like one that failed to start, says nothing about how long a fix takes.
  if (use.ok) timings.harnessCall(run, use.seconds * 1000);
  sendEstimate(ctx, run);
}
/** Sends a harness call's end, and a rejected one as a retry. */
function harnessEnd(
  ctx: Context,
  call: { stage: Stage; id: string; attempt: number; limit: number },
  usage: harness.Call["usage"],
  verdict: harness.Verdict,
) {
  send(ctx, { t: "harness", state: "end", ...call, usage, ...harness.outcome(verdict) });
  if (!verdict.ok) send(ctx, { t: "retry", stage: call.stage, id: call.id, why: "harness", detail: verdict.reason });
}

/** A harness call that failed to start: why, and its log. */
type Broken = { reason: string; log: string };
/** Asks the harness to resolve the conflict in progress until a result passes
 * the tool's checks or the attempts run out, the conflict restored after each
 * rejection. True when resolved; a harness that failed to start ends the tries. */
async function resolveWithHarness(
  ctx: Context,
  run: RunState,
  p: Planned,
  files: string[],
  h: Harness,
): Promise<true | Broken | null> {
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
    const liveCall = { stage: "merge" as const, id: p.display, attempt: run.attempts, limit };
    send(ctx, { t: "harness", state: "start", ...liveCall, files });
    const started = performance.now();
    const call = await harness.invoke(h, "conflict", text, {
      repo,
      reportDir: run.reportDir,
      number: run.calls,
      env: ctx.env,
      echo: ctx.echo,
      onActivity: live.activity(ctx.signal, liveCall),
    });
    const { verdict, broken } = harness.judge(call, h, () =>
      harness.acceptConflict(repo, files, head, before, excluded(ctx)),
    );
    harnessEnd(ctx, liveCall, call.usage, verdict);
    recordUse(ctx, run, {
      call: run.calls,
      kind: "conflict",
      patch: p.display,
      attempt: run.attempts,
      ...harness.outcome(verdict),
      seconds: harness.since(started),
      usage: call.usage,
    });
    if (verdict.ok) return true;
    ctx.progress(`rejected the harness's resolution: ${verdict.reason}`);
    harness.discard(repo, head, before, excluded(ctx));
    git.remerge(repo, p.commit!, mergeMessage(p), files);
    run.harnessCall = null;
    save(ctx, run);
    if (broken) return { reason: verdict.reason, log: call.log };
  }
  return null;
}

/** Asks the harness to fix a failing step, committing each accepted change as
 * its own fix commit, until the step passes or the attempts run out. True when
 * fixed; a harness that failed to start ends the tries. */
async function fixWithHarness(
  ctx: Context,
  run: RunState,
  step: StepName,
  cmds: string[][],
  log: string,
  h: Harness,
): Promise<true | Broken | null> {
  const cmd = cmds[cmds.length - 1];
  const { repo } = ctx,
    limit = h.attempts ?? 3;
  run.attempts = 0;
  // The failure each fix answers: a fix that leaves the step failing hands the
  // next attempt a new failure, which the next fix is recorded against.
  const keepFailure = () => {
    const path = join(run.reportDir, "steps", `${step}-failed-${run.fixes.length + 1}.log`);
    copyFileSync(log, path);
    return path;
  };
  let failedLog = keepFailure();
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
    const liveCall = { stage: "verify" as const, id: step, attempt: run.attempts, limit };
    send(ctx, { t: "harness", state: "start", ...liveCall });
    const started = performance.now();
    const call = await harness.invoke(h, "build", text, {
      repo,
      reportDir: run.reportDir,
      number: run.calls,
      env: ctx.env,
      echo: ctx.echo,
      onActivity: live.activity(ctx.signal, liveCall),
    });
    const { verdict, broken } = harness.judge(call, h, () => harness.acceptFix(repo, head, before, excluded(ctx)));
    harnessEnd(ctx, liveCall, call.usage, verdict);
    recordUse(ctx, run, {
      call: run.calls,
      kind: "build",
      step,
      attempt: run.attempts,
      ...harness.outcome(verdict),
      seconds: harness.since(started),
      usage: call.usage,
    });
    if (!verdict.ok) {
      ctx.progress(`rejected the harness's fix: ${verdict.reason}`);
      if (call.timedOut) harness.discard(repo, head, before, excluded(ctx));
      run.harnessCall = null;
      save(ctx, run);
      if (broken) return { reason: verdict.reason, log: call.log };
      continue;
    }
    commitAgentFix(ctx, run, step, verdict.files, failedLog);
    ctx.progress(`running ${step} again`);
    startItem(ctx, run, `step:${step}`);
    send(ctx, { t: "item", stage: "verify", id: step, state: "start" });
    const passed = await steps.runStep(cmds, { cwd: repo, log, env: ctx.env, echo: ctx.echo });
    endItem(ctx, run, `step:${step}`);
    if (passed) {
      event(run, "passed", { step });
      save(ctx, run);
      itemEnd(ctx, run, { t: "item", stage: "verify", id: step, state: "done", outcome: "fixed" });
      return true;
    }
    if (run.attempts < limit) failedLog = keepFailure();
  }
  return null;
}
/** Runs `step` on plain upstream, to tell a broken upstream from a broken patch. */
function onUpstream(ctx: Context, run: RunState, step: StepName) {
  return steps.runIsolated({
    repo: ctx.repo,
    workDir: work(ctx),
    name: "upstream",
    step,
    base: run.upstream,
    merges: [],
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
/** A failing step a run stops at: what it ran and its output. */
type StepFailure = { step: StepName; command: string; log: string };
async function stop(
  ctx: Context,
  run: RunState,
  code: Code,
  what: string[],
  next: string[],
  failure?: StepFailure,
): Promise<Outcome> {
  run.stopped = { code, snapshot: git.snapshot(ctx.repo) };
  run.stopFailure = failure ? await blame(ctx, run, failure) : null;
  save(ctx, run);
  const why = run.stopFailure && cause(run.stopFailure.attribution),
    failing =
      run.stopFailure && existsSync(run.stopFailure.log)
        ? steps.failureSummary(run.stopFailure.step, readFileSync(run.stopFailure.log, "utf8"))
        : null,
    reason = [
      what[0],
      ...(failing ? [`failing: ${failing}`] : []),
      ...(why ? [`caused by: ${why}`] : []),
      ...what.slice(1),
    ],
    handoffs = await writeReport(ctx, run, code, reason),
    agent = failure && run.stopFailure ? agentHint(ctx, run, failure, run.stopFailure, why) : [];
  return ended(ctx, run, {
    code,
    lines: [
      `custom-build stopped: ${reason[0]}`,
      ...reason.slice(1).map(line => `  ${line}`),
      `  report: ${join(run.reportDir, "report.md")}`,
      ...handoffs.map(path => `  handoff: ${path}`),
      ...next.map(line => `  ${line}`),
      ...agent.map(line => `  ${line}`),
      // Upstream breakage isn't fixed by continuing the pinned run.
      ...(code === 4 ? [] : [`  continue: scripts/custom-build continue`]),
      `  undo the run: scripts/custom-build rollback`,
      `  (without the tool in this checkout: ${toolCommand(ctx, code === 4 ? "rollback" : "continue")})`,
    ],
  });
}

/** The patches a failing step points at, worked out once per step and tree:
 * a stop that comes back to the same failure doesn't run them again. */
async function blame(ctx: Context, run: RunState, f: StepFailure): Promise<configFile.StopFailure> {
  const head = git.must(ctx.repo, ["rev-parse", "HEAD"]),
    known = run.stopFailure;
  if (known?.step === f.step && known.head === head) return known;
  // The step's log is written again by the next run; keep the failure this stop answers.
  const log = join(run.reportDir, "steps", `${f.step}-failed-${run.fixes.length + 1}.log`);
  if (existsSync(f.log) && resolve(f.log) !== resolve(log)) copyFileSync(f.log, log);
  ctx.progress(`working out which patches ${f.step} fails on`);
  const attribution = await steps.attribute({
    repo: ctx.repo,
    workDir: work(ctx),
    step: f.step,
    upstream: run.upstream,
    merged: mergedPatches(run),
    fixFiles: [],
    log,
    config: ctx.config,
    logDir: join(run.reportDir, "isolated"),
    env: ctx.env,
    echo: ctx.echo,
    progress: ctx.progress,
  });
  return { step: f.step, head, log, attribution };
}
const mergedPatches = (run: RunState) =>
  run.plan.filter(p => !p.skip && p.merge).map(p => ({ display: p.display, ref: p.commit!, merge: p.merge! }));
/** The patches a failure points at, in a few words; null when none does. */
function cause(attribution: configFile.Attribution[]): string | null {
  const drift = attribution.filter(a => a.kind === "build-drift").map(a => a.patch);
  if (drift.length) return `${drift.join(", ")} ${drift.length > 1 ? "fail" : "fails"} alone on upstream`;
  if (attribution.length > 1) return `${attribution.map(a => a.patch).join(" and ")} only together`;
  if (attribution.length) return `${attribution[0].patch} together with the other patches`;
  return null;
}
/** Writes a prompt for fixing the failing step with an agent; returns the
 * lines that name it and the command that runs it in the checkout. */
function agentHint(
  ctx: Context,
  run: RunState,
  f: StepFailure,
  stopped: configFile.StopFailure,
  why: string | null,
): string[] {
  const path = join(run.reportDir, `fix-${f.step}.md`),
    excerpt = existsSync(stopped.log) ? readFileSync(stopped.log, "utf8").split("\n").slice(-200).join("\n") : "",
    h = ctx.config.harness,
    exe = !h?.command[0] ? "claude" : h.command[0].includes("/") ? resolve(ctx.repo, h.command[0]) : h.command[0];
  writeFileSync(
    path,
    harness.fill(harness.template("fix", templates(ctx)), {
      step: f.step,
      command: f.command,
      cause: why ?? "not worked out: no merged patch touches the files the failure names",
      patches: run.merged.map(m => `${m.source}: ${m.description}`),
      log: stopped.log,
      logExcerpt: excerpt,
    }),
  );
  return [
    `prompt for an agent: ${path}`,
    `run it: cd ${rebase.word(ctx.repo)} && ${rebase.word(exe)} "$(cat ${rebase.word(path)})"`,
  ];
}

/** The run's report, rebase check and handoffs; returns the handoff paths. */
async function writeReport(ctx: Context, run: RunState, code: Code, reason: string[]): Promise<string[]> {
  const { repo } = ctx,
    active = run.plan.filter(p => !p.skip),
    // The commits this run built, not the refs: a patch branch may have moved on during a stop.
    mergeCheck = rebaseCheck(
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
        merged: mergedPatches(run),
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
  for (const r of mergeCheck.filter(r => r.clean === false))
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
  const handed = new Set(mergeCheck.filter(r => r.clean === false).map(r => r.display));
  for (const r of run.rebased ?? []) {
    if (r.outcome !== "failed") continue;
    if (r.step) {
      const command = steps.command(r.step, ctx.config, stepVars(ctx)).join(" "),
        excerpt = r.log && existsSync(r.log) ? readFileSync(r.log, "utf8").trimEnd().split("\n").slice(-40) : [];
      handoffs.push(
        report.writeHandoff(run.reportDir, template, {
          ...handoffBase(ctx, run, r.patch, upstream),
          kind: "rebase-checks",
          problem: `Rebased onto upstream main, \`${command}\` (${r.step}) fails on ${r.branch} alone:\n\n\`\`\`text\n${excerpt.join("\n")}\n\`\`\``,
          cause: "upstream main moved on",
          fix: `none; ${r.branch} kept its old tip ${r.from.slice(0, 7)}`,
          task: `Rebase this branch onto the latest upstream main and make \`${command}\` pass, keeping the change's intent. Check that the repository's typecheck, tests and build pass.`,
        }),
      );
    } else if (!handed.has(r.patch))
      handoffs.push(
        report.writeHandoff(run.reportDir, template, {
          ...handoffBase(ctx, run, r.patch, upstream),
          kind: "rebase",
          problem: `Rebasing ${r.branch} onto upstream main stopped: ${r.reason}.`,
          cause: "upstream main moved on",
          fix: "none",
          task: `Rebase this branch onto the latest upstream main and resolve the conflicts, keeping the change's intent. Check that the repository's typecheck, tests and build still pass.`,
        }),
      );
  }
  const attributed = (
    step: StepName,
    log: string | undefined,
    a: configFile.Attribution,
    fix: string,
    hint: string,
  ) => {
    const command = steps.command(step, ctx.config, stepVars(ctx)).join(" "),
      excerpt = log && existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").slice(-40) : [];
    handoffs.push(
      report.writeHandoff(run.reportDir, template, {
        ...handoffBase(ctx, run, a.patch, upstream),
        kind: a.kind,
        problem: `\`${command}\` (${step}) failed in the custom build:\n\n\`\`\`text\n${excerpt.join("\n")}\n\`\`\``,
        cause:
          a.kind === "build-drift"
            ? "upstream main moved on"
            : a.others.length
              ? `clashes with: ${a.others.join(", ")}`
              : "clashes with the other changes in this build",
        fix,
        task:
          a.kind === "build-drift"
            ? `With this branch merged alone onto the latest upstream main, \`${command}\` fails. Update the branch onto upstream main and fix it${hint}.`
            : `This branch and ${a.others.join(", ")} fail \`${command}\` only when merged together. Decide with their authors which side adapts, or wait until one of them is merged upstream, then update this branch if it is the one to change.`,
      }),
    );
  };
  for (const fix of run.fixes)
    for (const a of fix.attribution ?? []) {
      const stat = git.git(repo, ["show", "--stat", "--format=", fix.commit]).stdout.trimEnd();
      attributed(
        fix.step,
        fix.log,
        a,
        `${fix.commit.slice(0, 7)} custom-build: fix ${fix.step} (${fix.by})\n\n\`\`\`text\n${stat}\n\`\`\``,
        "; the fix the custom build applied is shown above as a hint",
      );
    }
  // A run stopped at a failing step hands it to the patches it points at before anyone fixed it.
  const stopped = run.stopped ? run.stopFailure : null;
  for (const a of stopped?.attribution ?? [])
    attributed(stopped!.step, stopped!.log, a, "none; the custom build stopped on it", "");
  report.writeReport(run, { outcome: { code, reason }, upstream: run.upstream, pulled, rebase: mergeCheck, handoffs });
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
  return {
    patch: display,
    description:
      p?.description ?? ctx.config.patches.find(c => sources.display(c.source) === display)?.description ?? "",
    link: p?.prLink ?? (source ? sources.prLink(source) : null) ?? checkout,
    upstream,
    checkout,
  };
}

async function finish(ctx: Context, run: RunState): Promise<Outcome> {
  const { repo, config } = ctx,
    pushed = offerPush(ctx, run),
    handoffs = await writeReport(ctx, run, 0, []),
    lines = [...summary(run), ...pushed.lines, ...handoffs.map(path => `  handoff: ${path}`)];
  // The backups are the run's start, both halves, so a rollback never mixes builds.
  if (run.startTip) git.must(repo, ["branch", "-f", `${config.branch}-prev`, run.startTip]);
  else if (git.branchExists(repo, `${config.branch}-prev`)) git.must(repo, ["branch", "-D", `${config.branch}-prev`]);
  // Copy, clear the run, then drop the start copy: dying in between leaves a
  // run whose `continue` makes the same backup again.
  if (run.startBinary && existsSync(run.startBinary)) replaceFile(run.startBinary, `${binary(ctx)}.prev`);
  else if (!run.startBinary) rmSync(`${binary(ctx)}.prev`, { force: true });
  configFile.clearRun(ctx.dir);
  if (run.startBinary) rmSync(run.startBinary, { force: true });
  let code: Code = pushed.refused ? 1 : 0;
  if (config.afterBuild) {
    startItem(ctx, run, "after-build");
    stage(ctx, "after-build", "start");
    ctx.progress(`running after-build command: ${config.afterBuild.join(" ")}`);
    const ok = await steps.runStep(config.afterBuild, {
      cwd: repo,
      log: join(run.reportDir, "steps", "after-build.log"),
      env: ctx.env,
      echo: ctx.echo,
    });
    endItem(ctx, run, "after-build");
    stage(ctx, "after-build", "done", ok ? "passed" : "failed");
    lines.push(ok ? "after-build command: passed" : "after-build command failed; the build itself succeeded");
  }
  if (run.push) {
    startItem(ctx, run, "push");
    stage(ctx, "push", "start");
    ctx.progress(`pushing ${config.branch} to origin`);
    const out = git.git(repo, ["push", "--force-with-lease", "origin", `${config.branch}:${config.branch}`]);
    endItem(ctx, run, "push");
    stage(ctx, "push", "done", out.code === 0 ? `pushed ${config.branch}` : `push of ${config.branch} failed`);
    if (out.code === 0) lines.push(`pushed ${config.branch} to origin`);
    else {
      lines.push(`push to origin failed: ${(out.stderr || out.stdout).trim()}`);
      code = 1;
    }
  }
  recordTimings(ctx, run);
  return ended(ctx, run, { code, lines });
}
function summary(run: RunState): string[] {
  const of = (kind: string) => run.events.filter(e => e.kind === kind).map(e => e.patch ?? e.step ?? "");
  return [
    `custom-build: built dist/corgi-custom on upstream ${short(run.upstream)} with ${run.merged.length} ${run.merged.length === 1 ? "patch" : "patches"}`,
    ...rebase.lines(run.rebased ?? [], { current: false }).map(line => `  ${line}`),
    ...run.events.filter(e => e.kind === "rebase-note").map(e => `  note: ${e.detail}`),
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
  if (run.phase === "rollback") return rollback(ctx);
  // The time the run sat stopped isn't its time: counting starts again here.
  timings.resume(run, ms(ctx));
  if (run.kind === "rebase") return resumeRebase(ctx, run);
  // Merging or committing onto any other branch would change a branch the run doesn't own.
  if (git.currentBranch(repo) !== ctx.config.branch || !git.isAncestor(repo, run.upstream, "HEAD"))
    throw Error(
      `${ctx.config.branch} is not checked out at this run's upstream ${short(run.upstream)}; check it out to continue, or undo the run with \`rollback\``,
    );
  replay(ctx, run, "continue");
  if (run.harnessCall) {
    const outcome = await resumeHarnessCall(ctx, run, run.harnessCall);
    if (outcome) return outcome;
  } else if (run.phase === "merge") {
    const p = run.plan[run.cursor];
    if (git.mergeInProgress(repo)) {
      const left = git.unmergedFiles(repo);
      if (left.length) {
        send(ctx, {
          t: "item",
          stage: "merge",
          id: p.display,
          state: "failed",
          outcome: "stopped",
          detail: `unmerged files: ${left.join(", ")}`,
        });
        return ended(ctx, run, {
          code: 2,
          lines: [
            `custom-build: ${p.display} still has unmerged files: ${left.join(", ")}`,
            "  resolve them and `git add` them, then continue",
          ],
        });
      }
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
      // The patches the stop pointed at are what this fix answers.
      const known = run.stopFailure?.step === run.step ? run.stopFailure : null;
      run.fixes.push({
        step: run.step,
        commit: git.must(repo, ["rev-parse", "HEAD"]),
        by: "user",
        files: changed,
        ...(known ? { log: known.log, attribution: known.attribution } : {}),
      });
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
    const what = `the interrupted harness resolution of ${p.display} was rejected: ${verdict.reason}`;
    send(ctx, { t: "item", stage: "merge", id: p.display, state: "failed", outcome: "stopped", detail: what });
    return stop(
      ctx,
      run,
      2,
      [what, `files: ${files.join(", ")}`],
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
  const what = `the interrupted harness fix for ${step} was rejected: ${verdict.reason}`;
  send(ctx, { t: "item", stage: "verify", id: step, state: "failed", outcome: "failed", detail: what });
  return stop(ctx, run, 3, [what], ["fix it in the working tree (or commit the fix), then continue"], {
    step,
    command: steps.command(step, ctx.config, stepVars(ctx)).join(" "),
    log: call.log ?? join(run.reportDir, "steps", `${step}.log`),
  });
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
  if (run?.kind === "rebase") {
    // Interrupted before it recorded a result, the branch at the cursor may have
    // moved in its own worktree without passing its checks.
    ctx.task?.("undo", "running");
    const active = run.rebaseStop ? null : run.rebaseTargets?.[run.rebaseCursor ?? 0],
      undone = active ? rebase.undoInterrupted(active) : null;
    if (run.rebaseStop) rebase.abandon({ repo: ctx.repo }, run.rebaseStop);
    rebase.cleanLeftovers({ repo: ctx.repo, workDir: work(ctx) });
    ctx.task?.(
      "undo",
      "done",
      run.rebaseStop ? `${run.rebaseStop.target.branch}'s rebase abandoned` : "rebase run ended",
    );
    configFile.clearRun(ctx.dir);
    // A stopped run offers no push; the branches it moved still need one.
    const moved = (run.rebased ?? []).filter(r => (r.outcome === "rebased" || r.pending) && r.to && !r.push);
    return {
      code: 0,
      lines: [
        "custom-build: ended the rebase run; branches rebased before the stop keep their new tips and backups",
        ...(undone ? [`  ${undone}`] : []),
        ...rebase.lines(run.rebased ?? [], { current: false }).map(line => `  ${line}`),
        ...moved.map(r => `  push: ${rebase.pushCommand(r)}`),
      ],
    };
  }
  if (run) {
    // The forced checkout below discards the run's half-done work, which lives
    // only on the custom branch; edits anywhere else are someone else's.
    const current = git.currentBranch(repo);
    if (current !== config.branch && !git.isClean(repo))
      throw Error(
        `${current ?? "the detached HEAD"} has uncommitted changes, and rollback would discard them; commit or stash them first`,
      );
    run.phase = "rollback";
    save(ctx, run);
    ctx.task?.("undo", "running");
    if (git.mergeInProgress(repo)) git.git(repo, ["merge", "--abort"]);
    if (run.startTip) {
      git.must(repo, ["checkout", "--quiet", "-f", "-B", config.branch, run.startTip]);
      ctx.task?.("undo", "done", `${config.branch} back at ${short(run.startTip)}`);
    } else {
      git.must(repo, ["checkout", "--quiet", "-f", run.startBranch ?? run.startHead]);
      const drop = run.startBranch !== config.branch && git.branchExists(repo, config.branch);
      if (drop) git.must(repo, ["branch", "-D", config.branch]);
      ctx.task?.(
        "undo",
        "done",
        `${run.startBranch ?? short(run.startHead)} checked out${drop ? `, ${config.branch} deleted` : ""}`,
      );
    }
    if (run.startBinary && existsSync(run.startBinary)) restoreBinary(ctx, run.startBinary, false);
    else if (!run.startBinary) restoreBinary(ctx, null, false);
    await restoreDependencies(ctx, join(run.reportDir, "steps", "rollback-install.log"));
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
  if (prev) {
    ctx.task?.("undo", "running");
    git.must(repo, ["checkout", "--quiet", "-B", config.branch, prev]);
    ctx.task?.("undo", "done", `${config.branch} back at ${config.branch}-prev (${short(prev)})`);
  }
  if (existsSync(prevBinary)) restoreBinary(ctx, prevBinary, true);
  if (prev)
    await restoreDependencies(ctx, join(ctx.dir, "reports", `rollback-${stamp(ctx.now())}`, "steps", "install.log"));
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

/** Where a stopped run is, and the commands that go on from there. A run file
 * cut short (an interrupted save, an older tool) still gets an answer. */
function whereStopped(run: RunState): { where: string; next: string } {
  const at = run.plan?.[run.cursor],
    where =
      run.kind === "rebase"
        ? `rebasing ${run.rebaseStop?.target.branch ?? "own branches"}${run.rebaseStop ? ` in ${run.rebaseStop.worktree}` : ""}`
        : run.phase === "merge"
          ? at
            ? `merging ${at.display} (${run.cursor + 1} of ${run.plan.length})`
            : "merging patches"
          : run.phase === "verify"
            ? `verifying (${run.step ?? "install"})`
            : run.phase === "rollback"
              ? "rolling back and restoring dependencies"
              : "writing the report",
    next =
      run.kind === "rebase"
        ? run.rebaseStop
          ? "scripts/custom-build continue, scripts/custom-build rebase --skip-branch, or scripts/custom-build rollback"
          : "scripts/custom-build continue, or scripts/custom-build rollback"
        : run.phase === "rollback"
          ? "scripts/custom-build continue (finishes rollback)"
          : run.stopped?.code === 4
            ? "scripts/custom-build rollback, then rebuild once upstream is fixed"
            : "scripts/custom-build continue, or scripts/custom-build rollback";
  return { where, next };
}
/** The refusal to start while `run` is stopped or in progress: where it is,
 * since when, and what goes on from there. */
function inProgress(ctx: Context, run: RunState): Explained {
  const { where, next } = whereStopped(run),
    since = run.startedAt ? Date.parse(run.startedAt) : NaN,
    ago = Number.isNaN(since) ? "" : `, started ${span(ctx.now().getTime() - since)} ago`;
  return new Explained(
    "a run is stopped or in progress; resume it with `continue` or undo it with `rollback`",
    [`  stopped: while ${where}${ago}`, ...(run.reportDir ? [`  report: ${run.reportDir}`] : []), `  next: ${next}`],
    "a run is stopped or in progress",
  );
}
/** `2h 05m`, `12m` or `40s`. */
function span(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000)),
    h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return m ? `${m}m` : `${t}s`;
}

/** The stopped run, if any, and which patches need a rebase onto upstream. */
export async function status(ctx: Context): Promise<Outcome> {
  const run = configFile.loadRun(ctx.dir);
  let stopped: statusView.View["run"] = null;
  if (run) stopped = { ...whereStopped(run), startedAt: run.startedAt, report: run.reportDir };
  const remote = git.resolveUpstreamRemote(ctx.repo, ctx.config),
    name = `${remote}/${ctx.config.upstream.branch}`,
    upstream = git.revParse(ctx.repo, `refs/remotes/${name}`),
    view: statusView.View = {
      run: stopped,
      upstream: { name, tip: upstream },
      rows: [],
      note: null,
      home: ctx.env.HOME,
    };
  if (upstream) {
    const own = rebase.select(
        { repo: ctx.repo, config: ctx.config, env: ctx.env, upstream, upstreamRemote: remote },
        ctx.config.rebase ?? "all",
        { skip: new Set(), fetch: false },
      ),
      owns = new Map<string, statusView.Own>();
    for (const t of own.targets) owns.set(t.patch, { kind: "behind", conflicts: t.conflicts });
    for (const r of own.results) owns.set(r.patch, ownState(r));
    // Patch names link to their pages; only a terminal shows links.
    const fork = ctx.color && git.hasRemote(ctx.repo, "origin") ? git.remoteTarget(ctx.repo, "origin", "push") : null;
    view.rows = rebaseCheck(ctx, upstream, knownRefs(ctx)).map((r, i) => ({
      patch: r.display,
      url: listView.patchLink(ctx.config.patches[i].source, fork),
      clean: r.clean,
      files: r.files,
      own: owns.get(r.display) ?? null,
    }));
    view.note = own.note;
  }
  return { code: 0, lines: statusView.render(view, { color: !!ctx.color }) };
}
function ownState(r: RebaseResult): statusView.Own {
  if (r.pending) return { kind: "pending", command: rebase.pushCommand(r) };
  if (r.outcome === "current") return { kind: "current", ...(r.reason ? { reason: r.reason } : {}) };
  if (r.worktree) return { kind: "worktree", path: r.worktree, rebasableThere: !!r.rebasableThere };
  if (r.diverged) return { kind: "diverged" };
  return { kind: "other", reason: r.reason ?? r.outcome };
}

/** Rebases the own patch branches onto upstream and nothing else; stops at a
 * conflict the harness can't resolve. */
export async function rebaseCommand(
  ctx: Context,
  o: { rebase?: RebaseMode; push?: boolean; inWorktree?: boolean } = {},
): Promise<Outcome> {
  const { repo, config } = ctx;
  git.requireVersion(repo);
  const busy = configFile.loadRun(ctx.dir);
  if (busy) throw inProgress(ctx, busy);
  const remote = preflight(ctx, o);
  const run: RunState = {
    kind: "rebase",
    startedAt: ctx.now().toISOString(),
    startTip: null,
    startBinary: null,
    startHead: git.must(repo, ["rev-parse", "HEAD"]),
    startBranch: git.currentBranch(repo),
    upstream: "",
    reportDir: "",
    phase: "rebase",
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
    rebased: [],
    rebaseTargets: [],
    rebaseCursor: 0,
    rebaseStop: null,
  };
  timings.resume(run, ms(ctx));
  begin(ctx, run, remote, liveState.stagesOf(run, config));
  startItem(ctx, run, "fetch");
  ctx.progress(`fetching ${remote} ${config.upstream.branch}`);
  run.upstream = git.fetchRemote(repo, remote, config.upstream.branch);
  run.reportDir = newReportDir(ctx);
  copyTool(ctx);
  exclude(ctx);
  const e = runEnv(ctx, run);
  rebase.cleanLeftovers(e);
  const chosen = rebase.select(e, o.rebase ?? config.rebase ?? "all", {
    skip: new Set(),
    fetch: true,
    inWorktree: !!o.inWorktree,
  });
  endItem(ctx, run, "fetch");
  if (chosen.note) event(run, "rebase-note", { detail: chosen.note });
  run.rebased = chosen.results;
  run.rebaseTargets = chosen.targets;
  save(ctx, run);
  if (ctx.signal) {
    fetched(ctx, run, remote, null);
    stage(ctx, "rebase", "start");
    for (const r of chosen.results) send(ctx, liveState.rebaseItem(r));
  }
  return rebaseLoop(ctx, run);
}

async function rebaseLoop(ctx: Context, run: RunState): Promise<Outcome> {
  const e = runEnv(ctx, run),
    targets = run.rebaseTargets ?? [];
  while ((run.rebaseCursor ?? 0) < targets.length) {
    const t = targets[run.rebaseCursor ?? 0];
    startItem(ctx, run, `rebase:${t.branch}`);
    send(ctx, { t: "item", stage: "rebase", id: t.branch, state: "start" });
    const r = await rebase.rebaseTarget(e, t, { stopOnConflict: true });
    if ("stop" in r) return rebaseStopped(ctx, run, r.stop, r.exhausted);
    recordRebase(ctx, run, r.result);
  }
  stage(ctx, "rebase", "done", liveState.rebaseSummary(run.rebased ?? []));
  const pushed = offerPush(ctx, run),
    handoffs = await writeReport(ctx, run, 0, []);
  configFile.clearRun(ctx.dir);
  recordTimings(ctx, run);
  const shown = rebase.lines(run.rebased ?? [], { current: false });
  return ended(ctx, run, {
    code: pushed.refused ? 1 : 0,
    lines: [
      `custom-build: rebased own branches onto upstream ${short(run.upstream)}`,
      ...(shown.length ? shown.map(line => `  ${line}`) : ["  nothing to rebase"]),
      ...run.events.filter(e => e.kind === "rebase-note").map(e => `  note: ${e.detail}`),
      ...pushed.lines,
      ...handoffs.map(path => `  handoff: ${path}`),
      `  report: ${join(run.reportDir, "report.md")}`,
    ],
  });
}
function recordRebase(ctx: Context, run: RunState, result: configFile.RebaseResult) {
  // A branch the run stopped at counts the active time on both sides of the stop.
  endItem(ctx, run, `rebase:${result.branch}`);
  (run.rebased ??= []).push(result);
  run.rebaseCursor = (run.rebaseCursor ?? 0) + 1;
  run.rebaseStop = null;
  run.stopped = null;
  save(ctx, run);
  itemEnd(ctx, run, liveState.rebaseItem(result));
}
async function rebaseStopped(
  ctx: Context,
  run: RunState,
  stop: configFile.RebaseStop,
  exhausted: boolean,
): Promise<Outcome> {
  const code: Code = exhausted ? 5 : 2,
    at = git.must(stop.worktree, ["log", "-1", "--format=%h %s", stop.commit]),
    what = `${exhausted ? "the harness could not resolve the rebase conflict" : "rebase conflict"} in ${stop.target.branch} at ${at}`;
  run.rebaseStop = stop;
  run.stopped = { code, snapshot: {} };
  save(ctx, run);
  send(ctx, { t: "item", stage: "rebase", id: stop.target.branch, state: "failed", outcome: "stopped", detail: what });
  await writeReport(ctx, run, code, [what]);
  return ended(ctx, run, {
    code,
    lines: [
      `custom-build stopped: ${what}`,
      ...(stop.problem ? [`  problem: ${stop.problem}`] : []),
      `  files: ${stop.files.join(", ") || "none unmerged"}`,
      `  worktree: ${stop.worktree}`,
      `  report: ${join(run.reportDir, "report.md")}`,
      "  resolve the conflicts in the worktree and `git add` the files, then: scripts/custom-build continue",
      "  skip this branch: scripts/custom-build rebase --skip-branch",
      "  end the rebase run: scripts/custom-build rollback",
    ],
  });
}
async function resumeRebase(ctx: Context, run: RunState): Promise<Outcome> {
  const stop = run.rebaseStop;
  replay(ctx, run, "continue");
  if (stop) {
    const stopped = (detail: string) =>
      send(ctx, { t: "item", stage: "rebase", id: stop.target.branch, state: "failed", outcome: "stopped", detail });
    if (!existsSync(stop.worktree)) {
      stopped(`the worktree ${stop.worktree} is gone`);
      return ended(ctx, run, {
        code: 2,
        lines: [
          `custom-build: the worktree ${stop.worktree} for ${stop.target.branch} is gone`,
          "  skip the branch: scripts/custom-build rebase --skip-branch, or end the run: scripts/custom-build rollback",
        ],
      });
    }
    const left = git.unmergedFiles(stop.worktree);
    if (left.length) {
      stopped(`unmerged files: ${left.join(", ")}`);
      return ended(ctx, run, {
        code: 2,
        lines: [
          `custom-build: ${stop.target.branch} still has unmerged files: ${left.join(", ")}`,
          `  resolve them in ${stop.worktree} and \`git add\` them, then continue`,
        ],
      });
    }
    const r = await rebase.resumeTarget(runEnv(ctx, run), stop);
    if ("stop" in r) return rebaseStopped(ctx, run, r.stop, r.exhausted);
    recordRebase(ctx, run, r.result);
  }
  return rebaseLoop(ctx, run);
}
/** Gives up the branch a `rebase` run stopped at and goes on with the next. */
export async function skipBranch(ctx: Context): Promise<Outcome> {
  const run = configFile.loadRun(ctx.dir);
  if (run?.kind !== "rebase" || !run.rebaseStop) throw Error("there is no stopped rebase run to skip a branch of");
  const stop = run.rebaseStop;
  timings.resume(run, ms(ctx));
  replay(ctx, run, "rebase");
  rebase.abandon(runEnv(ctx, run), stop);
  recordRebase(ctx, run, {
    patch: stop.target.patch,
    branch: stop.target.branch,
    from: stop.target.from,
    to: null,
    lease: stop.target.lease,
    outcome: "skipped",
    reason: "skipped with --skip-branch",
  });
  return rebaseLoop(ctx, run);
}
