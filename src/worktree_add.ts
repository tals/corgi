//! Adds a linked worktree on a new branch, for an agent the launcher
//! starts in it. Corgi lists worktrees without creating them otherwise.
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as subprocess from "./subprocess";
import type { Runtime } from "./runtime";

/** The repository's local and remote branches, newest commit first, for a
 * new worktree to start from. */
export async function branches(runtime: Runtime, workspace: number) {
  const ws = runtime.workspaces.get(workspace);
  if (!ws) throw Error("NoWorkspace");
  const out = await subprocess
    .run(
      [
        "git",
        "-C",
        ws.cwd,
        "for-each-ref",
        "--sort=-committerdate",
        "--count=2000",
        "--format=%(refname)%09%(committerdate:unix)",
        "refs/heads",
        "refs/remotes",
      ],
      { timeout_ms: 5000, max_output: 1 << 20 },
    )
    .catch(() => null);
  if (!out?.ok()) throw Error("BranchesUnavailable");
  return out.stdout
    .toString()
    .split("\n")
    .flatMap(line => {
      const [ref, at] = line.split("\t");
      // A remote's HEAD only points at one of its branches.
      if (!ref || ref.endsWith("/HEAD")) return [];
      return [{ ref, name: ref.replace(/^refs\/(heads|remotes)\//, ""), at: Number(at) || 0 }];
    });
}
/** Has Git add `path` on a new `branch` from `base`, in the repository of
 * the workspace's checkouts. An existing branch or folder is refused. */
export async function add(runtime: Runtime, workspace: number, path: string, branch: string, base: string) {
  const ws = runtime.workspaces.get(workspace);
  if (!ws) throw Error("NoWorkspace");
  const common = ws.worktrees?.common_dir;
  if (!common) throw Error("NoWorktree");
  if (!isAbsolute(path)) throw Error("WorktreeAddFailed");
  const git = (args: string[], timeout_ms = 5000) =>
    subprocess.run(["git", "-C", ws.cwd, ...args], { timeout_ms }).catch(() => null);
  if (!(await git(["check-ref-format", "--branch", branch]))?.ok()) throw Error("InvalidBranch");
  if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))?.ok()) throw Error("BranchExists");
  if (
    await access(path).then(
      () => true,
      () => false,
    )
  )
    throw Error("FolderExists");
  const out = await git(["worktree", "add", "-b", branch, path, base], 120000);
  if (!out?.ok()) throw Error("WorktreeAddFailed");
  const root = ws.worktrees?.entries.find(e => e.primary)?.path;
  if (root && path.startsWith(root + "/")) await exclude(root, common, path.slice(root.length + 1).split("/")[0]);
  runtime.worktree_tracker.forget(common);
}
/** Keeps a worktree inside the main checkout from showing there as
 * untracked: its top folder goes in the repository's own exclude file,
 * which isn't committed. */
async function exclude(root: string, common: string, top: string) {
  const ignored = await subprocess
    .run(["git", "-C", root, "check-ignore", "-q", "--", `${top}/`], { timeout_ms: 5000 })
    .catch(() => null);
  if (ignored?.ok()) return;
  const file = join(common, "info", "exclude");
  try {
    const old = await readFile(file, "utf8").catch(() => "");
    await mkdir(join(common, "info"), { recursive: true });
    await appendFile(file, `${old.length > 0 && !old.endsWith("\n") ? "\n" : ""}/${top}/\n`);
  } catch {
    // The worktree works anyway; it only shows as untracked in the main checkout.
  }
}
