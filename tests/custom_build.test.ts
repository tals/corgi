import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as config from "../scripts/custom_build/config";
import * as report from "../scripts/custom_build/report";
import { main } from "../scripts/custom_build/main";
import * as sources from "../scripts/custom_build/sources";
import * as steps from "../scripts/custom_build/steps";
import { buildLeftover as harnessLeftover } from "../scripts/custom_build/harness";
import * as gitTool from "../scripts/custom_build/git";

setDefaultTimeout(60_000);
const scratch = mkdtempSync(join(tmpdir(), "custom-build-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string) => {
  const dir = join(scratch, `${name}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const identity = (cwd: string) => {
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
};
function write(cwd: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
}
function commit(cwd: string, files: Record<string, string>, message = "change") {
  write(cwd, files);
  git(cwd, "add", "--", ...Object.keys(files));
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** A GitHub stand-in (`<github>/<owner>/<repo>.git` bare repositories), an
 * upstream `tals/corgi` with one base commit, and a clone with `upstream` and
 * `origin` remotes. */
type World = { github: string; upstream: string; seed: string; clone: string; env: Record<string, string> };
function world(): World {
  const root = fresh("world"),
    github = join(root, "github"),
    upstream = join(github, "tals/corgi.git"),
    fork = join(github, "me/corgi.git"),
    seed = join(root, "seed"),
    clone = join(root, "clone");
  for (const bare of [upstream, fork]) {
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
  }
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  identity(seed);
  commit(seed, { "base.txt": "one\ntwo\nthree\n", "package.json": "{}\n", ".gitignore": "dist/\n" }, "base");
  git(seed, "remote", "add", "origin", upstream);
  git(seed, "push", "-q", "origin", "main");
  git(root, "clone", "-q", "-o", "upstream", upstream, clone);
  identity(clone);
  git(clone, "remote", "add", "origin", fork);
  git(clone, "push", "-q", "origin", "main");
  return {
    github,
    upstream,
    seed,
    clone,
    env: { ...process.env, CORGI_CUSTOM_BUILD_GITHUB: `file://${github}` } as Record<string, string>,
  };
}
/** A branch in the clone off upstream main with `files` committed. */
function branch(w: World, name: string, files: Record<string, string>, from = "upstream/main"): string {
  const back = git(w.clone, "rev-parse", "--abbrev-ref", "HEAD");
  git(w.clone, "checkout", "-q", "-b", name, from);
  const sha = commit(w.clone, files, `${name}: change`);
  git(w.clone, "checkout", "-q", back);
  return sha;
}
/** A commit published as `refs/pull/<n>/head` on `<github>/<repo>.git`. */
function pullRequest(w: World, repo: string, n: number, files: Record<string, string>): string {
  const bare = join(w.github, `${repo}.git`);
  if (!existsSync(bare)) {
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
  }
  git(w.seed, "fetch", "-q", w.upstream, "main");
  git(w.seed, "checkout", "-q", "--detach", "FETCH_HEAD");
  const sha = commit(w.seed, files, `pr ${n}`);
  git(w.seed, "push", "-q", "-f", bare, `HEAD:refs/pull/${n}/head`);
  git(w.seed, "checkout", "-q", "main");
  return sha;
}
/** A branch published on `<github>/<repo>.git`. */
function forkBranch(w: World, repo: string, name: string, files: Record<string, string>): string {
  const bare = join(w.github, `${repo}.git`);
  if (!existsSync(bare)) {
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
  }
  git(w.seed, "checkout", "-q", "--detach", "main");
  const sha = commit(w.seed, files, `${name}: change`);
  git(w.seed, "push", "-q", "-f", bare, `HEAD:refs/heads/${name}`);
  git(w.seed, "checkout", "-q", "main");
  return sha;
}
/** Puts a `gh` first on PATH that answers `gh pr view <n> --repo <repo>` from `answers`. */
function stubGh(w: World, answers: Record<string, { state: string; title: string; mergeCommit?: string }>) {
  const bin = fresh("gh-bin");
  for (const [key, answer] of Object.entries(answers))
    writeFileSync(
      join(bin, `${sources.slug(key)}.json`),
      JSON.stringify({
        state: answer.state,
        title: answer.title,
        mergeCommit: answer.mergeCommit ? { oid: answer.mergeCommit } : null,
      }),
    );
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\n# gh pr view N --repo R --json ...\nkey=$(printf '%s#%s' "$5" "$3" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9][^a-z0-9]*/-/g')\n[ -f "${bin}/$key.json" ] || exit 1\ncat "${bin}/$key.json"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  w.env.PATH = `${bin}:${w.env.PATH}`;
}
/** A PATH without any `gh`, so PR state comes from ancestry. */
function noGh(w: World) {
  const bin = fresh("no-gh");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  w.env.PATH = `${bin}:${w.env.PATH}`;
}
const read = (path: string) => readFileSync(path, "utf8");

test("add arguments name upstream PRs, other repositories' PRs and branches, or own branches", () => {
  const up = "tals/corgi";
  expect(sources.parse("#123", up)).toEqual({ kind: "pr", repo: up, number: 123 });
  expect(sources.parse("123", up)).toEqual({ kind: "pr", repo: up, number: 123 });
  expect(sources.parse("https://github.com/tals/corgi/pull/123", up)).toEqual({ kind: "pr", repo: up, number: 123 });
  expect(sources.parse("rhuss/corgi#2", up)).toEqual({ kind: "pr", repo: "rhuss/corgi", number: 2 });
  expect(sources.parse("https://github.com/rhuss/corgi/pull/2/", up)).toEqual({
    kind: "pr",
    repo: "rhuss/corgi",
    number: 2,
  });
  expect(sources.parse("rhuss/corgi:voice/dictation", up)).toEqual({
    kind: "fork-branch",
    repo: "rhuss/corgi",
    branch: "voice/dictation",
  });
  expect(sources.parse("https://github.com/rhuss/corgi/tree/voice", up)).toEqual({
    kind: "fork-branch",
    repo: "rhuss/corgi",
    branch: "voice",
  });
  expect(sources.parse("https://git.example.org/x/corgi.git#branch=fix", up)).toEqual({
    kind: "fork-branch",
    url: "https://git.example.org/x/corgi.git",
    branch: "fix",
  });
  expect(sources.parse("fix-jump-to-blocked", up)).toEqual({ kind: "branch", name: "fix-jump-to-blocked" });
  expect(sources.parse("feature/x", up)).toEqual({ kind: "branch", name: "feature/x" });
});
test("sources display as the binary shows them and slug into file names", () => {
  const up = "tals/corgi",
    shown = (arg: string) => sources.display(sources.parse(arg, up));
  expect(shown("#109")).toBe("tals/corgi#109");
  expect(shown("rhuss/corgi#2")).toBe("rhuss/corgi#2");
  expect(shown("rhuss/corgi:voice")).toBe("rhuss/corgi:voice");
  expect(shown("my-branch")).toBe("my-branch");
  expect(shown("https://git.example.org/x/corgi.git#branch=fix")).toBe("https://git.example.org/x/corgi.git:fix");
  expect(sources.slug("tals/corgi#109")).toBe("tals-corgi-109");
  expect(sources.slug("rhuss/corgi:Voice_Dictation")).toBe("rhuss-corgi-voice-dictation");
  expect(sources.privateRef({ kind: "pr", repo: "rhuss/corgi", number: 2 })).toBe(
    "refs/custom-build/rhuss/corgi/pull/2",
  );
  expect(sources.privateRef({ kind: "fork-branch", repo: "rhuss/corgi", branch: "voice" })).toBe(
    "refs/custom-build/rhuss/corgi/heads/voice",
  );
  expect(sources.fetchUrl({ kind: "pr", repo: "rhuss/corgi", number: 2 }, {})).toBe(
    "https://github.com/rhuss/corgi.git",
  );
  expect(sources.fetchUrl({ kind: "branch", name: "x" }, {})).toBeNull();
});
test("the config directory comes from --dir, then the environment, then the checkout", () => {
  const repoRoot = "/repo";
  expect(config.resolveDir({ env: {}, repoRoot })).toBe("/repo/.custom-build");
  expect(config.resolveDir({ env: { CORGI_CUSTOM_BUILD_DIR: "/dots/corgi" }, repoRoot })).toBe("/dots/corgi");
  expect(config.resolveDir({ env: { CORGI_CUSTOM_BUILD_DIR: "" }, repoRoot })).toBe("/repo/.custom-build");
  expect(config.resolveDir({ dir: "/opt/cb", env: { CORGI_CUSTOM_BUILD_DIR: "/dots/corgi" }, repoRoot })).toBe(
    "/opt/cb",
  );
  expect(config.resolveDir({ dir: "rel", env: {}, repoRoot, cwd: "/here" })).toBe("/here/rel");
});
test("a missing config has defaults; a saved one reads back the same", () => {
  const dir = join(fresh("config"), "not-yet");
  expect(config.load(dir)).toEqual({
    version: 1,
    upstream: { repo: "tals/corgi", branch: "main" },
    branch: "custom-build",
    patches: [],
    retired: [],
  });
  const saved: config.Config = {
    ...config.defaults(),
    patches: [{ source: { kind: "pr", repo: "tals/corgi", number: 109 }, description: "Jump", added: "2026-11-04" }],
    retired: [
      {
        source: { kind: "branch", name: "old" },
        description: "Old",
        added: "2026-10-01",
        retired: "2026-11-04",
        reason: "merged",
      },
    ],
    harness: { command: ["claude", "-p"], attempts: 2 },
    afterBuild: ["./dist/corgi-custom", "dev"],
  };
  config.save(dir, saved);
  expect(read(join(dir, "config.json"))).toEndWith("}\n");
  expect(read(join(dir, "config.json"))).toContain('\n  "version": 1,');
  expect(config.load(dir)).toEqual(saved);
});
test("a config from a newer tool, or with a broken harness, is refused", () => {
  const dir = fresh("config");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 2 }));
  expect(() => config.load(dir)).toThrow("newer than this tool");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, harness: { command: [] } }));
  expect(() => config.load(dir)).toThrow("harness.command must be a non-empty array of strings");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, harness: { command: "claude" } }));
  expect(() => config.load(dir)).toThrow("harness.command");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, afterBuild: "x" }));
  expect(() => config.load(dir)).toThrow("afterBuild");
});
test("the test world publishes PR heads and fork branches", () => {
  const w = world();
  const pr = pullRequest(w, "tals/corgi", 1, { "pr1.txt": "x\n" }),
    fork = forkBranch(w, "other/corgi", "topic", { "topic.txt": "y\n" });
  expect(git(w.clone, "ls-remote", w.upstream, "refs/pull/1/head")).toStartWith(pr);
  expect(git(w.clone, "ls-remote", `file://${w.github}/other/corgi.git`, "refs/heads/topic")).toStartWith(fork);
  expect(branch(w, "mine", { "mine.txt": "z\n" })).toMatch(/^[0-9a-f]{40}$/);
});

