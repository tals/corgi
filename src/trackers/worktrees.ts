import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as clock from "../clock";
import * as subprocess from "../subprocess";
import * as worktrees from "../worktrees";
import type { Runtime } from "../runtime";
import type { Workspace } from "../workspace";
import type { Target } from "../agent_order";

const inventory_ms = 10000;
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
  const out = { total: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
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
    this.cache.clear();
    this.locations.clear();
    this.repositories.clear();
    this.jobs = [];
  }
  busy() {
    return this.thread !== null;
  }
  /** Removes a linked worktree, uncommitted changes and all; its branch
   * stays. A locked one, or one a workspace lives in, is refused. */
  async remove(runtime: Runtime, workspace: number, path: string): Promise<void> {
    const ws = runtime.workspaces.get(workspace);
    if (!ws) throw Error("NoWorkspace");
    const checkout = worktrees.linked(ws.worktrees).find(e => e.path === path);
    if (!checkout) throw Error("NoWorktree");
    if (checkout.locked !== null) throw Error("WorktreeLocked");
    for (const other of runtime.workspaces.items) {
      const cwd = await realpath(other.cwd).catch(() => other.cwd);
      if (cwd === path || cwd.startsWith(path + "/")) throw Error("WorktreeInUse");
    }
    const out = await subprocess
      .run(["git", "-C", ws.cwd, "worktree", "remove", "--force", path], { timeout_ms: 60000 })
      .catch(() => null);
    if (!out?.ok()) throw Error("WorktreeRemoveFailed");
    // The next tick lists the worktrees again instead of waiting out the cache.
    this.cache.delete(ws.worktrees!.common_dir);
    this.next_refresh = 0;
  }
  tick(runtime: Runtime, details: ReadonlySet<number> = new Set()) {
    let changed = false;
    if (this.thread) {
      if (!this.done) return false;
      this.thread = null;
      changed = this.apply(runtime);
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
              e.stale = false;
            } else e.stale = true;
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
