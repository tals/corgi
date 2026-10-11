import { readdir, stat, open } from "node:fs/promises";
import { watch, FSWatcher } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { Provider, timestampMs } from "../providers";
import { Pool } from "../inference";
export type Entry = {
  provider: Provider;
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
const copied = (e: Entry): Entry => ({
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
const records = (s: string, mid = false) =>
  complete(s, mid)
    .split("\n")
    .flatMap(l => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
function claudeText(v: any): string | null {
  if (v.type !== "user" || v.isMeta || v.toolUseResult) return null;
  const c = v.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some(p => p.type !== "text")) return null;
  return c.map(p => p.text ?? "").join(" ");
}
export function claudeEntry(session: string, head: string, tail: string, mid = false, mtime = 0): Entry | null {
  const e: Entry = {
    provider: "claude",
    session,
    title: "",
    first: "",
    last: "",
    cwd: "",
    branch: "",
    updated_at: mtime,
    interrupted: false,
  };
  for (const v of records(head)) {
    if (v.type !== "user") continue;
    if (v.entrypoint === "sdk-cli") return null;
    if (!e.cwd) e.cwd = v.cwd ?? "";
    const t = claudeText(v);
    if (t !== null && typed(t)) {
      e.first = t;
      break;
    }
  }
  let title = "",
    named = "",
    renamed = "";
  const lines = records(tail, mid);
  for (const v of lines) {
    switch (v.type) {
      case "continued-in":
        return null;
      case "ai-title":
        title = v.aiTitle ?? "";
        break;
      case "agent-name":
        named = v.agentName ?? "";
        break;
      case "custom-title":
        renamed = v.customTitle ?? "";
        break;
      case "user": {
        if (v.entrypoint === "sdk-cli") return null;
        if (v.gitBranch) e.branch = v.gitBranch;
        if (!e.cwd) e.cwd = v.cwd ?? "";
        const t = claudeText(v);
        if (t === null) break;
        if (t.replace(/^[ \n\t]+/, "").startsWith("[Request interrupted")) e.interrupted = true;
        else if (typed(t)) {
          e.last = t;
          e.interrupted = false;
        }
        break;
      }
    }
  }
  if (!e.cwd) return null;
  e.title = renamed || named || title;
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = lines[i];
    if (v.type !== "user" && v.type !== "assistant") continue;
    const time = timestampMs(v.timestamp ?? "");
    if (time !== null) {
      e.updated_at = Math.floor(time / 1000);
      break;
    }
  }
  return e;
}
export function codexTail(tail: string, mid = false) {
  let last = "",
    interrupted = false;
  for (const v of records(tail, mid)) {
    if (v.payload?.type === "turn_aborted") interrupted = true;
    else if (v.type === "response_item" && v.payload?.type === "message" && v.payload?.role === "user") {
      const t = (v.payload.content ?? []).map((p: any) => p.text ?? "").join(" ");
      if (typed(t)) {
        last = t;
        interrupted = false;
      }
    }
  }
  return { last, interrupted };
}
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
async function readAt(path: string, offset: number, len: number) {
  const f = await open(path);
  try {
    const b = Buffer.alloc(len),
      { bytesRead } = await f.read(b, 0, len, offset);
    return b.subarray(0, bytesRead).toString();
  } finally {
    await f.close();
  }
}
export async function readClaude(path: string, s: any): Promise<Entry | null> {
  const head = await readAt(path, 0, Math.min(s.size, 128 * 1024));
  let span = 65536;
  for (;;) {
    const start = Math.max(0, s.size - span),
      tail = await readAt(path, start, s.size - start),
      e = claudeEntry(basename(path, ".jsonl"), head, tail, start > 0, Math.floor(s.mtimeMs / 1000));
    if (!e) return null;
    if (!e.last && start > 0 && span < 2 * 1024 * 1024) {
      span *= 2;
      continue;
    }
    e.last ||= e.first;
    e.first ||= e.last;
    return e.first ? copied(e) : null;
  }
}
export async function readCodex(path: string, s: any): Promise<Entry | null> {
  let span = 65536;
  for (;;) {
    const start = Math.max(0, s.size - span),
      t = codexTail(await readAt(path, start, s.size - start), start > 0);
    if (!t.last && start > 0 && span < 2 * 1024 * 1024) {
      span *= 2;
      continue;
    }
    return copied({
      provider: "codex",
      session: "",
      title: "",
      first: "",
      cwd: "",
      branch: "",
      updated_at: 0,
      ...t,
    });
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
  replace(found: Entry[], read: Provider[]) {
    const seen = new Set(found.map(e => e.provider + ":" + e.session));
    for (const e of found) this.put(e);
    for (const [key, item] of this.items)
      if (read.includes(item.entry.provider) && !seen.has(key)) this.remove(item.entry.provider, item.entry.session);
  }
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
  cache = new Cache();
  ready = false;
  changed = new Set<string>();
  rollouts = new Map<string, string>();
  epoch = randomBytes(8).readBigUInt64LE() | 1n;
  stopping = false;
  pool = new Pool({ config: { provider: "codex", timeout_ms: 5000 } });
  watchers: FSWatcher[] = [];
  timer: ReturnType<typeof setTimeout> | null = null;
  refreshing: Promise<void> | null = null;
  static start() {
    const w = new Worker();
    void w.refresh();
    w.startWatching();
    return w;
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.pool.close();
    await this.refreshing;
  }
  snapshot(): History {
    return {
      pending: !this.ready,
      entries: [...this.store.items.values()].map(i => clone(i.entry)).sort((a, b) => b.updated_at - a.updated_at),
    };
  }
  update(epoch: bigint | number, revision: bigint | number): Update | null {
    if (!this.ready) return null;
    const full = BigInt(epoch) !== this.epoch || BigInt(revision) < this.store.forgot;
    if (!full && BigInt(revision) === this.store.revision) return null;
    return {
      epoch: this.epoch,
      revision: this.store.revision,
      full,
      entries: [...this.store.items.values()]
        .filter(i => full || i.revision > BigInt(revision))
        .map(i => clone(i.entry))
        .sort((a, b) => b.updated_at - a.updated_at),
      removed: full
        ? []
        : this.store.gone
            .filter(g => g.revision > BigInt(revision))
            .map(({ provider, session }) => ({ provider, session })),
    };
  }
  startWatching() {
    for (const p of Provider.all) {
      try {
        const config = Provider.info(p).configDir();
        const root = p === "claude" ? join(config, "projects") : config;
        this.watchers.push(
          watch(root, { recursive: true }, (_event, file) => {
            if (file) this.changed.add(join(root, file.toString()));
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => void this.readChanged(), 1000);
          }),
        );
      } catch {}
    }
    if (!this.watchers.length) {
      this.timer = setTimeout(() => {
        void this.refresh();
        this.startWatching();
      }, 300000);
      this.timer.unref();
    }
  }
  async readChanged() {
    if (this.stopping) return;
    if (this.refreshing) await this.refreshing;
    const changes = [...this.changed];
    this.changed.clear();
    let listCodex = false;
    const root = join(Provider.info("claude").configDir(), "projects");
    for (const path of changes) {
      if (path.startsWith(root + "/")) {
        if (path.endsWith(".jsonl")) {
          const entry = await this.cached(path, "claude");
          if (entry) {
            try {
              if ((await stat(entry.cwd)).isDirectory()) this.store.put(entry);
            } catch {}
          } else this.store.remove("claude", basename(path, ".jsonl"));
        } else {
          try {
            for (const file of await readdir(path, { withFileTypes: true })) {
              if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
              const entry = await this.cached(join(path, file.name), "claude");
              if (entry) this.store.put(entry);
            }
          } catch {}
        }
      } else {
        const session = this.rollouts.get(path);
        if (session) {
          const old = this.store.get("codex", session);
          if (!old) {
            listCodex = true;
            continue;
          }
          try {
            const metadata = await stat(path),
              summary = await this.cached(path, "codex");
            if (summary)
              this.store.put({
                ...old,
                last: summary.last || old.last,
                interrupted: summary.interrupted,
                updated_at: Math.max(old.updated_at, Math.floor(metadata.mtimeMs / 1000)),
              });
          } catch {
            this.store.remove("codex", session);
          }
        } else if (path.endsWith("session_index.jsonl") || path.includes("/sessions/")) listCodex = true;
      }
    }
    if (listCodex) {
      try {
        const reply = await this.pool.listThreads(null, { load: () => this.stopping });
        for (const item of reply.result?.data ?? []) {
          if (!item.id || !item.preview || !item.cwd) continue;
          const summary = item.path ? await this.cached(item.path, "codex") : null;
          if (item.path) this.rollouts.set(item.path, item.id);
          const entry: Entry = {
            provider: "codex",
            session: item.id,
            title: item.name ?? "",
            first: item.preview,
            last: summary?.last || item.preview,
            cwd: item.cwd,
            branch: item.gitInfo?.branch ?? "",
            updated_at: item.updatedAt ?? 0,
            interrupted: summary?.interrupted ?? false,
          };
          try {
            if ((await stat(entry.cwd)).isDirectory()) this.store.put(entry);
          } catch {}
        }
      } catch {}
    }
  }
  async cached(path: string, provider: Provider) {
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
      const c = this.cache.lookup(path, s);
      return c
        ? c.entry
        : this.cache.store(path, s, provider === "claude" ? await readClaude(path, s) : await readCodex(path, s));
    } catch {
      return null;
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
      read: Provider[] = [];
    try {
      const projects = join(Provider.info("claude").configDir(), "projects");
      for (const project of await readdir(projects, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const folder = join(projects, project.name);
        for (const f of await readdir(folder, { withFileTypes: true })) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const e = await this.cached(join(folder, f.name), "claude");
          if (e) found.push(e);
        }
      }
      read.push("claude");
    } catch (e) {
      if ((e as any).code === "ENOENT") read.push("claude");
    }
    try {
      let cursor: string | null = null;
      for (let page = 0; page < 10 && !this.stopping; page++) {
        const reply = await this.pool.listThreads(cursor, { load: () => this.stopping });
        const result = reply.result;
        for (const item of result.data ?? []) {
          if (!item.id || !item.preview || !item.cwd) continue;
          const e: Entry = {
            provider: "codex",
            session: item.id,
            title: item.name ?? "",
            first: item.preview,
            last: item.preview,
            cwd: item.cwd,
            branch: item.gitInfo?.branch ?? "",
            updated_at: item.updatedAt ?? 0,
            interrupted: false,
          };
          if (item.path && isAbsolute(item.path)) {
            this.rollouts.set(item.path, item.id);
            const tail = await this.cached(item.path, "codex");
            if (tail) {
              e.last = tail.last || e.last;
              e.interrupted = tail.interrupted;
            }
          }
          found.push(copied(e));
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      read.push("codex");
    } catch {}
    const kept: Entry[] = [];
    for (const e of found)
      try {
        if ((await stat(e.cwd)).isDirectory()) kept.push(e);
      } catch {}
    this.store.replace(kept.sort((a, b) => b.updated_at - a.updated_at).slice(0, capacity), read);
    this.cache.sweep();
    this.ready = true;
  }
}
