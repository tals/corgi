import { join } from "node:path";
import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { Transcript } from "../adapter";
import { number, str, Text, field, timestampMs } from "../common";
import { Counts } from "../../usage/tokens";
import { Tokens } from "../../usage/live";
import { clip } from "../../activity/tools";
import { Text as Summary } from "../../activity/summary";
import { database } from "./history";
import { directory } from "./config";

export const path = (root: string, session: string) =>
  join(root, "brain", session, ".system_generated", "logs", "transcript.jsonl");
export function message(v: unknown) {
  const content = str(v, "content");
  switch (str(v, "type")) {
    case "USER_INPUT":
      return {
        role: "user" as const,
        text: /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)?.[1] ?? content,
      };
    case "PLANNER_RESPONSE":
      return { role: "assistant" as const, text: content };
    default:
      return null;
  }
}
export const transcript: Transcript = {
  completion: () => null,
  fallback(r, a) {
    if (r.name.len) a.setName(r.name.text());
    const p = r.progress;
    if (a.state !== "working" || !p || p.ended || !p.commentary.len || !p.turn.len || p.turn.text() !== a.turnId())
      return false;
    a.activity_generation = Bun.hash.wyhash(a.turnId(), 0n);
    return true;
  },
  reader(accounts) {
    const titles = new Map<string, { stamp: string; names: Map<string, string> }>();
    return {
      async refresh() {
        for (const account of ["", ...accounts()]) {
          const file = database(directory(account));
          try {
            const s = statSync(file),
              wal = statSync(file + "-wal", { throwIfNoEntry: false });
            const stamp = [s.ino, s.mtimeMs, wal?.size, wal?.mtimeMs].join(":");
            if (titles.get(file)?.stamp === stamp) continue;
            const db = new Database(file, { readonly: true });
            try {
              const names = new Map(
                db
                  .query<{ conversation_id: string; title: string }, []>(
                    "SELECT conversation_id,title FROM conversation_summaries",
                  )
                  .all()
                  .map(r => [r.conversation_id, r.title]),
              );
              titles.set(file, { stamp, names });
            } finally {
              db.close();
            }
          } catch {
            titles.delete(file);
          }
        }
      },
      name(session) {
        for (const { names } of titles.values()) {
          const title = names.get(session);
          if (title) return new Text(clip(title, 160));
        }
        return new Text();
      },
      timestamp: v => timestampMs(str(v, "created_at")),
      open(t, _req, _head, catchUp) {
        t.catch_up = catchUp;
      },
      record(t, req, v, appended, stamp) {
        const delta = new Counts(),
          m = message(v),
          step = number(v, "step_index");
        if (!m || step === null) return delta;
        t.spoke_at = Math.max(t.spoke_at, stamp ?? 0);
        if (m.role === "user") return delta;
        t.observeModel(v);
        const input = number(v, "input_tokens"),
          cached = number(v, "cache_read_tokens") ?? 0n,
          output = number(v, "output_tokens");
        if (input !== null && output !== null)
          delta.add(t.tracker.tokensCached(String(step), input + cached, cached, output, false));
        const calls = field(v, "tool_calls");
        if (Array.isArray(calls))
          calls.forEach((_, i) => {
            delta.tools += t.tracker.tool(step + ":" + i);
          });
        if (appended || (t.catch_up && stamp !== null && stamp >= req.tracked_since)) {
          if (delta.tokens_known)
            t.live.meter.add(
              new Tokens({ input: delta.input, cached_input: delta.cached_input, output: delta.output }),
              stamp ?? Date.now(),
            );
          t.live.meter.count(delta.tools);
          if (m.text && t.progress.turn.len) {
            t.progress.commentary = new Summary(clip(m.text, 2048));
            t.progress.dirty = true;
          }
        }
        return delta;
      },
    };
  },
};
