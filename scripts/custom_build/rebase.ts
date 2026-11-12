import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Config,
  Harness,
  HarnessUse,
  RebaseMode,
  RebaseResult,
  RebaseStop,
  RebaseTarget,
  StepName,
} from "./config";
import * as git from "./git";
import * as github from "./github";
import * as harness from "./harness";
import { activity, type Sink, signal } from "./live_events";
import * as sources from "./sources";
import * as steps from "./steps";

/** What rebasing needs from a run. */
export type Env = {
  repo: string;
  workDir: string;
  config: Config;
  env: Record<string, string | undefined>;
  echo?: (chunk: Uint8Array) => void;
  progress: (line: string) => void;
  /** The upstream commit to rebase onto and the remote it came from. */
  upstream: string;
  upstreamRemote: string;
  reportDir: string;
  /** Where the prompt templates are, first match wins. */
  templates: string[];
  /** Numbers the next harness call's prompt file. */
  nextCall: () => number;
  /** Told about each finished harness call, so the run records it. */
  onUse?: (use: HarnessUse) => void;
  harness: Harness | null;
  /** Receives the live events of the harness calls and retries. */
  signal?: Sink;
};
type Outcome = { result: RebaseResult } | { stop: RebaseStop; exhausted: boolean };
type How = NonNullable<RebaseResult["how"]>;

/** The checks a rebased branch must pass alone before it moves; the build adds nothing for one branch. */
const checks: StepName[] = ["install", "typecheck", "test"];
/** Per rebased branch until it is pushed: the tip it had (to undo), the tip it
 * got, and the fork's tip at the time (absent when the fork had none). */
export const backupRef = (branch: string) => `refs/custom-build/rebase-backup/${branch}`;
const rebasedRef = (branch: string) => `refs/custom-build/rebased/${branch}`;
const leaseRef = (branch: string) => `refs/custom-build/rebase-lease/${branch}`;
/** While an in-worktree rebase's checks run: the tip the rebase produced, so an
 * undo after an interruption touches that tip and nothing committed since. */
const checkingRef = (branch: string) => `refs/custom-build/rebase-checking/${branch}`;
/** Where the fork's copy of a branch is fetched to, read from origin's push URL. */
const forkRef = (branch: string) => `refs/custom-build/fork/${branch}`;
const worktreeOf = (e: Env, branch: string) => join(e.workDir, `rebase-${sources.slug(branch)}`);
export const noFork = "rebasing is off: origin is upstream itself, so there is no fork to push to";
export const noOrigin = "rebasing is off: there is no origin remote to push rebased branches to";

/** Removes rebase worktrees an interrupted run left behind. */
export function cleanLeftovers(e: Pick<Env, "repo" | "workDir">): void {
  if (!existsSync(e.workDir)) return;
  for (const name of readdirSync(e.workDir)) if (name.startsWith("rebase-")) remove(e, join(e.workDir, name));
}
function remove(e: Pick<Env, "repo">, path: string) {
  // Only inside a worktree of its own: elsewhere git would find the user's checkout above it.
  if (existsSync(join(path, ".git"))) git.rebaseAbort(path);
  git.removeWorktree(e.repo, path);
  rmSync(path, { recursive: true, force: true });
}

/** Why there is no fork to rebase for, or null: without one, a push to origin
 * would go to upstream, or nowhere. */
export function forkProblem(e: Pick<Env, "repo" | "config" | "upstreamRemote">): string | null {
  if (!git.hasRemote(e.repo, "origin")) return noOrigin;
  const fork = git.remoteTarget(e.repo, "origin", "push");
  if (
    fork === git.remoteTarget(e.repo, e.upstreamRemote, "fetch") ||
    github.sameRepository(e.config.upstream.repo, fork)
  )
    return noFork;
  return null;
}
/** The URL origin pushes to: tips, leases and pushes all use it. */
const pushUrl = (repo: string) => git.must(repo, ["remote", "get-url", "--push", "origin"]).split("\n")[0].trim();

/** The own patches (own branches, and PRs opened from the fork `origin` pushes
 * to) and what to do with each under `mode`: rebase it, or why not. `fetch`
 * reads the fork's copies; without it, the last fetched ones count.
 * `inWorktree` also rebases branches checked out in a worktree, right there. */