const dirOf = (w: World) => join(w.clone, ".custom-build");
/** Steps that need no Bun project: typecheck fails while a .txt file says BROKEN,
 * build writes the merges build.ts would stamp (parents, then subject) into the binary. */
const stubSteps = {
  install: ["true"],
  typecheck: ["sh", "-c", "! grep -rqs BROKEN --include=*.txt ."],
  test: ["true"],
  build: [
    "sh",
    "-c",
    "mkdir -p dist && git log --merges --first-parent --reverse --format=%P%x09%s upstream/main..HEAD > {outfile}",
  ],
};
function configure(w: World, patches: string[], extra: Partial<config.Config> = {}) {
  config.save(dirOf(w), {
    ...config.defaults(),
    patches: patches.map(arg => ({
      source: sources.parse(arg, "tals/corgi"),
      description: `about ${arg}`,
      added: "2026-11-04",
    })),
    steps: stubSteps,
    ...extra,
  });
}
let clock = Date.parse("2026-11-04T10:00:00Z");
async function cb(w: World, ...args: string[]) {
  let out = "",
    err = "";
  const code = await main(args, {
    cwd: w.clone,
    env: w.env,
    out: text => void (out += text),
    err: text => void (err += text),
    now: () => new Date((clock += 1000)),
  });
  if (process.env.CUSTOM_BUILD_TEST_DEBUG) process.stderr.write(`[${args.join(" ")} → ${code}]\n${out}${err}`);
  return { code, out, err };
}
const run = (w: World) => config.loadRun(dirOf(w));
const head = (w: World) => git(w.clone, "rev-parse", "HEAD");
const subjects = (w: World, range: string) => git(w.clone, "log", "--format=%s", "--first-parent", range).split("\n");
const latestReport = (w: World) => {
  const reports = join(dirOf(w), "reports");
  return join(reports, git(reports, "ls-files", "--others").split("\n")[0] ?? "");
};
const binary = (w: World) => join(w.clone, "dist", "corgi-custom");
/** Each stamped merge as the patch it brought in: its source, merged commit and description. */
const stamped = (w: World) =>
  read(binary(w))
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [parents, subject] = line.split("\t"),
        [, source, description] = /^Merge (\S+): (.*)$/.exec(subject) ?? [];
      return { source, commit: parents.split(" ")[1], description };
    });
