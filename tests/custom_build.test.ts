import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as config from "../scripts/custom_build/config";
import * as report from "../scripts/custom_build/report";
import { main } from "../scripts/custom_build/main";
import * as sources from "../scripts/custom_build/sources";
import * as steps from "../scripts/custom_build/steps";
import * as term from "../scripts/custom_build/term";
import * as timings from "../scripts/custom_build/timings";
import { buildLeftover as harnessLeftover } from "../scripts/custom_build/harness";
import * as gitTool from "../scripts/custom_build/git";
import type { LiveEvent } from "../scripts/custom_build/live_events";

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
function stubGh(
  w: World,
  answers: Record<string, { state: string; title: string; mergeCommit?: string; head?: string }>,
) {
  const bin = fresh("gh-bin");
  for (const [key, answer] of Object.entries(answers)) {
    // `head` is `owner/repo:branch`, the PR's head repository and branch.
    const [, owner, name, ref] = /^([^/]+)\/([^:]+):(.+)$/.exec(answer.head ?? "") ?? [];
    writeFileSync(
      join(bin, `${sources.slug(key)}.json`),
      JSON.stringify({
        state: answer.state,
        title: answer.title,
        mergeCommit: answer.mergeCommit ? { oid: answer.mergeCommit } : null,
        ...(answer.head ? { headRepositoryOwner: { login: owner }, headRepository: { name }, headRefName: ref } : {}),
      }),
    );
  }
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
test("sources display as the report names them and slug into file names", () => {
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
test("harness.kind must be claude or codex", async () => {
  const w = world();
  configure(w, [], { harness: { command: ["h"], kind: "gpt" as config.HarnessKind } });
  const refused = await cb(w, "list");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("harness.kind must be one of claude, codex");
  configure(w, [], { harness: { command: ["h"], kind: "codex" } });
  expect(config.load(dirOf(w)).harness?.kind).toBe("codex");
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
    // Only the rebase tests rebase own branches; they use `configureOwn`.
    rebase: "off",
    ...extra,
  });
}
let clock = Date.parse("2026-11-04T10:00:00Z");
async function cb(w: World, ...args: string[]) {
  return cbWith(w, {}, ...args);
}
/** `cb` with a terminal that answers each question with `ask`, and `sink` collecting the live events.
 * `live: "inline"` draws the live view into `out` at `columns` and `rows`; its questions are
 * written to `out` as the terminal's prompt would. */
async function cbWith(
  w: World,
  o: {
    ask?: (question: string) => string | null;
    sink?: (event: LiveEvent) => void;
    color?: boolean;
    columns?: number;
    rows?: number;
    live?: "inline";
  },
  ...args: string[]
) {
  let out = "",
    err = "";
  const ask = o.ask;
  const code = await main(args, {
    cwd: w.clone,
    env: w.env,
    out: text => void (out += text),
    err: text => void (err += text),
    now: () => new Date((clock += 1000)),
    ask: ask && o.live ? question => ((out += question), ask(question)) : ask,
    sink: o.sink,
    color: o.color,
    columns: o.columns,
    rows: o.rows,
    live: o.live,
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

test("a rebuild records its timings and the next one has history", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  configure(w, ["mine"]);
  expect((await cb(w, "rebuild")).code).toBe(0);
  const first = timings.loadHistory(dirOf(w)).runs;
  expect(first.length).toBe(1);
  expect(first[0]).toMatchObject({ command: "rebuild", partial: false });
  expect(Object.keys(first[0].items)).toEqual(
    expect.arrayContaining(["fetch", "merge:mine", "step:typecheck", "step:test", "step:build"]),
  );
  expect(first[0].activeMs).toBeGreaterThan(0);
  expect((await cb(w, "rebuild")).code).toBe(0);
  const h = timings.loadHistory(dirOf(w));
  expect(h.runs.length).toBe(2);
  expect(timings.estimate(h, "rebuild", ["fetch", "merge:mine"], {}, 0).last).toEqual(h.runs[1]);
});
test("a run state without timing loads", async () => {
  const w = world();
  branch(w, "left", { "base.txt": "one\nLEFT\nthree\n" });
  branch(w, "right", { "base.txt": "one\nRIGHT\nthree\n" });
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  // A run state an older tool wrote: no timings, no harness usage.
  const old = JSON.parse(read(config.runPath(dirOf(w))));
  expect(old.timing).toBeDefined();
  delete old.timing;
  delete old.harnessUsage;
  writeFileSync(config.runPath(dirOf(w)), JSON.stringify(old, null, 2));
  write(w.clone, { "base.txt": "one\nLEFT and RIGHT\nthree\n" });
  git(w.clone, "add", "base.txt");
  expect((await cb(w, "continue")).code).toBe(0);
  const runs = timings.loadHistory(dirOf(w)).runs;
  expect(runs.length).toBe(1);
  // The merge it stopped in started before the run state kept timings, so it has none.
  expect(Object.keys(runs[0].items)).toEqual(["step:install", "step:typecheck", "step:test", "step:build"]);
});
test("a stopped run is recorded once, when it finishes", async () => {
  const conflicted = () => {
    const w = world();
    branch(w, "left", { "base.txt": "one\nLEFT\nthree\n" });
    branch(w, "right", { "base.txt": "one\nRIGHT\nthree\n" });
    configure(w, ["left", "right"]);
    return w;
  };
  const w = conflicted();
  expect((await cb(w, "rebuild")).code).toBe(2);
  expect(existsSync(timings.historyPath(dirOf(w)))).toBe(false);
  expect(Object.keys(run(w)?.timing?.items ?? {})).toEqual(["fetch", "merge:left"]);
  write(w.clone, { "base.txt": "one\nLEFT and RIGHT\nthree\n" });
  git(w.clone, "add", "base.txt");
  expect((await cb(w, "continue")).code).toBe(0);
  const runs = timings.loadHistory(dirOf(w)).runs;
  expect(runs.length).toBe(1);
  expect(runs[0]).toMatchObject({ command: "rebuild", partial: false });
  expect(Object.keys(runs[0].items)).toEqual(
    expect.arrayContaining(["fetch", "merge:left", "merge:right", "step:build"]),
  );
  // Rolled back instead, the run writes its finished items, marked partial.
  const v = conflicted();
  expect((await cb(v, "rebuild")).code).toBe(2);
  expect((await cb(v, "rollback")).code).toBe(0);
  const partial = timings.loadHistory(dirOf(v)).runs;
  expect(partial.length).toBe(1);
  expect(partial[0]).toMatchObject({ command: "rebuild", partial: true });
  expect(Object.keys(partial[0].items)).toEqual(["fetch", "merge:left"]);
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
    "custom-build · 3 patches, merged in this order onto upstream/main\n" +
      "\n" +
      "#  PATCH              ADDED       DESCRIPTION\n" +
      "1  tals/corgi#109     2026-11-04  jump to blocked agents\n" +
      "2  my-branch          2026-11-04  My change\n" +
      "3  other/corgi:topic  2026-11-04  Topic\n",
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
  expect((await cb(w, "list", "--retired")).out).toMatch(/^my-branch  \d{4}-\d{2}-\d{2}  merged upstream$/m);
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

/** What a claude harness streams: one assistant message, then the result with its usage. */
const claudeStream = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Keeping both import blocks." }] } }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 1200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 49500,
      output_tokens: 7400,
    },
  }),
]
  .map(line => `echo '${line}'`)
  .join("\n");
const keepArgs = `printf '%s\\n' "$@" > "$(dirname "$0")/argv"`;
const argv = (h: { bin: string }) => read(join(h.bin, "argv")).split("\n").filter(Boolean);

test("a claude harness logs readable text, keeps the raw stream and records tokens", async () => {
  const w = world();
  conflicting(w);
  const h = stubHarness(`${keepArgs}\n${takeTheirs}\n${claudeStream}`);
  configure(w, ["left", "right"], { harness: { command: h.command, kind: "claude" } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  const log = read(join(latest(w), "prompts", "01-conflict.log"));
  expect(log).toContain("Keeping both import blocks.");
  expect(log).not.toContain('"type":"assistant"');
  expect(read(join(latest(w), "prompts", "01-conflict.jsonl"))).toContain('"type":"result"');
  expect(argv(h).slice(-3)).toEqual(["--output-format", "stream-json", "--verbose"]);
  expect(read(join(latest(w), "report.md"))).toContain(
    "## Harness\n\n- 1 call, 1 accepted, tokens 51.0k in / 7.4k out\n- right conflict try 1: accepted, 51.0k in / 7.4k out\n",
  );
});
test("plain run with kind claude shows readable text", async () => {
  const w = world();
  conflicting(w);
  const h = stubHarness(`${takeTheirs}\n${claudeStream}`);
  configure(w, ["left", "right"], { harness: { command: h.command, kind: "claude" } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(result.err).toContain("Keeping both import blocks.\n");
  expect(result.err).not.toContain('{"type"');
  expect(result.err).not.toContain("\x1b");
});
test("a claude harness's activity reaches the sink, and a sink that throws on it stops nothing", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"], {
    harness: { command: stubHarness(`${takeTheirs}\n${claudeStream}`).command, kind: "claude" },
  });
  const events: LiveEvent[] = [];
  const result = await cbWith(
    w,
    {
      sink: e => {
        events.push(e);
        if (e.t === "harness" && e.state === "activity") throw Error("broken view");
      },
    },
    "rebuild",
  );
  expect(result.code).toBe(0);
  expect(events[0]).toMatchObject({ t: "begin", harness: "claude" });
  const activity = events.filter(e => e.t === "harness" && e.state === "activity");
  expect(activity.length).toBeGreaterThan(0);
  expect(activity[0]).toMatchObject({ stage: "merge", id: "right", attempt: 1, limit: 3 });
  expect(activity.map(e => (e as { text?: string }).text)).toContain("Keeping both import blocks.");
  // The output after the throw still reached the log.
  expect(read(join(latest(w), "prompts", "01-conflict.log"))).toContain("Keeping both import blocks.");
  expect(events.find(e => e.t === "harness" && e.state === "end")).toMatchObject({
    ok: true,
    usage: { input: 51000, output: 7400 },
  });
});
test("a harness without kind is run and logged as today", async () => {
  const w = world();
  conflicting(w);
  const h = stubHarness(`${keepArgs}\n${takeTheirs}\necho plain words`);
  configure(w, ["left", "right"], { harness: { command: h.command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(argv(h)).not.toContain("--output-format");
  expect(existsSync(join(latest(w), "prompts", "01-conflict.jsonl"))).toBe(false);
  expect(read(join(latest(w), "prompts", "01-conflict.log"))).toContain("plain words\n");
  expect(result.err).toContain("plain words\n");
  expect(read(join(latest(w), "report.md"))).toContain(
    "## Harness\n\n- 1 call, 1 accepted, tokens unknown\n- right conflict try 1: accepted, tokens unknown\n",
  );
});
test("rejected fixes and rebase conflicts are recorded as harness calls", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  configure(w, ["bad"], { harness: { command: stubHarness("true").command, attempts: 2 } });
  expect((await cb(w, "rebuild")).code).toBe(5);
  expect(run(w)?.harnessUsage?.map(u => [u.call, u.kind, u.step, u.attempt, u.ok, u.reason])).toEqual([
    [1, "build", "typecheck", 1, false, "it changed nothing"],
    [2, "build", "typecheck", 2, false, "it changed nothing"],
  ]);
  expect(read(join(latest(w), "report.md"))).toContain(
    "## Harness\n\n- 2 calls, 0 accepted, tokens unknown\n" +
      "- typecheck fix try 1: rejected: it changed nothing, tokens unknown\n" +
      "- typecheck fix try 2: rejected: it changed nothing, tokens unknown\n",
  );

  const r = world();
  branch(r, "stale", { "base.txt": "one\nSTALE\nthree\n" });
  commit(r.seed, { "base.txt": "one\nUPSTREAM\nthree\n" }, "upstream moves on");
  git(r.seed, "push", "-q", "origin", "main");
  configure(r, ["stale"], { rebase: undefined, harness: { command: stubHarness(takeTheirs).command } });
  expect((await cb(r, "rebuild")).code).toBe(0);
  const rebaseCall = "- 1 call, 1 accepted, tokens unknown\n- stale rebase conflict try 1: accepted, tokens unknown\n";
  expect(read(join(latest(r), "report.md"))).toContain(`## Harness\n\n${rebaseCall}`);

  // The rebase command's report lists them too.
  const c = world();
  branch(c, "stale", { "base.txt": "one\nSTALE\nthree\n" });
  commit(c.seed, { "base.txt": "one\nUPSTREAM\nthree\n" }, "upstream moves on");
  git(c.seed, "push", "-q", "origin", "main");
  configure(c, ["stale"], { rebase: undefined, harness: { command: stubHarness(takeTheirs).command } });
  expect((await cb(c, "rebase")).code).toBe(0);
  expect(read(join(latest(c), "report.md"))).toContain(`## Harness\n\n${rebaseCall}`);
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
  const shown = (await cb(w, "status")).out;
  expect(shown).toMatch(/^stale +✗ 1 conflict/m);
  expect(shown).toMatch(/^  stale +base\.txt$/m);
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
test("reports/latest follows the newest run and only ten runs and ten rollback logs are kept", () => {
  const reports = fresh("reports");
  const names = Array.from({ length: 12 }, (_, i) => `20261104-1000${String(i).padStart(2, "0")}`);
  names.push("20261104-100011-2");
  const rollbacks = Array.from({ length: 11 }, (_, i) => `rollback-20261104-1100${String(i).padStart(2, "0")}`);
  for (const name of [...names, ...rollbacks]) mkdirSync(join(reports, name));
  report.linkLatest(reports, join(reports, "20261104-100011-2"));
  report.linkLatest(reports, join(reports, "20261104-100011-2"));
  report.prune(reports);
  expect(readlinkSync(join(reports, "latest"))).toBe("20261104-100011-2");
  expect(readdirSync(reports).sort()).toEqual([...names.slice(3), ...rollbacks.slice(1), "latest"].sort());
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
test("a second fix for the same step is recorded against the failure it answered", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN-ONE\n" });
  // The first fix leaves a different failure; the second one repairs it.
  const h = stubHarness("if grep -qs BROKEN-ONE bad.txt; then echo BROKEN-TWO > bad.txt; else echo fine > bad.txt; fi");
  configure(w, ["bad"], {
    harness: { command: h.command },
    steps: { ...stubSteps, typecheck: ["sh", "-c", "! grep -rhs BROKEN --include=*.txt ."] },
  });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(2);
  const first = read(join(latest(w), "steps", "typecheck-failed-1.log")),
    second = read(join(latest(w), "steps", "typecheck-failed-2.log"));
  expect(first).toContain("BROKEN-ONE");
  expect(second).toContain("BROKEN-TWO");
  expect(second).not.toContain("BROKEN-ONE");
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

/** Live events as short words, for comparing sequences: `t`, then `stage` or `state`, an item's outcome. */
function eventWords(events: LiveEvent[]): string[] {
  return events.map(e => {
    switch (e.t) {
      case "stage":
        return `stage ${e.stage} ${e.state}`;
      case "item":
        return `item ${e.stage} ${e.id} ${e.state}${e.outcome ? ` ${e.outcome}` : ""}`;
      case "harness":
        return `harness ${e.state}${e.state === "end" ? ` ok:${e.ok}` : ""}`;
      case "retry":
        return `retry ${e.why}`;
      case "end":
        return `end ok:${e.ok}`;
      default:
        return e.t;
    }
  });
}
/** Whether `want` appears in `words` in order, other words in between. */
const inOrder = (words: string[], want: string[]) => {
  let i = 0;
  for (const word of words) if (word === want[i]) i++;
  return i === want.length ? null : `missing ${want[i]} after ${want[i - 1] ?? "the start"}`;
};

test("a rebuild signals stages, items and the end", async () => {
  const w = world();
  conflicting(w);
  const tried = join(fresh("flaky"), "tried");
  const steps = { ...stubSteps, typecheck: ["sh", "-c", `test -f "${tried}" || { touch "${tried}"; false; }`] };
  configure(w, ["left", "right"], { steps, harness: { command: stubHarness(takeTheirs).command } });
  const events: LiveEvent[] = [];
  const result = await cbWith(w, { sink: e => void events.push(e) }, "rebuild");
  expect(result.code).toBe(0);
  const words = eventWords(events);
  expect(
    inOrder(words, [
      "begin",
      "stage fetch start",
      "stage fetch done",
      "stage merge start",
      "item merge left done merged",
      "item merge right start",
      "harness start",
      "harness end ok:true",
      "item merge right done agent-resolved",
      "stage merge done",
      "stage verify start",
      "retry flaky",
      "item verify typecheck done flaky",
      "stage verify done",
      "end ok:true",
    ]),
  ).toBeNull();
  expect(words.filter(word => word === "begin").length).toBe(1);
  expect(words.at(-1)).toBe("end ok:true");
  const begin = events[0] as Extract<LiveEvent, { t: "begin" }>;
  expect(begin).toMatchObject({
    command: "rebuild",
    branch: "custom-build",
    stages: ["fetch", "merge", "verify"],
    items: { merge: ["left", "right"], verify: ["install", "typecheck", "test", "build"] },
    harness: null,
  });
  const fetched = events.find(e => e.t === "stage" && e.stage === "fetch" && e.state === "done");
  expect(fetched).toMatchObject({
    upstream: { name: "upstream/main", tip: git(w.clone, "rev-parse", "upstream/main") },
  });
  const end = events.at(-1) as Extract<LiveEvent, { t: "end" }>;
  const outcome = result.out.trimEnd().split("\n");
  expect(end.headline).toBe(outcome[0].replace(/^custom-build: /, ""));
  expect(end.lines).toEqual(outcome.slice(1));
  expect(end.report).toEndWith("/report.md");
  expect(end.activeMs).toBeGreaterThanOrEqual(0);
  expect(result.out).toContain(`  report: ${end.report}\n`);
});
test("a rebuild prints the same with and without a sink", async () => {
  const outputs = [];
  for (const sink of [undefined, () => {}]) {
    const w = world();
    conflicting(w);
    configure(w, ["left", "right"], { harness: { command: stubHarness(takeTheirs).command } });
    const result = await cbWith(w, { sink }, "rebuild");
    expect(result.code).toBe(0);
    outputs.push(
      [result.out, result.err].map(text =>
        text
          .replaceAll(w.clone, "<clone>")
          .replace(/\d{8}-\d{6}(-\d+)?/g, "<stamp>")
          .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>"),
      ),
    );
  }
  expect(outputs[1]).toEqual(outputs[0]);
});
test("a stopped run signals the stop, and continue replays it first", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  const events: LiveEvent[] = [];
  const stopped = await cbWith(w, { sink: e => void events.push(e) }, "rebuild");
  expect(stopped.code).toBe(2);
  const words = eventWords(events);
  expect(inOrder(words, ["item merge left done merged", "item merge right failed stopped", "end ok:false"])).toBeNull();
  expect(events.at(-1)).toMatchObject({ t: "end", ok: false, code: 2, headline: "stopped: merge conflict in right" });
  git(w.clone, "checkout", "-q", "--theirs", "base.txt");
  git(w.clone, "add", "base.txt");
  const again: LiveEvent[] = [];
  expect((await cbWith(w, { sink: e => void again.push(e) }, "continue")).code).toBe(0);
  const next = eventWords(again);
  expect(next[0]).toBe("begin");
  expect(again[0]).toMatchObject({ command: "continue" });
  expect(
    inOrder(next, [
      "begin",
      "stage fetch done",
      "item merge left done merged",
      "item merge right start",
      "item merge right done user-resolved",
      "stage merge done",
      "stage verify done",
      "end ok:true",
    ]),
  ).toBeNull();
});
test("a rebase run signals its branches", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  const events: LiveEvent[] = [];
  const result = await cbWith(w, { sink: e => void events.push(e) }, "rebase");
  expect(result.code).toBe(0);
  const words = eventWords(events);
  expect(
    inOrder(words, [
      "begin",
      "stage fetch start",
      "stage fetch done",
      "stage rebase start",
      "item rebase mine start",
      "item rebase mine done rebased",
      "stage rebase done",
      "end ok:true",
    ]),
  ).toBeNull();
  expect(events[0]).toMatchObject({ command: "rebase", stages: ["fetch", "rebase"] });
});

test("a rebuild's rebase phase signals its branches and harness calls", async () => {
  const w = world();
  branch(w, "clean", { "clean.txt": "clean\n" });
  branch(w, "stale", conflictingLine("STALE"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["clean", "stale"], { harness: { command: stubHarness(takeTheirs).command } });
  const events: LiveEvent[] = [];
  expect((await cbWith(w, { sink: e => void events.push(e) }, "rebuild")).code).toBe(0);
  expect(events[0]).toMatchObject({ stages: ["fetch", "rebase", "merge", "verify"] });
  expect(
    inOrder(eventWords(events), [
      "stage fetch done",
      "stage rebase start",
      "item rebase stale start",
      "harness start",
      "harness end ok:true",
      "item rebase stale done rebased",
      "stage rebase done",
      "stage merge start",
    ]),
  ).toBeNull();
  expect(events.find(e => e.t === "harness" && e.state === "start")).toMatchObject({
    stage: "rebase",
    id: "stale",
    files: ["base.txt"],
  });
  expect(events.find(e => e.t === "stage" && e.stage === "rebase" && e.state === "done")).toMatchObject({
    summary: "2 rebased",
  });
});
const unpainted = (text: string) => Bun.stripANSI(text);
test("rebuild --verbose is accepted and plain output is unchanged", async () => {
  const outputs = [];
  for (const args of [["rebuild"], ["rebuild", "--verbose"]]) {
    const w = world();
    branch(w, "mine", { "mine.txt": "mine\n" });
    configure(w, ["mine"]);
    const result = await cb(w, ...args);
    expect(result.code).toBe(0);
    outputs.push(
      [result.out, result.err].map(text =>
        text
          .replaceAll(w.clone, "<clone>")
          .replace(/\d{8}-\d{6}(-\d+)?/g, "<stamp>")
          .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>"),
      ),
    );
  }
  expect(outputs[1]).toEqual(outputs[0]);
  expect(outputs[0][1]).toContain("custom-build: merging mine\n");
});
test("a live rebuild prints the card and the outcome lines", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  configure(w, ["mine"]);
  const result = await cbWith(w, { live: "inline", color: true, columns: 100, rows: 40 }, "rebuild");
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  const out = unpainted(result.out);
  expect(result.out).toContain("\x1b[?25l");
  expect(out).toContain("custom-build rebuild");
  expect(out).toContain("✓ built dist/corgi-custom");
  // The card wraps the long report path; without the spaces it reads as the plain line.
  expect(out.replace(/\s+/g, "")).toMatch(/report:\/\S+\/\.custom-build\/reports\/\d{8}-\d{6}\/report\.md/);
  expect(out).toContain(`  merged mine ${tip(w, "mine")!.slice(0, 7)} about mine\n`);
  expect(result.out).toEndWith(term.restore());
});
test("a live command that throws ends its view with the error", async () => {
  const w = world();
  noGh(w);
  configure(w, ["#99"]);
  const result = await cbWith(w, { live: "inline", color: true, columns: 100, rows: 40 }, "rebuild");
  expect(result.code).toBe(1);
  expect(result.err).toBe("");
  const out = unpainted(result.out);
  // The run had begun: its frame came first, the card with the error last.
  expect(out).toContain("custom-build rebuild");
  expect(out).toMatch(/✗ cannot fetch tals\/corgi#99: .* in \d+:\d\d\n/);
  expect(result.out).toEndWith(term.restore());
});
test("a timings history that can't be written is a warning, and the run keeps its outcome", async () => {
  for (const live of [false, true]) {
    const w = world();
    branch(w, "mine", { "mine.txt": "mine\n" });
    configure(w, ["mine"]);
    // The history is written through a temporary file, which a directory blocks.
    mkdirSync(join(dirOf(w), "timings.json.tmp"), { recursive: true });
    const result = await cbWith(w, live ? { live: "inline", color: true, columns: 100, rows: 40 } : {}, "rebuild");
    expect(result.code).toBe(0);
    const out = unpainted(result.out);
    expect(out).toContain(`  merged mine ${tip(w, "mine")!.slice(0, 7)} about mine\n`);
    if (live) {
      expect(result.err).toBe("");
      expect(out).toContain("✓ built dist/corgi-custom");
      expect(out.slice(out.lastIndexOf("✓ built"))).toContain("  warning: could not record timings: ");
    } else {
      expect(out).toStartWith("custom-build: built dist/corgi-custom");
      expect(result.err).toContain("custom-build: warning: could not record timings: ");
    }
    expect(run(w)).toBeNull();
  }
  // A rollback's partial entry likewise.
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  mkdirSync(join(dirOf(w), "timings.json.tmp"), { recursive: true });
  const undone = await cb(w, "rollback");
  expect(undone.code).toBe(0);
  expect(undone.out).toStartWith("custom-build: rolled back to ");
  expect(undone.err).toContain("custom-build: warning: could not record timings: ");
});
test("the usage names --verbose for every command with a live view", async () => {
  let out = "";
  expect(await main(["--help"], { cwd: scratch, env: {}, out: text => void (out += text), err: () => {} })).toBe(0);
  for (const command of ["rebuild [", "rebase [", "rebase --skip-branch", "continue"])
    expect(out.split("\n").find(line => line.startsWith(`  ${command}`))).toContain("[--verbose]");
});
test("a live run shows its warnings on the card", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"], { harness: { command: ["/nonexistent/harness", "{prompt_file}"] } });
  const result = await cbWith(w, { live: "inline", color: true, columns: 100, rows: 40 }, "rebuild");
  expect(result.code).toBe(2);
  expect(result.err).toBe("");
  const out = unpainted(result.out),
    card = out.slice(out.lastIndexOf("✗ stopped after"));
  expect(card).toContain("  warning: harness /nonexistent/harness is not executable; continuing without it\n");
  expect(card).toContain("  files: base.txt");
});
test("a live run pauses for the push question", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  git(w.clone, "push", "-q", "origin", "mine");
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  const asked: string[] = [];
  const result = await cbWith(
    w,
    { live: "inline", color: true, columns: 100, rows: 40, ask: q => (asked.push(q), "n") },
    "rebase",
  );
  expect(result.code).toBe(0);
  expect(asked).toEqual(["Force-push 1 rebased branch to origin (mine)? [y/N] "]);
  const at = result.out.indexOf(asked[0]);
  expect(at).toBeGreaterThan(0);
  expect(result.out.lastIndexOf("\x1b[?25h", at)).toBeGreaterThanOrEqual(0);
  expect(result.out.lastIndexOf("\x1b[?25h", at)).toBeGreaterThan(result.out.lastIndexOf("\x1b[?25l", at));
  expect(unpainted(result.out.slice(at))).toContain("git push --force-with-lease=refs/heads/mine:");
  expect(result.out).toEndWith(term.restore());
});
test("step names link to their logs, in a run and in its continue", async () => {
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  const events: LiveEvent[] = [];
  expect((await cbWith(w, { sink: e => void events.push(e) }, "rebuild")).code).toBe(2);
  const steps = run(w)!.reportDir + "/steps";
  git(w.clone, "checkout", "-q", "--theirs", "base.txt");
  git(w.clone, "add", "base.txt");
  expect((await cbWith(w, { sink: e => void events.push(e) }, "continue")).code).toBe(0);
  const logs = Object.fromEntries(
    ["install", "typecheck", "test", "build"].map(step => [step, pathToFileURL(`${steps}/${step}.log`).href]),
  );
  expect(events.find(e => e.t === "begin" && e.command === "continue")).toMatchObject({ links: logs });
  expect(events.find(e => e.t === "stage" && e.stage === "verify" && e.state === "start" && e.links)).toMatchObject({
    links: logs,
  });
});
test("continue shows the earlier progress", async () => {
  const w = world();
  conflicting(w);
  branch(w, "first", { "first.txt": "first\n" });
  configure(w, ["first", "left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  git(w.clone, "checkout", "-q", "--theirs", "base.txt");
  git(w.clone, "add", "base.txt");
  const events: LiveEvent[] = [];
  expect((await cbWith(w, { sink: e => void events.push(e) }, "continue")).code).toBe(0);
  const words = eventWords(events);
  expect(words.slice(0, 6)).toEqual([
    "begin",
    "stage fetch start",
    "stage fetch done",
    "stage merge start",
    "item merge first done merged",
    "item merge left done merged",
  ]);
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

test("a continue that stops again before going on ends its item as stopped", async () => {
  const stopsOf = (events: LiveEvent[]) =>
    eventWords(events).filter(word => /^item .* (start|failed)/.test(word) || word.startsWith("end"));
  // Merge conflicts still unresolved.
  const w = world();
  conflicting(w);
  configure(w, ["left", "right"]);
  expect((await cb(w, "rebuild")).code).toBe(2);
  const unmerged: LiveEvent[] = [];
  expect((await cbWith(w, { sink: e => void unmerged.push(e) }, "continue")).code).toBe(2);
  expect(stopsOf(unmerged).slice(-3)).toEqual([
    "item merge right start",
    "item merge right failed stopped",
    "end ok:false",
  ]);

  // An interrupted harness fix that changed nothing.
  const fix = world();
  branch(fix, "bad", { "bad.txt": "BROKEN\n" });
  configure(fix, ["bad"]);
  expect((await cb(fix, "rebuild")).code).toBe(3);
  interruptHarness(fix, { kind: "build", step: "typecheck", log: join(run(fix)!.reportDir, "steps", "typecheck.log") });
  const rejected: LiveEvent[] = [];
  expect((await cbWith(fix, { sink: e => void rejected.push(e) }, "continue")).code).toBe(3);
  expect(stopsOf(rejected).slice(-3)).toEqual([
    "item verify typecheck start",
    "item verify typecheck failed failed",
    "end ok:false",
  ]);

  // An interrupted harness resolution that fails the checks.
  const conflict = world();
  conflicting(conflict);
  configure(conflict, ["left", "right"]);
  expect((await cb(conflict, "rebuild")).code).toBe(2);
  interruptHarness(conflict, { kind: "conflict", patch: "right", files: ["base.txt"] });
  const resolution: LiveEvent[] = [];
  expect((await cbWith(conflict, { sink: e => void resolution.push(e) }, "continue")).code).toBe(2);
  expect(stopsOf(resolution).slice(-2)).toEqual(["item merge right failed stopped", "end ok:false"]);
});

// Rebasing own branches (User Story 6).

/** A commit on upstream main. */
function upstreamMoves(w: World, files: Record<string, string>) {
  commit(w.seed, files, "upstream moves on");
  git(w.seed, "push", "-q", "origin", "main");
}
const fork = (w: World) => join(w.github, "me/corgi.git");
const tip = (w: World, ref: string) => gitTool.revParse(w.clone, ref);
const behindUpstream = (w: World, ref: string) => !gitTool.isAncestor(w.clone, "upstream/main", ref);
const backupOf = (w: World, name: string) => tip(w, `refs/custom-build/rebase-backup/${name}`);
const onFork = (w: World, name: string) => git(w.clone, "ls-remote", fork(w), `refs/heads/${name}`).split("\t")[0];
/** `configure` without a `rebase` mode, so the default (`all`) applies. */
const configureOwn = (w: World, patches: string[], extra: Partial<config.Config> = {}) =>
  configure(w, patches, { rebase: undefined, ...extra });
const conflictingLine = (word: string) => ({ "base.txt": `one\n${word}\nthree\n` });
/** An own PR: `name` pushed to the fork and published as upstream's `refs/pull/<n>/head`; no local branch. */
function ownPullRequest(w: World, n: number, name: string, files: Record<string, string>): string {
  const sha = branch(w, name, files);
  git(w.clone, "push", "-q", "origin", name);
  git(w.clone, "push", "-q", w.upstream, `${name}:refs/pull/${n}/head`);
  git(w.clone, "branch", "-q", "-D", name);
  return sha;
}

test("rebuild rebases own branches behind upstream, conflicting or not, and merges the rebased tips", async () => {
  const w = world();
  const clean = branch(w, "clean", { "clean.txt": "clean\n" }),
    stale = branch(w, "stale", conflictingLine("STALE"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["clean", "stale"], { harness: { command: stubHarness(takeTheirs).command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  for (const name of ["clean", "stale"]) expect(behindUpstream(w, name)).toBe(false);
  expect([backupOf(w, "clean"), backupOf(w, "stale")]).toEqual([clean, stale] as (string | null)[]);
  expect(stamped(w).map(p => p.commit)).toEqual([tip(w, "clean")!, tip(w, "stale")!]);
  expect(result.out).toContain(`rebased stale: ${stale.slice(0, 7)} to ${tip(w, "stale")!.slice(0, 7)} (harness)`);
  expect(result.out).toContain("undo: git branch -f stale refs/custom-build/rebase-backup/stale");
  expect(read(join(latest(w), "report.md"))).toContain(
    "undo: git branch -f stale refs/custom-build/rebase-backup/stale",
  );
  expect(result.out).toContain(
    `git push --force-with-lease=refs/heads/clean: origin ${tip(w, "clean")}:refs/heads/clean`,
  );
  expect(read(join(latest(w), "report.md"))).toContain("## Rebased branches");
});

test("the rebase mode comes from the config, --rebase overrides it, and conflicting leaves clean branches", async () => {
  const w = world();
  const clean = branch(w, "clean", { "clean.txt": "clean\n" }),
    stale = branch(w, "stale", conflictingLine("STALE"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["clean", "stale"], { rebase: "off", harness: { command: stubHarness(takeTheirs).command } });
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect([tip(w, "clean"), tip(w, "stale")]).toEqual([clean, stale]);
  const invalid = await cb(w, "rebase", "--rebase=sometimes");
  expect(invalid.code).toBe(1);
  expect(invalid.err).toContain("--rebase must be one of all, conflicting, off");
  expect(run(w)).toBeNull();
  expect((await cb(w, "rebuild", "--rebase=conflicting")).code).toBe(0);
  expect(tip(w, "clean")).toBe(clean);
  expect(behindUpstream(w, "stale")).toBe(false);
  expect(stamped(w).map(p => p.commit)).toEqual([clean, tip(w, "stale")!]);
});

test("other people's branches and PRs are never rebased and keep their rebase handoffs", async () => {
  const w = world();
  forkBranch(w, "other/corgi", "topic", conflictingLine("TOPIC"));
  pullRequest(w, "tals/corgi", 7, conflictingLine("PR"));
  stubGh(w, { "tals/corgi#7": { state: "OPEN", title: "theirs", head: "other/corgi:feature" } });
  // A branch of the same name on the user's fork, behind upstream: ownership must not come from the name.
  const mine = branch(w, "feature", { "mine.txt": "mine\n" });
  git(w.clone, "push", "-q", "origin", "feature");
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["other/corgi:topic", "#7"], { harness: { command: stubHarness(takeTheirs).command } });
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(0);
  expect(result.out).not.toContain("rebased tals/corgi#7");
  expect(git(w.clone, "for-each-ref", "refs/custom-build/rebase-backup")).toBe("");
  expect([tip(w, "feature"), onFork(w, "feature")]).toEqual([mine, mine]);
  const files = handoffs(w);
  expect(files).toHaveLength(2);
  for (const file of files) expect(read(join(latest(w), "handoffs", file))).toContain("- Kind: rebase\n");
});

test("an own PR's head branch is rebased into a new local branch and pushed to the fork; without gh it is not", async () => {
  const w = world();
  const old = ownPullRequest(w, 5, "feature", { "feature.txt": "f\n" });
  stubGh(w, { "tals/corgi#5": { state: "OPEN", title: "feature", head: "me/corgi:feature" } });
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["#5"]);
  const result = await cb(w, "rebuild", "--push");
  expect(result.code).toBe(0);
  expect(behindUpstream(w, "feature")).toBe(false);
  expect(onFork(w, "feature")).toBe(tip(w, "feature")!);
  expect(backupOf(w, "feature")).toBeNull();
  expect(result.out).toContain("pushed feature to origin");

  const u = world(),
    unchanged = ownPullRequest(u, 5, "feature", { "feature.txt": "f\n" });
  noGh(u);
  upstreamMoves(u, { "up.txt": "up\n" });
  configureOwn(u, ["#5"]);
  expect((await cb(u, "rebase")).code).toBe(0);
  expect(git(u.clone, "branch", "--list", "feature")).toBe("");
  expect(onFork(u, "feature")).toBe(unchanged);
  expect(onFork(w, "feature")).not.toBe(old);
});

test("a rebased branch whose tests fail alone keeps its old tip and gets a rebase-checks handoff", async () => {
  const w = world();
  const old = branch(w, "mine", { "mine.txt": "mine\n" });
  upstreamMoves(w, { "up.txt": "up\n" });
  const h = stubHarness(fixBroken);
  configureOwn(w, ["mine"], {
    steps: { ...stubSteps, test: ["sh", "-c", "echo 'both files'; ! { test -f up.txt && test -f mine.txt; }"] },
    harness: { command: h.command },
  });
  const result = await cb(w, "rebase");
  expect(result.code).toBe(0);
  expect(tip(w, "mine")).toBe(old);
  expect(backupOf(w, "mine")).toBeNull();
  expect(h.calls()).toBe(0);
  expect(result.out).toContain("mine: failed: test fails on the rebased branch");
  expect(result.err).toContain("test failed on mine; running it once more in case the failure is flaky");
  expect(handoffs(w)).toEqual(["mine.md"]);
  const handoff = read(join(latest(w), "handoffs", "mine.md"));
  expect(handoff).toContain("- Kind: rebase-checks\n");
  expect(handoff).toContain("(test) fails on mine alone");
  expect(handoff).toContain("both files");
});
test("a rebased branch whose check passes only when run again moves, with a flaky warning", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  upstreamMoves(w, { "up.txt": "up\n" });
  const tried = join(fresh("flaky"), "tried");
  configureOwn(w, ["mine"], {
    steps: { ...stubSteps, test: ["sh", "-c", `test -f "${tried}" || { touch "${tried}"; false; }`] },
  });
  const result = await cb(w, "rebase");
  expect(result.code).toBe(0);
  expect(behindUpstream(w, "mine")).toBe(false);
  expect(result.out).toContain("test failed once and passed when run again, it may be flaky");
  expect(read(join(latest(w), "report.md"))).toContain("mine-test-flaky.log");
});

test("inside rebuild an unresolved rebase conflict keeps the old tip, and the run goes on to merge it", async () => {
  const w = world();
  const old = branch(w, "stale", conflictingLine("STALE"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["stale"]);
  const result = await cb(w, "rebuild");
  expect(result.code).toBe(2);
  expect(result.out).toContain("merge conflict in stale");
  expect(tip(w, "stale")).toBe(old);
  expect(run(w)?.rebased?.find(r => r.patch === "stale")?.outcome).toBe("failed");
  expect(run(w)?.plan.find(p => p.display === "stale")?.commit).toBe(old);
  expect(read(join(latest(w), "handoffs", "stale.md"))).toContain("- Kind: rebase\n");
  expect(readdirSync(join(dirOf(w), "work")).filter(name => name.startsWith("rebase-"))).toEqual([]);

  // With a harness that keeps failing, the rebuild still goes on with the old tip.
  const u = world();
  const kept = branch(u, "stale", conflictingLine("STALE"));
  upstreamMoves(u, conflictingLine("UPSTREAM"));
  configureOwn(u, ["stale"], { harness: { command: stubHarness("echo junk > junk.txt").command, attempts: 1 } });
  const done = await cb(u, "rebuild");
  expect(done.code).toBe(5);
  expect(done.out).toContain("the harness could not resolve the conflict in stale");
  expect(tip(u, "stale")).toBe(kept);
  expect(run(u)?.rebased?.find(r => r.patch === "stale")?.outcome).toBe("failed");
});

test("the rebase command stops at a conflict it can't resolve; continue, --skip-branch and rollback end it", async () => {
  const w = world();
  const first = branch(w, "first", conflictingLine("FIRST"));
  const second = branch(w, "second", conflictingLine("SECOND"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["first", "second"]);
  const stopped = await cb(w, "rebase");
  expect(stopped.code).toBe(2);
  expect(stopped.out).toMatch(/rebase conflict in first at [0-9a-f]{7} first: change/);
  expect(stopped.out).toContain("files: base.txt");
  const tree = /worktree: (\S+)/.exec(stopped.out)![1];
  const refused = await cb(w, "rebuild");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("a run is stopped or in progress");
  write(tree, conflictingLine("UPSTREAM FIRST"));
  git(tree, "add", "base.txt");
  // An edit after `git add` is not a resolution to skip past: the run stops again, the commit kept.
  write(tree, conflictingLine("UPSTREAM FIRST, EDITED"));
  const unstaged = await cb(w, "continue");
  expect(unstaged.code).toBe(2);
  expect(unstaged.out).toContain("problem: ");
  expect(tip(w, "first")).toBe(first);
  git(tree, "add", "base.txt");
  const next = await cb(w, "continue");
  expect(next.code).toBe(2);
  expect(next.out).not.toContain("git push");
  expect(behindUpstream(w, "first")).toBe(false);
  expect(git(w.clone, "show", "first:base.txt")).toBe("one\nUPSTREAM FIRST, EDITED\nthree");
  const skipped = await cb(w, "rebase", "--skip-branch");
  expect(skipped.code).toBe(0);
  expect(skipped.out).toContain("second: skipped");
  expect(tip(w, "second")).toBe(second);
  expect(run(w)).toBeNull();

  expect((await cb(w, "rebase")).code).toBe(2);
  const undone = await cb(w, "rollback");
  expect(undone.code).toBe(0);
  expect(undone.out).toContain("first: rebased earlier, push pending");
  expect(run(w)).toBeNull();
  expect(tip(w, "second")).toBe(second);
  expect(readdirSync(join(dirOf(w), "work")).filter(name => name.startsWith("rebase-"))).toEqual([]);

  // A harness that can't resolve it stops with 5.
  configureOwn(w, ["second"], { harness: { command: stubHarness("true").command, attempts: 1 } });
  const exhausted = await cb(w, "rebase");
  expect(exhausted.code).toBe(5);
  expect(exhausted.out).toContain("the harness could not resolve the rebase conflict in second");
  expect((await cb(w, "rollback")).code).toBe(0);
});

test("a rebase run records its timings, without the wait for the push answer", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  git(w.clone, "push", "-q", "origin", "mine");
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  const hour = 3_600_000,
    result = await cbWith(w, { ask: () => ((clock += hour), "y") }, "rebase");
  expect(result.code).toBe(0);
  const runs = timings.loadHistory(dirOf(w)).runs;
  expect(runs.length).toBe(1);
  expect(runs[0]).toMatchObject({ command: "rebase", partial: false });
  expect(Object.keys(runs[0].items)).toEqual(["fetch", "rebase:mine", "push"]);
  expect(runs[0].activeMs).toBeLessThan(hour);
});
test("rebased branches are pushed with a lease after a yes or with --push, and a moved remote copy is kept", async () => {
  const setup = () => {
    const w = world();
    const old = branch(w, "mine", { "mine.txt": "mine\n" });
    git(w.clone, "push", "-q", "origin", "mine");
    upstreamMoves(w, { "up.txt": "up\n" });
    configureOwn(w, ["mine"]);
    return { w, old };
  };
  const asked: string[] = [];
  const yes = setup(),
    accepted = await cbWith(yes.w, { ask: q => (asked.push(q), "y") }, "rebase");
  expect(accepted.code).toBe(0);
  expect(asked).toEqual(["Force-push 1 rebased branch to origin (mine)? [y/N] "]);
  expect(onFork(yes.w, "mine")).toBe(tip(yes.w, "mine")!);
  expect(backupOf(yes.w, "mine")).toBeNull();

  const forced = setup();
  expect((await cb(forced.w, "rebase", "--push")).code).toBe(0);
  expect(onFork(forced.w, "mine")).toBe(tip(forced.w, "mine")!);

  const declined = setup(),
    no = await cbWith(declined.w, { ask: () => "n" }, "rebase");
  expect(no.code).toBe(0);
  expect(onFork(declined.w, "mine")).toBe(declined.old);
  expect(no.out).toContain(`git push --force-with-lease=refs/heads/mine:${declined.old} origin`);

  const raced = setup(),
    elsewhere = git(raced.w.seed, "rev-parse", "main");
  const refused = await cbWith(
    raced.w,
    { ask: () => (git(raced.w.seed, "push", "-q", "-f", fork(raced.w), "main:refs/heads/mine"), "y") },
    "rebase",
  );
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("push of mine refused");
  expect(refused.out).toContain(`retry: git push --force-with-lease=refs/heads/mine:${raced.old} origin`);
  expect(existsSync(join(latest(raced.w), "rebase", "mine-push.log"))).toBe(true);
  expect(onFork(raced.w, "mine")).toBe(elsewhere);
  expect(backupOf(raced.w, "mine")).toBe(raced.old);
  // Four worlds, each rebased and checked.
}, 180_000);

test("own branches checked out, diverged or already upstream are left alone, and so is everything without a fork", async () => {
  const w = world();
  const busy = branch(w, "busy", { "busy.txt": "busy\n" }),
    split = branch(w, "split", { "split.txt": "split\n" }),
    landed = branch(w, "landed", { "landed.txt": "landed\n" });
  git(w.clone, "worktree", "add", "-q", join(fresh("busy"), "tree"), "busy");
  git(w.clone, "push", "-q", "origin", "split");
  git(w.seed, "fetch", "-q", fork(w), "split");
  git(w.seed, "checkout", "-q", "--detach", "FETCH_HEAD");
  commit(w.seed, { "remote.txt": "r\n" }, "remote change");
  git(w.seed, "push", "-q", fork(w), "HEAD:refs/heads/split");
  git(w.seed, "checkout", "-q", "main");
  git(w.clone, "checkout", "-q", "split");
  const local = commit(w.clone, { "local.txt": "l\n" }, "local change");
  git(w.clone, "checkout", "-q", "main");
  upstreamMoves(w, { "landed.txt": "landed\n" });
  configureOwn(w, ["busy", "split", "landed"]);
  const result = await cb(w, "rebase");
  expect(result.code).toBe(0);
  expect([tip(w, "busy"), tip(w, "split"), tip(w, "landed")]).toEqual([busy, local, landed]);
  expect(result.out).toContain("busy: skipped: checked out in ");
  expect(result.out).toContain("split: skipped: the local branch and origin/split have diverged");
  expect(result.out).toContain("landed: skipped: no commits left on top of upstream; remove the patch");
  expect(split).not.toBe(local);

  const u = world();
  const mine = branch(u, "mine", { "mine.txt": "mine\n" });
  git(u.clone, "remote", "set-url", "origin", u.upstream);
  upstreamMoves(u, { "up.txt": "up\n" });
  configureOwn(u, ["mine"]);
  const off = await cb(u, "rebase");
  expect(off.code).toBe(0);
  expect(off.out).toContain("rebasing is off: origin is upstream itself, so there is no fork to push to");
  expect(tip(u, "mine")).toBe(mine);
});

test("rebase --in-worktree rebases a checked-out branch in its own worktree, or skips a dirty one", async () => {
  const w = world();
  const busy = branch(w, "busy", conflictingLine("BUSY")),
    dirty = branch(w, "dirty", { "dirty.txt": "dirty\n" });
  const busyTree = join(fresh("busy"), "tree"),
    dirtyTree = join(fresh("dirty"), "tree");
  git(w.clone, "worktree", "add", "-q", busyTree, "busy");
  git(w.clone, "worktree", "add", "-q", dirtyTree, "dirty");
  write(dirtyTree, { "dirty.txt": "changed\n" });
  git(dirtyTree, "add", "--", "dirty.txt");
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["busy", "dirty"], { harness: { command: stubHarness(takeTheirs).command } });
  const result = await cb(w, "rebase", "--in-worktree");
  expect(result.code).toBe(0);
  expect(behindUpstream(w, "busy")).toBe(false);
  expect(backupOf(w, "busy")).toBe(busy);
  // The worktree moved with its branch: in sync, clean, and the harness resolved the conflict there.
  expect(git(busyTree, "rev-parse", "HEAD")).toBe(tip(w, "busy"));
  expect(git(busyTree, "status", "--porcelain")).toBe("");
  expect(result.out).toMatch(/rebased busy: [0-9a-f]{7} to [0-9a-f]{7} \(harness\)/);
  // A worktree with uncommitted tracked changes is left completely alone.
  expect(behindUpstream(w, "dirty")).toBe(true);
  expect(tip(w, "dirty")).toBe(dirty);
  expect(result.out).toContain("dirty: skipped: uncommitted changes in ");
});

test("a rejected in-worktree resolution keeps the worktree's untracked files", async () => {
  const w = world();
  branch(w, "busy", conflictingLine("BUSY"));
  const tree = join(fresh("busy"), "tree");
  git(w.clone, "worktree", "add", "-q", tree, "busy");
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  const calls = join(fresh("calls"), "n");
  // Call 1 leaves the conflict unresolved after writing an untracked file; call 2 resolves it.
  const h = stubHarness(
    `n=$(cat "${calls}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${calls}"\n[ "$n" = 1 ] && echo precious > keep.txt\n[ "$n" = 2 ] && ${takeTheirs}\nexit 0`,
  );
  configureOwn(w, ["busy"], { harness: { command: h.command } });
  const result = await cb(w, "rebase", "--in-worktree");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(2);
  expect(behindUpstream(w, "busy")).toBe(false);
  expect(read(join(tree, "keep.txt"))).toBe("precious\n");
  expect(result.out).toMatch(/rebased busy: [0-9a-f]{7} to [0-9a-f]{7} \(harness\)/);
});

test("an in-worktree rebase whose checks fail puts the branch back where it was", async () => {
  const w = world();
  const busy = branch(w, "busy", { "bad.txt": "BROKEN\n" });
  const tree = join(fresh("busy"), "tree");
  git(w.clone, "worktree", "add", "-q", tree, "busy");
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["busy"]);
  const result = await cb(w, "rebase", "--in-worktree");
  expect(result.code).toBe(0);
  expect(result.out).toContain("busy: failed: typecheck fails on the rebased branch");
  expect(tip(w, "busy")).toBe(busy);
  expect(git(tree, "rev-parse", "HEAD")).toBe(busy);
  expect(git(tree, "status", "--porcelain")).toBe("");
  // The backup was kept from the rebase's start; after the restore it names
  // the tip the branch is back at, harmless until the branch is pushed.
  expect(backupOf(w, "busy")).toBe(busy);
});

test("an in-worktree rebase records its backup before the rebase moves the branch", async () => {
  const w = world();
  const busy = branch(w, "busy", { "busy.txt": "busy\n" });
  const tree = join(fresh("busy"), "tree");
  git(w.clone, "worktree", "add", "-q", tree, "busy");
  upstreamMoves(w, { "up.txt": "up\n" });
  const seen = join(fresh("backup"), "at-check.txt");
  // The test step runs in the worktree after the rebase moved the branch; the
  // backup must already be there, so an interruption during the checks undoes.
  configureOwn(w, ["busy"], {
    steps: {
      ...stubSteps,
      test: [
        "sh",
        "-c",
        `git rev-parse refs/custom-build/rebase-backup/busy > "${seen}" 2>/dev/null || echo none > "${seen}"`,
      ],
    },
  });
  const result = await cb(w, "rebase", "--in-worktree");
  expect(result.code).toBe(0);
  expect(result.out).toMatch(/rebased busy: [0-9a-f]{7} to [0-9a-f]{7}/);
  expect(read(seen)).toBe(`${busy}\n`);
});

test("rebase --in-worktree leaves checked-out branches alone that are current or that the mode skips", async () => {
  const w = world();
  const clean = branch(w, "clean", { "clean.txt": "clean\n" });
  git(w.clone, "worktree", "add", "-q", join(fresh("clean"), "tree"), "clean");
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["clean"]);
  const skipped = await cb(w, "rebase", "--in-worktree", "--rebase=conflicting");
  expect(skipped.code).toBe(0);
  expect(tip(w, "clean")).toBe(clean);
  expect(backupOf(w, "clean")).toBeNull();
  // Rebased once, it is current: a second run doesn't rewrite it again.
  expect((await cbWith(w, { ask: () => "n" }, "rebase", "--in-worktree")).code).toBe(0);
  const rebased = tip(w, "clean")!;
  expect(rebased).not.toBe(clean);
  const again = await cbWith(w, { ask: () => "n" }, "rebase", "--in-worktree");
  expect(again.code).toBe(0);
  expect(tip(w, "clean")).toBe(rebased);
  expect(again.out).not.toContain("rebased clean");
});

test("a rejected in-worktree resolution after an earlier commit keeps the branch attached and moves it", async () => {
  const w = world();
  branch(w, "busy", { "first.txt": "first\n" });
  const tree = join(fresh("busy"), "tree");
  git(w.clone, "worktree", "add", "-q", tree, "busy");
  commit(tree, conflictingLine("BUSY"), "conflicting change");
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  const calls = join(fresh("calls"), "n");
  // Call 1 leaves the conflict unresolved, so the retry replays from the conflicting commit; call 2 resolves it.
  const h = stubHarness(
    `n=$(cat "${calls}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${calls}"\n[ "$n" = 2 ] && ${takeTheirs}\nexit 0`,
  );
  configureOwn(w, ["busy"], { harness: { command: h.command } });
  const result = await cbWith(w, { ask: () => "n" }, "rebase", "--in-worktree");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(2);
  expect(git(tree, "symbolic-ref", "HEAD")).toBe("refs/heads/busy");
  expect(behindUpstream(w, "busy")).toBe(false);
  expect(git(tree, "rev-parse", "HEAD")).toBe(tip(w, "busy"));
  expect(result.out).toContain(`git push --force-with-lease=refs/heads/busy: origin ${tip(w, "busy")}:refs/heads/busy`);
});

test("an in-worktree rebase skips a worktree that switched branches since the run chose it", async () => {
  const w = world();
  branch(w, "first", { "first.txt": "first\n" });
  const second = branch(w, "second", { "second.txt": "second\n" }),
    other = branch(w, "other", { "other.txt": "other\n" });
  const firstTree = join(fresh("first"), "tree"),
    secondTree = join(fresh("second"), "tree");
  git(w.clone, "worktree", "add", "-q", firstTree, "first");
  git(w.clone, "worktree", "add", "-q", secondTree, "second");
  upstreamMoves(w, { "up.txt": "up\n" });
  // While first is checked, the user switches second's worktree to another clean branch.
  configureOwn(w, ["first", "second"], {
    steps: { ...stubSteps, test: ["sh", "-c", `git -C "${secondTree}" checkout -q other 2>/dev/null || true`] },
  });
  const result = await cbWith(w, { ask: () => "n" }, "rebase", "--in-worktree");
  expect(result.code).toBe(0);
  expect(behindUpstream(w, "first")).toBe(false);
  expect([tip(w, "second"), tip(w, "other")]).toEqual([second, other]);
  expect(git(secondTree, "symbolic-ref", "--short", "HEAD")).toBe("other");
  expect(result.out).toMatch(
    new RegExp(`second: skipped: \\S*/second-\\d+/tree no longer has second at ${second.slice(0, 7)} checked out`),
  );
});

/** A `rebase --in-worktree` run of `busy` left as an interruption during its
 * checks would leave it: the test step saves the run state and the tip under
 * check, which are put back after the run. */
async function interruptedInWorktree() {
  const w = world();
  const busy = branch(w, "busy", { "busy.txt": "busy\n" });
  const tree = join(fresh("busy"), "tree");
  git(w.clone, "worktree", "add", "-q", tree, "busy");
  upstreamMoves(w, { "up.txt": "up\n" });
  const saved = fresh("run"),
    checking = "refs/custom-build/rebase-checking/busy";
  configureOwn(w, ["busy"], {
    steps: {
      ...stubSteps,
      test: [
        "sh",
        "-c",
        `cp "${join(dirOf(w), "run.json")}" "${saved}/run.json" && git rev-parse ${checking} > "${saved}/tip"`,
      ],
    },
  });
  expect((await cbWith(w, { ask: () => "n" }, "rebase", "--in-worktree")).code).toBe(0);
  const moved = tip(w, "busy")!;
  expect(moved).not.toBe(busy);
  expect(read(join(saved, "tip"))).toBe(`${moved}\n`);
  writeFileSync(join(dirOf(w), "run.json"), read(join(saved, "run.json")));
  git(w.clone, "update-ref", checking, moved);
  return { w, busy, tree, moved };
}

test("rollback of a rebase run interrupted during an in-worktree branch's checks puts the branch back", async () => {
  const { w, busy, tree, moved } = await interruptedInWorktree();
  const result = await cb(w, "rollback");
  expect(result.code).toBe(0);
  expect(result.out).toMatch(
    new RegExp(
      `put busy back at ${busy.slice(0, 7)} in \\S*/busy-\\d+/tree \\(it was at ${moved.slice(0, 7)}, unchecked\\)`,
    ),
  );
  expect(tip(w, "busy")).toBe(busy);
  expect(git(tree, "rev-parse", "HEAD")).toBe(busy);
  expect(config.loadRun(dirOf(w))).toBeNull();
  expect(tip(w, "refs/custom-build/rebase-checking/busy")).toBeNull();
});

test("rollback after an interrupted in-worktree rebase keeps commits made on the branch since", async () => {
  const { w, tree } = await interruptedInWorktree();
  const mine = commit(tree, { "later.txt": "mine\n" }, "my later commit");
  const result = await cb(w, "rollback");
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "it moved since the interrupted rebase; its tip before the rebase is refs/custom-build/rebase-backup/busy",
  );
  expect(tip(w, "busy")).toBe(mine);
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
});

test("an in-worktree check that fails keeps a commit made in the worktree during the checks", async () => {
  const w = world();
  branch(w, "busy", { "busy.txt": "busy\n" });
  const tree = join(fresh("busy"), "tree");
  git(w.clone, "worktree", "add", "-q", tree, "busy");
  upstreamMoves(w, { "up.txt": "up\n" });
  // The test step stands in for the user committing in the worktree, then fails.
  configureOwn(w, ["busy"], {
    steps: {
      ...stubSteps,
      test: [
        "sh",
        "-c",
        "echo mine > later.txt && git add later.txt && git -c user.name=t -c user.email=t@t commit -qm later && false",
      ],
    },
  });
  const result = await cbWith(w, { ask: () => "n" }, "rebase", "--in-worktree");
  expect(result.code).toBe(0);
  expect(result.out).toContain("busy: failed: test fails on the rebased branch");
  expect(git(tree, "log", "-1", "--format=%s", "busy")).toBe("later");
  expect(git(tree, "rev-parse", "HEAD")).toBe(tip(w, "busy"));
});

test("an in-worktree check that fails keeps uncommitted edits made during the checks", async () => {
  const w = world();
  const busy = branch(w, "busy", { "busy.txt": "busy\n" });
  const tree = join(fresh("busy"), "tree");
  git(w.clone, "worktree", "add", "-q", tree, "busy");
  upstreamMoves(w, { "up.txt": "up\n" });
  // The test step stands in for the user editing a tracked file in the worktree, then fails.
  configureOwn(w, ["busy"], { steps: { ...stubSteps, test: ["sh", "-c", "echo edited >> busy.txt && false"] } });
  const result = await cbWith(w, { ask: () => "n" }, "rebase", "--in-worktree");
  expect(result.code).toBe(0);
  const rebased = tip(w, "busy")!;
  expect(rebased).not.toBe(busy);
  expect(read(join(tree, "busy.txt"))).toBe("busy\nedited\nedited\n");
  expect(result.out).toContain(
    `busy: failed: test fails on the rebased branch; busy stays at ${rebased.slice(0, 7)} in `,
  );
  expect(result.out).toContain(
    "which changed during the checks; its tip before the rebase is refs/custom-build/rebase-backup/busy",
  );
});

test("a branch named by two patches is rebased once and both merge its new tip", async () => {
  const w = world();
  ownPullRequest(w, 5, "feature", { "feature.txt": "f\n" });
  git(w.clone, "fetch", "-q", "origin");
  git(w.clone, "branch", "-q", "feature", "origin/feature");
  stubGh(w, { "tals/corgi#5": { state: "OPEN", title: "feature", head: "me/corgi:feature" } });
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["feature", "#5"]);
  const result = await cbWith(w, { ask: () => "n" }, "rebuild");
  expect(result.code).toBe(0);
  expect(behindUpstream(w, "feature")).toBe(false);
  expect(result.out).toContain("the same branch as feature, handled with it");
  const plan = config.load(dirOf(w)).patches.map(p => sources.display(p.source));
  expect(plan).toEqual(["feature", "tals/corgi#5"]);
  for (const p of stamped(w)) expect(p.commit).toBe(tip(w, "feature")!);
});

test("status lists own branches behind, conflicting with or left alone by upstream", async () => {
  const w = world();
  branch(w, "clean", { "clean.txt": "clean\n" });
  branch(w, "stale", conflictingLine("STALE"));
  branch(w, "busy", { "busy.txt": "busy\n" });
  git(w.clone, "worktree", "add", "-q", join(fresh("busy"), "tree"), "busy");
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  git(w.clone, "fetch", "-q", "upstream");
  configureOwn(w, ["clean", "stale", "busy"]);
  const shown = await cb(w, "status");
  expect(shown.out).toMatch(/^clean +✓ clean +! behind upstream$/m);
  expect(shown.out).toMatch(/^stale +✗ 1 conflict +✗ behind, conflicts$/m);
  expect(shown.out).toMatch(/^busy +✓ clean +· in worktree \S*tree$/m);
  expect(shown.out).toContain("Branches behind upstream: `rebase` updates them.");
  expect(shown.out).toContain("Branches in a worktree: `rebase --in-worktree` rebases them there.");
  expect(shown.out).not.toContain("\x1b[");
});

test("add refuses the custom branch and its backup as patches", async () => {
  const w = world();
  configureOwn(w, []);
  for (const name of ["custom-build", "custom-build-prev"]) {
    const result = await cb(w, "add", name, "--description", "x");
    expect(result.code).toBe(1);
    expect(result.err).toContain("is a branch the tool resets");
  }
});

test("a rejected harness resolution is retried from that commit, keeping git's choice of commits", async () => {
  const w = world();
  // The branch: X, A (conflicts later), a merge of upstream's U1, B.
  git(w.clone, "checkout", "-q", "-b", "two", "upstream/main");
  commit(w.clone, { "x.txt": "X\n" }, "X");
  commit(w.clone, conflictingLine("A"), "A");
  upstreamMoves(w, { "u1.txt": "u1\n" });
  git(w.clone, "fetch", "-q", "upstream");
  git(w.clone, "merge", "-q", "--no-ff", "--no-edit", "upstream/main");
  commit(w.clone, { "b.txt": "B\n" }, "B");
  git(w.clone, "checkout", "-q", "main");
  upstreamMoves(w, { ...conflictingLine("UPSTREAM"), "u1.txt": "u2\n" });
  // Settings that would change the replay or move the branch early must not apply.
  for (const [key, value] of [
    ["rebase.autoSquash", "true"],
    ["rebase.abbreviateCommands", "true"],
    ["rebase.missingCommitsCheck", "error"],
    ["rebase.updateRefs", "true"],
  ])
    git(w.clone, "config", key, value);
  const old = tip(w, "two");
  const calls = join(fresh("calls"), "n");
  // Call 1 (at A) also writes an unrelated file and is rejected; call 2 resolves A.
  const h = stubHarness(
    `n=$(cat "${calls}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${calls}"\n[ "$n" = 1 ] && echo x > extra.txt\n${takeTheirs}`,
  );
  configureOwn(w, ["two"], { harness: { command: h.command } });
  const result = await cb(w, "rebase");
  expect(result.code).toBe(0);
  expect(h.calls()).toBe(2);
  expect(result.out).toMatch(/rebased two: [0-9a-f]{7} to [0-9a-f]{7} \(harness\)/);
  expect(backupOf(w, "two")).toBe(old);
  expect(git(w.clone, "log", "--format=%s", "upstream/main..two").split("\n")).toEqual(["B", "A", "X"]);
  expect(git(w.clone, "ls-tree", "--name-only", "two")).not.toContain("extra.txt");
  expect([git(w.clone, "show", "two:base.txt"), git(w.clone, "show", "two:u1.txt")]).toEqual(["one\nA\nthree", "u2"]);
});

test("a rebase conflict resolved once replays through rerere the next time", async () => {
  const w = world();
  const old = branch(w, "stale", conflictingLine("STALE"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["stale"]);
  const stopped = await cb(w, "rebase");
  const tree = /worktree: (\S+)/.exec(stopped.out)![1];
  write(tree, conflictingLine("UPSTREAM STALE"));
  git(tree, "add", "base.txt");
  expect((await cb(w, "continue")).code).toBe(0);
  git(w.clone, "branch", "-f", "stale", old);
  gitTool.deleteRef(w.clone, "refs/custom-build/rebase-backup/stale");
  const again = await cb(w, "rebase");
  expect(again.code).toBe(0);
  expect(again.out).toContain("(rerere)");
  expect(git(w.clone, "show", "stale:base.txt")).toBe("one\nUPSTREAM STALE\nthree");
});

test("a branch moved or checked out while it is rebased stays where it is", async () => {
  const moved = world();
  branch(moved, "mine", { "mine.txt": "mine\n" });
  upstreamMoves(moved, { "up.txt": "up\n" });
  const elsewhere = git(moved.clone, "rev-parse", "main");
  configureOwn(moved, ["mine"], {
    steps: { ...stubSteps, test: ["sh", "-c", `git update-ref refs/heads/mine ${elsewhere}`] },
  });
  const result = await cb(moved, "rebase");
  expect(result.out).toContain("mine: skipped: the branch moved while it was rebased");
  expect(tip(moved, "mine")).toBe(elsewhere);
  expect(backupOf(moved, "mine")).toBeNull();

  const busy = world();
  const old = branch(busy, "mine", { "mine.txt": "mine\n" });
  upstreamMoves(busy, { "up.txt": "up\n" });
  const other = join(fresh("busy"), "tree");
  configureOwn(busy, ["mine"], {
    steps: { ...stubSteps, test: ["sh", "-c", `git worktree add -q "${other}" mine`] },
  });
  const checked = await cb(busy, "rebase");
  expect(checked.out).toContain("mine: skipped: checked out in ");
  expect(tip(busy, "mine")).toBe(old);
  expect(backupOf(busy, "mine")).toBeNull();
});

test("a rebased branch not pushed yet is offered again and keeps its backup until it is rebased again from its new tip", async () => {
  const w = world();
  const old = branch(w, "mine", { "mine.txt": "mine\n" });
  git(w.clone, "push", "-q", "origin", "mine");
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  const first = await cbWith(w, { ask: () => "n" }, "rebase");
  expect(first.code).toBe(0);
  const rebased = tip(w, "mine")!;
  expect(backupOf(w, "mine")).toBe(old);
  // Nothing new upstream: the pending push is offered again, not reported as diverged.
  const second = await cbWith(w, { ask: () => "n" }, "rebase");
  expect(second.out).toContain("mine: rebased earlier, push pending");
  expect(second.out).not.toContain("diverged");
  expect(second.out).toContain(`git push --force-with-lease=refs/heads/mine:${old} origin ${rebased}:refs/heads/mine`);
  // A new commit on the rebased branch, then upstream moves again: rebased from
  // the new tip, which becomes the backup; the commit stays.
  git(w.clone, "checkout", "-q", "mine");
  const added = commit(w.clone, { "more.txt": "more\n" }, "more");
  git(w.clone, "checkout", "-q", "main");
  upstreamMoves(w, { "up2.txt": "up\n" });
  const third = await cbWith(w, { ask: () => "n" }, "rebase");
  expect(third.out).toContain("rebased mine:");
  expect(backupOf(w, "mine")).toBe(added);
  expect(git(w.clone, "show", "mine:more.txt")).toBe("more");
  const pushed = await cb(w, "rebase", "--push");
  expect(pushed.code).toBe(0);
  expect(pushed.out).toContain("pushed mine to origin");
  expect(behindUpstream(w, "mine")).toBe(false);
  expect(onFork(w, "mine")).toBe(tip(w, "mine")!);
  expect(backupOf(w, "mine")).toBeNull();
  expect(gitTool.isAncestor(w.clone, rebased, "mine")).toBe(false);
});

test("a rebuild merges an own PR's rebased head that is not pushed yet, not the old PR head", async () => {
  const w = world();
  const old = ownPullRequest(w, 5, "feature", { "feature.txt": "f\n" });
  stubGh(w, { "tals/corgi#5": { state: "OPEN", title: "feature", head: "me/corgi:feature" } });
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["#5"]);
  expect((await cbWith(w, { ask: () => "n" }, "rebase")).code).toBe(0);
  const rebased = tip(w, "feature")!;
  expect(rebased).not.toBe(old);
  expect((await cb(w, "rebuild")).code).toBe(0);
  expect(stamped(w).map(p => p.commit)).toEqual([rebased]);
});

test("a git rebase that fails before stopping is reported as failed, not as rebased", async () => {
  const w = world();
  const old = branch(w, "mine", { "mine.txt": "mine\n" });
  upstreamMoves(w, { "up.txt": "up\n" });
  const hooks = join(gitTool.commonDir(w.clone), "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-rebase"), "#!/bin/sh\necho refusing >&2\nexit 1\n");
  chmodSync(join(hooks, "pre-rebase"), 0o755);
  configureOwn(w, ["mine"]);
  const result = await cb(w, "rebase");
  expect(result.out).toContain("mine: failed: git rebase failed");
  expect(tip(w, "mine")).toBe(old);
  expect(backupOf(w, "mine")).toBeNull();
});

test("tips, leases and pushes use the URL origin pushes to", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  git(w.clone, "push", "-q", "origin", "mine");
  git(w.clone, "remote", "set-url", "origin", w.upstream);
  git(w.clone, "remote", "set-url", "--push", "origin", fork(w));
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  const result = await cb(w, "rebase", "--push");
  expect(result.code).toBe(0);
  expect(result.out).toContain("pushed mine to origin");
  expect(onFork(w, "mine")).toBe(tip(w, "mine")!);
});

test("without an origin nothing is rebased, and worktrees an interrupted run left are removed", async () => {
  const w = world();
  const mine = branch(w, "mine", { "mine.txt": "mine\n" });
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  git(w.clone, "fetch", "-q", "upstream");
  const left = join(dirOf(w), "work", "rebase-mine");
  mkdirSync(join(dirOf(w), "work"), { recursive: true });
  git(w.clone, "worktree", "add", "-q", "--detach", left, mine);
  git(w.clone, "remote", "remove", "origin");
  const result = await cb(w, "rebase");
  expect(result.code).toBe(0);
  expect(result.out).toContain("there is no origin remote to push rebased branches to");
  expect(tip(w, "mine")).toBe(mine);
  expect(existsSync(left)).toBe(false);
  expect(git(w.clone, "worktree", "list")).not.toContain("rebase-mine");
});

test("continuing a rebase run with unmerged files ends its branch as stopped", async () => {
  const w = world();
  branch(w, "first", conflictingLine("FIRST"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["first"]);
  expect((await cb(w, "rebase")).code).toBe(2);
  const events: LiveEvent[] = [];
  const again = await cbWith(w, { sink: e => void events.push(e) }, "continue");
  expect(again.code).toBe(2);
  expect(again.out).toContain("first still has unmerged files: base.txt");
  expect(eventWords(events).slice(-2)).toEqual(["item rebase first failed stopped", "end ok:false"]);
  expect((await cb(w, "rollback")).code).toBe(0);
});
test("a stopped rebase run whose worktree is gone can still be skipped or rolled back", async () => {
  const w = world();
  const stale = branch(w, "stale", conflictingLine("STALE"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["stale"]);
  const stopped = await cb(w, "rebase");
  const tree = /worktree: (\S+)/.exec(stopped.out)![1];
  rmSync(tree, { recursive: true, force: true });
  const resumed = await cb(w, "continue");
  expect(resumed.code).toBe(2);
  expect(resumed.out).toContain("is gone");
  expect((await cb(w, "rebase", "--skip-branch")).code).toBe(0);
  expect(run(w)).toBeNull();
  expect(tip(w, "stale")).toBe(stale);

  const again = await cb(w, "rebase");
  rmSync(/worktree: (\S+)/.exec(again.out)![1], { recursive: true, force: true });
  expect((await cb(w, "rollback")).code).toBe(0);
  expect(run(w)).toBeNull();
});

test("remote URLs compare by repository, however they are spelled", () => {
  const same = [
    "git@GitHub.com:Org/Corgi.git",
    "https://github.com/org/corgi",
    "git@github.com:/org/corgi",
    "ssh://git@github.com:22/org/corgi.git/",
  ];
  expect(new Set(same.map(gitTool.repositoryOf))).toEqual(new Set(["github.com/org/corgi"]));
  expect(gitTool.repositoryOf("git@github.com:1234/corgi.git")).toBe("github.com/1234/corgi");
  expect(gitTool.repositoryOf("file:///srv/repo")).toBe(gitTool.repositoryOf("/srv/repo/"));
});

test("a branch that was ahead of its fork copy is still recognized as pending after its rebase", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  git(w.clone, "push", "-q", "origin", "mine");
  git(w.clone, "checkout", "-q", "mine");
  commit(w.clone, { "ahead.txt": "ahead\n" }, "ahead");
  git(w.clone, "checkout", "-q", "main");
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  expect((await cbWith(w, { ask: () => "n" }, "rebase")).code).toBe(0);
  const again = await cbWith(w, { ask: () => "n" }, "rebase");
  expect(again.out).toContain("mine: rebased earlier, push pending");
  expect(again.out).not.toContain("diverged");
});

test("a rebase the user aborted in the stopped worktree is reported as failed, not rebased", async () => {
  const w = world();
  const old = branch(w, "stale", conflictingLine("STALE"));
  upstreamMoves(w, conflictingLine("UPSTREAM"));
  configureOwn(w, ["stale"]);
  const stopped = await cb(w, "rebase");
  const tree = /worktree: (\S+)/.exec(stopped.out)![1];
  git(tree, "rebase", "--abort");
  const resumed = await cb(w, "continue");
  expect(resumed.code).toBe(0);
  expect(resumed.out).toContain("stale: failed: the rebase did not complete");
  expect(tip(w, "stale")).toBe(old);
});

test("a leftover directory that is no worktree is removed without touching the user's own rebase", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  upstreamMoves(w, { "up.txt": "up\n", ...conflictingLine("UPSTREAM") });
  configureOwn(w, ["mine"]);
  // The user is in the middle of a rebase of their own in the checkout.
  git(w.clone, "checkout", "-q", "-b", "own", "main");
  commit(w.clone, conflictingLine("OWN"), "own");
  git(w.clone, "fetch", "-q", "upstream");
  Bun.spawnSync(["git", "rebase", "upstream/main"], { cwd: w.clone, stdout: "ignore", stderr: "ignore" });
  expect(gitTool.rebaseInProgress(w.clone)).toBe(true);
  const plain = join(dirOf(w), "work", "rebase-plain");
  mkdirSync(plain, { recursive: true });
  // A worktree of the user's whose directory is away for now keeps its registration.
  const away = join(fresh("away"), "tree");
  git(w.clone, "worktree", "add", "-q", "--detach", away, "main");
  const name = readdirSync(join(gitTool.commonDir(w.clone), "worktrees")).find(n =>
    read(join(gitTool.commonDir(w.clone), "worktrees", n, "gitdir")).includes(away.replace(/^\/private/, "")),
  )!;
  renameSync(away, `${away}-moved`);
  await cb(w, "rebase");
  expect(existsSync(plain)).toBe(false);
  expect(gitTool.rebaseInProgress(w.clone)).toBe(true);
  expect(existsSync(join(gitTool.commonDir(w.clone), "worktrees", name))).toBe(true);
});

test("origin fetching upstream and pushing to the fork, with several push URLs, still rebases and pushes", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  git(w.clone, "push", "-q", "origin", "mine");
  git(w.clone, "remote", "remove", "upstream");
  git(w.clone, "remote", "set-url", "origin", w.upstream);
  git(w.clone, "remote", "set-url", "--push", "origin", fork(w));
  git(w.clone, "remote", "set-url", "--add", "--push", "origin", fork(w));
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  const result = await cb(w, "rebase", "--push");
  expect(result.code).toBe(0);
  expect(result.out).toContain("pushed mine to origin");
  expect(onFork(w, "mine")).toBe(tip(w, "mine")!);
});

test("a pending push stays offered while its branch is checked out", async () => {
  const w = world();
  branch(w, "mine", { "mine.txt": "mine\n" });
  git(w.clone, "push", "-q", "origin", "mine");
  upstreamMoves(w, { "up.txt": "up\n" });
  configureOwn(w, ["mine"]);
  expect((await cbWith(w, { ask: () => "n" }, "rebase")).code).toBe(0);
  git(w.clone, "worktree", "add", "-q", join(fresh("busy"), "tree"), "mine");
  const again = await cbWith(w, { ask: () => "n" }, "rebase");
  expect(again.out).toContain("mine: rebased earlier, push pending");
  expect(again.out).toContain("push: git push --force-with-lease=refs/heads/mine:");
});

// Rollback and dependencies (FR-036).

/** Install steps that count their runs in a file and fail while `broken` exists. */
function countedInstall(w: World) {
  const dir = fresh("install"),
    count = join(dir, "count"),
    broken = join(dir, "broken");
  configure(w, ["bad"], {
    steps: { ...stubSteps, install: ["sh", "-c", `test ! -f "${broken}" && echo x >> "${count}"`] },
  });
  return { runs: () => (existsSync(count) ? read(count).split("\n").filter(Boolean).length : 0), broken };
}

test("rollback reinstalls dependencies, and continue finishes a rollback whose install failed", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  const start = head(w),
    install = countedInstall(w);
  expect((await cb(w, "rebuild")).code).toBe(3);
  const before = install.runs();
  writeFileSync(install.broken, "");
  const failed = await cb(w, "rollback");
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("dependency restore failed after rollback");
  expect(run(w)?.phase).toBe("rollback");
  rmSync(install.broken);
  expect((await cb(w, "continue")).code).toBe(0);
  expect(run(w)).toBeNull();
  expect(head(w)).toBe(start);
  expect(install.runs()).toBe(before + 1);
});

test("a rollback refused for uncommitted changes leaves the stopped run to continue", async () => {
  const w = world();
  branch(w, "bad", { "bad.txt": "BROKEN\n" });
  countedInstall(w);
  expect((await cb(w, "rebuild")).code).toBe(3);
  git(w.clone, "checkout", "-q", "main");
  write(w.clone, { "base.txt": "edited\n" });
  const refused = await cb(w, "rollback");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("has uncommitted changes, and rollback would discard them");
  expect(run(w)?.phase).toBe("verify");
  expect(run(w)?.stopped?.code).toBe(3);
  git(w.clone, "checkout", "-q", "--", "base.txt");
  git(w.clone, "checkout", "-q", "custom-build");
  expect((await cb(w, "continue")).code).toBe(3);
});

test("rollback to the previous build reinstalls dependencies", async () => {
  const w = world();
  branch(w, "bad", { "good.txt": "fine\n" });
  const install = countedInstall(w);
  expect((await cb(w, "rebuild")).code).toBe(0);
  const first = head(w);
  upstreamMoves(w, { "up.txt": "up\n" });
  expect((await cb(w, "rebuild")).code).toBe(0);
  const before = install.runs();
  expect((await cb(w, "rollback")).code).toBe(0);
  expect(head(w)).toBe(first);
  expect(install.runs()).toBe(before + 1);
});
