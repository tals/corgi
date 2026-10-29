//! `corgi __update-check`: a release loads a checkpoint as it would after an
//! update, starting nothing, and says what stopped it. What it says leaves
//! the machine in a bug report, so it holds ids, counts and providers only.
import { readFileSync } from "node:fs";
import { Runtime } from "../runtime";
import * as breadcrumbs from "../breadcrumbs";
import * as checkpoint from "./checkpoint";
import { checkpoint as schema } from "./schema";
import { Provider } from "../providers";
import * as migrations from "./migrations";
import * as errors from "../errors";
import * as json from "../json";

export type State = {
  /** One line: what was saved, in counts. */
  summary: string;
  /** A line for each pane and native session: what it shows and knows. */
  items: string[];
  /** What the release's own loading repaired before it stopped. */
  repairs: string[];
  /** The last changes to what panes and sessions showed, oldest first, timed from the save. */
  recent: string[];
  /** The checkpoint as saved, with every string the schema doesn't name a value of replaced. */
  anonymized: string;
};
export type Result =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** The check that failed, when the release names it. */
      why: string | null;
      /** Where it failed, when the release doesn't name the check. */
      frames: string[];
      state: State;
    };

/** Loads `path` with the restore the daemon uses, so what passes here loads there. */
export async function run(path: string, socket: string, executable: string): Promise<Result> {
  let bytes: string;
  try {
    bytes = readFileSync(path, "utf8");
  } catch {
    // Nothing saved is nothing to turn down.
    return { ok: true };
  }
  let state: unknown = null;
  const r = new Runtime(),
    repairs: string[] = [];
  try {
    try {
      state = json.parse(bytes);
    } catch {}
    const decoded = migrations.decode("checkpoint", bytes);
    state = decoded.value;
    await checkpoint.restore(r, decoded.value, false, socket, executable, false, repairs);
    return { ok: true };
  } catch (error) {
    const why = error instanceof checkpoint.Invalid ? scrub(error.why) : null;
    return {
      ok: false,
      error: word(errors.name(error)),
      why,
      frames: why ? [] : frames(error),
      state: { ...describe(state), repairs: repairs.map(scrub) },
    };
  } finally {
    r.destroy();
  }
}
/** The functions the failure passed through, innermost first, without paths
 * or the numbers the bundler adds to names it renames. */