const refs = (w: World) =>
  [
    git(w.clone, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/mine", "refs/heads/other"),
    ...["tals/corgi", "other/corgi", "me/corgi"].map(repo =>
      existsSync(join(w.github, `${repo}.git`)) ? git(w.clone, "ls-remote", join(w.github, `${repo}.git`)) : "",
    ),
  ].join("\n");

test("rebuild merges an own branch, an upstream PR, a fork PR and a fork branch in order", async () => {
  const w = world();
  const mine = branch(w, "mine", { "mine.txt": "mine\n" }),
    pr = pullRequest(w, "tals/corgi", 1, { "pr1.txt": "one\n" }),
    forkPr = pullRequest(w, "other/corgi", 2, { "pr2.txt": "two\n" }),
    topic = forkBranch(w, "other/corgi", "topic", { "topic.txt": "topic\n" });
  stubGh(w, {
    "tals/corgi#1": { state: "OPEN", title: "viewer: one" },
    "other/corgi#2": { state: "OPEN", title: "two" },
  });
  configure(w, ["mine", "#1", "other/corgi#2", "other/corgi:topic"]);
  const before = refs(w);
  const result = await cb(w, "rebuild");
  expect(result.err).not.toContain("custom-build: cannot");
  expect(result.code).toBe(0);
  expect(git(w.clone, "branch", "--show-current")).toBe("custom-build");
  expect(subjects(w, "upstream/main..HEAD")).toEqual([
    "Merge other/corgi:topic: about other/corgi:topic",
    "Merge other/corgi#2: about other/corgi#2",
    "Merge tals/corgi#1: about #1",
    "Merge mine: about mine",
  ]);
  expect(stamped(w)).toEqual([
    { source: "mine", commit: mine, description: "about mine" },
    { source: "tals/corgi#1", commit: pr, description: "about #1" },
    { source: "other/corgi#2", commit: forkPr, description: "about other/corgi#2" },
    { source: "other/corgi:topic", commit: topic, description: "about other/corgi:topic" },
  ]);
  expect(result.out).toContain("with 4 patches");
  expect(run(w)).toBeNull();
  // SC-007: patch branches and upstream are untouched; no remotes were added.
  expect(refs(w)).toBe(before);
  expect(git(w.clone, "remote").split("\n").sort()).toEqual(["origin", "upstream"]);
  expect(git(w.clone, "status", "--porcelain")).toBe("");
});
test("rebuild refuses a dirty checkout or a stopped run and changes nothing", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  configure(w, ["mine"]);
  write(w.clone, { "base.txt": "edited\n" });
  const dirty = await cb(w, "rebuild");
  expect(dirty.code).toBe(1);
  expect(dirty.err).toContain("uncommitted changes");
  expect(git(w.clone, "branch", "--list", "custom-build")).toBe("");
  git(w.clone, "checkout", "--", "base.txt");
  config.saveRun(dirOf(w), { phase: "merge" } as config.RunState);
  const stopped = await cb(w, "rebuild");
  expect(stopped.code).toBe(1);
  expect(stopped.err).toContain("`continue`");
  expect(git(w.clone, "branch", "--list", "custom-build")).toBe("");
});
test("a patch that can't be fetched stops the run before anything is reset", async () => {
  const w = world();
  noGh(w);
  configure(w, ["#99"]);
  const start = head(w),
    result = await cb(w, "rebuild");
  expect(result.code).toBe(1);
  expect(result.err).toContain("cannot fetch tals/corgi#99");
  expect(head(w)).toBe(start);
  expect(git(w.clone, "branch", "--list", "custom-build")).toBe("");
  expect(run(w)).toBeNull();
});
test("merged and contained patches are skipped, closed PRs merged with a warning", async () => {
  const w = world();
  const lower = branch(w, "lower", { "lower.txt": "lower\n" });
  branch(w, "stacked", { "stacked.txt": "stacked\n" }, "lower");
  pullRequest(w, "tals/corgi", 3, { "pr3.txt": "three\n" });
  pullRequest(w, "tals/corgi", 4, { "pr4.txt": "four\n" });
  pullRequest(w, "tals/corgi", 5, { "pr5.txt": "five\n" });
  // #3 landed on upstream main as a squash commit, so its head isn't an ancestor.
  const squash = commit(w.seed, { "pr3.txt": "three\n" }, "pr 3 (squashed)");
  git(w.seed, "push", "-q", w.upstream, "HEAD:main");
  stubGh(w, {
    "tals/corgi#3": { state: "MERGED", title: "merged one", mergeCommit: squash },
    "tals/corgi#4": { state: "CLOSED", title: "closed one" },
    // Merged per GitHub, but into a commit the fetched main lacks.
    "tals/corgi#5": { state: "MERGED", title: "merged elsewhere", mergeCommit: "0".repeat(40) },
  });
  configure(w, ["stacked", "lower", "#3", "#4", "#5"]);
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(result.out).toContain("skipped tals/corgi#3: merged upstream, it can be removed from the list");
  expect(result.out).toContain("skipped lower: already contained");
  expect(result.out).toContain("warning: tals/corgi#4");
  expect(result.out).toContain("note: tals/corgi#5: the PR is merged, but not into the fetched main; merging it");
  expect(stamped(w).map(p => p.source)).toEqual(["stacked", "tals/corgi#4", "tals/corgi#5"]);
  expect(git(w.clone, "merge-base", "--is-ancestor", lower, "HEAD")).toBe("");
});
test("the after-build command runs only after a successful run", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  const marker = join(fresh("after"), "ran");
  configure(w, ["mine"], { afterBuild: ["sh", "-c", `echo ran >> ${marker}`] });
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(read(marker)).toBe("ran\n");
  configure(w, ["mine", "bad"], { afterBuild: ["sh", "-c", `echo ran >> ${marker}`] });
  expect((await cb(w, "rebuild")).code).toBe(3);
  expect(read(marker)).toBe("ran\n");
});