export function select(
  e: Pick<Env, "repo" | "config" | "env" | "upstream" | "upstreamRemote">,
  mode: RebaseMode,
  o: { skip: Set<string>; fetch: boolean; inWorktree?: boolean },
): { targets: RebaseTarget[]; results: RebaseResult[]; note: string | null } {
  const targets: RebaseTarget[] = [],
    results: RebaseResult[] = [];
  if (mode === "off") return { targets, results, note: null };
  const candidates = e.config.patches.filter(
    p => (p.source.kind === "branch" || p.source.kind === "pr") && !o.skip.has(sources.display(p.source)),
  );
  if (!candidates.length) return { targets, results, note: null };
  const problem = forkProblem(e);
  if (problem) return { targets, results, note: problem };
  const fork = git.remoteTarget(e.repo, "origin", "push"),
    url = pushUrl(e.repo),
    // `origin/<branch>` tracks the fork the tool pushes to only when origin fetches from there too.
    tracked = git.git(e.repo, ["remote", "get-url", "origin"]).stdout.trim() === url,
    // A PR's head names a GitHub repository; a fork elsewhere can't be it. SSH aliases count by their host.
    host = fork.split("/")[0],
    githubHost = (e.env.GH_HOST || "github.com").toLowerCase();
  // Asked once, and only when there is a PR to match: it may call ssh.
  let isGitHub: boolean | null = null;
  const onGitHub = () =>
    (isGitHub ??= fork.startsWith("/") || host === githubHost || git.sshHostname(host) === githubHost);
  const reserved = [e.config.branch, `${e.config.branch}-prev`, e.config.upstream.branch],
    // A branch named by two patches (say, itself and a PR opened from it) is rebased once.
    first = new Map<string, string>();
  for (const p of candidates) {
    const s = p.source,
      patch = sources.display(s);
    let branch: string;
    if (s.kind === "branch") branch = s.name;
    else if (s.kind === "pr") {
      if (!onGitHub()) continue;
      const head = github.prInfo(s.repo, s.number, e.env)?.head;
      if (!head || !github.sameRepository(head.repo, fork)) continue;
      branch = head.branch;
    } else continue;
    const skipped = (reason: string): RebaseResult => ({
      patch,
      branch,
      from: "",
      to: null,
      lease: "",
      outcome: "skipped",
      reason,
    });
    if (!git.validBranchName(e.repo, branch) || reserved.includes(branch)) {
      results.push(skipped(`the branch name ${JSON.stringify(branch)} can't be rebased`));
      continue;
    }
    const earlier = first.get(branch);
    if (earlier) {
      results.push(skipped(`the same branch as ${earlier}, handled with it`));
      continue;
    }
    first.set(branch, patch);
    try {
      const r = assess(e, mode, { patch, branch, url, tracked, fetch: o.fetch, inWorktree: !!o.inWorktree });
      if ("target" in r) targets.push(r.target);
      else results.push(r.result);
    } catch (error) {
      results.push(skipped((error as Error).message));
    }
  }
  return { targets, results, note: null };
}

/** What to do with one own branch: where its rebase starts, the lease for the
 * push, or why it is left alone. */
function assess(
  e: Pick<Env, "repo" | "upstream">,
  mode: RebaseMode,
  o: { patch: string; branch: string; url: string; tracked: boolean; fetch: boolean; inWorktree: boolean },
): { target: RebaseTarget } | { result: RebaseResult } {
  const { patch, branch } = o,
    result = (from: string, lease: string, rest: Partial<RebaseResult>) => ({
      result: { patch, branch, from, to: null, lease, outcome: "skipped" as const, ...rest },
    });
  let lease: string;
  if (o.fetch) {
    const read = git.remoteTip(e.repo, o.url, `refs/heads/${branch}`);
    if ("error" in read) return result("", "", { reason: `cannot read origin: ${read.error}` });
    lease = read.tip;
    if (lease) {
      const failed = git.fetch(e.repo, o.url, `+refs/heads/${branch}:${forkRef(branch)}`);
      if (failed) return result("", lease, { reason: `cannot fetch origin/${branch}: ${failed}` });
      // As `git fetch origin` would, so git and the tool agree on origin's tip.
      if (o.tracked) git.updateRefs(e.repo, [{ ref: `refs/remotes/origin/${branch}`, value: lease }]);
    } else git.deleteRef(e.repo, forkRef(branch));
  } else {
    // Without a fetch, the freshest record of origin: git's `origin/<branch>`,
    // which every fetch and push updates (one made by hand too), else the tool's own.
    const tracking = git.revParse(e.repo, `refs/remotes/origin/${branch}`);
    lease = (o.tracked ? tracking : null) ?? git.revParse(e.repo, forkRef(branch)) ?? tracking ?? "";
  }
  const local = git.revParse(e.repo, `refs/heads/${branch}`),
    pushed = lease || null,
    rebased = git.revParse(e.repo, rebasedRef(branch));
  // Rebased by an earlier run whose push is still due: the branch still holds
  // that rebase, and the fork is where it was then.
  const pending =
    !!rebased &&
    !!local &&
    local !== pushed &&
    git.isAncestor(e.repo, rebased, local) &&
    (git.revParse(e.repo, leaseRef(branch)) ?? "") === (pushed ?? "");
  let from: string;
  if (!local && !pushed) return result("", lease, { reason: `no branch ${branch} here or on origin` });
  if (!local) from = pushed!;
  else if (!pushed || pushed === local || git.isAncestor(e.repo, pushed, local) || pending) from = local;
  else if (git.isAncestor(e.repo, local, pushed)) from = pushed;
  else return result(local, lease, { reason: `the local branch and origin/${branch} have diverged`, diverged: true });
  const conflicts = !git.mergeTreeCheck(e.repo, e.upstream, from).clean;
  const current = (reason?: string) =>
    result(from, lease, {
      outcome: "current",
      ...(reason ? { reason } : {}),
      ...(pending ? { to: from, pending: true, reason: "rebased earlier; push pending" } : {}),
    });
  // A branch on top of upstream, or one the mode leaves alone, stays as it is
  // wherever it is checked out: `--in-worktree` rewrites only what needs it.
  if (git.isAncestor(e.repo, e.upstream, from)) return current();
  if (mode === "conflicting" && !conflicts) return current("behind upstream, but merges cleanly");
  const busy = git.checkedOutIn(e.repo, branch);
  // A pending push stays offered while the branch is checked out; only rebasing it waits.
  if (busy) {
    // The worktree holds the local tip, so an in-worktree rebase starts there:
    // only the tip the checkout is at counts, and a push still due waits.
    if (o.inWorktree && !pending && from === local)
      return { target: { patch, branch, from, lease, local, conflicts, worktree: busy } };
    const rebasableThere = !pending && from === local,
      hint = !o.inWorktree && rebasableThere ? "; `rebase --in-worktree` rebases it there" : "";
    return result(from, lease, {
      reason: `checked out in ${busy}${hint}`,
      worktree: busy,
      rebasableThere,
      ...(pending ? { outcome: "current" as const, to: from, pending: true } : {}),
    });
  }
  return { target: { patch, branch, from, lease, local, conflicts, ...(pending ? { pending } : {}) } };
}

