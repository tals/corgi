import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Transcript } from "../adapter";
import { number, str, Text, field, timestampMs } from "../common";
import { Counts } from "../../usage/tokens";
import { Tokens } from "../../usage/live";
import { clip } from "../../activity/tools";
import { Text as Summary } from "../../activity/summary";
import { database, indexStamp } from "./summaries";
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
  reader() {
    const titles = new Map<string, { stamp: string; names: Map<string, string> }>();
    return {
      async refresh(requests) {
        const followed = new Map<string, string[]>();
        for (const req of requests) {
          const account = req.account ?? "",
            session = req.agent.sessionId(),
            ids = followed.get(account);
          if (ids) ids.push(session);
          else followed.set(account, [session]);
        }
        for (const account of titles.keys()) if (!followed.has(account)) titles.delete(account);
        for (const [account, ids] of followed) {
          const file = database(directory(account)),
            changed = indexStamp(file);
          if (!changed) {
            titles.delete(account);
            continue;
          }
          try {
            const stamp = [changed, ...ids].join("/");
            if (titles.get(account)?.stamp === stamp) continue;
            const db = new Database(file, { readonly: true });
            try {
              const title = db.query<{ title: string }, [string]>(
                "SELECT title FROM conversation_summaries WHERE conversation_id = ?",
              );
              titles.set(account, { stamp, names: new Map(ids.map(id => [id, title.get(id)?.title ?? ""])) });
            } finally {
              db.close();
            }
          } catch {
            titles.delete(account);
          }
        }
      },
      name(session, account) {
        return new Text(clip(titles.get(account)?.names.get(session) ?? "", 160));
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
