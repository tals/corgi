// `conversation.grep`'s searches, off the daemon's thread. The daemon holds the
// index lock for each; `locked` says whether this one may write the index.
import * as path from "node:path";
import * as grep from "./conversation_grep";
import * as cacheIndex from "./conversation_grep_cache";
import * as output from "./conversation_grep_output";
import type { Command, Event, Search } from "./conversation_grep_service";
import type { GrepSummary } from "./protocol";

const running = new Set<number>(),
  cancelled = new Set<number>();
const post = (event: Event) => self.postMessage(event);
/** Bytes `lines` take as JSONL. */
const size = (lines: string[]) => lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);

/** Searches as `corgi grep --json` does, posting each conversation's lines as
 * it's found until they'd pass `cap` bytes. */
async function run(job: Search): Promise<GrepSummary> {
  const stop = () => {
    if (cancelled.has(job.id)) throw Error("Cancelled");
  };
  const session = await cacheIndex.open(job.cache, job.options, undefined, job.locations, !job.locked),
    out = output.renderer(job.display);
  let bytes = 0,
    returned = 0,
    capped = 0,
    truncated = false,
    saved = performance.now();
  try {
    const matches = await grep.search(job.cache, session.sources, {
      ...job.options,
      open: async source => {
        stop();
        const indexed = !session.fresh(source),
          lanes = await session.messages(source);
        // A worker stopped mid-search keeps what it indexed up to a second ago.
        if (indexed && performance.now() - saved >= 1000) {
          session.save();
          saved = performance.now();
        }
        return lanes;
      },
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
    });
};
