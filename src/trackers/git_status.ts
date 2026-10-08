import { milliTimestamp } from "../clock";
import { run as subprocessRun } from "../subprocess";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Ref, State } from "./git_push";
import { Text } from "../providers";
import type { Store } from "../workspace";
export class Commit {
  hash = new Text();
  subject = new Text();
  author = new Text();
  timestamp = 0;
  date = new Text();
}
export class Commits {
  items: Commit[] = Array.from({ length: 12 }, () => new Commit());
  len = 0;
}
export function clean(source: string, capacity = source.length * 4) {
  let out = "";
  for (const ch of source) {
    const cp = ch.codePointAt(0)!,
      v = cp >= 32 && !(cp >= 127 && cp <= 159) && cp !== 0xfffd ? ch : " ";
    if (Buffer.byteLength(out + v) > capacity) break;
    out += v;
  }
  return out;
}
export function cleaned(capacity: number, source: string) {
  return new Text(clean(source, capacity));
}
export function parseCommits(raw: string) {
  const out = new Commits(),
    fields = raw.split("\0");
  for (let i = 0; i + 4 < fields.length && out.len < 12; i += 5) {
    const c = new Commit();
    c.hash = cleaned(12, fields[i].replace(/^[\r\n]+|[\r\n]+$/g, ""));
    c.author = cleaned(80, fields[i + 1]);
    c.date = cleaned(16, fields[i + 2]);
    c.timestamp = /^-?\d+$/.test(fields[i + 3]) ? Number(fields[i + 3]) : 0;
    c.subject = cleaned(240, fields[i + 4]);
    out.items[out.len++] = c;
  }
  return out;
}
type Job = {
  id: number;
  cwd: string;
  ahead: bigint | null;
  commits: Commits;
  ref: Ref;
};
type Cached = {
  refs: string;
  ahead: bigint | null;
  seen: number;
  commits: Commits;
  ref: Ref;
  /** The upstream's full ref name, such as "refs/remotes/origin/main". */
  tracking?: string;
  /** `gitStamp` when git last ran, and when that was. */
  stamp?: string;
  checked?: number;
};
/** How long an unchanged repository goes without running git. */
const recheck_ms = 60000;
/** The files a repository's branch state comes from, as their change times.
 * While they stay the same, git would answer the same. Null when `.git` is a
 * file (a worktree or submodule), whose state lives elsewhere. */