/** Rebases one branch onto upstream in a throwaway worktree, then checks it and
 * moves it. A conflict the harness can't resolve stops there when
 * `stopOnConflict` (the worktree stays for the user); otherwise, or on any
 * error, the branch keeps its old tip. A branch with a worktree of its own
 * (`--in-worktree`) is rebased right there instead. */
export async function rebaseTarget(e: Env, t: RebaseTarget, o: { stopOnConflict: boolean }): Promise<Outcome> {
  if (t.worktree) return inOwnWorktree(e, t, t.worktree, o);
  const tree = worktreeOf(e, t.branch);
  try {
    remove(e, tree);
    mkdirSync(e.workDir, { recursive: true });
    git.addWorktree(e.repo, tree, t.from);
    e.progress(`rebasing ${t.branch} onto upstream (${t.from.slice(0, 7)})`);
    const out = git.rebase(tree, e.upstream);
    if (out.code !== 0 && !git.rebaseInProgress(tree))
      return failed(e, t, tree, `git rebase failed: ${(out.stderr || out.stdout).trim()}`);
    return await drive(e, t, tree, "clean", o);
  } catch (error) {
    return failed(e, t, tree, (error as Error).message);
  }
}

/** Rebases a branch that is checked out in `t.worktree` right there, so the
 * checkout and the branch move together; the worktree is never removed. Its
 * tracked files must be committed; a rebase or check that fails, and a rebase
 * that leaves nothing, put the branch back at the tip it started from. */
async function inOwnWorktree(e: Env, t: RebaseTarget, tree: string, o: { stopOnConflict: boolean }): Promise<Outcome> {
  const skipped = (reason: string): Outcome => ({
    result: { patch: t.patch, branch: t.branch, from: t.from, to: null, lease: t.lease, outcome: "skipped", reason },
  });
  try {
    // Targets are chosen before any branch runs; the worktree may have moved on since.
    if (!existsSync(tree)) return skipped(`the worktree ${tree} is gone`);
    if (git.currentBranch(tree) !== t.branch || git.revParse(tree, "HEAD") !== t.from)
      return skipped(`${tree} no longer has ${t.branch} at ${t.from.slice(0, 7)} checked out`);
    if (!git.isClean(tree)) return skipped(`uncommitted changes in ${tree}; commit or stash them first`);
    e.progress(`rebasing ${t.branch} onto upstream in ${tree} (${t.from.slice(0, 7)})`);
    // The rebase itself moves the branch, so the backup is kept from its start:
    // an interruption during the checks finds it and undoes like any other
    // rebase. A push still pending keeps the backup its run left behind.
    if (!t.pending) git.updateRefs(e.repo, [{ ref: backupRef(t.branch), value: t.from }]);
    const out = git.rebase(tree, e.upstream);
    if (out.code !== 0 && !git.rebaseInProgress(tree))
      return failed(e, t, tree, `git rebase failed: ${(out.stderr || out.stdout).trim()}`);
    return await drive(e, t, tree, "clean", o);
  } catch (error) {
    return failed(e, t, tree, (error as Error).message);
  }
}

/** Goes on with a `rebase` run's stopped branch once the user resolved the conflict in its worktree. */
export async function resumeTarget(e: Env, stop: RebaseStop): Promise<Outcome> {
  const problem = continueOrSkip(stop.worktree);
  if (problem) return { stop: { ...stop, files: git.unmergedFiles(stop.worktree), problem }, exhausted: false };
  return drive(e, stop.target, stop.worktree, "user", { stopOnConflict: true });
}

/** Gives up a `rebase` run's stopped branch: its rebase is aborted; a throwaway
 * worktree is removed, the branch's own stays, back at its old tip. */
export function abandon(e: Pick<Env, "repo">, stop: RebaseStop): void {
  if (stop.target.worktree) restore(stop.target, stop.worktree);
  else remove(e, stop.worktree);
}

