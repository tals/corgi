import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as clock from "../clock";
import * as subprocess from "../subprocess";
import * as worktrees from "../worktrees";
import type { Runtime } from "../runtime";
import type { Workspace } from "../workspace";
import type { Target } from "../agent_order";

const inventory_ms = 10000;
/** Git's tree with nothing in it, to diff a worktree that has no commits. */
const empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Changed files a detail pass looks at for times and line counts. */
const max_measured = 1000;
const max_counted_bytes = 1 << 20;
const detail_ms = 3000;
type Query = (cwd: string, args: string[]) => Promise<string | null>;
type Input = { target: Target; cwd: string; writes: string[] };
type Cached = {
  snapshot: worktrees.Snapshot;
  inventory_at: number;
  detail_at: number;
  seen: number;
  comparisons: Map<string, worktrees.Comparison>;
};
/** How long Git gets to delete a worktree; a big one takes seconds. */
const removal_timeout_ms = 600000;
/** How long a finished removal stays reported, for viewers to see how it ended. */
const removal_kept_ms = 30000;
type Removing = worktrees.Removal & { quit: subprocess.Quit; at: number };
type Job = {
  workspace: Workspace;
  cwd: string;
  epoch: number;
  inputs: Input[];
  detail: boolean;
  result?: worktrees.Snapshot | null;
};

