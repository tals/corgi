import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type Output = { code: number; stdout: string; stderr: string };
/** Merges, and the commits that conclude them, record and replay resolutions. */
const rerere = ["-c", "rerere.enabled=true", "-c", "rerere.autoUpdate=true"];

const interruptions = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
/** Stops the process when a synchronous child was interrupted (Ctrl-C, a kill):
 * it died of SIGINT, SIGTERM or SIGHUP, or exited with 130 or 143, the codes a
 * shell gives for the first two. 129 by itself is git's code for a usage error,
 * so only the signal counts for SIGHUP. Nothing after an interrupted call may
 * run on its failed result, as a Ctrl-C would have stopped the tool right there
 * without a listener for it. A timeout's kill is not an interruption. The live
 * view's exit hook restores the terminal. */
export function stopIfInterrupted(p: {
  exitCode: number | null;
  signalCode?: string | null;
  exitedDueToTimeout?: boolean;
}): void {
  if (p.exitedDueToTimeout) return;
  const bySignal = p.signalCode ? interruptions[p.signalCode as keyof typeof interruptions] : undefined,
    byCode = [interruptions.SIGINT, interruptions.SIGTERM].find(code => code === p.exitCode),
    code = bySignal ?? byCode;
  if (code !== undefined) process.exit(code);
}

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
  stopIfInterrupted(p);
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
/** The repository a remote fetches from or pushes to, as `host/path` without
 * scheme, user, port, `.git` or case, so two spellings of one repository compare equal. */
export function remoteTarget(cwd: string, name: string, direction: "fetch" | "push"): string {
  return repositoryOf(git(cwd, ["remote", "get-url", ...(direction === "push" ? ["--push"] : []), name]).stdout);
}
/** A remote URL as `host/path` (a path for a local one), lowercased, without
 * scheme, user, port, `.git` or trailing slashes. Only a URL with a scheme
 * has a port; in `user@host:1234/repo` the digits are the owner. */
export function repositoryOf(url: string): string {
  const u = url.trim();
  let where = u;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u),
    scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(u);
  if (/^file:\/\//i.test(u)) where = u.slice("file://".length);
  else if (scheme) where = `${scheme[1]}/${scheme[2].replace(/^\/+/, "")}`;
  else if (scp) where = `${scp[1]}/${scp[2].replace(/^\/+/, "")}`;
  return where
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}
/** The host an SSH alias stands for (`Host` entries in the SSH config), else the alias. */
export function sshHostname(alias: string): string {
  let p;
  try {
    p = Bun.spawnSync(["ssh", "-G", alias], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 5000 });
  } catch {
    return alias; // no ssh here
  }
  stopIfInterrupted(p);
  const line =
    p.exitCode === 0
      ? p.stdout
          .toString()
          .split("\n")
          .find(l => l.startsWith("hostname "))
      : null;
  return line ? line.slice("hostname ".length).trim().toLowerCase() : alias;
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
/** Removes the worktree at `path`; when its directory is already gone, only its
 * own registration is dropped, never other worktrees'. */