/** Puts a branch checked out in its worktree back at the tip its rebase
 * started from: abort what is in progress, then reset, which a clean tree
 * (the rebase's precondition) makes safe. A worktree that has another branch
 * checked out, or is rebasing one, is left alone; the branch then moves back
 * by itself unless some other checkout holds it. With `expected` (the tip the
 * finished rebase produced), a branch that has moved on from it since, say by
 * a commit of the user's, is left alone too, and so is a checkout whose
 * tracked files changed meanwhile: the reset would erase those edits. */
function restore(t: RebaseTarget, tree: string, expected?: string): void {
  if (!existsSync(tree)) return;
  const here = git.currentBranch(tree) === t.branch;
  if (git.rebaseInProgress(tree)) {
    if (git.rebasingBranch(tree) !== t.branch) return;
    git.rebaseAbort(tree);
  } else if (expected) {
    if (git.revParse(tree, `refs/heads/${t.branch}`) !== expected) return;
    if (here && !git.isClean(tree)) return;
  }
  if (git.currentBranch(tree) === t.branch) git.git(tree, ["reset", "--hard", "--quiet", t.from]);
  else if (!git.checkedOutIn(tree, t.branch)) git.git(tree, ["update-ref", `refs/heads/${t.branch}`, t.from]);
}
/** Where a branch `restore` could not put back was left, for a result's reason; "" when it is back. */
function leftAt(repo: string, t: RebaseTarget, tree: string): string {
  const now = git.revParse(repo, `refs/heads/${t.branch}`);
  return now && now !== t.from
    ? `; ${t.branch} stays at ${now.slice(0, 7)} in ${tree}, which changed during the checks; its tip before the rebase is ${backupRef(t.branch)}`
    : "";
}
/** Undoes the in-worktree rebase a `rebase` run was interrupted in, before it
 * recorded a result: the branch already moved but its checks never finished.
 * Only a rebase still in progress, or the very tip it produced, is undone; a
 * branch that moved on since keeps its commits. A line saying what was done,
 * or null when there was nothing to undo. */
export function undoInterrupted(t: RebaseTarget): string | null {
  if (!t.worktree || !existsSync(t.worktree)) return null;
  const tree = t.worktree,
    tip = git.revParse(tree, `refs/heads/${t.branch}`),
    checking = git.revParse(tree, checkingRef(t.branch)),
    rebasing = git.rebaseInProgress(tree);
  git.deleteRef(tree, checkingRef(t.branch));
  if (tip === t.from && !rebasing) return null;
  if (!rebasing && tip !== checking)
    return `left ${t.branch} at ${tip?.slice(0, 7)} in ${tree}: it moved since the interrupted rebase; its tip before the rebase is ${backupRef(t.branch)}`;
  if (!rebasing && git.currentBranch(tree) === t.branch && !git.isClean(tree))
    return `left ${t.branch} at ${tip?.slice(0, 7)} in ${tree}: it has uncommitted changes; its tip before the rebase is ${backupRef(t.branch)}`;
  restore(t, tree, checking ?? undefined);
  const now = git.revParse(tree, `refs/heads/${t.branch}`);
  return now === t.from
    ? `put ${t.branch} back at ${t.from.slice(0, 7)} in ${tree} (it was at ${tip?.slice(0, 7)}, unchecked)`
    : `left ${t.branch} at ${now?.slice(0, 7)}: ${tree} has another checkout; its tip before the rebase is ${backupRef(t.branch)}`;
}

function failed(e: Env, t: RebaseTarget, tree: string, reason: string, rest: Partial<RebaseResult> = {}): Outcome {
  if (t.worktree) {
    // Failing during the checks, the branch goes back only from the tip the rebase produced.
    const checking = git.revParse(e.repo, checkingRef(t.branch));
    restore(t, tree, checking ?? undefined);
    git.deleteRef(e.repo, checkingRef(t.branch));
    if (checking) reason += leftAt(e.repo, t, tree);
  } else remove(e, tree);
  return {
    result: {
      patch: t.patch,
      branch: t.branch,
      from: t.from,
      to: null,
      lease: t.lease,
      outcome: "failed",
      reason,
      ...rest,
    },
  };
}

/** Continues a stopped rebase whose paths are all resolved; a commit that
 * became empty (upstream has its change) is dropped. The reason when it
 * can't go on, else null. */
function continueOrSkip(tree: string): string | null {
  const left = git.unmergedFiles(tree);
  if (left.length) return `still unmerged: ${left.join(", ")}`;
  const at = git.revParse(tree, "REBASE_HEAD"),
    out = git.rebaseContinue(tree);
  if (out.code === 0 || !git.rebaseInProgress(tree)) return null;
  // It stopped at the next commit's conflict.
  if (git.revParse(tree, "REBASE_HEAD") !== at || git.unmergedFiles(tree).length) return null;
  // Only a commit with nothing left to apply is skipped; anything else is the user's to fix.
  if (!git.matchesHead(tree)) return (out.stderr || out.stdout).trim() || "git rebase --continue failed";
  const skip = git.git(tree, ["rebase", "--skip"], { rerere: true });
  return skip.code === 0 || !git.rebaseInProgress(tree) ? null : (skip.stderr || skip.stdout).trim();
}

