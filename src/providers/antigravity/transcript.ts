import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Transcript } from "../adapter";
import { number, str, Text, field, timestampMs } from "../common";
import { Counts } from "../../usage/tokens";
import { Tokens } from "../../usage/live";
import { Call, clip, shortPath } from "../../activity/tools";
import { Text as Summary } from "../../activity/summary";
import { database, indexStamp } from "./summaries";
import { directory } from "./config";

const pathKeys = new Set([
  "Path",
  "TargetFile",
  "AbsolutePath",
  "DirectoryPath",
  "SearchPath",
  "SearchDirectory",
  "file_path",
  "path",
]);
const detailKeys = [
  "toolSummary",
  "Description",
  "description",
  "CommandLine",
  "command",
  "Query",
  "query",
  "Pattern",
  "pattern",
  "Path",
  "TargetFile",
  "AbsolutePath",
  "DirectoryPath",
  "SearchPath",
  "SearchDirectory",
  "file_path",
  "path",
  "Url",
  "url",
  "Role",
  "Action",
  "Prompt",
  "prompt",
] as const;

/** Compact agy transcripts JSON-encode tool argument values as strings. */
function argText(args: unknown, key: string) {
  const raw = str(args, key);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {}
  }
  return raw;
}

function toolCall(value: unknown, id: bigint) {
  const name = str(value, "name");
  if (!name) return null;
  const call = new Call();
  call.id = id;
  call.append(name);
  const args = field(value, "args");
  for (const key of detailKeys) {
    const detail = argText(args, key);
    if (!detail) continue;
    call.append(": ");
    call.detail(pathKeys.has(key) ? shortPath(detail) : detail);
    break;
  }
  return call;
}

function firstUpdate(text: string) {
  for (const row of text.split("\n")) {
    const line = row.replace(/^[ \t\r#*\->`_]+|[ \t\r#*\->`_]+$/g, "");
    if (line) return line;
  }
  return "";
}

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
    if (a.state === "working" && !a.activity_inferred && r.update.len && r.update_at > a.activity_at) {
      a.setActivity(r.update.text());
      a.activity_at = r.update_at;
    }
    const p = r.progress;
    if (
      a.state !== "working" ||
      !p ||
      p.ended ||
      (!p.commentary.len && !p.evidence.len) ||
      !p.turn.len ||
      p.turn.text() !== a.turnId()
    )
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
        if (step === null) return delta;
        if (!m) {
          if (str(v, "source") === "MODEL" && t.progress.turn.len && !t.progress.ended)
            t.progress.finishId(t.progress.key(String(step)), appended);
          return delta;
        }
        t.spoke_at = Math.max(t.spoke_at, stamp ?? 0);
        if (m.role === "user") return delta;
        t.observeModel(v);
        const input = number(v, "input_tokens"),
          cached = number(v, "cache_read_tokens") ?? 0n,
          output = number(v, "output_tokens");
        if (input !== null && output !== null)
          delta.add(t.tracker.tokensCached(String(step), input + cached, cached, output, false));
        const calls = field(v, "tool_calls"),
          list = Array.isArray(calls) ? calls : [];
        list.forEach((_, i) => {
          delta.tools += t.tracker.tool(step + ":" + i);
        });
        if (appended || (t.catch_up && stamp !== null && stamp >= req.tracked_since)) {
          if (delta.tokens_known)
            t.live.meter.add(
              new Tokens({ input: delta.input, cached_input: delta.cached_input, output: delta.output }),
              stamp ?? Date.now(),
            );
          t.live.meter.count(delta.tools);
        }
        const text = m.text.trim();
        if (!req.child && text && stamp !== null) {
          const line = firstUpdate(text);
          if (line) {
            t.update = new Text(clip(line, 160));
            t.update_at = stamp * 1000;
          }
        }
        if (t.progress.turn.len && !t.progress.ended) {
          // Each tool call's result step follows the planner step in call order.
          const keys = list.map((_, i) => t.progress.key(String(step + 1n + BigInt(i))));
          // Any still-pending tool from an earlier planner step finished before this one.
          for (const open of t.progress.pending)
            if (open && !keys.includes(open.id)) t.progress.finishId(open.id, appended);
          list.forEach((value, i) => {
            const key = keys[i];
            if (t.progress.seen.includes(key)) return;
            const call = toolCall(value, key);
            if (call) t.progress.save(call, appended);
          });
          if (appended && text) {
            t.progress.commentary = new Summary(clip("Latest agent update: " + text, 2048));
            t.progress.dirty = true;
          }
        }
        return delta;
      },
    };
  },
};
