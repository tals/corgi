import { stat, open } from "node:fs/promises";
import { realpathSync, watch, FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Provider, adapter, byProvider } from "../providers";
import type { SessionHistory } from "../providers/adapter";
import * as accounts from "../accounts";
import * as profiles from "../agent_profiles";
import * as row from "./row";
export type Entry = {
  provider: Provider;
  /** The account it ran in, "" for the default. */
  account: string;
  session: string;
  title: string;
  first: string;
  last: string;
  cwd: string;
  branch: string;
  updated_at: number;
  interrupted: boolean;
};
export type History = { pending: boolean; entries: Entry[] };
export const capacity = 1000;
export function clip(text: string, limit: number) {
  const bytes = Buffer.from(text),
    out: number[] = [];
  let space = false;
  for (const ch of bytes) {
    if ([32, 9, 10, 13].includes(ch)) {
      space = out.length > 0;
      continue;
    }
    if (ch < 32 || ch === 127) continue;
    if (out.length + Number(space) >= limit) break;
    if (space) out.push(32);
    space = false;
    out.push(ch);
  }
  let b = Buffer.from(out);
  while (b.length) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {
      b = b.subarray(0, b.length - 1);
    }
  }
  return "";
}
export const copied = (e: Entry): Entry => ({
  ...e,
  title: clip(e.title, 120),
  first: clip(e.first, 200),
  last: clip(e.last, 200),
  branch: clip(e.branch, 80),
});
export function clone(e: Entry) {
  return { ...e };
}
export function typed(text: string) {
  const s = text.replace(/^[ \n\t]+/, "");
  return (
    !!s &&
    ![
      "<command-",
      "<local-command",
      "<system-reminder",
      "<task-notification",
      "<bash-",
      "Caveat:",
      "[Request interrupted",
      "This session is being continued",
      "/",
      "◯",
      "# AGENTS.md",
      "<environment_context",
      "<user_instructions",
      "<turn_aborted",
      "<user_shell_command",
    ].some(p => s.startsWith(p))
  );
}
export function complete(bytes: string, mid: boolean) {
  const start = mid ? (bytes.indexOf("\n") < 0 ? bytes.length : bytes.indexOf("\n") + 1) : 0,
    end = bytes.lastIndexOf("\n");
  return bytes.slice(start, Math.max(start, end));
}
export const records = (s: string, mid = false) =>
  complete(s, mid)
    .split("\n")
    .flatMap(l => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
export class Cache {
  files = new Map<string, { stamp: string; entry: Entry | null; seen: boolean }>();
  lookup(path: string, s: any) {
    const c = this.files.get(path);
    if (c) c.seen = true;
    return c?.stamp === stamp(s) ? c : null;
  }
  store(path: string, s: any, entry: Entry | null) {
    this.files.set(path, { stamp: stamp(s), entry, seen: true });
    return entry;
  }
  sweep() {
    for (const [p, c] of this.files)
      if (!c.seen) this.files.delete(p);
      else c.seen = false;
  }
}
const stamp = (s: any) => `${s.ino}:${s.size}:${s.mtimeMs}`;
export async function readAt(path: string, offset: number, len: number) {
  const f = await open(path);
  try {
    const b = Buffer.alloc(len),
      { bytesRead } = await f.read(b, 0, len, offset);
    return b.subarray(0, bytesRead).toString();
  } finally {
    await f.close();
  }
}
/** The entry `read` makes of the file at `path`, kept until the file changes. */
export async function cached(cache: Cache, path: string, read: (path: string, s: any) => Promise<Entry | null>) {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    const c = cache.lookup(path, s);
    return c ? c.entry : cache.store(path, s, await read(path, s));
  } catch {
    return null;
  }
}
export async function directory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
export class Store {
  items = new Map<string, { entry: Entry; revision: bigint }>();
  gone: { provider: Provider; session: string; revision: bigint }[] = [];
  revision = 0n;
  forgot = 0n;
  get(p: Provider, s: string) {
    return this.items.get(p + ":" + s)?.entry ?? null;
  }
  put(e: Entry) {
    const key = e.provider + ":" + e.session;
    if (Buffer.byteLength(key) > 512) return;
    const old = this.items.get(key);
    if (old && JSON.stringify(old.entry) === JSON.stringify(e)) return;
    this.items.set(key, { entry: copied(e), revision: ++this.revision });
  }
  remove(p: Provider, s: string) {
    if (!this.items.delete(p + ":" + s)) return;
    this.revision++;
    if (this.gone.length === 256) this.forgot = this.gone.shift()!.revision;
    this.gone.push({ provider: p, session: s, revision: this.revision });
  }
  /** Keeps `found`, and drops what the sources in `read` no longer list. */
  replace(found: Entry[], read: string[]) {
    const seen = new Set(found.map(e => e.provider + ":" + e.session));
    for (const e of found) this.put(e);
    for (const [key, item] of this.items)
      if (read.includes(source(item.entry.provider, item.entry.account ?? "")) && !seen.has(key))
        this.remove(item.entry.provider, item.entry.session);
  }
}
/** A provider's account, as the history worker keys its readers. */
export const source = (provider: Provider, account: string) => provider + "\0" + account;
/** Whether an account listed before read every root `history` reads, as
 * a folder that links to the default's history: its sessions are listed
 * once, as the earlier account's. Notes the roots otherwise. */
