import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worktreeAdd from "./worktree_add";
import * as errors from "./errors";

function git(cwd: string, ...args: string[]) {
  const out = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (out.exitCode !== 0) throw Error(out.stderr.toString());
  return out.stdout.toString().trim();
}

test("adds a worktree on a new branch, refusing an existing branch or folder and bad names", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-worktree-add-")));
  try {
    const repo = join(root, "app");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "a");
    const forgotten: string[] = [];
    const runtime: any = {
      workspaces: {
        get: (id: number) =>
          id === 1
            ? { cwd: repo, worktrees: { common_dir: join(repo, ".git"), entries: [{ path: repo, primary: true }] } }
            : null,
      },
      worktree_tracker: { forget: (common: string) => forgotten.push(common) },
    };
    const add = (path: string, branch: string) =>
      worktreeAdd.add(runtime, 1, path, branch, "refs/heads/main").then(
        () => null,
        error => errors.name(error),
      );
    expect(await add(join(root, "app-topic"), "topic")).toBeNull();
    expect(git(join(root, "app-topic"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("topic");
    // Under the project root, the main checkout doesn't list it as untracked.
    expect(await add(join(repo, ".worktrees", "inside"), "inside")).toBeNull();
    expect(await add(join(repo, ".worktrees", "again"), "again")).toBeNull();
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").match(/^\/\.worktrees\/$/gm)).toHaveLength(1);
    expect(forgotten).toHaveLength(3);
    expect(await add(join(root, "app-again"), "topic")).toBe("BranchExists");
    mkdirSync(join(root, "app-taken"));
    expect(await add(join(root, "app-taken"), "taken")).toBe("FolderExists");
    expect(await add(join(root, "app-bad"), "a..b")).toBe("InvalidBranch");
    expect(await worktreeAdd.add(runtime, 2, join(root, "x"), "x", "main").catch(errors.name)).toBe("NoWorkspace");
    const listed = await worktreeAdd.branches(runtime, 1);
    expect(listed.map(b => b.name).sort()).toEqual(["again", "inside", "main", "topic"]);
    expect(listed.find(b => b.name === "main")).toMatchObject({ ref: "refs/heads/main" });
    expect(listed.every(b => b.at > 0)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