export async function gitStamp(root: string, cached: Cached): Promise<string | null> {
  const git = join(root, ".git");
  try {
    if (!(await stat(git)).isDirectory()) return null;
  } catch {
    return null;
  }
  const files = ["HEAD", "config", "packed-refs"];
  for (const name of [cached.ref.branch, cached.tracking ?? ""]) if (name.startsWith("refs/")) files.push(name);
  const stamps = await Promise.all(
    files.map(file =>
      stat(join(git, file), { bigint: true }).then(
        s => `${s.ino}:${s.mtimeNs}:${s.size}`,
        () => "-",
      ),
    ),
  );
  return stamps.join(" ");
}
export class Tracker {
  thread: Promise<void> | null = null;
  done = false;
  stopping = false;
  next_refresh = 0;
  jobs: Job[] = [];
  cache = new Map<string, Cached>();
  deinit() {
    this.stopping = true;
    this.cache.clear();
    this.jobs = [];
  }
  busy() {
    return this.thread !== null;
  }
  tick(store: Store) {
    let changed = false;
    if (this.thread) {
      if (!this.done) return false;
      this.thread = null;
      changed = this.apply(store);
    }
    const now = milliTimestamp();
    if (now < this.next_refresh) return changed;
    this.next_refresh = now + 3000;
    this.jobs = store.items.map(w => ({
      id: w.id,
      cwd: w.cwd,
      ahead: null,
      commits: new Commits(),
      ref: new Ref(),
    }));
    this.done = false;
    this.thread = this.run().finally(() => {
      this.done = true;
    });
    return changed;
  }
  apply(store: Store) {
    let changed = false;
    for (const job of this.jobs) {
      const w = store.get(job.id);
      if (!w || w.cwd !== job.cwd) continue;
      changed ||=
        w.git_ahead !== job.ahead ||
        JSON.stringify(w.git_ref) !== JSON.stringify(job.ref) ||
        JSON.stringify(w.git_commits) !== JSON.stringify(job.commits);
      if (
        !w.git_ref.view().sameBranch(job.ref.view()) ||
        (!w.git_ref.view().eql(job.ref.view()) && w.git_push.phase === "failed")
      )
        w.git_push = new State();
      w.git_ref = job.ref;
      w.git_ahead = job.ahead;
      w.git_commits = job.commits;
    }
    this.jobs = [];
    return changed;
  }
  async run() {
    const now = milliTimestamp();
    for (const [k, v] of this.cache) if (now - v.seen > 60000) this.cache.delete(k);
    for (const job of this.jobs) {
      if (this.stopping) break;
      try {
        const result = await this.refreshInto(job.cwd, now);
        Object.assign(job, result);
      } catch {}
    }
  }
  async refresh(cwd: string, now: number) {
    return (await this.refreshInto(cwd, now)).ahead;
  }
  save(key: string, refs: string, ahead: bigint | null, now: number) {
    const c: Cached = {
      refs,
      ahead,
      seen: now,
      commits: new Commits(),
      ref: new Ref(),
    };
    this.cache.set(key, c);
    return c;
  }
  async refreshInto(cwd: string, now: number): Promise<Cached> {
    const negative = this.cache.get(cwd);
    if (negative && !negative.refs && now - negative.seen < 30000) return negative;
    let root = cwd;
    for (;;) {
      try {
        await access(join(root, ".git"));
        break;
      } catch {}
      const parent = dirname(root);
      if (parent === root) return this.save(cwd, "", null, now);
      root = parent;
    }
    const key = await realpath(root),
      cached = this.cache.get(key);
    if (cached && (cached.seen === now || (!cached.refs && now - cached.seen < 30000))) return cached;
    const before = cached ? await gitStamp(root, cached) : null;
    if (cached?.stamp !== undefined && before === cached.stamp && now - cached.checked! < recheck_ms) {
      cached.seen = now;
      return cached;
    }
    const result = await this.query(root, key, cached, now),
      after = await gitStamp(root, result);
    // After a change while git ran, or a switch to files not yet stamped,
    // the next refresh runs git again.
    if (after !== null && (cached === undefined || before === after)) {
      result.stamp = after;
      result.checked = now;
    }
    return result;
  }
  private async query(root: string, key: string, cached: Cached | undefined, now: number): Promise<Cached> {
    const refs = await command(root, ["rev-parse", "--verify", "HEAD"]);
    if (refs === null) return this.save(key, "", null, now);
    const branch = await command(root, ["symbolic-ref", "--quiet", "HEAD"]);
    if (branch === null) return this.save(key, refs, null, now);
    const tracking = await command(root, [
      "for-each-ref",
      "--format=%(upstream:remotename)%00%(upstream:remoteref)",
      branch,
    ]);
    if (tracking === null) return this.save(key, refs, null, now);
    const [remote = "", destination = ""] = tracking.split("\0"),
      ref = Ref.init(key, refs, branch, remote, destination),
      upstream = await command(root, ["rev-parse", "--verify", "@{upstream}"]);
    if (upstream === null) {
      const result = this.save(key, refs, null, now);
      result.ref = ref;
      return result;
    }
    const upstream_ref = (await command(root, ["rev-parse", "--symbolic-full-name", "@{upstream}"])) ?? "";
    const fingerprint = upstream + ".." + refs;
    if (cached && cached.refs === fingerprint && cached.ahead !== null) {
      cached.seen = now;
      cached.ref = ref;
      cached.tracking = upstream_ref;
      return cached;
    }
    const count = await command(root, ["rev-list", "--count", fingerprint]);
    if (count === null) return this.save(key, fingerprint, null, now);
    const ahead = /^\d+$/.test(count) ? BigInt(count) : null,
      result = this.save(key, fingerprint, ahead, now);
    result.ref = ref;
    result.tracking = upstream_ref;
    if (ahead !== null && ahead > 0n) {
      const output = await command(root, [
        "log",
        "--no-show-signature",
        "--no-decorate",
        "--encoding=UTF-8",
        "--date=format:%Y-%m-%d %H:%M",
        "--format=%h%x00%an%x00%ad%x00%at%x00%s%x00",
        "-12",
        fingerprint,
        "--",
      ]);
      if (output !== null) result.commits = parseCommits(output);
    }
    return result;
  }
}
export async function command(cwd: string, args: string[]) {
  try {
    const out = await subprocessRun(["git", "--no-optional-locks", "-C", cwd, ...args], {
      timeout_ms: 2000,
      max_output: 65536,
    });
    return out.ok() ? out.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}
