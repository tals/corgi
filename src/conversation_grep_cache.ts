// Reuse normalized files, refreshing only changed transcripts the search reaches.
import * as fs from "node:fs";
import * as path from "node:path";
import { cached, discover, measure, read, selected, store, versions } from "./conversation_grep";
import type { Lanes, Location, Manifest, Normalized, Options, Source } from "./conversation_grep";

export type Progress = (scanned: number, total: number, phase: "checking" | "indexing") => Promise<void>;
type Index = Manifest & { index_version: 1 };

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
  let previous: Index | null = null;
  try {
    const value = await Bun.file(file).json();
    if (value.index_version === 1) previous = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  const decoding = await versions(),
    behind = (s: Source) => stale(s, decoding.get(s.provider) ?? "", options.tools);
  const candidates = selected(manifest, options),
    changed = candidates.filter(behind).length,
    unreadable = new Set<Source>();
  manifest.reused = candidates.length - changed;
  let reported = performance.now();
  if (changed) await progress?.(0, changed, "indexing");

  async function update(source: Source): Promise<Normalized | null | undefined> {
    if (unreadable.has(source)) return null;
    if (!behind(source)) return undefined;
    let normalized: Normalized;
    try {
      normalized = await read(source, options.tools);
    } catch (error) {
      // A truncated archive, or a transcript deleted since discovery, doesn't
      // fail the search; a file is skipped until it changes.
      warnings.push(`Unreadable transcript skipped: ${source.source}: ${error}`);
      unreadable.add(source);
      ignored.push({ source: source.source, stamp: source.stamp });
      return null;
    }
    source.title = normalized.title || source.title;
    manifest.malformed += normalized.malformed;
    manifest.partial += normalized.partial;
    if (readOnly) measure(source, normalized.messages);
    else {
      store(cache, source, normalized);
      source.indexed_stamp = source.stamp;
      source.indexed_version = decoding.get(source.provider);
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
      const normalized = await update(source);
      if (normalized === null) return null;
      if (normalized) return { text: normalized.messages, ...(options.tools ? { tools: normalized.tools } : {}) };
      try {
        return await cached(cache, source, options.tools);
      } catch (error) {
        // The lock holder retired it: its transcript is gone.
        if (readOnly && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    save() {
      if (readOnly) return;
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