async function drive(
  e: Env,
  t: RebaseTarget,
  tree: string,
  start: How,
  o: { stopOnConflict: boolean },
): Promise<Outcome> {
  let how = start;
  const tries = new Map<string, number>(),
    limit = e.harness?.attempts ?? 3;
  // Set once the harness failed to start: it would fail the same way again.
  let down: string | null = null;
  while (git.rebaseInProgress(tree)) {
    const at = git.rebaseStoppedAt(tree),
      files = git.unmergedFiles(tree);
    if (!at) return failed(e, t, tree, "the rebase stopped without a conflict");
    const stop = (problem?: string, harnessDown = false): Outcome => ({
      stop: { target: t, worktree: tree, commit: at.commit, files, ...(problem ? { problem } : {}) },
      exhausted: harnessDown || (!!e.harness && !problem),
    });
    if (!files.length) {
      // rerere replayed a recorded resolution for every path.
      if (how === "clean") how = "rerere";
      const problem = continueOrSkip(tree);
      if (!problem) continue;
      return o.stopOnConflict ? stop(problem) : failed(e, t, tree, `the rebase can't go on at ${at.line}: ${problem}`);
    }
    const used = tries.get(at.commit) ?? 0;
    if (down) {
      const problem = `the harness failed to run: ${down}`;
      // The attempts ended at once, which reads as exit 5 everywhere else.
      return o.stopOnConflict
        ? stop(problem, true)
        : failed(e, t, tree, `rebase conflict at ${at.line} in ${files.join(", ")}; ${problem}`);
    }
    if (!e.harness || used >= limit)
      return o.stopOnConflict ? stop() : failed(e, t, tree, `rebase conflict at ${at.line} in ${files.join(", ")}`);
    tries.set(at.commit, used + 1);
    const head = git.must(tree, ["rev-parse", "HEAD"]),
      before = git.snapshot(tree),
      text = harness.fill(harness.template("rebase-conflict", e.templates), {
        patch: t.patch,
        description: e.config.patches.find(p => sources.display(p.source) === t.patch)?.description ?? "",
        branch: t.branch,
        commit: at.line,
        upstream: git.must(e.repo, ["log", "-1", "--format=%h %s", e.upstream]),
        files,
      });
    e.progress(`asking the harness to resolve rebasing ${t.branch} at ${at.line} (attempt ${used + 1} of ${limit})`);
    const live = { stage: "rebase" as const, id: t.branch, attempt: used + 1, limit };
    signal(e.signal, { t: "harness", state: "start", ...live, files });
    const started = performance.now(),
      number = e.nextCall();
    const call = await harness.invoke(e.harness, "conflict", text, {
      repo: tree,
      reportDir: e.reportDir,
      number,
      env: e.env,
      echo: e.echo,
      onActivity: activity(e.signal, live),
    });
    const { verdict, broken } = harness.judge(call, e.harness, () =>
      harness.acceptConflict(tree, files, head, before, []),
    );
    if (broken && !verdict.ok) down = verdict.reason;
    const problem = verdict.ok ? continueOrSkip(tree) : verdict.reason;
    signal(e.signal, {
      t: "harness",
      state: "end",
      ...live,
      usage: call.usage,
      ok: !problem,
      ...(problem ? { reason: problem } : {}),
    });
    if (problem) signal(e.signal, { t: "retry", stage: "rebase", id: t.branch, why: "harness", detail: problem });
    e.onUse?.({
      call: number,
      kind: "rebase-conflict",
      patch: t.patch,
      branch: t.branch,
      attempt: used + 1,
      ...(problem ? { ok: false, reason: problem } : { ok: true }),
      seconds: harness.since(started),
      usage: call.usage,
    });
    if (!problem) {
      how = "harness";
      continue;
    }
    // Replay from this commit again, onto what was already replayed, so earlier
    // resolutions stay: the same commits git chose first, minus those before it.
    e.progress(`rejected the harness's resolution: ${problem}`);
    git.rebaseAbort(tree);
    // Only a throwaway worktree is cleaned: a branch's own worktree holds the
    // user's untracked files, which are not the harness's to remove.
    if (!t.worktree) git.git(tree, ["clean", "-fdq"]);
    const drop = git
        .git(e.repo, ["rev-list", "--no-merges", `${e.upstream}..${at.commit}^`])
        .stdout.split("\n")
        .filter(Boolean),
      again = drop.length
        ? git.rebaseKeepingTodo(tree, {
            onto: head,
            upstream: e.upstream,
            // A branch's own worktree rebases the branch itself, so it moves
            // with the checkout; a throwaway worktree rebases its detached tip.
            branch: t.worktree ? t.branch : t.from,
            drop,
            editor: todoEditor(e),
          })
        : git.rebase(tree, e.upstream);
    if (again.code !== 0 && !git.rebaseInProgress(tree))
      return failed(e, t, tree, `git rebase failed: ${(again.stderr || again.stdout).trim()}`);
  }
  return finish(e, t, tree, how);
}