/** NUL-delimited porcelain preserves whitespace, newlines and quoted paths. */
export function parseInventory(raw: string): worktrees.Checkout[] {
  const entries: worktrees.Checkout[] = [];
  let entry: worktrees.Checkout | null = null;
  for (const field of raw.split("\0")) {
    if (field.startsWith("worktree ")) {
      entry = {
        path: field.slice(9),
        head: "",
        branch: null,
        primary: entries.length === 0,
        bare: false,
        detached: false,
        locked: null,
        prunable: null,
        available: false,
        comparison: null,
        changes: null,
        created: null,
        edited: null,
        stale: false,
      };
      if (!isAbsolute(entry.path)) throw Error("InvalidWorktree");
      entries.push(entry);
    } else if (entry) {
      if (field.startsWith("HEAD ")) entry.head = field.slice(5);
      else if (field.startsWith("branch ")) entry.branch = field.slice(7);
      else if (field === "bare") entry.bare = true;
      else if (field === "detached") entry.detached = true;
      else if (field === "locked" || field.startsWith("locked ")) entry.locked = field.slice(7);
      else if (field === "prunable" || field.startsWith("prunable ")) entry.prunable = field.slice(9);
    }
  }
  if (!entries.length) throw Error("InvalidWorktree");
  return entries;
}
export function parseChanges(raw: string): worktrees.Changes {
  const out = { total: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, added: 0, removed: 0 };
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    if (field.length < 4 || field[2] !== " ") throw Error("InvalidGitStatus");
    const xy = field.slice(0, 2);
    if (xy === "!!") continue;
    out.total++;
    if (xy === "??") out.untracked++;
    else if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) out.conflicted++;
    else {
      if (xy[0] !== " ") out.staged++;
      if (xy[1] !== " ") out.modified++;
    }
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return out;
}
/** The paths `git status --porcelain=v1 -z` lists, and whether each is untracked. */
export function changedPaths(raw: string): { path: string; untracked: boolean }[] {
  const out: { path: string; untracked: boolean }[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const xy = field.slice(0, 2);
    if (xy !== "!!") out.push({ path: field.slice(3), untracked: xy === "??" });
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return out;
}
/** Lines added and removed in `git diff --numstat -z`; binary files count none. */
export function parseNumstat(raw: string): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const field of raw.split("\0")) {
    const match = field.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) continue;
    added += Number(match[1]) || 0;
    removed += Number(match[2]) || 0;
  }
  return { added, removed };
}
/** The Unix time on a reflog's first entry, in seconds. */
export function reflogStart(raw: string): number | null {
  const match = raw.slice(0, raw.indexOf("\n") >>> 0).match(/> (\d+) [+-]\d{4}(\t|$)/);
  return match ? Number(match[1]) : null;
}
export function parseBase(raw: string): worktrees.Base | null {
  const refs = new Map(
    raw
      .trimEnd()
      .split("\n")
      .map(row => {
        const [ref, head, symbolic] = row.split("\0");
        return [ref, { head, symbolic }] as const;
      }),
  );
  const default_ref = refs
    .get("refs/remotes/origin/HEAD")
    ?.symbolic?.replace(/^refs\/remotes\/origin\//, "refs/heads/");
  for (const ref of [default_ref, "refs/heads/main", "refs/heads/master", "refs/heads/trunk"]) {
    const head = ref ? refs.get(ref)?.head : null;
    if (ref && head && /^[0-9a-f]{40,64}$/.test(head)) return { ref, name: ref.slice(11), head };
  }
  return null;
}
function stale(snapshot: worktrees.Snapshot): worktrees.Snapshot {
  return { ...snapshot, stale: true, agents: snapshot.agents.map(a => ({ ...a, stale: true })) };
}
async function directory(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  for (;;) {
    try {
      const resolved = await realpath(path);
      return (await stat(resolved)).isDirectory() ? resolved : dirname(resolved);
    } catch {
      const parent = dirname(path);
      if (parent === path) return null;
      path = parent;
    }
  }
}

export class Tracker {
  thread: Promise<void> | null = null;
  done = false;
  stopping = false;
  jobs: Job[] = [];
  next_refresh = 0;
  private details = "";
  private cache = new Map<string, Cached>();
  private pending = new Map<string, Promise<worktrees.Snapshot>>();
  private locations = new Map<string, { root: string | null; at: number }>();
  private repositories = new Map<string, { common: string | null; at: number }>();
  /** Each workspace's removal under way, or its last, by workspace id. */
  private removals = new Map<number, Removing>();
  private next_removal = 1;
  /** The removals as viewers last heard of them. */
  private reported = "";
  /** When each worktree was made, by admin directory and its inode. */
  private created = new Map<string, number | null>();
  /** Commit times by commit, in ms. */
  private committed = new Map<string, number | null>();
  /** Untracked files' line counts, by path, modification time and size. */
  private lines = new Map<string, number>();
  private quit = new subprocess.Quit();
  constructor(
    private query: Query = async (cwd, args) => {
      try {
        const out = await subprocess.run(["git", "--no-optional-locks", "-C", cwd, ...args], {
          timeout_ms: 2000,
          max_output: 262144,
          quit: this.quit,
        });
        return out.ok() ? out.stdout.toString() : null;
      } catch {
        return null;
      }
    },
  ) {}
  close() {
    this.stopping = true;
    this.quit.signal();
    for (const job of this.removals.values()) job.quit.signal();
    this.cache.clear();
    this.locations.clear();
    this.repositories.clear();
    this.created.clear();
    this.committed.clear();
    this.lines.clear();
    this.jobs = [];
  }
  busy() {
    return this.thread !== null;
  }
  /** Lists the repository's worktrees again on the next tick, after one was added. */
  forget(common: string) {
    this.cache.delete(common);
    this.next_refresh = 0;
  }
  /** Starts removing a linked worktree, uncommitted changes and all; its
   * branch stays. A locked one, or one a workspace lives in, is refused.
   * Git deletes it in the background, where `removal` reports on it: a big
   * checkout takes seconds, and requests wait on each other. */
  async remove(runtime: Runtime, workspace: number, path: string): Promise<number> {
    const ws = runtime.workspaces.get(workspace);
    if (!ws) throw Error("NoWorkspace");
    const checkout = worktrees.linked(ws.worktrees).find(e => e.path === path);
    if (!checkout) throw Error("NoWorktree");
    if (checkout.locked !== null) throw Error("WorktreeLocked");
    if (this.removing(workspace)) throw Error("WorktreeRemoving");
    for (const other of runtime.workspaces.items) {
      const cwd = await realpath(other.cwd).catch(() => other.cwd);
      if (cwd === path || cwd.startsWith(path + "/")) throw Error("WorktreeInUse");
    }
    const job: Removing = {
      id: this.next_removal++,
      path,
      phase: "deleting",
      error: "",
      quit: new subprocess.Quit(),
      at: 0,
    };
    this.removals.set(workspace, job);
    void this.erase(job, ws.cwd, ws.worktrees!.common_dir);
    return job.id;
  }
  /** Stops a removal under way; the files already deleted stay deleted. */
  stopRemoval(workspace: number): void {
    const job = this.removals.get(workspace);
    if (job?.phase === "deleting") job.quit.signal();
  }
  /** The workspace's removal under way, or the last one, for a while after it ended. */
  removal(workspace: number): worktrees.Removal | null {
    const job = this.removals.get(workspace);
    if (!job) return null;
    if (job.at && clock.milliTimestamp() - job.at > removal_kept_ms) {
      this.removals.delete(workspace);
      return null;
    }
    return { id: job.id, path: job.path, phase: job.phase, error: job.error };
  }
  private removing(workspace: number): boolean {
    return this.removals.get(workspace)?.phase === "deleting";
  }
  /** Has Git delete the worktree and drop it, for as long as that takes;
   * stopping kills Git, leaving what it had not deleted yet. */
  private async erase(job: Removing, cwd: string, common: string) {
    let phase: Removing["phase"] = "done",
      error = "";
    try {
      const out = await subprocess.run(["git", "-C", cwd, "worktree", "remove", "--force", job.path], {
        timeout_ms: removal_timeout_ms,
        quit: job.quit,
      });
      if (!out.ok()) [phase, error] = ["failed", "WorktreeRemoveFailed"];
    } catch {
      [phase, error] = job.quit.aborted ? ["stopped", ""] : ["failed", "WorktreeRemoveFailed"];
    }
    // The next tick lists the worktrees again instead of waiting out the cache.
    this.cache.delete(common);
    this.next_refresh = 0;
    job.phase = phase;
    job.error = error;
    job.at = clock.milliTimestamp();
  }
  tick(runtime: Runtime, details: ReadonlySet<number> = new Set()) {
    // A removal's progress reaches viewers with the next snapshot.
    const removals = JSON.stringify([...this.removals.keys()].map(id => this.removal(id)));
    let changed = removals !== this.reported;
    this.reported = removals;
    if (this.thread) {
      if (!this.done) return changed;
      this.thread = null;
      changed = this.apply(runtime) || changed;
    }
    const now = clock.milliTimestamp();
    const key = [...details].sort().join(",");
    if (now < this.next_refresh && key === this.details) return changed;
    this.details = key;
    this.next_refresh = now + detail_ms;
    this.jobs = runtime.workspaces.items.map(workspace => ({
      workspace,
      cwd: workspace.cwd,
      epoch: workspace.git_epoch,
      detail: details.has(workspace.id),
      inputs: [
        ...runtime.panes
          .filter(p => runtime.workspaces.owner(p.id) === workspace && p.agent().provider)
          .map(p => ({
            target: { pane: p.id },
            cwd: p.agent().directory() || p.cwd,
            writes: worktrees.writtenPaths(p.agent()),
          })),
        ...runtime.sessions
          .filter(s => s.workspace_id === workspace.id)
          .map(s => ({
            target: { native: s.id },
            cwd: s.attachment.agent().directory() || s.cwd,
            writes: worktrees.writtenPaths(s.attachment.agent()),
          })),
      ],
    }));
    this.done = false;
    this.thread = this.run(now).finally(() => {
      this.done = true;
    });
    return changed;
  }
  apply(runtime: Runtime) {
    let changed = false;
    for (const job of this.jobs) {
      const ws = runtime.workspaces.get(job.workspace.id);
      if (ws !== job.workspace || ws.cwd !== job.cwd || ws.git_epoch !== job.epoch || job.result === undefined)
        continue;
      const encode = (v: unknown) =>
        JSON.stringify(v, (_, value) => (typeof value === "bigint" ? value.toString() : value));
      if (encode(ws.worktrees) !== encode(job.result)) {
        ws.worktrees = job.result;
        changed = true;
      }
    }
    this.jobs = [];
    return changed;
  }
  private async run(now: number) {
    // Bound subprocess concurrency and share inventory even across workspaces.
    for (const job of this.jobs) {
      if (this.stopping) break;
      const snapshot = await this.refresh(job.cwd, job.detail, now, job.workspace.worktrees);
      job.result = snapshot
        ? { ...snapshot, agents: await this.associate(snapshot, job.inputs, now, job.workspace.worktrees) }
        : null;
    }
    for (const [key, cached] of this.cache) if (now - cached.seen > 60000) this.cache.delete(key);
    for (const [key, cached] of this.locations) if (now - cached.at > 60000) this.locations.delete(key);
    for (const [key, cached] of this.repositories) if (now - cached.at > 60000) this.repositories.delete(key);
  }
  async refresh(
    cwd: string,
    detail: boolean,
    now = clock.milliTimestamp(),
    previous: worktrees.Snapshot | null = null,
  ): Promise<worktrees.Snapshot | null> {
    // A failed lookup must not turn a formerly known repository into an empty one.
    let location = this.repositories.get(cwd);
    if (!location || now - location.at >= (location.common === null ? 30000 : inventory_ms)) {
      const raw = await this.query(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      let common: string | null = null;
      if (raw !== null)
        try {
          common = await realpath(raw.replace(/\n$/, ""));
        } catch {}
      location = { common, at: now };
      this.repositories.set(cwd, location);
    }
    const common = location.common;
    if (common === null) return previous ? stale(previous) : null;
    const key = common;
    const cached = this.cache.get(key);
    if (cached) {
      cached.seen = now;
      if (now - cached.inventory_at < inventory_ms && (!detail || now - cached.detail_at < detail_ms))
        return cached.snapshot;
    }
    const pending = this.pending.get(key);
    if (pending) {
      await pending;
      return this.refresh(cwd, detail, now, previous);
    }
    const task = this.scan(cwd, key, detail, now, cached);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  /** Fills in `checkout`'s line counts and when it was last edited. */
  private async measure(checkout: worktrees.Checkout, paths: { path: string; untracked: boolean }[]) {
    const changes = checkout.changes!;
    const born = /^[0-9a-f]{40,64}$/.test(checkout.head) && !/^0+$/.test(checkout.head);
    const diff = await this.query(checkout.path, ["diff", "--numstat", "-z", born ? "HEAD" : empty_tree, "--"]);
    if (diff !== null) Object.assign(changes, parseNumstat(diff));
    let edited = born ? await this.commitTime(checkout.path, checkout.head) : null;
    for (const { path, untracked } of paths.slice(0, max_measured)) {
      if (this.stopping) return;
      const full = join(checkout.path, path);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      edited = Math.max(edited ?? 0, info.mtimeMs);
      if (untracked) changes.added += await this.countLines(full, info.mtimeMs, info.size);
    }
    checkout.edited = edited === null ? null : Math.floor(edited);
  }
  private async commitTime(cwd: string, head: string): Promise<number | null> {
    if (!this.committed.has(head)) {
      const raw = await this.query(cwd, ["log", "-1", "--format=%ct", head, "--"]);
      const seconds = raw === null ? NaN : Number(raw.trim());
      if (this.committed.size > 1024) this.committed.clear();
      this.committed.set(head, Number.isFinite(seconds) && raw!.trim() ? seconds * 1000 : null);
    }
    return this.committed.get(head) ?? null;
  }
  /** A text file's lines; binary files and files over 1 MB count none. */
  private async countLines(path: string, mtime: number, size: number): Promise<number> {
    if (size === 0 || size > max_counted_bytes) return 0;
    const key = `${path}\0${mtime}\0${size}`;
    let lines = this.lines.get(key);
    if (lines === undefined) {
      lines = 0;
      try {
        const data = await readFile(path);
        if (!data.subarray(0, 8000).includes(0)) {
          for (const byte of data) if (byte === 10) lines++;
          if (data[data.length - 1] !== 10) lines++;
        }
      } catch {}
      if (this.lines.size > 8192) this.lines.clear();
      this.lines.set(key, lines);
    }
    return lines;
  }
  /** When `git worktree add` made the worktree: its HEAD reflog's first
   * entry, or when its admin directory was made. A worktree made again at
   * the same path has a new admin directory. */
  private async createdAt(path: string): Promise<number | null> {
    try {
      const pointer = (await readFile(join(path, ".git"), "utf8")).match(/^gitdir: (.*)$/m)?.[1]?.trim();
      if (!pointer) return null;
      const admin = isAbsolute(pointer) ? pointer : join(path, pointer),
        info = await stat(admin),
        key = `${admin}\0${info.ino}`;
      if (this.created.has(key)) return this.created.get(key)!;
      let created: number | null = null;
      try {
        const seconds = reflogStart(await readFile(join(admin, "logs", "HEAD"), "utf8"));
        if (seconds !== null) created = seconds * 1000;
      } catch {}
      if (created === null && info.birthtimeMs > 0) created = Math.floor(info.birthtimeMs);
      if (this.created.size > 1024) this.created.clear();
      this.created.set(key, created);
      return created;
    } catch {
      return null;
    }
  }
  private async scan(
    cwd: string,
    key: string,
    detail: boolean,
    now: number,
    cached?: Cached,
  ): Promise<worktrees.Snapshot> {
    let snapshot = cached?.snapshot;
    let inventory_at = cached?.inventory_at ?? -Infinity;
    const comparisons = cached?.comparisons ?? new Map<string, worktrees.Comparison>();
    try {
      if (!snapshot || now - inventory_at >= inventory_ms) {
        const raw = await this.query(cwd, ["worktree", "list", "--porcelain", "-z"]);
        const refs = await this.query(cwd, [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(symref)",
          "refs/heads",
          "refs/remotes/origin/HEAD",
        ]);
        if (raw === null || refs === null) throw Error("GitUnavailable");
        const entries = parseInventory(raw),
          base = parseBase(refs);
        for (const e of entries) {
          try {
            e.path = await realpath(e.path);
            await access(join(e.path, ".git"));
            e.available = !e.bare;
          } catch {
            e.available = false;
          }
          const old = snapshot?.entries.find(old => old.path === e.path);
          e.changes = old?.changes ?? null;
          e.created = old?.created ?? null;
          e.edited = old?.edited ?? null;
          if (base) e.comparison = comparisons.get(`${base.head}...${e.head}`) ?? null;
          e.stale = old?.changes !== null && old?.changes !== undefined;
        }
        snapshot = { common_dir: key, base, entries, agents: [], stale: false };
        inventory_at = now;
      }
      snapshot = { ...snapshot, entries: snapshot.entries.map(e => ({ ...e })) };
      if (detail) {
        const base = snapshot.base;
        for (const e of worktrees.linked(snapshot)) {
          if (this.stopping) break;
          if (base && /^[0-9a-f]{40,64}$/.test(e.head) && !/^0+$/.test(e.head)) {
            const fingerprint = `${base.head}...${e.head}`;
            let comparison = comparisons.get(fingerprint) ?? null;
            if (!comparison) {
              const counts = await this.query(cwd, ["rev-list", "--left-right", "--count", fingerprint, "--"]);
              const match = counts?.match(/^(\d+)\s+(\d+)\s*$/);
              if (match) {
                comparison = { ahead: BigInt(match[2]), behind: BigInt(match[1]) };
                comparisons.set(fingerprint, comparison);
              }
            }
            e.comparison = comparison;
          }
          if (e.available) {
            const status = await this.query(e.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
            if (status !== null) {
              e.changes = parseChanges(status);
              await this.measure(e, changedPaths(status));
              e.stale = false;
            } else e.stale = true;
            e.created = await this.createdAt(e.path);
          }
        }
      }
      const result = {
        snapshot,
        inventory_at,
        detail_at: detail ? now : (cached?.detail_at ?? -Infinity),
        comparisons,
        seen: now,
      };
      if (!this.stopping) this.cache.set(key, result);
      if (comparisons.size > 1024) comparisons.clear();
      return snapshot;
    } catch {
      const failed = snapshot ? stale(snapshot) : { common_dir: key, base: null, entries: [], agents: [], stale: true };
      if (!this.stopping)
        this.cache.set(key, { snapshot: failed, inventory_at: now, detail_at: now, comparisons, seen: now });
      return failed;
    }
  }
  private async checkout(path: string, now: number): Promise<string | null> {
    const cached = this.locations.get(path);
    if (cached && now - cached.at < inventory_ms) return cached.root;
    const cwd = await directory(path);
    const raw = cwd ? await this.query(cwd, ["rev-parse", "--show-toplevel"]) : null;
    let root: string | null = null;
    if (raw !== null)
      try {
        root = await realpath(raw.replace(/\n$/, ""));
      } catch {}
    this.locations.set(path, { root, at: now });
    return root;
  }
  private async associate(
    snapshot: worktrees.Snapshot,
    inputs: Input[],
    now: number,
    previous: worktrees.Snapshot | null,
  ) {
    const out: worktrees.Association[] = [];
    if (!worktrees.linked(snapshot).length) return out;
    for (const input of inputs) {
      const paths = input.writes.length ? input.writes : [input.cwd];
      const found = new Set<string>();
      let uncertain = snapshot.stale;
      for (const path of paths) {
        const missing = snapshot.entries.find(e => !e.available && (path === e.path || path.startsWith(e.path + "/")));
        if (missing) {
          found.add(missing.path);
          uncertain = true;
          continue;
        }
        const root = await this.checkout(path, now);
        if (root === null) uncertain = true;
        if (root && snapshot.entries.some(e => e.path === root)) found.add(root);
      }
      for (const path of found)
        out.push({ target: input.target, path, source: input.writes.length ? "write" : "cwd", stale: uncertain });
      if (!found.size && uncertain)
        for (const old of previous?.agents ?? []) {
          if (JSON.stringify(old.target) === JSON.stringify(input.target)) out.push({ ...old, stale: true });
        }
    }
    return out;
  }
}
