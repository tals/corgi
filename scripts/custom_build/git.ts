import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export type Output = { code: number; stdout: string; stderr: string };
/** Merges, and the commits that conclude them, record and replay resolutions. */
const rerere = ["-c", "rerere.enabled=true", "-c", "rerere.autoUpdate=true"];

export function git(
  cwd: string,
  args: string[],
  o: { rerere?: boolean; env?: Record<string, string | undefined> } = {},
): Output {
  const p = Bun.spawnSync(["git", ...(o.rerere ? rerere : []), ...args], {
    cwd,
    env: o.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
/** stdout of a git command that must succeed, trimmed. */
export function must(cwd: string, args: string[], o: { rerere?: boolean } = {}): string {
  const out = git(cwd, args, o);
  if (out.code !== 0) throw Error(`git ${args[0]} failed: ${(out.stderr || out.stdout).trim()}`);
  return out.stdout.trim();
}
const lines = (text: string) => text.split("\n").filter(Boolean);

export function repoRoot(cwd: string): string {
  const out = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (out.code !== 0) throw Error("not inside a git repository");
  return out.stdout.trim();
}
export function version(cwd: string): string {
  return must(cwd, ["--version"]).replace(/^git version /, "");
}
/** Refuses a git older than `minimum` (`merge-tree --write-tree` needs 2.38). */
export function requireVersion(cwd: string, minimum = "2.38"): void {
  const have = version(cwd).split(/[.\s]/).map(Number),
    want = minimum.split(".").map(Number);
  for (let i = 0; i < want.length; i++) {
    if ((have[i] ?? 0) > want[i]) return;
    if ((have[i] ?? 0) < want[i]) throw Error(`git ${minimum} or newer is required (found ${version(cwd)})`);
  }
}
/** No changes to tracked files; untracked files don't count. */
export function isClean(cwd: string): boolean {
  return must(cwd, ["status", "--porcelain", "--untracked-files=no"]) === "";
}
export function currentBranch(cwd: string): string | null {
  const out = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return out.code === 0 ? out.stdout.trim() : null;
}
export function revParse(cwd: string, ref: string): string | null {
  const out = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return out.code === 0 ? out.stdout.trim() : null;
}
export function isAncestor(cwd: string, a: string, b: string): boolean {
  return git(cwd, ["merge-base", "--is-ancestor", a, b]).code === 0;
}
export function hasRemote(cwd: string, name: string): boolean {
  return git(cwd, ["remote", "get-url", name]).code === 0;
}
/** Fetches `refspec` from a URL or remote; the error text on failure. */
export function fetch(cwd: string, from: string, refspec: string): string | null {
  const out = git(cwd, ["fetch", "--quiet", "--no-tags", from, refspec]);
  return out.code === 0 ? null : (out.stderr || out.stdout).trim() || "fetch failed";
}
/** Updates `refs/remotes/<remote>/<branch>` and returns its commit. */
export function fetchRemote(cwd: string, remote: string, branch: string): string {
  const failed = fetch(cwd, remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
  if (failed) throw Error(`cannot fetch ${remote} ${branch}: ${failed}`);
  return revParse(cwd, `refs/remotes/${remote}/${branch}`)!;
}
/** The configured remote, else `upstream` when it exists, else `origin`. */
export function resolveUpstreamRemote(cwd: string, config: { upstream: { remote?: string } }): string {
  if (config.upstream.remote) return config.upstream.remote;
  return hasRemote(cwd, "upstream") ? "upstream" : "origin";
}
export function mergeNoFF(cwd: string, commit: string, message: string): Output {
  return git(cwd, ["merge", "--no-ff", "--no-edit", "-m", message, commit], { rerere: true });
}
export function mergeInProgress(cwd: string): boolean {
  return revParse(cwd, "MERGE_HEAD") !== null;
}
export function unmergedFiles(cwd: string): string[] {
  return lines(git(cwd, ["diff", "--name-only", "--diff-filter=U"]).stdout);
}
/** Concludes the merge in progress, letting rerere record its resolution. */
export function commitMerge(cwd: string, message: string): string {
  must(cwd, ["commit", "--no-verify", "-m", message], { rerere: true });
  return must(cwd, ["rev-parse", "HEAD"]);
}
/** Whether `ref` merges cleanly onto `base`, without touching the working tree. */
export function mergeTreeCheck(cwd: string, base: string, ref: string): { clean: boolean; files: string[] } {
  const out = git(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, ref]);
  if (out.code === 0) return { clean: true, files: [] };
  if (out.code !== 1) throw Error(`git merge-tree failed: ${out.stderr.trim()}`);
  // The first line is the tree; the conflicted files follow.
  return { clean: false, files: [...new Set(lines(out.stdout).slice(1))] };
}
export function filesTouchedByMerge(cwd: string, merge: string): string[] {
  return lines(git(cwd, ["diff", "--name-only", `${merge}^1`, merge]).stdout);
}
export function addWorktree(cwd: string, path: string, commit: string): void {
  must(cwd, ["worktree", "add", "--quiet", "--detach", "--force", path, commit]);
}
export function removeWorktree(cwd: string, path: string): void {
  git(cwd, ["worktree", "remove", "--force", path]);
  git(cwd, ["worktree", "prune"]);
}
/** The directory holding `info/exclude`, shared by every worktree. */
export function commonDir(cwd: string): string {
  const dir = must(cwd, ["rev-parse", "--git-common-dir"]);
  return dir.startsWith("/") ? dir : join(cwd, dir);
}
export function branchExists(cwd: string, name: string): boolean {
  return revParse(cwd, `refs/heads/${name}`) !== null;
}
export function validBranchName(cwd: string, name: string): boolean {
  return git(cwd, ["check-ref-format", "--branch", name]).code === 0;
}
/** Each changed or untracked path with its status and content, to tell later
 * what someone else changed in the working tree. */
export type Snapshot = Record<string, string>;
export function snapshot(cwd: string): Snapshot {
  const entries = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]).stdout.split("\0"),
    out: Snapshot = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2),
      path = entry.slice(3);
    // A rename's original path follows as its own entry.
    if (xy[0] === "R" || xy[0] === "C") i++;
    out[path] = `${xy}:${contentHash(join(cwd, path))}`;
  }
  return out;
}
function contentHash(path: string): string {
  try {
    return statSync(path).isFile() ? Bun.hash(readFileSync(path)).toString(16) : "other";
  } catch {
    return "missing";
  }
}
/** Paths whose state differs from `before`, leaving out those under `exclude` (repo-relative). */
export function changedSince(cwd: string, before: Snapshot, exclude: string[] = []): string[] {
  const after = snapshot(cwd),
    paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter(path => before[path] !== after[path])
    .filter(path => !exclude.some(prefix => prefix && (path === prefix || path.startsWith(prefix + "/"))))
    .sort();
}
/** Another worktree that has `branch` checked out, or null. */
export function worktreeWith(cwd: string, branch: string): string | null {
  const here = must(cwd, ["rev-parse", "--show-toplevel"]);
  let path = "";
  for (const line of git(cwd, ["worktree", "list", "--porcelain"]).stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && realpathSync(path) !== realpathSync(here)) return path;
  }
  return null;
}
/** Redoes a merge whose resolution was rejected: conflict markers back in
 * `files`, and anything rerere recorded for them forgotten so it never replays. */
export function remerge(cwd: string, commit: string, message: string, files: string[]): void {
  git(cwd, [
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoUpdate=false",
    "merge",
    "--no-ff",
    "--no-edit",
    "-m",
    message,
    commit,
  ]);
  if (!mergeInProgress(cwd)) return;
  git(cwd, ["-c", "rerere.enabled=true", "rerere", "forget", "--", ...files]);
  git(cwd, ["checkout", "-m", "--", ...files]);
  // Paths rerere replayed in the first merge were staged by autoUpdate; this
  // merge replays them without staging, so stage them again or every later
  // attempt is rejected as still unmerged.
  const replayed = unmergedFiles(cwd).filter(path => !files.includes(path));
  if (replayed.length) git(cwd, ["add", "--", ...replayed]);
}