/** A todo-list editor that leaves out the `pick`s of the commits in `$CUSTOM_BUILD_DROP`. */
function todoEditor(e: Pick<Env, "workDir">): string {
  const path = join(e.workDir, "todo-editor.sh");
  writeFileSync(
    path,
    // Matched picks become drops, so git's own checks see every commit accounted for.
    `awk -v drop="$CUSTOM_BUILD_DROP" 'BEGIN { n = split(drop, d, " ") } ($1 == "pick" || $1 == "p") { for (i = 1; i <= n; i++) if (index(d[i], $2) == 1) { $1 = "drop"; break } } { print }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
  );
  return path;
}

/** Checks the rebased tip alone and moves the branch to it. */
async function finish(e: Env, t: RebaseTarget, tree: string, how: How): Promise<Outcome> {
  // A harness fix moves the rebased tip on.
  let to = git.must(tree, ["rev-parse", "HEAD"]);
  const base = { patch: t.patch, branch: t.branch, from: t.from, lease: t.lease };
  // `back`: an outcome that undoes an in-worktree rebase's move of the branch.
  const done = (result: RebaseResult, back = false): Outcome => {
    if (t.worktree) {
      // A commit or an edit made in the worktree during the checks stays.
      if (back) {
        restore(t, tree, to);
        const left = leftAt(e.repo, t, tree);
        if (left) result = { ...result, reason: `${result.reason}${left}` };
      }
      git.deleteRef(e.repo, checkingRef(t.branch));
    } else remove(e, tree);
    return { result };
  };
  // An aborted or failed rebase leaves the old tip, which is no rebase at all.
  if (!git.isAncestor(e.repo, e.upstream, to)) return failed(e, t, tree, "the rebase did not complete");
  if (t.worktree) git.updateRefs(e.repo, [{ ref: checkingRef(t.branch), value: to }]);
  if (git.must(e.repo, ["rev-list", "--count", `${e.upstream}..${to}`]) === "0")
    return done(
      {
        ...base,
        to: null,
        outcome: "skipped",
        reason: "no commits left on top of upstream; remove the patch",
      },
      true,
    );
  const vars = { outfile: join(tree, "dist", "corgi-rebase") },
    logs = join(e.reportDir, "rebase"),
    flaky: { step: StepName; log: string }[] = [],
    fixes: string[] = [],
    limit = e.harness?.attempts ?? 3;
  // Harness tries for this branch, over all its checks; `down` once it failed to start.
  let tries = 0,
    down: string | null = null;
  for (let i = 0; i < checks.length; i++) {
    const step = checks[i];
    e.progress(`running ${step} on ${t.branch} rebased`);
    const log = join(logs, `${sources.slug(t.branch)}-${step}.log`),
      keep = join(logs, `${sources.slug(t.branch)}-${step}-flaky.log`),
      tried = await steps.runWithRetry(steps.commands(step, e.config, vars), {
        cwd: tree,
        log,
        env: e.env,
        echo: e.echo,
        keep,
        again: failed => steps.failedAgain(step, e.config, vars, failed),
        onRetry: () => {
          e.progress(`${step} failed on ${t.branch}; running what failed once more in case it is flaky`);
          signal(e.signal, { t: "retry", stage: "rebase", id: t.branch, why: "flaky", detail: `${step} failed once` });
        },
      });
    if (tried.ok) {
      if (tried.flaky) flaky.push({ step, log: keep });
      continue;
    }
    const failing = steps.failureSummary(step, readFileSync(log, "utf8"));
    // The harness's fix would run in the branch's own worktree; edits made
    // there meanwhile are the user's, and a rejected attempt must not erase
    // them, so the harness is not asked while any are there.
    const dirty = t.worktree && !git.isClean(tree);
    // The harness adapts the branch to upstream; each accepted fix is a commit
    // on the branch, and every check runs again from the first.
    let fixed: string | null = null;
    while (e.harness && !down && !fixed && tries < limit && !dirty) {
      tries++;
      const r = await fixBranch(e, t, tree, { step, log, failing, attempt: tries, limit });
      if (r.ok) fixed = r.commit;
      else if (r.broken) down = r.reason;
    }
    if (fixed) {
      fixes.push(fixed);
      to = fixed;
      if (t.worktree) git.updateRefs(e.repo, [{ ref: checkingRef(t.branch), value: to }]);
      i = -1;
      continue;
    }
    const harnessNote = down
      ? `; the harness failed to run: ${down}`
      : dirty
        ? `; ${tree} changed during the checks; its edits are kept and the harness was not asked`
        : tries
          ? `; the harness could not fix it in ${plural(tries, "try", "tries")}`
          : "";
    return done(
      {
        ...base,
        to: null,
        outcome: "failed",
        reason: `${step} fails on the rebased branch${failing ? `: ${failing}` : ""}${harnessNote}`,
        step,
        log,
        ...(fixes.length ? { fixes } : {}),
      },
      true,
    );
  }
  const extra = { ...(flaky.length ? { flaky } : {}), ...(fixes.length ? { fixes } : {}) };
  // A checkout or a commit made meanwhile keeps the branch where it is; a
  // branch rebased in its own worktree is checked out there by design.
  if (!t.worktree) {
    const busy = git.checkedOutIn(e.repo, t.branch);
    if (busy) return done({ ...base, to: null, outcome: "skipped", reason: `checked out in ${busy}`, ...extra });
  }
  // The checks approved the worktree's files as they were while they ran; a
  // commit or an edit made meanwhile means they did not check `to`. The
  // worktree keeps what it has, but its tip is not recorded as checked.
  if (t.worktree && (git.revParse(tree, "HEAD") !== to || !git.isClean(tree)))
    return done({
      ...base,
      to: null,
      outcome: "skipped",
      reason: `${tree} changed during the checks; ${t.branch} keeps its rebased tip, unchecked`,
      ...extra,
    });
  // The backup, the record of this rebase and the move happen together; the
  // rebase itself already moved a branch rebased in its own worktree.
  const records: { ref: string; value: string; old?: string | null }[] = [
    { ref: backupRef(t.branch), value: t.from },
    { ref: rebasedRef(t.branch), value: to },
    ...(t.lease ? [{ ref: leaseRef(t.branch), value: t.lease }] : []),
  ];
  if (!t.worktree) records.push({ ref: `refs/heads/${t.branch}`, value: to, old: t.local });
  const moved = git.updateRefs(e.repo, records);
  if (moved && !t.lease) git.deleteRef(e.repo, leaseRef(t.branch));
  if (!moved)
    return done({ ...base, to: null, outcome: "skipped", reason: "the branch moved while it was rebased", ...extra });
  return done({ ...base, to, outcome: "rebased", how, ...(t.local ? {} : { created: true }), ...extra });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Asks the harness once to make the failing check pass on the rebased branch;
 * an accepted change is committed on it. `broken`: the harness failed to start. */
async function fixBranch(
  e: Env,
  t: RebaseTarget,
  tree: string,
  f: { step: StepName; log: string; failing: string | null; attempt: number; limit: number },
): Promise<{ ok: true; commit: string } | { ok: false; reason: string; broken: boolean }> {
  const h = e.harness!,
    head = git.must(tree, ["rev-parse", "HEAD"]),
    before = git.snapshot(tree),
    command = steps.command(f.step, e.config, { outfile: join(tree, "dist", "corgi-rebase") }).join(" "),
    upstream = git.must(e.repo, ["log", "-1", "--format=%h %s", e.upstream]),
    text = harness.fill(harness.template("rebase-fix", e.templates), {
      patch: t.patch,
      description: e.config.patches.find(p => sources.display(p.source) === t.patch)?.description ?? "",
      branch: t.branch,
      upstream,
      step: f.step,
      command,
      failing: f.failing ?? "see the output below",
      attempt: `${f.attempt} of ${f.limit}`,
      logExcerpt: readFileSync(f.log, "utf8").split("\n").slice(-200).join("\n"),
      base: e.upstream.slice(0, 12),
      from: git.git(e.repo, ["merge-base", t.from, e.upstream]).stdout.trim().slice(0, 12) || t.from.slice(0, 12),
    });
  e.progress(`asking the harness to fix ${f.step} on ${t.branch} (attempt ${f.attempt} of ${f.limit})`);
  const live = { stage: "rebase" as const, id: t.branch, attempt: f.attempt, limit: f.limit };
  signal(e.signal, { t: "harness", state: "start", ...live });
  const started = performance.now(),
    number = e.nextCall(),
    call = await harness.invoke(h, "build", text, {
      repo: tree,
      reportDir: e.reportDir,
      number,
      env: e.env,
      echo: e.echo,
      onActivity: activity(e.signal, live),
    }),
    { verdict, broken } = harness.judge(call, h, () => harness.acceptFix(tree, head, before, []));
  signal(e.signal, { t: "harness", state: "end", ...live, usage: call.usage, ...harness.outcome(verdict) });
  if (!verdict.ok)
    signal(e.signal, { t: "retry", stage: "rebase", id: t.branch, why: "harness", detail: verdict.reason });
  e.onUse?.({
    call: number,
    kind: "rebase-fix",
    patch: t.patch,
    branch: t.branch,
    step: f.step,
    attempt: f.attempt,
    ...harness.outcome(verdict),
    seconds: harness.since(started),
    usage: call.usage,
  });
  if (!verdict.ok) {
    e.progress(`rejected the harness's fix: ${verdict.reason}`);
    // A fix that changed nothing leaves nothing to undo; the reset would
    // only erase edits the user made in the worktree meanwhile.
    if (!verdict.untouched) harness.discard(tree, head, before, []);
    return { ok: false, reason: verdict.reason, broken };
  }
  git.must(tree, ["add", "-A", "--", ...verdict.files]);
  git.must(tree, [
    "commit",
    "--no-verify",
    "-q",
    "-m",
    `fix: pass ${f.step} on upstream ${e.upstream.slice(0, 7)}\n\nMade by the custom build's harness after rebasing onto ${upstream}.\n\nFixed-By: harness`,
  ]);
  return { ok: true, commit: git.must(tree, ["rev-parse", "HEAD"]) };
}

