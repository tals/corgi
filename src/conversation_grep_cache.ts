// Reuse normalized files, refreshing only changed transcripts the search reaches.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cached, discover, measure, read, readOn, records, selected, store, tail, versions } from "./conversation_grep";
import type { Lanes, Location, Manifest, Normalized, Options, Source } from "./conversation_grep";
import * as providerSearch from "./providers/search";

export type Progress = (scanned: number, total: number, phase: "checking" | "indexing") => Promise<void>;
type Index = Manifest & { index_version: 1 };

/** Where the index lives, for `corgi grep` and the daemon alike. */
export function directory(env = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "corgi", "conversation-grep-v2");
}

/** Whether two discoveries left out the same files at the same stamps, in
 * whatever order their checks finished. */
function sameIgnored(a: NonNullable<Manifest["ignored"]>, b: NonNullable<Manifest["ignored"]>): boolean {
  if (a.length !== b.length) return false;
  const was = new Map(a.map(s => [s.source, s]));
  return b.every(s => was.get(s.source)?.stamp === s.stamp && !!was.get(s.source)?.failed === !!s.failed);
}
/** The index lock, or null while another search holds it. Only its holder
 * writes the index; cache files are replaced whole, so others read freely. */
export async function tryLock(cache: string): Promise<(() => void) | null> {
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const { flock } = await import("./native_bridge");
  const fd = fs.openSync(path.join(cache, "lock"), "a", 0o600);
  if (!flock(fd)) {
    fs.closeSync(fd);
    return null;
  }
  return () => {
    flock(fd, false);
    fs.closeSync(fd);
  };
}

/** Whether a conversation's cache files are behind its source or its provider's
 * decoding (`version`), for a search with or without tools. */
export function stale(s: Source, version: string, tools = false): boolean {
  return (
    s.indexed_stamp !== s.stamp ||
    s.indexed_version !== version ||
    (tools && (s.tools_stamp !== s.stamp || s.tools_version !== version))
  );
}

/** The index as last saved; null when there's none, or it can't be read as
 * one, as after a crash or a cleared cache. The search then indexes afresh. */
