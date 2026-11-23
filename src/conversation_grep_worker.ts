// `conversation.grep`'s searches, off the daemon's thread. The daemon holds the
// index lock for each; `locked` says whether this one may write the index.
// Between searches the worker keeps what it found and read, so typing a query
// pays for discovery and reading conversations once, not on every key.
import * as path from "node:path";
import * as grep from "./conversation_grep";
import * as cacheIndex from "./conversation_grep_cache";
import * as output from "./conversation_grep_output";
import * as grepRegex from "./conversation_grep_regex";
import type { Lanes, Message, Source } from "./conversation_grep";
import type { Command, Event, Search } from "./conversation_grep_service";
import type { GrepSummary } from "./protocol";

const running = new Set<number>(),
  cancelled = new Set<number>();
const post = (event: Event) => self.postMessage(event);
/** Bytes `lines` take as JSONL. */
const size = (lines: string[]) => lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
/** How long one discovery serves the searches after it, so text written since
 * shows at most this late. One older than half this is renewed after a search. */
const reuse_ms = 2000;
/** The index a search last opened, what it was opened for and when. A
 * writable one serves only searches that hold the lock too. */
type Warm = { session: cacheIndex.Session; scope: string; locked: boolean; at: number };
let warm: Warm | null = null;
/** A discovery under way after a search, for the next one. */
let renewing: Promise<void> | null = null;
/** Each conversation's messages as last read, by key, with their text in one
 * string; `stamp` is its transcript's then. Kept while the worker lives. */
const memory = new Map<string, { stamp: string; text: Message[]; joined: string }>();

/** What decides which conversations a search's index lists. */
function scope(job: Search): string {
  const o = job.options;
  return JSON.stringify([job.cache, job.locations, o.workspace, o.folders, o.age, o.provider, o.session, o.tools]);
}
async function discover(job: Search): Promise<Warm> {
  const at = performance.now(),
    session = await cacheIndex.open(job.cache, job.options, undefined, job.locations, !job.locked);
  return { session, scope: scope(job), locked: job.locked, at };
}
/** The index for `job`: the last one while it's recent and lists the same
 * conversations, else a new one. */
async function index(job: Search): Promise<cacheIndex.Session> {
  await renewing;
  const fits = (w: Warm | null): w is Warm =>
    !!w && w.scope === scope(job) && w.locked === job.locked && performance.now() - w.at < reuse_ms;
  if (!fits(warm)) warm = await discover(job);
  return warm.session;
}
/** After a search, discovers again for the next if the index is getting old. */
function renew(job: Search): void {
  if (renewing || !warm || warm.scope !== scope(job) || performance.now() - warm.at < reuse_ms / 2) return;
  renewing = discover(job)
    .then(next => {
      warm = next;
    })
    .catch(() => {})
    .finally(() => {
      renewing = null;
    });
}

/** Searches as `corgi grep --json` does, posting each conversation's lines as
 * it's found until they'd pass `cap` bytes. A `warm` search only reads the
 * conversations, for the searches after it. */
async function run(job: Search): Promise<GrepSummary> {
  const stop = () => {
    if (cancelled.has(job.id)) throw Error("Cancelled");
  };
  const session = await index(job),
    out = output.renderer(job.display),
    regex = grepRegex.compile({ ...job.options, before: 0, after: 0 }),
    // A line that matches is a match in a conversation's lines joined, its
    // ^ and $ at line ends, so a conversation this misses has none to search.
    any = new RegExp(regex.source, regex.flags.replace(/[gy]/g, "") + "m");
  let bytes = 0,
    returned = 0,
    capped = 0,
    truncated = false,
    saved = performance.now();
  /** `source`'s messages, as last read while its transcript is unchanged;
   * null when its text can't match. */
  const open = async (source: Source): Promise<Lanes | null> => {
    stop();
    const kept = job.options.tools ? undefined : memory.get(source.key);
    if (kept?.stamp === source.stamp) return job.warm || any.test(kept.joined) ? { text: kept.text } : null;
    const indexed = !session.fresh(source),
      lanes = await session.messages(source);
    // A worker stopped mid-search keeps what it indexed up to a second ago.
    if (indexed && performance.now() - saved >= 1000) {
      session.save();
      saved = performance.now();
    }
    if (!lanes || job.options.tools) return lanes;
    const text = [...lanes.text],
      joined = text.map(m => m.text).join("\n");
    memory.set(source.key, { stamp: source.stamp, text, joined });
    return job.warm || any.test(joined) ? { text } : null;
  };
  try {
    if (job.warm) {
      for (const source of session.sources) await open(source);
      const summary = { returned: 0, truncated: false, limit_reached: false, capped_sessions: 0 };
      return { candidates: session.sources.length, ...summary, warnings: session.manifest.warnings };
    }
    const matches = await grep.search(job.cache, session.sources, {
      ...job.options,
      open,
      found: async m => {
        stop();
        const match = {
          ...m,
          source: {
            provider: m.source.provider,
            account: m.source.account,
            session: m.source.session,
            cwd: m.source.cwd,
            updated_at: m.source.updated_at,
            source: m.source.source,
            ...(session.fresh(m.source) ? { cache: path.join(job.cache, m.source.file) } : {}),
          },
        };
        out.add(match);
        let lines = out.take().split("\n").filter(Boolean);
        if (bytes + size(lines) > job.cap) {
          // What fits of it ends the search, its last line clipped. A UTF-16
          // unit is at most 3 bytes of UTF-8, so the characters left bound them.
          const rest = output.renderer({
            ...job.display,
            maxOutputChars: Math.max(1, Math.floor((job.cap - bytes) / 3)),
          });
          rest.add(match);
          lines = rest.take().split("\n").filter(Boolean);
          if (bytes + size(lines) > job.cap) lines = [];
          truncated = true;
        }
        bytes += size(lines);
        if (lines.length) {
          returned++;
          if (m.count_limited) capped++;
          post({ type: "lines", id: job.id, lines: lines.map(line => JSON.parse(line)) });
        }
        return !truncated;
      },
    });
    return {
      candidates: session.sources.length,
      returned,
      truncated,
      limit_reached: !!job.options.limit && matches.length >= job.options.limit,
      capped_sessions: capped,
      warnings: session.manifest.warnings,
    };
  } finally {
    session.save();
  }
}

self.onmessage = (event: MessageEvent<Command>) => {
  const command = event.data;
  if (command.type === "cancel") {
    if (running.has(command.id)) cancelled.add(command.id);
    return;
  }
  const id = command.id;
  running.add(id);
  void run(command)
    .then(
      summary => post({ type: "done", id, summary }),
      error =>
        post(
          cancelled.has(id)
            ? { type: "cancelled", id }
            : { type: "failed", id, error: error instanceof Error ? error.message : String(error) },
        ),
    )
    .finally(() => {
      running.delete(id);
      cancelled.delete(id);
      renew(command);
    });
};