/** Pushes each rebased branch to origin with its lease; a pushed branch drops
 * its backup. A refusal keeps git's output in the report's `rebase/`. */
export function push(repo: string, reportDir: string, results: RebaseResult[]): string[] {
  const lines: string[] = [],
    url = pushUrl(repo),
    // `origin/<branch>` tracks the fork this pushes to only when origin
    // fetches from it too; without that, git's own push would update it.
    tracked = git.git(repo, ["remote", "get-url", "origin"]).stdout.trim() === url;
  for (const r of results) {
    const out = git.pushWithLease(repo, url, r.branch, r.to!, r.lease);
    if (out.code === 0) {
      r.push = "pushed";
      for (const ref of [backupRef(r.branch), rebasedRef(r.branch), leaseRef(r.branch)]) git.deleteRef(repo, ref);
      // What origin holds now, so `status` doesn't read the old tip as a
      // divergence: the tool's record, and the tracking ref it prefers.
      git.updateRefs(
        repo,
        tracked
          ? [
              { ref: forkRef(r.branch), value: r.to! },
              { ref: `refs/remotes/origin/${r.branch}`, value: r.to! },
            ]
          : [{ ref: forkRef(r.branch), value: r.to! }],
      );
      lines.push(`  pushed ${r.branch} to origin`);
      continue;
    }
    r.push = "refused";
    const text = (out.stderr || out.stdout).trim(),
      log = join(reportDir, "rebase", `${sources.slug(r.branch)}-push.log`),
      why = text.split("\n").find(line => /^\s*!|^(error|fatal):/.test(line) && !/failed to push some refs/.test(line));
    mkdirSync(join(reportDir, "rebase"), { recursive: true });
    writeFileSync(log, `$ ${pushCommand(r)}\n${text}\n`);
    r.pushDetail = log;
    lines.push(`  push of ${r.branch} refused: ${(why ?? text.split("\n").pop() ?? "").trim()} (${log})`);
    lines.push(`  retry: ${pushCommand(r)}`);
  }
  return lines;
}
/** What of the rebased branches needs the user on a short summary: harness
 * fixes to review, and refused pushes with the command to retry. */
