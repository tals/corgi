import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as customBuild from "./custom_build";
const merge = (subject: string, commit = "0123456789abcdef") => ({ commit, subject });
const fork = "github.com/someone/corgi";
test("a remote URL is named by host and path, without credentials, port or .git", () => {
  for (const url of [
    "git@github.com:someone/corgi.git",
    "github.com:someone/corgi",
    "ssh://git@github.com/someone/corgi.git",
    "ssh://git@GitHub.com:22/someone/corgi",
    "https://github.com/someone/corgi",
    "https://someone:ghp_secret@github.com/someone/corgi.git/",
    " https://x-access-token:abc@github.com/someone/corgi.git\n",
  ])
    expect(customBuild.repository(url)).toBe(fork);
  expect(customBuild.repository("https://gitlab.example.com/group/sub/corgi.git")).toBe(
    "gitlab.example.com/group/sub/corgi",
  );
  for (const local of ["/home/me/corgi", "../corgi", "file:///home/me/corgi", "C:/src/corgi", ""])
    expect(customBuild.repository(local)).toBe("");
});
test("a build is custom when it merged onto main or lives outside upstream", () => {
  const upstream = customBuild.upstreamRepository;
  expect(customBuild.custom({ repository: "", merges: [] })).toBe(false);
  expect(customBuild.custom({ repository: upstream, merges: [] })).toBe(false);
  expect(customBuild.custom({ repository: fork, merges: [] })).toBe(true);
  expect(customBuild.custom({ repository: upstream, merges: [merge("Merge branch 'x'")] })).toBe(true);
});
test("--version keeps its line; --verbose adds a custom build's repository and merges", () => {
  const vanilla = { repository: customBuild.upstreamRepository, merges: [] };
  expect(customBuild.versionText("1.2.3", "abc1234", vanilla, false)).toBe("corgi 1.2.3 (abc1234)\n");
  expect(customBuild.versionText("1.2.3", "abc1234", vanilla, true)).toBe("corgi 1.2.3 (abc1234)\n");
  const custom = {
    repository: fork,
    merges: [
      merge("Merge tals/corgi#109: Jump to blocked", "6bf60e85aaaa"),
      merge("Merge branch 'voice'", "8d318ec1cccc"),
    ],
  };
  expect(customBuild.versionText("1.2.3", "abc1234", custom, false)).toBe("corgi 1.2.3 (abc1234)\n");
  expect(customBuild.versionText("1.2.3", "abc1234", custom, true)).toBe(
    "corgi 1.2.3 (abc1234)\n" +
      "  github.com/someone/corgi\n" +
      "  6bf60e8 Merge tals/corgi#109: Jump to blocked\n" +
      "  8d318ec Merge branch 'voice'\n",
  );
});
test("the build reads the branch's repository and its first-parent merges since upstream main", () => {
  const dir = mkdtempSync(join(tmpdir(), "custom-build-git-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(
      ["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) throw Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const commit = (file: string) => {
    writeFileSync(join(dir, file), file);
    git("add", file);
    git("commit", "-qm", `add ${file}`);
  };
  try {
    git("init", "-q", "-b", "main");
    commit("base");
    git("remote", "add", "upstream", "git@github.com:tals/corgi.git");
    git("remote", "add", "origin", "https://someone:ghp_secret@github.com/someone/corgi.git");
    git("update-ref", "refs/remotes/upstream/main", "HEAD");
    expect(customBuild.fromGit(dir)).toEqual({ repository: fork, merges: [] });
    git("checkout", "-qb", "side");
    commit("side");
    git("checkout", "-qb", "custom", "upstream/main");
    for (const branch of ["jump", "voice"]) {
      git("checkout", "-qb", branch, "upstream/main");
      commit(branch);
      // A merge inside a merged branch is not one of the build's merges.
      if (branch === "voice") git("merge", "-q", "--no-ff", "-m", "Merge side into voice", "side");
      git("checkout", "-q", "custom");
      git("merge", "-q", "--no-ff", "-m", `Merge ${branch}: ${branch} feature`, branch);
    }
    commit("tweak");
    const id = customBuild.fromGit(dir);
    expect(id.repository).toBe(fork);
    expect(id.merges.map(m => m.subject)).toEqual(["Merge jump: jump feature", "Merge voice: voice feature"]);
    expect(id.merges[1].commit).toBe(git("rev-parse", "HEAD~1"));
    // The branch's own remote wins over origin; with no upstream remote, origin/main is the base.
    git("remote", "add", "mine", "git@gitlab.example.com:me/corgi.git");
    git("update-ref", "refs/remotes/mine/custom", "HEAD");
    git("branch", "-q", "--set-upstream-to", "mine/custom");
    git("remote", "remove", "upstream");
    git("update-ref", "refs/remotes/origin/main", "HEAD~1");
    expect(customBuild.fromGit(dir)).toEqual({ repository: "gitlab.example.com/me/corgi", merges: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("outside a git checkout the build has no identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "custom-build-nogit-"));
  try {
    expect(customBuild.fromGit(dir)).toEqual({ repository: "", merges: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