async function lastSaved(file: string): Promise<Index | null> {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(text);
    const entries = (list: unknown, ...fields: string[]) =>
      Array.isArray(list) && list.every(e => e && fields.every(field => typeof e[field] === "string"));
    return value?.index_version === 1 &&
      entries(value.sources, "key", "source", "stamp", "provider", "account", "session") &&
      (value.ignored === undefined || entries(value.ignored, "source", "stamp"))
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Waits for the index lock, for callers that must write the index. */
export async function lock(cache: string): Promise<() => void> {
  const start = performance.now();
  for (;;) {
    const release = await tryLock(cache);
    if (release) return release;
    if (performance.now() - start > 30000) throw Error("Conversation index is busy; try again shortly");
    await Bun.sleep(40);
  }
}

/** The index for one search: conversations in scope, newest first, each
 * indexed only when the search reaches it, so hits arrive while older
 * transcripts still wait. Without the lock (`readOnly`), a changed transcript
 * is read for this search alone and nothing is written. */
export type Session = {
  manifest: Manifest;
  sources: Source[];
  /** Indexes a changed transcript and returns its messages; undefined when its
   * cache is current, null when it can't be read or is older than the scope. */
  update(source: Source): Promise<Normalized | null | undefined>;
  /** Whether the source's cache files hold what this search reads. */
  fresh(source: Source): boolean;
  /** The source's messages by lane, from the transcript just indexed or its cache. */
  messages(source: Source): Promise<Lanes | null>;
  /** Retires removed transcripts' files and saves what was indexed. */
  save(): void;
};

export async function open(
  cache: string,
  options: Options,
  progress?: Progress,
  locations?: Location[],
  readOnly = false,
): Promise<Session> {
  const start = performance.now(),
    file = path.join(cache, "index.json");
  const previous = await lastSaved(file);
  const { sources, warnings, ignored } = await discover(
    previous?.sources,
    locations,
    progress ? (scanned, total) => progress(scanned, total, "checking") : undefined,
    previous?.ignored,
  );
  const manifest: Index = {
    version: 1,
    index_version: 1,
    as_of: new Date().toISOString(),
    sources,
    ignored,
    warnings,
    discovery_ms: performance.now() - start,
    prepare_ms: 0,
    malformed: 0,
    partial: 0,
    refreshed: 0,
  };
  // Whether discovery found what the saved index doesn't say; otherwise only
  // indexing gives a save something to write.
  const saved = new Map((previous?.sources ?? []).map(s => [s.key, s])),
    gone = previous?.ignored ?? [];
  const discovered =
    !previous ||
    saved.size !== sources.length ||
    sources.some(s => {
      const old = saved.get(s.key);
      return !old || old.stamp !== s.stamp || old.file_id !== s.file_id;
    }) ||
    !sameIgnored(gone, ignored);
  const decoding = await versions(),
    behind = (s: Source) => stale(s, decoding.get(s.provider) ?? "", options.tools);
  const candidates = selected(manifest, options),
    changed = candidates.filter(behind).length,
    unreadable = new Set<Source>();
  manifest.reused = candidates.length - changed;
  let reported = performance.now();
  if (changed) await progress?.(0, changed, "indexing");

  /** A transcript that only grew since it was indexed, as a live agent's does:
   * its cached messages and those read on from where indexing stopped, rather
   * than the whole transcript again. Null when it can't be read so. */
  async function appended(source: Source): Promise<Normalized | null> {
    const end = source.indexed_end;
    if (options.tools || !end || !source.indexed_stamp || end.stamp !== source.indexed_stamp) return null;
    if (source.indexed_version !== decoding.get(source.provider)) return null;
    // The same file, no shorter, still holding what was read: its stamp is inode:size:mtime.
    const [inode, size] = source.stamp.split(":"),
      [was] = source.indexed_stamp.split(":");
    try {
      if (inode !== was || !(Number(size) >= end.bytes) || tail(source.source, end.bytes) !== source.indexed_tail)
        return null;
      // The cache file is replaced before the index is saved, so a search
      // stopped between the two leaves it ahead of where the index says.
      const kept = records(await Bun.file(path.join(cache, source.file)).text());
      if (kept.length !== source.messages) return null;
      const more = await readOn(source, end);
      if (!more) return null;
      const messages = [...kept, ...more.messages];
      // One indexed before anyone spoke is named by the first to speak.
      const named = source.title ? "" : providerSearch.title(messages.find(m => m.role === "user")?.text ?? "");
      return { ...more, messages, title: more.title || named };
    } catch {
      return null;
    }
  }

  async function update(source: Source): Promise<Normalized | null | undefined> {
    if (unreadable.has(source)) return null;
    if (!behind(source)) return undefined;
    let normalized: Normalized;
    try {
      normalized = (await appended(source)) ?? (await read(source, options.tools));
    } catch (error) {
      // A truncated archive, or a transcript deleted since discovery, doesn't
      // fail the search; a file is skipped until it changes.
      warnings.push(`Unreadable transcript skipped: ${source.source}: ${error}`);
      unreadable.add(source);
      ignored.push({ source: source.source, stamp: source.stamp, failed: true });
      return null;
    }
    // Where indexing stopped, to read on from; one gone since is read whole next time.
    let at: string | undefined;
    if (normalized.end && !readOnly)
      try {
        at = tail(source.source, normalized.end.bytes);
      } catch {}
    source.title = normalized.title || source.title;
    manifest.malformed += normalized.malformed;
    manifest.partial += normalized.partial;
    if (readOnly) measure(source, normalized.messages);
    else {
      store(cache, source, normalized);
      source.indexed_stamp = source.stamp;
      source.indexed_version = decoding.get(source.provider);
      source.indexed_end = at === undefined ? undefined : normalized.end && { ...normalized.end, stamp: source.stamp };
      source.indexed_tail = at;
      if (normalized.tools) {
        source.tools_stamp = source.stamp;
        source.tools_version = source.indexed_version;
      }
      manifest.refreshed!++;
    }
    if (progress && performance.now() - reported >= 80) {
      await progress(manifest.refreshed!, changed, "indexing");
      reported = performance.now();
    }
    // Scope used the file's time; its last message may turn out older.
    return options.age && source.updated_at < options.asOf - options.age ? null : normalized;
  }

  return {
    manifest,
    sources: candidates,
    update,
    fresh: source => !behind(source),
    async messages(source) {
      let normalized = await update(source);
      if (normalized === undefined) {
        try {
          const lanes = await cached(cache, source, options.tools);
          if (lanes.text.length === source.messages) return lanes;
        } catch {}
        // Its cache files are gone, cut short or don't parse: the transcript
        // is read again. One the lock holder retired is gone too, and is skipped.
        source.indexed_stamp = source.tools_stamp = undefined;
        normalized = await update(source);
      }
      if (!normalized) return null;
      return { text: normalized.messages, ...(options.tools ? { tools: normalized.tools } : {}) };
    },
    save() {
      if (readOnly || !(discovered || manifest.refreshed || unreadable.size)) return;
      if (unreadable.size) manifest.sources = sources.filter(s => !unreadable.has(s));
      // Retire files only after discovering a removed transcript. Never touch provider stores.
      const retained = new Set(manifest.sources.map(s => s.key));
      for (const source of previous?.sources ?? [])
        if (!retained.has(source.key)) {
          for (const suffix of [".jsonl", ".tools.jsonl"])
            fs.rmSync(path.join(cache, source.key + suffix), { force: true });
        }
      manifest.prepare_ms = performance.now() - start;
      fs.writeFileSync(file + ".new", JSON.stringify(manifest), { mode: 0o600 });
      fs.renameSync(file + ".new", file);
    },
  };
}

/** Indexes every changed transcript in scope, for callers that search later. */
export async function refresh(
  cache: string,
  options: Options,
  progress?: Progress,
  locations?: Location[],
): Promise<Manifest> {
  const session = await open(cache, options, progress, locations);
  for (const source of session.sources) await session.update(source);
  session.save();
  return session.manifest;
}