export function removeWorktree(cwd: string, path: string): void {
  if (git(cwd, ["worktree", "remove", "--force", path]).code === 0) return;
  const admin = join(commonDir(cwd), "worktrees");
  if (!existsSync(admin)) return;
  for (const name of readdirSync(admin)) {
    const gitdir = join(admin, name, "gitdir");
    // macOS reports temporary paths with and without /private.
    const same = (a: string, b: string) => a.replace(/^\/private\//, "/") === b.replace(/^\/private\//, "/");
    if (existsSync(gitdir) && same(readFileSync(gitdir, "utf8").trim(), join(path, ".git")))
      rmSync(join(admin, name), { recursive: true, force: true });
  }
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

/** A merge or a rebase stopped at a conflict. */
export function conflictInProgress(cwd: string): boolean {
  return mergeInProgress(cwd) || revParse(cwd, "REBASE_HEAD") !== null;
}
export function rebaseInProgress(cwd: string): boolean {
  return ["rebase-merge", "rebase-apply"].some(name => {
    const path = must(cwd, ["rev-parse", "--git-path", name]);
    return existsSync(path.startsWith("/") ? path : join(cwd, path));
  });
}
/** Settings that would change what a rebase replays, or move the user's
 * branches behind the tool's back, pinned to git's defaults. */
const pinned = [
  "-c",
  "rebase.abbreviateCommands=false",
  "-c",
  "rebase.missingCommitsCheck=ignore",
  "-c",
  "rebase.autoSquash=false",
  "-c",
  "rebase.updateRefs=false",
  "-c",
  "rebase.rebaseMerges=false",
];
function rebaseGit(cwd: string, args: string[], env: Record<string, string> = {}): Output {
  return git(cwd, [...pinned, ...args], { rerere: true, env: { ...process.env, GIT_EDITOR: "true", ...env } });
}
/** Rebases `branch` onto `onto` with the commits git picks against `upstream`
 * (cherry-picked ones left out, as in the first rebase), minus `drop`: the
 * commits already replayed into `onto`. `editor` is a script that removes the
 * `pick` lines of the commits in `$CUSTOM_BUILD_DROP` from the todo list. */
export function rebaseKeepingTodo(
  cwd: string,
  o: { onto: string; upstream: string; branch: string; drop: string[]; editor: string },
): Output {
  return rebaseGit(
    cwd,
    [
      "rebase",
      "-i",
      "--no-autosquash",
      "--no-update-refs",
      "--no-rebase-merges",
      "--empty=drop",
      "--onto",
      o.onto,
      o.upstream,
      o.branch,
    ],
    {
      GIT_SEQUENCE_EDITOR: `sh '${o.editor.replaceAll("'", "'\\''")}'`,
      CUSTOM_BUILD_DROP: o.drop.join(" "),
    },
  );
}
/** Starts rebasing the checkout at `cwd` onto `onto`; check `rebaseInProgress` for a stop. */
export function rebase(cwd: string, onto: string): Output {
  return rebaseGit(cwd, ["rebase", "--no-update-refs", "--no-rebase-merges", onto]);
}

/** Whether the index and the files match HEAD. */
export function matchesHead(cwd: string): boolean {
  return git(cwd, ["diff", "--quiet", "--cached", "HEAD"]).code === 0 && git(cwd, ["diff", "--quiet"]).code === 0;
}
export function rebaseContinue(cwd: string): Output {
  return rebaseGit(cwd, ["rebase", "--continue"]);
}
/** The branch a rebase in progress at `cwd` is rebasing; null for a detached one or none. */
export function rebasingBranch(cwd: string): string | null {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const path = git(cwd, ["rev-parse", "--git-path", `${dir}/head-name`]).stdout.trim(),
      file = path && resolve(cwd, path);
    if (!file || !existsSync(file)) continue;
    const ref = readFileSync(file, "utf8").trim();
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  }
  return null;
}
export function rebaseAbort(cwd: string): void {
  git(cwd, ["rebase", "--abort"]);
}
/** The commit a stopped rebase is replaying, as `<sha>` and `<short sha> <subject>`. */
export function rebaseStoppedAt(cwd: string): { commit: string; line: string } | null {
  const commit = revParse(cwd, "REBASE_HEAD");
  return commit ? { commit, line: must(cwd, ["log", "-1", "--format=%h %s", commit]) } : null;
}
export function deleteRef(cwd: string, ref: string): void {
  git(cwd, ["update-ref", "-d", ref]);
}
/** The worktree, the current one included, that has `branch` checked out, or null. */
export function checkedOutIn(cwd: string, branch: string): string | null {
  let path = "";
  for (const line of git(cwd, ["worktree", "list", "--porcelain"]).stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}
/** The commit `ref` points at on `remote` (a name or URL): "" when it doesn't
 * exist there; the error text when the remote can't be read. */
export function remoteTip(cwd: string, remote: string, ref: string): { tip: string } | { error: string } {
  const out = git(cwd, ["ls-remote", "--refs", remote, ref]);
  if (out.code !== 0) return { error: (out.stderr || out.stdout).trim() || "ls-remote failed" };
  // ls-remote matches by tail; only the exact ref counts.
  const line = out.stdout
    .split("\n")
    .map(l => l.split("\t"))
    .find(([, name]) => name?.trim() === ref);
  return { tip: line?.[0].trim() ?? "" };
}
const zero = "0".repeat(40);
/** Applies ref updates all or nothing; `old` null means the ref must not exist, undefined means any value. */
export function updateRefs(cwd: string, updates: { ref: string; value: string; old?: string | null }[]): boolean {
  const lines = [
    "start",
    ...updates.map(u => `update ${u.ref} ${u.value}${u.old === undefined ? "" : ` ${u.old ?? zero}`}`),
    "commit",
    "",
  ];
  const p = Bun.spawnSync(["git", "update-ref", "--stdin"], {
    cwd,
    stdin: new TextEncoder().encode(lines.join("\n")),
    stdout: "pipe",
    stderr: "pipe",
  });
  stopIfInterrupted(p);
  return p.exitCode === 0;
}
/** Pushes `commit` to `branch` on `remote`, only while the remote branch is still at `lease` ("" = absent). */
export function pushWithLease(cwd: string, remote: string, branch: string, commit: string, lease: string): Output {
  return git(cwd, [
    "push",
    "--quiet",
    `--force-with-lease=refs/heads/${branch}:${lease}`,
    remote,
    `${commit}:refs/heads/${branch}`,
  ]);
}