export function attention(results: RebaseResult[]): string[] {
  return results.flatMap(r => [
    ...(r.outcome === "rebased" && r.fixes?.length
      ? [`  review ${r.branch}: the harness fixed its checks in ${r.fixes.map(c => c.slice(0, 7)).join(", ")}`]
      : []),
    ...(r.push === "refused"
      ? [`  push of ${r.branch} refused (${r.pushDetail ?? "see the report"})`, `  retry: ${pushCommand(r)}`]
      : []),
  ]);
}
/** A branch name as a shell word, quoted when it needs it. */
export const word = (text: string) => (/^[\w./@+:-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);
export function pushCommand(r: RebaseResult): string {
  return `git push --force-with-lease=${word(`refs/heads/${r.branch}:${r.lease}`)} origin ${word(`${r.to}:refs/heads/${r.branch}`)}`;
}
/** The undo command while the backup exists; a push removed it. */
const undoHint = (r: RebaseResult) => (r.push === "pushed" ? "" : `; undo: ${undo(r)}`);
function undo(r: RebaseResult): string {
  return r.created ? `git branch -D ${word(r.branch)}` : `git branch -f ${word(r.branch)} ${word(backupRef(r.branch))}`;
}

/** One line per own patch: what happened, how to undo it, flaky checks and the push. */
export function lines(results: RebaseResult[], o: { current: boolean }): string[] {
  return results
    .filter(r => o.current || r.outcome !== "current" || r.pending)
    .map(r => {
      const pushed = r.push === "pushed" ? "; pushed" : r.push === "refused" ? "; push refused" : "",
        flaky = r.flaky?.length
          ? `; ${r.flaky.map(f => f.step).join(", ")} failed once and passed when run again, it may be flaky (${r.flaky.map(f => f.log).join(", ")})`
          : "",
        // Kept for review on a rebased branch; on one that wasn't, still reachable for a look.
        fixes = r.fixes?.length
          ? r.outcome === "rebased"
            ? `; the harness fixed its checks in ${r.fixes.map(c => c.slice(0, 7)).join(", ")}, review before pushing`
            : `; the harness's tries: ${r.fixes.map(c => c.slice(0, 7)).join(", ")}`
          : "";
      if (r.outcome === "rebased")
        return `rebased ${r.patch}: ${r.from.slice(0, 7)} to ${r.to!.slice(0, 7)} (${r.how})${fixes}${undoHint(r)}${flaky}${pushed}`;
      if (r.pending) return `${r.patch}: rebased earlier, push pending${undoHint(r)}${pushed}`;
      if (r.outcome === "current") return `${r.patch}: current${r.reason ? ` (${r.reason})` : ""}`;
      if (r.outcome === "failed") return `${r.patch}: not rebased: ${r.reason}${fixes}${flaky}`;
      return `${r.patch}: ${r.outcome}: ${r.reason}${flaky}`;
    });
}
