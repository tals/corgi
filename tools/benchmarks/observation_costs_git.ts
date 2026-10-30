/** Warm git-status cost in ordinary and linked workspaces. Private fixture only.
 * CORGI_NATIVE_ROOT=/path/to/native/zig-out bun tools/benchmarks/observation_costs_git.ts
 * OBSERVATION_REPEATS=8 OBSERVATION_SWEEPS=4; pass --check for audit only.
 */
import { strictEqual } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import * as git from "../../src/trackers/git_status";
import * as benchmark from "./cpu_lock";

const root = mkdtempSync(join(tmpdir(), "corgi-observation-git-")),
  repository = join(root, "main"),
  plain = join(root, "plain"),
  trace = join(root, "trace"),
  repeats = Number(process.env.OBSERVATION_REPEATS ?? 8),
  sweeps = Number(process.env.OBSERVATION_SWEEPS ?? 4);
const release = await benchmark.acquire();
const ticks = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString());
function command(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw Error(result.stderr.toString());
}
function childrenCpu() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return ((Number(fields[13]) + Number(fields[14])) * 1000000) / ticks;
}
type Cached = Awaited<ReturnType<git.Tracker["refreshInto"]>>;
async function linkedStamp(root: string, value: Cached): Promise<string | null> {
  try {
    const pointer = await readFile(join(root, ".git"), "utf8"),
      match = /^gitdir: (.+)\n?$/.exec(pointer);
    if (!match) return null;
    const directory = resolve(root, match[1]),
      common = resolve(directory, (await readFile(join(directory, "commondir"), "utf8")).trim());
    const files = [
      join(root, ".git"),
      join(directory, "commondir"),
      join(directory, "HEAD"),
      join(directory, "config.worktree"),
      join(common, "config"),
      join(common, "packed-refs"),
      ...[value.ref.branch, value.tracking ?? ""]
        .filter(name => name.startsWith("refs/"))
        .map(name => join(common, name)),
    ];
    return (
      await Promise.all(
        files.map(file =>
          stat(file, { bigint: true }).then(
            s => `${file}:${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}:${s.size}`,
            () => `${file}:-`,
          ),
        ),
      )
    ).join("\n");
  } catch {
    return null;
  }
}
class CompactTracker extends git.Tracker {
  retained = new Map<string, { value: Cached; stamp: string; at: number }>();
  async refreshInto(cwd: string, now: number) {
    const previous = this.retained.get(cwd),
      before = previous ? await linkedStamp(cwd, previous.value) : null;
    if (previous && before === previous.stamp && now - previous.at < 60000) {
      previous.value.seen = now;
      return previous.value;
    }
    const value = await super.refreshInto(cwd, now),
      after = await linkedStamp(cwd, value);
    if (after !== null && (!previous || before === after)) this.retained.set(cwd, { value, stamp: after, at: now });
    else this.retained.delete(cwd);
    return value;
  }
}
type Case = { name: string; paths: string[]; tracker: git.Tracker };
type Sample = { wall_ms: number; self_cpu_ms: number; child_cpu_ms: number; sweeps: number };
async function measure(entry: Case, now: () => number): Promise<Sample> {
  const child = childrenCpu(),
    cpu = process.cpuUsage(),
    start = performance.now();
  for (let i = 0; i < sweeps; i++) {
    const at = now();
    for (const path of entry.paths) await entry.tracker.refreshInto(path, at);
  }
  const wall = performance.now() - start,
    used = process.cpuUsage(cpu),
    childUsed = childrenCpu() - child;
  return { wall_ms: wall, self_cpu_ms: (used.user + used.system) / 1000, child_cpu_ms: childUsed / 1000, sweeps };
}
async function audit(entry: Case, at: number) {
  writeFileSync(trace, "");
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  try {
    for (const path of entry.paths) await entry.tracker.refreshInto(path, at);
    return readFileSync(trace, "utf8")
      .split("\n")
      .filter(line => line.includes("built-in: git "));
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  }
}
try {
  if (!Number.isInteger(repeats) || repeats < 2 || !Number.isInteger(sweeps) || sweeps < 1)
    throw Error("Invalid sample parameters");
  mkdirSync(repository);
  mkdirSync(plain);
  command(["init", "-q", "-b", "main", repository]);
  for (let i = 0; i < 16; i++) writeFileSync(join(repository, `file-${i}.txt`), "fixture\n".repeat(10));
  command(["-C", repository, "add", "."]);
  command([
    "-C",
    repository,
    "-c",
    "user.name=Benchmark",
    "-c",
    "user.email=benchmark@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  command(["-C", repository, "config", "remote.origin.url", repository]);
  command(["-C", repository, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  command(["-C", repository, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  command(["-C", repository, "branch", "--set-upstream-to=origin/main", "main"]);
  const linked: string[] = [];
  for (let i = 0; i < 16; i++) {
    const target = join(root, `linked-${i}`),
      branch = `fixture-${i}`;
    command(["-C", repository, "worktree", "add", "-q", "-b", branch, target, "main"]);
    command(["-C", target, "branch", "--set-upstream-to=origin/main", branch]);
    linked.push(target);
  }
  const cases: Case[] = [
    { name: "no-repository-1-workspace", paths: [plain], tracker: new git.Tracker() },
    { name: "main-1-workspace", paths: [repository], tracker: new git.Tracker() },
    { name: "main-16-workspaces-same-directory", paths: Array(16).fill(repository), tracker: new git.Tracker() },
    { name: "linked-1-workspace", paths: linked.slice(0, 1), tracker: new git.Tracker() },
    { name: "linked-16-workspaces", paths: linked, tracker: new git.Tracker() },
    { name: "compact-linked-1-workspace", paths: linked.slice(0, 1), tracker: new CompactTracker() },
    { name: "compact-linked-16-workspaces", paths: linked, tracker: new CompactTracker() },
  ];
  for (const entry of cases)
    for (const path of entry.paths) {
      const value = await entry.tracker.refreshInto(path, 1000);
      strictEqual(value.ahead, path === plain ? null : 0n);
    }
  const audits = [];
  for (const entry of cases) {
    const commands = await audit(entry, 2000);
    const expected = entry.name.startsWith("linked-") ? entry.paths.length * 5 : 0;
    strictEqual(commands.length, expected);
    audits.push({ name: entry.name, commands_per_sweep: commands.length, commands });
  }
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify({ verified: audits }, null, 2));
  } else {
    let stamp = 3000;
    const results = new Map<string, Sample[]>(cases.map(entry => [entry.name, []]));
    for (let repetition = 0; repetition < repeats; repetition++)
      for (const entry of repetition % 2 ? cases.toReversed() : cases)
        results.get(entry.name)!.push(await measure(entry, () => ++stamp));
    const mutationChecks: string[] = [];
    const target = linked[0],
      candidate = new CompactTracker();
    let mutationAt = 1000;
    const check = async (name: string) => {
      const at = ++mutationAt,
        expected = await new git.Tracker().refreshInto(target, at),
        actual = await candidate.refreshInto(target, at);
      strictEqual(JSON.stringify(actual.ref), JSON.stringify(expected.ref));
      strictEqual(actual.refs, expected.refs);
      strictEqual(actual.ahead, expected.ahead);
      strictEqual(JSON.stringify(actual.commits), JSON.stringify(expected.commits));
      mutationChecks.push(name);
    };
    await check("initial");
    command([
      "-C",
      target,
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "mutation",
    ]);
    await check("branch ref changes");
    command(["-C", target, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    await check("upstream ref changes");
    command(["-C", target, "checkout", "-q", "-b", "mutation-branch", "HEAD~1"]);
    command(["-C", target, "branch", "--set-upstream-to=origin/main", "mutation-branch"]);
    await check("branch checkout and tracking config");
    command(["-C", target, "config", "branch.mutation-branch.remote", "."]);
    command(["-C", target, "config", "branch.mutation-branch.merge", "refs/heads/fixture-0"]);
    await check("remote and merge config changes");
    command(["-C", target, "pack-refs", "--all", "--prune"]);
    await check("loose refs packed and pruned");
    console.log(
      JSON.stringify(
        {
          bun: Bun.version,
          cpu: cpus()[0].model,
          affinity: readFileSync("/proc/self/status", "utf8")
            .split("\n")
            .filter(s => /Cpus_allowed_list|Mems_allowed_list/.test(s)),
          repeats,
          sweeps,
          child_cpu_resolution_ms: 1000 / ticks,
          fixture: "One private repository, sixteen tracked files, sixteen linked worktrees, unchanged HEAD/upstream",
          timing:
            "Installed warm tracker calls; setup excluded. Distinct virtual timestamps inside 60-second metadata cache lifetime. No GIT_TRACE during timing.",
          audits,
          mutation_checks: mutationChecks,
          prototype_limits:
            "Ordinary linked worktrees only; no submodules, reftable, includeIf configs, common-dir replacement, or concurrent filesystem mutations validated. Production retains periodic recheck and needs explicit lifecycle/invalidation coverage.",
          results: [...results].map(([name, samples]) => {
            const count = samples.reduce((sum, sample) => sum + sample.sweeps, 0),
              wall = samples.reduce((sum, sample) => sum + sample.wall_ms, 0),
              self = samples.reduce((sum, sample) => sum + sample.self_cpu_ms, 0),
              children = samples.reduce((sum, sample) => sum + sample.child_cpu_ms, 0);
            return {
              name,
              samples,
              mean_sweep_wall_ms: wall / count,
              mean_sweep_self_cpu_ms: self / count,
              mean_sweep_child_cpu_ms: children / count,
              cpu_percent_at_3_second_interval: (self + children) / count / 30,
            };
          }),
        },
        null,
        2,
      ),
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  await release();
}
