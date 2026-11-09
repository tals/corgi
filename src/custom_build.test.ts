import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as customBuild from "./custom_build";
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
test("a build is custom when its commit lives outside upstream", () => {
  expect(customBuild.custom({ repository: "" })).toBe(false);
  expect(customBuild.custom({ repository: customBuild.upstreamRepository })).toBe(false);
  expect(customBuild.custom({ repository: fork })).toBe(true);
});
test("--version keeps its line; --verbose adds a custom build's repository as a link", () => {
  const vanilla = { repository: customBuild.upstreamRepository };
  expect(customBuild.versionText("1.2.3", "abc1234", vanilla, false)).toBe("corgi 1.2.3 (abc1234)\n");
  expect(customBuild.versionText("1.2.3", "abc1234", vanilla, true)).toBe("corgi 1.2.3 (abc1234)\n");
  const custom = { repository: fork };
  expect(customBuild.versionText("1.2.3", "abc1234", custom, false)).toBe("corgi 1.2.3 (abc1234)\n");
  expect(customBuild.versionText("1.2.3", "abc1234", custom, true)).toBe(
    "corgi 1.2.3 (abc1234)\n  https://github.com/someone/corgi\n",
  );
});
test("the build reads its repository from the branch's remote, else origin", () => {
  const dir = mkdtempSync(join(tmpdir(), "custom-build-git-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(
      ["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) throw Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "base"), "base");
    git("add", "base");
    git("commit", "-qm", "add base");
    git("remote", "add", "upstream", "git@github.com:tals/corgi.git");
    git("remote", "add", "origin", "https://someone:ghp_secret@github.com/someone/corgi.git");
    git("update-ref", "refs/remotes/upstream/main", "HEAD");
    // Upstream can't hold the fork's commit, so origin names the repository.
    expect(customBuild.fromGit(dir)).toEqual({ repository: fork });
    // The branch's own remote wins over origin; with no upstream remote, origin is still the fallback.
    git("remote", "add", "mine", "git@gitlab.example.com:me/corgi.git");
    git("update-ref", "refs/remotes/mine/custom", "HEAD");
    git("checkout", "-qb", "custom");
    git("branch", "-q", "--set-upstream-to", "mine/custom");
    git("remote", "remove", "upstream");
    expect(customBuild.fromGit(dir)).toEqual({ repository: "gitlab.example.com/me/corgi" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("outside a git checkout the build has no identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "custom-build-nogit-"));
  try {
    expect(customBuild.fromGit(dir)).toEqual({ repository: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