export function frames(error: unknown): string[] {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  return stack
    .split("\n")
    .flatMap(line => /^\s*at (?:async )?([\w$.<>]+) \(/.exec(line)?.[1]?.replace(/\d+$/, "") ?? [])
    .slice(0, 8);
}
const max_items = 64,
  max_recent = 24;
/** What the checkpoint holds and what refers to what, as saved. Whether
 * that loads is the restore's to say, not this. */
export function describe(state: any): Omit<State, "repairs"> {
  if (!state || typeof state !== "object" || Array.isArray(state))
    return { summary: "not a JSON object", items: [], recent: [], anonymized: "null" };
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : []),
    conversations = list(state.conversations),
    provider = (id: unknown) => conversations.find(c => c?.id === id)?.agent?.provider,
    same = (a: unknown, b: unknown) => json.stringify(a ?? "") === json.stringify(b ?? "");
  // Which saved conversation a resume hint would bring back, by id: the session itself stays out.
  const resumes = (hint: any) => {
    if (!hint?.provider || same(hint.session, "") || same(hint.session, [])) return [];
    const c = conversations.find(c => c?.agent?.provider === hint.provider && same(c.agent.session, hint.session));
    return [c ? `can resume ${word(c.id)}` : `can resume a ${word(hint.provider)} session that isn't saved`];
  };
  const shows = (b: any) => [
    b?.actor ? `shows conversation ${word(b.actor)}` : "shows no conversation",
    ...(list(b?.known).length ? [`has shown ${list(b.known).map(word).join(", ")}`] : []),
  ];
  const items: string[] = [];
  for (const p of list(state.panes)) {
    const b = p?.binding ?? {},
      agent = provider(b.actor) ?? b.provisional?.provider;
    items.push(
      [
        `pane ${word(p?.id)}: ${agent ? word(agent) : "no agent"}`,
        ...shows(b),
        ...resumes(p?.resume_hint),
        ...(p?.dormant ? ["asleep"] : []),
      ].join(", "),
    );
  }
  for (const s of list(state.sessions))
    items.push(
      [
        `native session ${word(s?.id)}: ${word(s?.provider)}`,
        ...shows(s?.binding),
        `members ${list(s?.members).map(word).join(", ") || "none"}`,
        ...(s?.exited ? ["exited"] : []),
      ].join(", "),
    );
  items.push(
    `known conversation ids: {${conversations.map(c => `${word(c?.id)}: ${word(c?.agent?.provider)}`).join(", ")}}`,
  );
  const by = new Map<string, number>();
  for (const c of conversations) by.set(word(c?.agent?.provider), (by.get(word(c?.agent?.provider)) ?? 0) + 1);
  const count = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`,
    summary =
      `${state.live ? "live" : "cold"} checkpoint v${word(state.version)}: ` +
      [
        count(list(state.workspaces).length, "workspace"),
        count(list(state.panes).length, "pane"),
        count(list(state.closed).length, "closed tab"),
        count(list(state.sessions).length, "native session"),
        count(conversations.length, "conversation") +
          (by.size ? ` (${[...by].map(([p, n]) => `${p} ${n}`).join(", ")})` : ""),
      ].join(", ");
  const cap = (lines: string[]) =>
    lines.length > max_items ? [...lines.slice(0, max_items), `… and ${lines.length - max_items} more`] : lines;
  const saved_ms = Number.isFinite(state.saved_at) ? state.saved_at * 1000 : Date.now(),
    recent = breadcrumbs
      .parse(state.breadcrumbs)
      .slice(-max_recent)
      .map(e => breadcrumbs.line(e, saved_ms));
  return { summary, items: cap(items), recent, anonymized: json.stringify(anonymize(state)) };
}
/** The strings a checkpoint may keep, by field: the members the schema lists
 * for each enum and provider field, and breadcrumb kinds. */
const kept: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const out = new Map<string, Set<string>>(),
    add = (key: string, values: readonly string[]) => {
      const set = out.get(key) ?? new Set<string>();
      for (const v of values) set.add(v);
      out.set(key, set);
    };
  for (const line of schema.trim().split("\n")) {
    const match = /\.([a-z_]+)[^.]*: (enum .+|provider)$/.exec(line);
    if (match) add(match[1], match[2] === "provider" ? Provider.all : match[2].split(" ").slice(1));
  }
  add("kind", breadcrumbs.kinds);
  return out;
})();
/** Fields the schema calls text, which a checkpoint may save as a list of bytes. */
const texts: ReadonlySet<string> = new Set(
  schema
    .trim()
    .split("\n")
    .flatMap(line => /\.([a-z_]+)[^.]*: (?:string|custom bounded_text\.\w+\(\d+\))$/.exec(line)?.[1] ?? []),
);
/** Settings, not the session: what launches, labels and accounts look like. */
const settings = new Set([
  "agent_commands",
  "link_labels",
  "agent_yolo",
  "agent_hidden",
  "account_yolo",
  "account_hidden",
  "last_agent",
]);
/** What a private value stands for, by the field it's in. */
const kinds: Record<string, string> = {
  session: "session",
  turn: "turn",
  last_finished_turn: "turn",
  phase_turn: "turn",
  thread: "turn",
  cwd: "folder",
  common_dir: "folder",
  path: "path",
  transcript: "path",
};
const timed = (key: string) => /^at$|_at$|since$/.test(key);
/** The checkpoint `state` as an issue can show it:
 * - a string the schema doesn't list for its field becomes a token, the same
 *   one wherever the same value appears: "<session 1>", "<text 3, 11 chars>";
 * - a field holding its default (0, "", false, null, nothing) is left out;
 * - a time becomes seconds before the save, whatever unit it was saved in;
 * - settings are left out, and a list of one thing repeated says so once.
 * It's for reading, not loading. */
export function anonymize(state: any): unknown {
  const tokens = new Map<string, string>(),
    counts = new Map<string, number>(),
    saved = Number(state?.saved_at) || 0;
  const token = (key: string, value: string | unknown[]) => {
    const kind = kinds[key] ?? "text",
      id = `${kind}\0${json.stringify(value)}`;
    let t = tokens.get(id);
    if (!t) {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      t = kind === "text" ? `<text ${n}, ${value.length} chars>` : `<${kind} ${n}>`;
      tokens.set(id, t);
    }
    return t;
  };
  // Times are saved in seconds, milliseconds or microseconds; the save's own is in seconds.
  const before = (v: number) => {
    for (const unit of [1, 1e3, 1e6])
      if (Math.abs(v / unit - saved) < 3e8) return Math.round((v / unit - saved) * 10) / 10;
    return v;
  };
  const empty = (v: unknown) =>
    v === 0 ||
    v === "" ||
    v === false ||
    v === null ||
    v === undefined ||
    (Array.isArray(v) && !v.length) ||
    (!!v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === "bigint") value = Number(value);
    if (typeof value === "string") return value === "" || kept.get(key)?.has(value) ? value : token(key, value);
    if (typeof value === "number") return saved && timed(key) && value > 1e8 ? before(value) : value;
    if (Array.isArray(value)) {
      if (texts.has(key) && value.length && value.every(x => typeof x === "number")) return token(key, value);
      const items = value.map(item => walk(item, key)),
        first = items.length > 2 ? json.stringify(items[0]) : null;
      // Unused slots and default entries say the same thing many times, or nothing.
      if (first === null || !items.every(item => json.stringify(item) === first)) return items;
      return empty(items[0]) ? [] : { [`<${items.length} ×>`]: items[0] };
    }
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).flatMap(([k, v], i) => {
          if (key === "" && (settings.has(k) || k === "saved_at")) return [];
          const field = /^[a-z_][a-z0-9_]{0,40}$/.test(k) ? k : `<key ${i}>`,
            out = walk(v, field);
          return empty(out) ? [] : [[field, out]];
        }),
      );
    return value;
  };
  return walk(state, "");
}
/** A number or a short plain name; anything else could carry a path or a session. */
function word(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (typeof value === "string" && /^[\w .-]{1,32}$/.test(value)) return value;
  return value === null || value === undefined ? "none" : "?";
}
/** A check's reason with anything path- or session-shaped taken out; a
 * corrupt checkpoint can put either where an id belongs. */
function scrub(why: string): string {
  return why.replace(/\S*\/\S*|\S{33,}/g, "?");
}