function shared(history: SessionHistory, covered: Set<string>) {
  const roots = history.roots().map(root => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
  if (roots.length && roots.every(root => covered.has(root))) return true;
  for (const root of roots) covered.add(root);
  return false;
}
/** The provider accounts whose sessions the launcher offers: each default,
 * then the rest, but those taken out of Manage agents that no saved agent
 * or command runs in. */
function sources(removed: row.Removed): row.Launch[] {
  const used = profiles.list();
  return [
    ...Provider.all.map(provider => ({ provider, account: "" })),
    ...accounts.known().map(a => ({ provider: a.provider, account: a.dir })),
  ].filter(l => !row.removed(removed, l, used));
}
export type Update = {
  epoch: bigint;
  revision: bigint;
  full: boolean;
  entries: Entry[];
  removed: { provider: Provider; session: string }[];
};
export class Worker {
  store = new Store();
  ready = false;
  /** Where each account's roots changed since it last looked. */
  changed = new Map<string, Set<string>>();
  epoch = randomBytes(8).readBigUInt64LE() | 1n;
  stopping = false;
  histories = new Map<string, Promise<SessionHistory | null>>();
  /** Each account's watchers, by the root each watches. */
  watching = new Map<string, Map<string, FSWatcher>>();
  /** Looks for accounts that came or went, and roots that showed up. */
  syncing: ReturnType<typeof setInterval> | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  refreshing: Promise<void> | null = null;
  /** The rows taken out of Manage agents, whose sessions it doesn't list. */
  removed: row.Removed = { agent_hidden: byProvider(() => false), account_hidden: [], commands: [] };
  static start(removed?: row.Removed) {
    const w = new Worker();
    if (removed) w.removed = row.removedOf(removed);
    void w.refresh();
    void w.startWatching();
    w.syncing = setInterval(() => void w.sync(), 10000);
    w.syncing.unref();
    return w;
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.syncing) clearInterval(this.syncing);
    for (const roots of this.watching.values()) for (const watcher of roots.values()) watcher.close();
    for (const history of this.histories.values()) void history.then(h => h?.close());
    await this.refreshing;
  }
  /** An account's history, opened on first use. */
  history(p: Provider, account: string) {
    const key = source(p, account);
    let history = this.histories.get(key);
    if (!history) this.histories.set(key, (history = adapter(p).history?.(account) ?? Promise.resolve(null)));
    return history;
  }
  /** Reads again once an account came or went, or a root it couldn't watch,
   * such as a new account's `projects`, showed up. */
  async sync() {
    if (!this.stopping && (await this.startWatching())) await this.refresh();
  }
  /** Follows the rows Manage agents took out: their sessions leave the
   * list, and come back with them. */
  async follow(removed: row.Removed) {
    if (row.sameRemoved(removed, this.removed)) return;
    this.removed = row.removedOf(removed);
    // A read already under way listed the old rows.
    await this.refreshing;
    if (this.stopping) return;
    await this.startWatching();
    await this.refresh();
  }
  snapshot(): History {
    return {
      pending: !this.ready,
      entries: [...this.store.items.values()].map(i => clone(i.entry)).sort((a, b) => b.updated_at - a.updated_at),
    };
  }
  update(epoch: bigint, revision: bigint): Update | null {
    if (!this.ready) return null;
    const full = epoch !== this.epoch || revision < this.store.forgot;
    if (!full && revision === this.store.revision) return null;
    return {
      epoch: this.epoch,
      revision: this.store.revision,
      full,
      entries: [...this.store.items.values()]
        .filter(i => full || i.revision > revision)
        .map(i => clone(i.entry))
        .sort((a, b) => b.updated_at - a.updated_at),
      removed: full
        ? []
        : this.store.gone.filter(g => g.revision > revision).map(({ provider, session }) => ({ provider, session })),
    };
  }
  /** Watches every account's roots it doesn't yet, and lets go of accounts
   * Corgi no longer knows; true when either happened. */
  async startWatching(): Promise<boolean> {
    let moved = false;
    const listed = sources(this.removed),
      wanted = new Set(listed.map(s => source(s.provider, s.account)));
    for (const [key, roots] of this.watching) {
      if (wanted.has(key)) continue;
      for (const watcher of roots.values()) watcher.close();
      this.watching.delete(key);
      void this.histories.get(key)?.then(h => h?.close());
      this.histories.delete(key);
      moved = true;
    }
    const covered = new Set<string>();
    for (const { provider: p, account } of listed) {
      const key = source(p, account),
        roots = this.watching.get(key) ?? new Map<string, FSWatcher>();
      if (!this.watching.has(key)) {
        this.watching.set(key, roots);
        moved = true;
      }
      const history = await this.history(p, account);
      if (this.stopping) return moved;
      if (history && shared(history, covered)) {
        for (const watcher of roots.values()) watcher.close();
        roots.clear();
        continue;
      }
      for (const root of history?.roots() ?? []) {
        if (roots.has(root)) continue;
        try {
          roots.set(
            root,
            watch(root, { recursive: true }, (_event, file) => {
              if (file) {
                const paths = this.changed.get(key) ?? new Set();
                this.changed.set(key, paths.add(join(root, file.toString())));
              }
              if (this.timer) clearTimeout(this.timer);
              this.timer = setTimeout(() => void this.readChanged(), 1000);
            }),
          );
          moved = true;
        } catch {}
      }
    }
    // With nothing to watch, it reads everything again now and then.
    if (![...this.watching.values()].some(roots => roots.size) && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.refresh();
      }, 300000);
      this.timer.unref();
    }
    return moved;
  }
  async readChanged() {
    if (this.stopping) return;
    if (this.refreshing) await this.refreshing;
    const changes = [...this.changed];
    this.changed.clear();
    for (const [key, paths] of changes) {
      if (!this.watching.has(key)) continue;
      const [p, account] = key.split("\0") as [Provider, string];
      await (await this.history(p, account))?.changed([...paths], this.store, () => this.stopping);
    }
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.read().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  async read() {
    const found: Entry[] = [],
      read: string[] = [],
      listed = sources(this.removed),
      covered = new Set<string>();
    for (const { provider: p, account } of listed) {
      const history = await this.history(p, account);
      if (!history || this.stopping) continue;
      if (shared(history, covered)) {
        read.push(source(p, account));
        continue;
      }
      const { sessions, complete } = await history.list(() => this.stopping);
      found.push(...sessions);
      if (complete) read.push(source(p, account));
    }
    const kept: Entry[] = [];
    for (const e of found) if (await directory(e.cwd)) kept.push(e);
    this.store.replace(kept.sort((a, b) => b.updated_at - a.updated_at).slice(0, capacity), read);
    // An account Corgi forgot takes its sessions with it.
    const known = new Set(listed.map(s => source(s.provider, s.account)));
    for (const { entry } of [...this.store.items.values()])
      if (!known.has(source(entry.provider, entry.account ?? ""))) this.store.remove(entry.provider, entry.session);
    this.ready = true;
  }
}
