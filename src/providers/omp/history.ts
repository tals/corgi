import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionHistory } from "../adapter";
import { Cache, cached, copied, directory, readAt, records, type Entry, source } from "../../launch/history";
import { directory as configDirectory } from "./integration";
import { field, str, timestampMs } from "../common";
import { messageText } from "../pi/headless";
import * as locations from "./locations";
import * as accounts from "../../accounts";
export function entry(head: string, tail: string, mid = false, mtime = 0): Entry | null {
  const first = records(head).slice(0, 2),
    slot = first.find(v => str(v, "type") === "title"),
    header = first.find(v => str(v, "type") === "session");
  if (!header || !str(header, "id") || !str(header, "cwd")) return null;
  const e: Entry = {
    provider: "omp",
    account: "",
    session: str(header, "id"),
    cwd: str(header, "cwd"),
    title: str(slot, "title"),
    first: "",
    last: "",
    branch: "",
    interrupted: false,
    updated_at: mtime,
  };
  for (const v of records(head))
    if (str(v, "type") === "message" && str(field(v, "message"), "role") === "user") {
      e.first = messageText(field(v, "message"));
      if (e.first) break;
    }
  for (const v of records(tail, mid)) {
    if (str(v, "type") === "title_change" && str(v, "title")) e.title = str(v, "title");
    if (str(v, "type") !== "message") continue;
    const m = field(v, "message"),
      role = str(m, "role"),
      stamp = timestampMs(str(v, "timestamp"));
    if (stamp !== null && ["user", "assistant"].includes(role)) e.updated_at = Math.floor(stamp / 1000);
    if (role === "user") {
      e.last = messageText(m);
      e.interrupted = false;
    }
    if (role === "assistant") e.interrupted = str(m, "stopReason") === "aborted";
  }
  e.last ||= e.first;
  e.first ||= e.last;
  return e.first ? copied(e) : null;
}
export function open(account = ""): SessionHistory {
  const cache = new Cache();
  const read = async (p: string, s: { size: number; mtimeMs: number }) => {
    const start = Math.max(0, s.size - 256 * 1024);
    const e = entry(
      await readAt(p, 0, Math.min(s.size, 128 * 1024)),
      await readAt(p, start, s.size - start),
      start > 0,
      Math.floor(s.mtimeMs / 1000),
    );
    if (e) e.account = account;
    return e;
  };
  const list = async (stopping: () => boolean) => {
    const sessions: Entry[] = [];
    let complete = true;
    const key = locations.accountKey(account),
      observed = locations.all(),
      owners = new Map(observed.map(v => [v.session, v])),
      candidates = [
        ...new Set([
          "",
          ...accounts
            .known()
            .filter(a => a.provider === "omp")
            .map(a => a.dir),
          account,
        ]),
      ],
      roots = new Map<string, string>();
    // Unobserved history in a shared folder belongs to one account, default first.
    for (const candidate of candidates)
      for (const root of locations.sessionRoots(candidate)) {
        const path = locations.canonical(root);
        if (!roots.has(path)) roots.set(path, locations.accountKey(candidate));
      }
    const belongs = (e: Entry, path: string, fallback: boolean) => {
      const owner = owners.get(e.session);
      return owner
        ? owner.account === key && locations.canonical(owner.transcript) === locations.canonical(path)
        : fallback;
    };
    // Sessions sit one folder per directory deep; subagents' sit deeper.
    const scan = async (folder: string, depth: number, fallback: boolean) => {
      try {
        for (const f of await readdir(folder, { withFileTypes: true })) {
          if (stopping()) {
            complete = false;
            return;
          }
          const p = join(folder, f.name);
          if (f.isDirectory() && depth) await scan(p, depth - 1, fallback);
          else if (f.isFile() && f.name.endsWith(".jsonl") && !f.name.startsWith(".")) {
            const e = await cached(cache, p, read);
            if (e && belongs(e, p, fallback)) sessions.push(e);
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
      }
    };
    for (const root of locations.sessionRoots(account))
      await scan(root, 1, roots.get(locations.canonical(root)) === key);
    for (const { session, transcript, account: owner } of observed) {
      if (owner !== key) continue;
      if (stopping()) {
        complete = false;
        break;
      }
      const e = await cached(cache, transcript, read);
      if (e?.session === session) sessions.push(e);
    }
    cache.sweep();
    return { sessions: [...new Map(sessions.map(e => [e.session, e])).values()], complete };
  };
  return {
    roots: () => [...new Set([configDirectory(account), locations.directory(), ...locations.sessionRoots(account)])],
    list,
    async changed(_paths, store, stopping) {
      const result = await list(stopping);
      const kept = [];
      for (const e of result.sessions) if (await directory(e.cwd)) kept.push(e);
      if (result.complete) store.replace(kept, [source("omp", account)]);
      else for (const e of kept) store.put(e);
    },
    close() {},
  };
}
