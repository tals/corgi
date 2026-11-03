//! Search progress sent directly by the conversation grep tool, independently
//! of the model's shell-tool reply. One bounded snapshot replaces the last.
import { Provider } from "./providers";
import * as json from "./json";
import { truncateUtf8 } from "./bounded_text";
import type { Entry } from "./launcher_resume";

export const top_k = 5;
export type Phase = "checking" | "indexing" | "searching" | "done" | "failed" | "cancelled";
export type Match = {
  provider: Provider;
  session: string;
  account: string;
  cwd: string;
  title: string;
  excerpt: string;
  updated_at: number;
};
export type State = {
  id: string;
  revision: number;
  phase: Phase;
  expression: string;
  workspace: string;
  found: number;
  scanned: number;
  total: number;
  limited: boolean;
  matches: Match[];
  error: string;
};
export type Event = { kind: "search"; session: string; search: State };
export function finished(state: State): boolean {
  return state.phase === "done" || state.phase === "failed" || state.phase === "cancelled";
}
function line(value: unknown, limit: number): string {
  return truncateUtf8(typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ") : "", limit);
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/** Parse once at the wire boundary; never use display text as search state. */
export function parse(value: unknown): State | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = json.object(value),
    id = line(v.id, 128),
    revision = count(v.revision),
    found = count(v.found),
    scanned = count(v.scanned),
    total = count(v.total);
  let phase: Phase;
  switch (v.phase) {
    case "checking":
    case "indexing":
    case "searching":
    case "done":
    case "failed":
    case "cancelled":
      phase = v.phase;
      break;
    default:
      return null;
  }
  if (
    !id ||
    revision === null ||
    found === null ||
    scanned === null ||
    total === null ||
    scanned > total ||
    !Array.isArray(v.matches) ||
    v.matches.length > top_k
  )
    return null;
  const matches: Match[] = [];
  for (const value of v.matches) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = json.object(value),
      provider = Provider.parse(row.provider),
      session = line(row.session, 256);
    if (!provider || !session || typeof row.updated_at !== "number" || !Number.isFinite(row.updated_at)) return null;
    if (matches.some(m => m.provider === provider && m.session === session)) continue;
    matches.push({
      provider,
      session,
      account: line(row.account, 1024),
      cwd: line(row.cwd, 2048),
      title: line(row.title, 240),
      excerpt: line(row.excerpt, 320),
      updated_at: row.updated_at,
    });
  }
  if (matches.length > found) return null;
  return {
    id,
    revision,
    phase,
    expression: line(v.expression, 1024),
    workspace: line(v.workspace, 2048),
    found,
    scanned,
    total,
    limited: v.limited === true,
    matches,
    error: line(v.error, 320),
  };
}
export function entry(match: Match): Entry {
  return {
    ...match,
    title: match.title || "Untitled conversation",
    first: "",
    last: match.excerpt,
    branch: "",
    updated_at: match.updated_at / 1000,
    interrupted: false,
    starred: false,
  };
}