test("a conflict without a harness stops with the files, then continue finishes and rerere replays it", async () => {
  const w = world();
  branch(w, "left", { "base.txt": "one\nLEFT\nthree\n" });
  branch(w, "right", { "base.txt": "one\nRIGHT\nthree\n" });
  configure(w, ["left", "right"]);
  const stopped = await cb(w, "rebuild");
  expect(stopped.code).toBe(2);
  expect(stopped.out).toContain("merge conflict in right");
  expect(stopped.out).toContain("files: base.txt");
  expect(stopped.out).toContain("scripts/custom-build continue");
  expect(git(w.clone, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toMatch(/^[0-9a-f]{40}$/);
  expect(run(w)?.phase).toBe("merge");
  expect(git(w.clone, "branch", "--show-current")).toBe("custom-build");
  // Still conflicted: continue refuses.
  expect((await cb(w, "continue")).code).toBe(2);
  write(w.clone, { "base.txt": "one\nLEFT and RIGHT\nthree\n" });
  git(w.clone, "add", "base.txt");
  const resumed = await cb(w, "continue");
  expect(resumed.code).toBe(0);
  expect(run(w)).toBeNull();
  expect(read(join(w.clone, "base.txt"))).toBe("one\nLEFT and RIGHT\nthree\n");
  const again = await cb(w, "rebuild");
  expect(again.code).toBe(0);
  expect(read(join(w.clone, "base.txt"))).toBe("one\nLEFT and RIGHT\nthree\n");
  expect(subjects(w, "upstream/main..HEAD")).toEqual(["Merge right: about right", "Merge left: about left"]);
});

test("a successful run keeps the previous build as -prev; a stopped run leaves the backups alone", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  configure(w, ["mine"]);
  expect((await cb(w, "rebuild")).code).toBe(0);
  const first = head(w),
    firstBinary = read(binary(w));
  expect(git(w.clone, "branch", "--list", "custom-build-prev")).toBe("");
  git(w.clone, "checkout", "-q", "mine");
  commit(w.clone, { "mine.txt": "mine 2\n" });
  git(w.clone, "checkout", "-q", "custom-build");
  expect((await cb(w, "rebuild")).code).toBe(0);
  const second = head(w),
    secondBinary = read(binary(w));
  expect(git(w.clone, "rev-parse", "custom-build-prev")).toBe(first);
  expect(read(`${binary(w)}.prev`)).toBe(firstBinary);
  // A stopped run: the backups still name the first build.
  branch(w, "clash", { "mine.txt": "clash\n" });
  configure(w, ["mine", "clash"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  expect(git(w.clone, "branch", "--show-current")).toBe("custom-build");
  expect(git(w.clone, "rev-parse", "custom-build-prev")).toBe(first);
  expect(read(`${binary(w)}.prev`)).toBe(firstBinary);
  // Rolling back the stopped run returns to where it started.
  const back = await cb(w, "rollback");
  expect(back.code).toBe(0);
  expect(head(w)).toBe(second);
  expect(read(binary(w))).toBe(secondBinary);
  expect(run(w)).toBeNull();
  expect(git(w.clone, "status", "--porcelain")).toBe("");
  // With no run, rollback restores the backups.
  const prev = await cb(w, "rollback");
  expect(prev.code).toBe(0);
  expect(head(w)).toBe(first);
  expect(read(binary(w))).toBe(firstBinary);
  expect(git(w.clone, "branch", "--show-current")).toBe("custom-build");
});
test("rollback with nothing built says so", async () => {
  const w = world();
  configure(w, []);
  const result = await cb(w, "rollback");
  expect(result.code).toBe(1);
  expect(result.err).toContain("nothing to roll back to");
});
test("rolling back a stopped first run returns to the branch it started on", async () => {
  const w = world();
  branch(w, "left", { "base.txt": "one\nLEFT\nthree\n" });
  branch(w, "right", { "base.txt": "one\nRIGHT\nthree\n" });
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  expect((await cb(w, "rollback")).code).toBe(0);
  expect(git(w.clone, "branch", "--show-current")).toBe("main");
  expect(git(w.clone, "branch", "--list", "custom-build")).toBe("");
  expect(existsSync(binary(w))).toBe(false);
});
test("an own branch behind its pushed copy uses the pushed one; a diverged one uses local with a warning", async () => {
  const w = world();
  branch(w, "behind", { "behind.txt": "1\n" });
  git(w.clone, "push", "-q", "origin", "behind");
  git(w.clone, "checkout", "-q", "behind");
  const ahead = commit(w.clone, { "behind.txt": "2\n" });
  git(w.clone, "push", "-q", "origin", "behind");
  git(w.clone, "reset", "-q", "--hard", "HEAD^");
  branch(w, "diverged", { "diverged.txt": "1\n" });
  git(w.clone, "push", "-q", "origin", "diverged");
  git(w.clone, "checkout", "-q", "diverged");
  commit(w.clone, { "diverged.txt": "pushed\n" });
  git(w.clone, "push", "-q", "-f", "origin", "diverged");
  git(w.clone, "reset", "-q", "--hard", "HEAD^");
  const local = commit(w.clone, { "diverged.txt": "local\n" });
  git(w.clone, "checkout", "-q", "main");
  configure(w, ["behind", "diverged"]);
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(result.out).toContain("note: behind: local branch is behind origin/behind; using origin/behind");
  expect(result.out).toContain(
    "note: diverged: local branch and origin/diverged have diverged; using the local branch",
  );
  expect(stamped(w).map(p => p.commit)).toEqual([ahead, local]);
});

test("a step failing only on the custom branch stops with 3; failing on upstream too stops with 4", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  configure(w, ["bad"]);
  const failed = await cb(w, "rebuild");
  expect(failed.code).toBe(3);
  expect(failed.out).toContain("typecheck failed");
  expect(run(w)?.step).toBe("typecheck");
  expect(existsSync(join(dirOf(w), "work", "isolated-upstream"))).toBe(false);
  // The user fixes it in the tree; continue commits the fix and finishes.
  rmSync(join(w.clone, "bad.txt"));
  const fixed = await cb(w, "continue");
  expect(fixed.code).toBe(0);
  expect(git(w.clone, "log", "-1", "--format=%s")).toBe("custom-build: fix typecheck (user)");

  const u = world();
  commit(u.seed, { "upstream.txt": "BROKEN\n" }, "upstream breaks");
  git(u.seed, "push", "-q", "origin", "main");
  branch(u, "fine", { "fine.txt": "fine\n" }, "main");
  configure(u, ["fine"]);
  const broken = await cb(u, "rebuild");
  expect(broken.code).toBe(4);
  expect(broken.out).toContain("upstream is broken");
  expect(broken.out).toContain("roll back, then rebuild once upstream is fixed");
  expect(broken.out).not.toContain("continue: ");
});

test("a PR merged on another repository is still merged; one merged upstream is skipped", async () => {
  const w = world();
  pullRequest(w, "other/corgi", 5, { "pr5.txt": "five\n" });
  stubGh(w, { "other/corgi#5": { state: "MERGED", title: "merged in the fork" } });
  configure(w, ["other/corgi#5"]);
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(stamped(w).map(p => p.source)).toEqual(["other/corgi#5"]);
});
test("the config directory stays out of git status after the reset drops its .gitignore entry", async () => {
  const w = world();
  commit(w.clone, { ".gitignore": "dist/\n/.custom-build/\n" }, "tool: ignore its directory");
  branch(w, "mine", { "mine.txt": "mine\n" });
  configure(w, ["mine"]);
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(read(join(w.clone, ".gitignore"))).toBe("dist/\n");
  expect(git(w.clone, "status", "--porcelain")).toBe("");
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(
    read(join(w.clone, ".git", "info", "exclude"))
      .split("\n")
      .filter(l => l === "/.custom-build/"),
  ).toHaveLength(1);
});
test("a custom branch checked out in another worktree is refused before anything changes", async () => {
  const w = world();
  configure(w, []);
  git(w.clone, "branch", "custom-build", "main");
  git(w.clone, "worktree", "add", "-q", join(fresh("wt"), "elsewhere"), "custom-build");
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(1);
  expect(result.err).toContain("checked out in another worktree");
  expect(run(w)).toBeNull();
});
test("continue after an interrupted step commits only tracked changes", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  configure(w, ["bad"]);
  expect((await cb(w, "rebuild")).code).toBe(3);
  const state = run(w)!;
  config.saveRun(dirOf(w), { ...state, stopped: null });
  write(w.clone, { "scratch-notes.md": "mine\n", "bad.txt": "fixed\n" });
  expect((await cb(w, "continue")).code).toBe(0);
  expect(git(w.clone, "show", "--name-only", "--format=", "HEAD")).toBe("bad.txt");
  expect(git(w.clone, "status", "--porcelain")).toBe("?? scratch-notes.md");
});

test("add creates an ignored config, dates entries, refuses duplicates and takes PR titles", async () => {
  const w = world();
  stubGh(w, { "tals/corgi#109": { state: "OPEN", title: "viewer: jump to blocked agents" } });
  clock = Date.parse("2026-11-04T10:00:00Z");
  expect((await cb(w, "add", "#109")).out).toBe("added tals/corgi#109: jump to blocked agents\n");
  expect(git(w.clone, "status", "--porcelain")).toBe("");
  expect((await cb(w, "add", "my-branch", "--description", "My change")).code).toBe(0);
  expect((await cb(w, "add", "other/corgi:topic", "--description", "Topic")).code).toBe(0);
  const duplicate = await cb(w, "add", "109");
  expect(duplicate.code).toBe(1);
  expect(duplicate.err).toContain("tals/corgi#109 is already in the list");
  const untitled = await cb(w, "add", "other/corgi#7");
  expect(untitled.code).toBe(1);
  expect(untitled.err).toContain("needs --description");
  const saved = config.load(dirOf(w));
  expect(saved.patches.map(p => [sources.display(p.source), p.description, p.added])).toEqual([
    ["tals/corgi#109", "jump to blocked agents", "2026-11-04"],
    ["my-branch", "My change", "2026-11-04"],
    ["other/corgi:topic", "Topic", "2026-11-04"],
  ]);
  expect((await cb(w, "list")).out).toBe(
    "tals/corgi#109  jump to blocked agents  (added 2026-11-04)\n" +
      "my-branch  My change  (added 2026-11-04)\n" +
      "other/corgi:topic  Topic  (added 2026-11-04)\n",
  );
});
test("remove retires a patch with its reason, which it needs off a terminal", async () => {
  const w = world();
  configure(w, ["my-branch", "#5"]);
  const unexplained = await cb(w, "remove", "my-branch");
  expect(unexplained.code).toBe(1);
  expect(unexplained.err).toContain("needs --reason");
  const removed = await cb(w, "remove", "my-branch", "--reason", "merged upstream");
  expect(removed.code).toBe(0);
  const saved = config.load(dirOf(w));
  expect(saved.patches.map(p => sources.display(p.source))).toEqual(["tals/corgi#5"]);
  expect(saved.retired).toHaveLength(1);
  expect(saved.retired[0]).toMatchObject({ reason: "merged upstream", description: "about my-branch" });
  expect(saved.retired[0].retired).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect((await cb(w, "list", "--retired")).out).toContain("my-branch  about my-branch  (retired ");
  expect((await cb(w, "remove", "nope", "--reason", "x")).code).toBe(1);
});
test("--dir and CORGI_CUSTOM_BUILD_DIR move every read and write, the option winning", async () => {
  const w = world(),
    viaEnv = join(fresh("dots"), "corgi-build"),
    viaOption = join(fresh("opt"), "cb");
  w.env.CORGI_CUSTOM_BUILD_DIR = viaEnv;
  expect((await cb(w, "add", "a-branch", "--description", "A")).code).toBe(0);
  expect(existsSync(join(viaEnv, "config.json"))).toBe(true);
  expect((await cb(w, "--dir", viaOption, "add", "b-branch", "--description", "B")).code).toBe(0);
  expect(config.load(viaOption).patches.map(p => p.description)).toEqual(["B"]);
  expect(config.load(viaEnv).patches.map(p => p.description)).toEqual(["A"]);
  expect((await cb(w, "list")).out).toContain("a-branch");
  expect((await cb(w, `--dir=${viaOption}`, "list")).out).toContain("b-branch");
  expect(existsSync(dirOf(w))).toBe(false);
});

/** A harness script; each call appends a line to `<bin>/calls`. */
function stubHarness(body: string): { command: string[]; calls: () => number; bin: string } {
  const bin = fresh("harness"),
    path = join(bin, "harness");
  writeFileSync(path, `#!/bin/sh\necho call >> "${bin}/calls"\n${body}\n`);
  chmodSync(path, 0o755);
  return {
    command: [path, "{prompt_file}"],
    calls: () => (existsSync(join(bin, "calls")) ? read(join(bin, "calls")).split("\n").filter(Boolean).length : 0),
    bin,
  };
}
const takeTheirs = 'for f in $(git diff --name-only --diff-filter=U); do git checkout -q --theirs -- "$f"; done';
function conflicting(w: World) {
  branch(w, "left", { "base.txt": "one\nLEFT\nthree\n" });
  branch(w, "right", { "base.txt": "one\nRIGHT\nthree\n" });
}

test("a harness resolution that passes the checks is committed with a trailer", async () => {
  const w = world();
  conflicting(w);
  const h = stubHarness(
    `cp "$1" "${'$(dirname "$0")'}/prompt-file"; cat > "$(dirname "$0")/stdin"; echo "$CORGI_CUSTOM_BUILD_KIND" > "$(dirname "$0")/kind"; cp .custom-build/run.json "$(dirname "$0")/run.json"\n${takeTheirs}`,
  );
  configure(w, ["left", "right"], { harness: { command: h.command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(1);
  expect(read(join(w.clone, "base.txt"))).toBe("one\nRIGHT\nthree\n");
  expect(git(w.clone, "log", "-1", "--format=%B", "HEAD^{/Merge right}")).toBe(
    "Merge right: about right\n\nResolved-By: harness",
  );
  const prompt = read(join(h.bin, "prompt-file"));
  expect(read(join(h.bin, "stdin"))).toBe(prompt);
  expect(read(join(h.bin, "kind"))).toBe("conflict\n");
  // While it ran, the run recorded the call; afterwards the marker is gone.
  expect(JSON.parse(read(join(h.bin, "run.json"))).harnessCall).toMatchObject({
    kind: "conflict",
    patch: "right",
    attempt: 1,
    files: ["base.txt"],
  });
  expect(prompt).toContain("- Patch: right");
  expect(prompt).toContain("- base.txt");
  expect(prompt).toContain("- left: about left");
  expect(prompt).toContain("- Description: about right");
  expect(prompt).toContain("- Pull request: none");
  expect(prompt).toContain("Resolve the conflicts in the files listed above.");
  expect(result.out).toContain("agent resolved the conflict in right");
});
test("harness resolutions with markers, extra edits, commits or timeouts are rejected until attempts run out", async () => {
  const cases: [string, string, { timeoutSeconds?: number }][] = [
    ["leaves markers", "true", {}],
    ["edits another file", `${takeTheirs}\necho changed > package.json`, {}],
    ["commits", `${takeTheirs}\ngit add -A && git commit -q -m mine`, {}],
    ["times out", "exec sleep 10", { timeoutSeconds: 1 }],
  ];
  for (const [name, body, limits] of cases) {
    const w = world();
    conflicting(w);
    const h = stubHarness(body);
    configure(w, ["left", "right"], { harness: { command: h.command, attempts: 2, ...limits } });
    const result = await cb(w, "rebuild");
    expect([name, result.code]).toEqual([name, 5]);
    expect([name, h.calls()]).toEqual([name, 2]);
    expect(result.out).toContain("rollback");
    // The conflict is back in place for the user.
    expect([name, git(w.clone, "diff", "--name-only", "--diff-filter=U")]).toEqual([name, "base.txt"]);
    expect(read(join(w.clone, "package.json"))).toBe("{}\n");
    expect(run(w)?.phase).toBe("merge");
  }
});
test("a harness that can't be run is a warning, and the run stops as without one", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"], { harness: { command: ["/nonexistent/harness", "{prompt_file}"] } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(2);
  expect(result.err).toContain("warning: harness /nonexistent/harness is not executable");
});

const fixBroken = 'for f in $(grep -rl BROKEN --include=*.txt .); do echo fixed > "$f"; done';
test("a harness build fix becomes its own commit and the steps rerun; the next rebuild drops it", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  const h = stubHarness(
    `echo "$CORGI_CUSTOM_BUILD_KIND" > "$(dirname "$0")/kind"; cp "$1" "$(dirname "$0")/prompt-file"\n${fixBroken}`,
  );
  configure(w, ["bad"], { harness: { command: h.command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(read(join(h.bin, "kind"))).toBe("build\n");
  const prompt = read(join(h.bin, "prompt-file"));
  expect(prompt).toContain("- Step: typecheck");
  expect(prompt).toContain("- Command: `sh -c ! grep -rqs BROKEN --include=*.txt .`");
  expect(prompt).toContain("- bad: about bad");
  expect(prompt).toContain("$ sh -c ! grep -rqs BROKEN");
  expect(prompt).toContain("- Do not commit, amend or rebase; leave your changes in the working tree.");
  expect(git(w.clone, "log", "-1", "--format=%B")).toBe("custom-build: fix typecheck (agent)\n\nFixed-By: harness");
  expect(stamped(w).map(p => p.source)).toEqual(["bad"]);
  expect(result.out).toContain("agent fix");
  expect(git(w.clone, "status", "--porcelain")).toBe("");
  // Rebuilding starts from upstream again: the old fix is gone, a new one is
  // made. (Both runs within one second may produce the same commit ids.)
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(h.calls()).toBe(2);
  expect(git(w.clone, "log", "--first-parent", "--format=%s", "upstream/main..HEAD").split("\n")).toEqual([
    "custom-build: fix typecheck (agent)",
    "Merge bad: about bad",
  ]);
});
test("a harness that changes nothing exhausts its attempts; upstream breakage never calls it", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  const idle = stubHarness("true");
  configure(w, ["bad"], { harness: { command: idle.command, attempts: 2 } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(5);
  expect(idle.calls()).toBe(2);
  expect(run(w)?.step).toBe("typecheck");

  const u = world();
  commit(u.seed, { "upstream.txt": "BROKEN\n" }, "upstream breaks");
  git(u.seed, "push", "-q", "origin", "main");
  branch(u, "fine", { "fine.txt": "fine\n" }, "main");
  const unused = stubHarness(fixBroken);
  configure(u, ["fine"], { harness: { command: unused.command } });
  expect((await cb(u, "rebuild")).code).toBe(4);
  expect(unused.calls()).toBe(0);
});

const latest = (w: World) => join(dirOf(w), "reports", "latest");
const handoffs = (w: World) => {
  const dir = join(latest(w), "handoffs");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
const rule = "never into the custom build branch";

test("a patch that conflicts with upstream is reported for a rebase with a handoff", async () => {
  const w = world();
  branch(w, "stale", { "base.txt": "one\nSTALE\nthree\n" });
  commit(w.seed, { "base.txt": "one\nUPSTREAM\nthree\n" }, "upstream moves on");
  git(w.seed, "push", "-q", "origin", "main");
  const h = stubHarness(takeTheirs);
  configure(w, ["stale"], { harness: { command: h.command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  const text = read(join(latest(w), "report.md"));
  expect(text).toContain("## Needs a rebase onto upstream\n\n- stale: base.txt\n");
  expect(text).toContain("## Agent-resolved merges\n\n- stale: base.txt\n");
  expect(text).toContain("## Clashes between patches\n\nnone\n");
  expect(handoffs(w)).toEqual(["stale.md"]);
  const handoff = read(join(latest(w), "handoffs", "stale.md"));
  expect(handoff).toContain("# Handoff: stale\n");
  expect(handoff).toContain("- Kind: rebase\n");
  expect(handoff).toContain("- base.txt");
  expect(handoff).toContain("upstream main moved on");
  expect(handoff).toContain("Run this in the checkout of branch stale:");
  expect(handoff).toContain(rule);
  expect(result.out).toContain("handoff: ");
  // status runs the same check without rebuilding.
  expect((await cb(w, "status")).out).toContain("stale: needs a rebase onto upstream (base.txt)");
});
test("patches that only clash with each other get a note and no handoff, however resolved", async () => {
  const byHarness = world();
  conflicting(byHarness);
  configure(byHarness, ["left", "right"], { harness: { command: stubHarness(takeTheirs).command } });
  expect((await cb(byHarness, "rebuild")).code).toBe(0);
  expect(read(join(latest(byHarness), "report.md"))).toContain(
    "## Clashes between patches\n\n- right conflicted with patches merged before it in base.txt (resolved by harness); it merges cleanly onto upstream alone\n",
  );
  expect(handoffs(byHarness)).toEqual([]);

  const byUser = world();
  conflicting(byUser);
  configure(byUser, ["left", "right"]);
  expect((await cb(byUser, "rebuild")).code).toBe(2);
  expect(read(join(latest(byUser), "report.md"))).toContain("(resolved by nobody yet)");
  write(byUser.clone, { "base.txt": "one\nBOTH\nthree\n" });
  git(byUser.clone, "add", "base.txt");
  expect((await cb(byUser, "continue")).code).toBe(0);
  expect(read(join(latest(byUser), "report.md"))).toContain("in base.txt (resolved by user)");
  expect(handoffs(byUser)).toEqual([]);
});
test("an agent fix for a patch that fails alone on upstream hands off build drift to that patch", async () => {
  const w = world();
  branch(w, "fine", { "fine.txt": "fine\n" });
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  configure(w, ["fine", "bad"], { harness: { command: stubHarness(fixBroken).command } });
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(handoffs(w)).toEqual(["bad.md"]);
  const handoff = read(join(latest(w), "handoffs", "bad.md"));
  expect(handoff).toContain("- Kind: build-drift\n");
  expect(handoff).toContain("custom-build: fix typecheck (agent)");
  expect(handoff).toContain("bad.txt");
  expect(handoff).toContain(rule);
  const text = read(join(latest(w), "report.md"));
  expect(text).toMatch(/## Fix commits\n\n- [0-9a-f]{7} typecheck \(agent\): bad\.txt\n/);
  expect(text).toContain("- typecheck: passed");
  expect(text).toContain("- build: passed");
});
test("an agent fix for patches that only fail together hands off a clash naming each other", async () => {
  const w = world();
  branch(w, "a", { "a.txt": "a\n" });
  branch(w, "b", { "b.txt": "b\n" });
  const steps = {
    ...stubSteps,
    typecheck: [
      "sh",
      "-c",
      'test -f ok.txt || ! { test -f a.txt && test -f b.txt; } || { echo "a.txt clashes with b.txt"; false; }',
    ],
  };
  configure(w, ["a", "b"], { steps, harness: { command: stubHarness("echo ok > ok.txt").command } });
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(handoffs(w)).toEqual(["a.md", "b.md"]);
  const a = read(join(latest(w), "handoffs", "a.md")),
    b = read(join(latest(w), "handoffs", "b.md"));
  expect(a).toContain("- Kind: build-clash\n");
  expect(a).toContain("clashes with: b");
  expect(b).toContain("clashes with: a");
  for (const text of [a, b]) expect(text).toContain(rule);
});
test("reports/latest follows the newest run and only ten runs are kept", () => {
  const reports = fresh("reports");
  const names = Array.from({ length: 12 }, (_, i) => `20261104-1000${String(i).padStart(2, "0")}`);
  names.push("20261104-100011-2");
  for (const name of names) mkdirSync(join(reports, name));
  report.linkLatest(reports, join(reports, "20261104-100011-2"));
  report.linkLatest(reports, join(reports, "20261104-100011-2"));
  report.prune(reports);
  expect(readlinkSync(join(reports, "latest"))).toBe("20261104-100011-2");
  expect(readdirSync(reports).sort()).toEqual([...names.slice(3), "latest"].sort());
});

test("the real steps are the repository's checks, the unit tests after a native build", () => {
  const vars = { outfile: "/r/dist/corgi-custom" },
    real = config.defaults();
  expect(steps.commands("typecheck", real, vars)).toEqual([["bun", "typecheck.ts"]]);
  expect(steps.commands("test", real, vars)).toEqual([
    ["bun", "build.ts", "--native-only"],
    ["bun", "test", "src"],
  ]);
  expect(steps.commands("build", real, vars)).toEqual([["bun", "build.ts", "--outfile", "/r/dist/corgi-custom"]]);
  expect(steps.commands("test", { ...real, steps: { test: ["true"] } }, vars)).toEqual([["true"]]);
});

test("rebuild --push sends the custom branch to origin; a plain rebuild never pushes", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  configure(w, ["mine"]);
  const fork = join(w.github, "me/corgi.git");
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(git(w.clone, "ls-remote", fork, "refs/heads/custom-build")).toBe("");
  const pushed = await cb(w, "rebuild", "--push");
  expect(pushed.code).toBe(0);
  expect(pushed.out).toContain("pushed custom-build to origin");
  expect(git(w.clone, "ls-remote", fork, "refs/heads/custom-build")).toStartWith(head(w));
  expect(git(w.clone, "ls-remote", w.upstream, "refs/heads/custom-build")).toBe("");
});
test("rebuild refuses a patch named like a branch it resets, and --push to upstream under another name", async () => {
  const w = world();
  branch(w, "custom-build-prev", { "prev.txt": "prev\n" });
  configure(w, ["custom-build-prev"]);
  const start = head(w),
    taken = await cb(w, "rebuild");
  expect(taken.code).toBe(1);
  expect(taken.err).toContain("the patch custom-build-prev is a branch the tool resets");
  expect(head(w)).toBe(start);
  expect(run(w)).toBeNull();
  branch(w, "mine", { "mine.txt": "mine\n" });
  configure(w, ["mine"]);
  // origin pushes to upstream, spelled with a trailing slash.
  git(w.clone, "remote", "set-url", "--push", "origin", `${w.upstream}/`);
  const pushed = await cb(w, "rebuild", "--push");
  expect(pushed.code).toBe(1);
  expect(pushed.err).toContain("--push needs an origin remote of your own");
  expect(git(w.clone, "ls-remote", w.upstream, "refs/heads/custom-build")).toBe("");
});
test("an own branch known only from a stale origin copy stops instead of building the old commit", async () => {
  const w = world();
  branch(w, "gone", { "gone.txt": "gone\n" });
  git(w.clone, "push", "-q", "origin", "gone");
  git(w.clone, "branch", "-q", "-D", "gone");
  // Deleted on origin; the clone still has refs/remotes/origin/gone.
  git(join(w.github, "me/corgi.git"), "update-ref", "-d", "refs/heads/gone");
  configure(w, ["gone"]);
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(1);
  expect(result.err).toContain("cannot fetch origin/gone for gone");
  expect(run(w)).toBeNull();
});
test("rollback of a stopped run keeps uncommitted edits on another branch", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  git(w.clone, "merge", "--abort");
  git(w.clone, "checkout", "-q", "left");
  write(w.clone, { "base.txt": "my edit\n" });
  const refused = await cb(w, "rollback");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("left has uncommitted changes");
  expect(read(join(w.clone, "base.txt"))).toBe("my edit\n");
  expect(run(w)).not.toBeNull();
});
test("install runs when nothing is installed yet, even with unchanged manifests", () => {
  const w = world(),
    start = head(w);
  expect(steps.installNeeded(w.clone, start)).toBe(true);
  mkdirSync(join(w.clone, "node_modules"));
  expect(steps.installNeeded(w.clone, start)).toBe(false);
});
test("after a harness fix every step runs again, so a fix can't break a step that passed", async () => {
  const w = world();
  branch(w, "flaky", { "flaky.txt": "FAILTEST\n" });
  // The first fix passes the tests by breaking typecheck; the second fixes typecheck.
  const h = stubHarness("if grep -qs FAILTEST flaky.txt; then echo BROKEN > flaky.txt; else echo fine > flaky.txt; fi");
  configure(w, ["flaky"], {
    harness: { command: h.command },
    steps: { ...stubSteps, test: ["sh", "-c", "! grep -rqs FAILTEST --include=*.txt ."] },
  });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(2);
  expect(read(join(w.clone, "flaky.txt"))).toBe("fine\n");
  expect(git(w.clone, "log", "--first-parent", "--format=%s", "upstream/main..HEAD").split("\n")).toEqual([
    "custom-build: fix typecheck (agent)",
    "custom-build: fix test (agent)",
    "Merge flaky: about flaky",
  ]);
});
test("a fix for every step within one attempt each still finishes the run", async () => {
  const w = world();
  branch(w, "four", { "a.txt": "INSTALLX\n", "b.txt": "BROKEN\n", "c.txt": "FAILTEST\n", "d.txt": "BUILDX\n" });
  const fails = (marker: string, then = "true") => ["sh", "-c", `! grep -rqs ${marker} --include=*.txt . && ${then}`];
  // Each call repairs the first marker left, which is the one the failing step checks.
  const h = stubHarness(
    'for m in INSTALLX BROKEN FAILTEST BUILDX; do f=$(grep -rls --include=*.txt "$m" . | head -1); if [ -n "$f" ]; then echo fine > "$f"; exit 0; fi; done',
  );
  configure(w, ["four"], {
    harness: { command: h.command, attempts: 1 },
    steps: {
      install: fails("INSTALLX"),
      typecheck: fails("BROKEN"),
      test: fails("FAILTEST"),
      build: fails("BUILDX", "mkdir -p dist && touch {outfile}"),
    },
  });
  const result = await cb(w, "rebuild");
  expect(result.err).not.toContain("custom-build: cannot");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(4);
});
test("a recorded resolution replays before any harness is called", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  write(w.clone, { "base.txt": "one\nBOTH\nthree\n" });
  git(w.clone, "add", "base.txt");
  expect((await cb(w, "continue")).code).toBe(0);
  const h = stubHarness(takeTheirs);
  configure(w, ["left", "right"], { harness: { command: h.command } });
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(h.calls()).toBe(0);
  expect(read(join(w.clone, "base.txt"))).toBe("one\nBOTH\nthree\n");
  expect(read(join(latest(w), "report.md"))).toContain("in base.txt (resolved by rerere)");
});
test("a harness retry keeps the files rerere replayed staged, so a later attempt can pass", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  write(w.clone, { "base.txt": "one\nBOTH\nthree\n" });
  git(w.clone, "add", "base.txt");
  expect((await cb(w, "continue")).code).toBe(0);
  // Now right also conflicts in a file rerere knows nothing about.
  for (const [name, text] of [
    ["left", '{"left":1}\n'],
    ["right", '{"right":1}\n'],
  ]) {
    git(w.clone, "checkout", "-q", name);
    commit(w.clone, { "package.json": text });
  }
  git(w.clone, "checkout", "-q", "custom-build");
  // The first attempt leaves the markers in; the second resolves.
  const h = stubHarness(`[ "$(wc -l < "$(dirname "$0")/calls")" -ge 2 ] || exit 0\n${takeTheirs}`);
  configure(w, ["left", "right"], { harness: { command: h.command, attempts: 2 } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(2);
  expect(read(join(w.clone, "base.txt"))).toBe("one\nBOTH\nthree\n");
  expect(read(join(w.clone, "package.json"))).toBe('{"right":1}\n');
});
test("the conflict prompt for a PR carries its link and description", async () => {
  const w = world();
  branch(w, "left", { "base.txt": "one\nLEFT\nthree\n" });
  pullRequest(w, "tals/corgi", 8, { "base.txt": "one\nPR\nthree\n" });
  noGh(w);
  const h = stubHarness(`cp "$1" "$(dirname "$0")/prompt-file"\n${takeTheirs}`);
  configure(w, ["left", "#8"], { harness: { command: h.command } });
  expect((await cb(w, "rebuild")).code).toBe(0);
  const prompt = read(join(h.bin, "prompt-file"));
  expect(prompt).toContain("- Patch: tals/corgi#8");
  expect(prompt).toContain("- Description: about #8");
  expect(prompt).toContain("- Pull request: https://github.com/tals/corgi/pull/8");
});
test("continue refuses when the custom branch is no longer checked out", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  git(w.clone, "merge", "--abort");
  git(w.clone, "checkout", "-q", "left");
  const left = head(w),
    result = await cb(w, "continue");
  expect(result.code).toBe(1);
  expect(result.err).toContain("custom-build is not checked out");
  expect(result.err).toContain("rollback");
  expect(head(w)).toBe(left);
  expect(git(w.clone, "branch", "--show-current")).toBe("left");
});
test("a reset that fails forgets the run and changes nothing", async () => {
  const w = world();
  commit(w.seed, { "new.txt": "upstream\n" }, "upstream adds a file");
  git(w.seed, "push", "-q", "origin", "main");
  branch(w, "mine", { "mine.txt": "mine\n" });
  configure(w, ["mine"]);
  write(w.clone, { "new.txt": "untracked and in the way\n" });
  const start = head(w),
    result = await cb(w, "rebuild");
  expect(result.code).toBe(1);
  expect(run(w)).toBeNull();
  expect(head(w)).toBe(start);
  expect(git(w.clone, "branch", "--show-current")).toBe("main");
  expect(read(join(w.clone, "new.txt"))).toBe("untracked and in the way\n");
});
test("a fork URL with credentials is refused, on add and in the config", async () => {
  const w = world();
  const added = await cb(w, "add", "https://me:secret@git.example.org/x/corgi.git#branch=fix", "--description", "X");
  expect(added.code).toBe(1);
  expect(added.err).toContain("carries credentials");
  expect(added.err).not.toContain("secret");
  expect(existsSync(join(dirOf(w), "config.json"))).toBe(false);
  expect((await cb(w, "add", "ssh://git@git.example.org/x/corgi.git#branch=fix", "--description", "X")).code).toBe(0);
  const dir = fresh("config");
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      version: 1,
      patches: [
        {
          source: { kind: "fork-branch", url: "https://x-access-token:t0k@github.com/a/b.git", branch: "c" },
          description: "d",
        },
      ],
    }),
  );
  expect(() => config.load(dir)).toThrow("carries credentials");
});
test("a stopped and continued run keeps one set of handoffs", async () => {
  const w = world();
  branch(w, "stale", { "base.txt": "one\nSTALE\nthree\n" });
  commit(w.seed, { "base.txt": "one\nUPSTREAM\nthree\n" }, "upstream moves on");
  git(w.seed, "push", "-q", "origin", "main");
  configure(w, ["stale"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  expect(handoffs(w)).toEqual(["stale.md"]);
  write(w.clone, { "base.txt": "one\nBOTH\nthree\n" });
  git(w.clone, "add", "base.txt");
  expect((await cb(w, "continue")).code).toBe(0);
  expect(handoffs(w)).toEqual(["stale.md"]);
});
test("a harness that times out takes its children with it", async () => {
  const w = world();
  conflicting(w);
  // The harness and its background child hold a FIFO open; its reader sees
  // the end only once both are gone.
  const fifo = join(fresh("fifo"), "held");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const reader = Bun.spawn(["cat", fifo], { stdout: "ignore" }),
    h = stubHarness(`exec 3>"${fifo}"\n(exec sleep 30) &\nexec sleep 30`);
  configure(w, ["left", "right"], { harness: { command: h.command, attempts: 1, timeoutSeconds: 1 } });
  try {
    expect((await cb(w, "rebuild")).code).toBe(5);
    const gone = await Promise.race([
      reader.exited.then(() => true),
      new Promise<boolean>(resolve => setTimeout(resolve, 5000, false)),
    ]);
    expect(gone).toBe(true);
  } finally {
    reader.kill();
  }
});
test("a fix never commits the temporary files an interrupted bun build leaves", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  const h = stubHarness(`${fixBroken}\necho junk > .0123abcd-00000000.bun-build`);
  configure(w, ["bad"], { harness: { command: h.command } });
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(git(w.clone, "show", "--name-only", "--format=", "HEAD")).toBe("bad.txt");
  expect(harnessLeftover("dir/.0123abcd-00000000.bun-build")).toBe(true);
  expect(harnessLeftover("src/build.ts")).toBe(false);
});
test("an agent fix touching a single patch that passes alone names the other merged patches as its clash", async () => {
  const w = world();
  branch(w, "a", { "a.txt": "a\n" });
  branch(w, "b", { "b.txt": "b\n" });
  // Fails with both merged; the output names only a.txt, so only a is implicated.
  const steps = {
    ...stubSteps,
    typecheck: [
      "sh",
      "-c",
      'test -f ok.txt || test "$(ls [ab].txt 2>/dev/null | wc -l)" -lt 2 || { echo "a.txt broke"; false; }',
    ],
  };
  configure(w, ["a", "b"], { steps, harness: { command: stubHarness("echo ok > ok.txt").command } });
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(handoffs(w)).toEqual(["a.md"]);
  expect(read(join(latest(w), "handoffs", "a.md"))).toContain("clashes with: b");
});
test("a failure log names a file only outside lines that hold nothing but a path", () => {
  const log = [
    "$ sh -c test -f src/e.ts",
    "src/a.test.ts:",
    "(pass) works",
    "  src/b.test.ts",
    "src/c.ts(3,4): error",
    "at x (/r/src/d.ts:1:2)",
  ];
  const text = steps.failureText(log.join("\n"));
  expect(["src/a.test.ts", "src/b.test.ts", "src/c.ts", "src/d.ts", "src/e.ts"].map(f => text.includes(f))).toEqual([
    false,
    false,
    true,
    true,
    false,
  ]);
});
test("an agent fix that no patch is named for runs nothing to attribute it and hands off nothing", async () => {
  const w = world();
  branch(w, "a", { "a.txt": "a\n" });
  branch(w, "b", { "b.txt": "b\n" });
  // A test runner's file list names every patch's file; the failure names none.
  const steps = {
    ...stubSteps,
    typecheck: ["sh", "-c", 'printf "a.txt:\\nb.txt:\\n"; test -f ok.txt || ! test -f a.txt'],
  };
  configure(w, ["a", "b"], { steps, harness: { command: stubHarness("echo ok > ok.txt").command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(result.err).toContain("the typecheck fix changed or the failure names; not attributed");
  expect(result.err).not.toContain("alone on upstream (");
  expect(handoffs(w)).toEqual([]);
  expect(read(join(latest(w), "report.md"))).toMatch(/typecheck \(agent\): ok\.txt \(no merged patch .*; no handoff\)/);
});
test("attribution says which patch it runs alone and how many are left", async () => {
  const w = world();
  branch(w, "fine", { "fine.txt": "fine\n" });
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  configure(w, ["fine", "bad"], { harness: { command: stubHarness(fixBroken).command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(result.err).toContain("running typecheck with bad alone on upstream (1 of 1)");
});
test("a step that fails once and passes when run again is reported as flaky, never fixed or blamed", async () => {
  const w = world();
  branch(w, "a", { "a.txt": "a\n" });
  const tried = join(fresh("flaky"), "tried");
  const steps = { ...stubSteps, typecheck: ["sh", "-c", `test -f "${tried}" || { touch "${tried}"; false; }`] };
  const h = stubHarness("echo ok > ok.txt");
  configure(w, ["a"], { steps, harness: { command: h.command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(0);
  expect(git(w.clone, "log", "--first-parent", "--format=%s", "upstream/main..HEAD")).toBe("Merge a: about a");
  expect(existsSync(join(latest(w), "isolated", "upstream-typecheck.log"))).toBe(false);
  expect(result.out).toContain("warning: typecheck failed once and passed when run again; it may be flaky");
  const text = read(join(latest(w), "report.md"));
  expect(text).toContain(
    "- typecheck failed once and passed when run again; it may be flaky (log: steps/typecheck-flaky-1.log)",
  );
  expect(text).toContain("- typecheck: passed");
  expect(existsSync(join(latest(w), "steps", "typecheck-flaky-1.log"))).toBe(true);
});

/** Turns a stopped run into one interrupted during a harness call: the marker
 * the tool writes before calling it, with the tree as it was then. */
function interruptHarness(w: World, call: Partial<config.HarnessCall> & { kind: "conflict" | "build" }) {
  const state = run(w)!;
  config.saveRun(dirOf(w), {
    ...state,
    stopped: null,
    harnessCall: { attempt: 1, head: head(w), snapshot: gitTool.snapshot(w.clone), ...call },
  });
}
test("continue after an interrupted harness conflict call commits leftovers that pass the checks as the agent's", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  interruptHarness(w, { kind: "conflict", patch: "right", files: ["base.txt"] });
  git(w.clone, "checkout", "-q", "--theirs", "--", "base.txt");
  const resumed = await cb(w, "continue");
  expect(resumed.code).toBe(0);
  expect(git(w.clone, "log", "-1", "--format=%B", "HEAD^{/Merge right}")).toBe(
    "Merge right: about right\n\nResolved-By: harness",
  );
  expect(resumed.out).toContain("agent resolved the conflict in right");
  expect(read(join(latest(w), "report.md"))).toContain("## Agent-resolved merges\n\n- right: base.txt\n");
  expect(run(w)).toBeNull();
});
test("continue after an interrupted harness conflict call rejects leftovers that fail the checks", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  const before = head(w);
  interruptHarness(w, { kind: "conflict", patch: "right", files: ["base.txt"] });
  git(w.clone, "checkout", "-q", "--theirs", "--", "base.txt");
  write(w.clone, { "package.json": "changed\n" });
  const resumed = await cb(w, "continue");
  expect(resumed.code).toBe(2);
  expect(resumed.out).toContain("the interrupted harness resolution of right was rejected");
  expect(resumed.out).toContain("outside the conflict: package.json");
  expect(head(w)).toBe(before);
  expect(git(w.clone, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toMatch(/^[0-9a-f]{40}$/);
  expect(read(join(latest(w), "report.md"))).toContain("Result: stopped (exit 2)");
  expect(run(w)?.harnessCall ?? null).toBeNull();
});
test("continue after an interrupted harness build call commits an accepted fix as the agent's and hands it off", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  configure(w, ["bad"]);
  expect((await cb(w, "rebuild")).code).toBe(3);
  const log = join(run(w)!.reportDir, "steps", "typecheck.log");
  interruptHarness(w, { kind: "build", step: "typecheck", log });
  write(w.clone, { "bad.txt": "fixed\n" });
  const resumed = await cb(w, "continue");
  expect(resumed.code).toBe(0);
  expect(git(w.clone, "log", "-1", "--format=%B")).toBe("custom-build: fix typecheck (agent)\n\nFixed-By: harness");
  expect(resumed.out).toMatch(/agent fix [0-9a-f]{7} for typecheck/);
  expect(read(join(latest(w), "report.md"))).toMatch(/## Fix commits\n\n- [0-9a-f]{7} typecheck \(agent\): bad\.txt\n/);
  expect(handoffs(w)).toEqual(["bad.md"]);
  expect(read(join(latest(w), "handoffs", "bad.md"))).toContain("- Kind: build-drift\n");
});
test("continue after an interrupted harness build call that changed nothing stops without committing", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  configure(w, ["bad"]);
  expect((await cb(w, "rebuild")).code).toBe(3);
  const before = head(w);
  interruptHarness(w, { kind: "build", step: "typecheck", log: join(run(w)!.reportDir, "steps", "typecheck.log") });
  const resumed = await cb(w, "continue");
  expect(resumed.code).toBe(3);
  expect(resumed.out).toContain("the interrupted harness fix for typecheck was rejected: it changed nothing");
  expect(head(w)).toBe(before);
  expect(run(w)?.phase).toBe("verify");
  expect(run(w)?.harnessCall ?? null).toBeNull();
});
