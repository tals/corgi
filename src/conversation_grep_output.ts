import * as path from "node:path";
import type { Tool } from "./providers/search_tools";

export type Hit = {
  line: number;
  seq: number;
  text: string;
  context: boolean;
  role: string;
  timestamp: number | null;
  ref: string;
  message_line: number;
  submatches: { start: number; end: number }[];
  lane?: "text" | "tools";
  tool?: Tool;
};
export type Match = {
  source: {
    provider: string;
    account?: string;
    session: string;
    cwd: string;
    updated_at: number;
    title?: string;
    /** The transcript. */
    source?: string;
    /** Its cached copy, one JSON message per line. */
    cache?: string;
  };
  hits: Hit[];
  matching_count?: number;
  count_limited?: boolean;
};
export type Options = {
  workspace: string;
  json: boolean;
  onlyMatching: boolean;
  list: boolean;
  count: boolean;
  maxLineChars: number;
  maxOutputChars: number;
  fullLines: boolean;
};

type DisplayHit = Omit<Hit, "submatches" | "seq"> & {
  submatches?: Hit["submatches"];
  seq?: number;
  clipped?: boolean;
};

// Hits carry rg's UTF-8 byte offsets; convert them before slicing JavaScript strings.
function ranges(hit: Hit): { start: number; end: number }[] {
  const bytes = Buffer.from(hit.text);
  return hit.submatches.map(({ start, end }) => ({
    start: bytes.subarray(0, start).toString().length,
    end: bytes.subarray(0, end).toString().length,
  }));
}

function safe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, c => {
    if (c === "\t") return "\\t";
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function clip(hit: Hit, limit: number): { text: string; clipped: boolean } {
  const text = hit.text;
  if (limit <= 0 || text.length <= limit) return { text, clipped: false };
  const matches = hit.context ? [] : ranges(hit);
  if (!matches.length) return { text: text.slice(0, Math.max(0, limit - 1)) + "…", clipped: true };
  // Divide the budget among distant matches, merging overlapping windows.
  const size = Math.max(1, Math.floor((limit - matches.length - 1) / matches.length));
  const makeWindows = (extend: boolean) => {
    const windows: { start: number; end: number }[] = [];
    for (const match of matches) {
      const width = size;
      let start = Math.max(0, Math.floor((match.start + match.end - width) / 2));
      let end = Math.min(text.length, start + width);
      start = Math.max(0, end - width);
      // Avoid splitting a short URL or branch name at the edge when space allows.
      while (extend && start > 0 && /[\w/.:@-]/.test(text[start - 1]) && end - start < size + 24) start--;
      while (extend && end < text.length && /[\w/.:@-]/.test(text[end]) && end - start < size + 24) end++;
      const previous = windows.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else windows.push({ start, end });
    }
    let result = "";
    for (const [i, window] of windows.entries()) {
      if (window.start > (i ? windows[i - 1]!.end : 0)) result += "…";
      result += text.slice(window.start, window.end);
    }
    if (windows.at(-1)!.end < text.length) result += "…";
    return result;
  };
  const extended = makeWindows(true);
  const result = extended.length <= limit ? extended : makeWindows(false);
  return { text: result.length <= limit ? result : result.slice(0, Math.max(0, limit - 1)) + "…", clipped: true };
}

function header(source: Match["source"], workspace: string): string {
  const date = Number.isFinite(source.updated_at) ? new Date(source.updated_at).toISOString().slice(0, 10) : "?";
  // A worktree outside the workspace's folder shows in full.
  const relative = workspace === "*" ? source.cwd : path.relative(workspace, source.cwd) || ".",
    cwd = relative.startsWith("..") ? source.cwd : relative;
  return `${safe(source.provider)}:${safe(source.session)}  ${date}  ${safe(cwd)}${source.cache ? "  " + safe(source.cache) : ""}`;
}

export type Rendered = { truncated: boolean; clipped_lines: number; shown_conversations: number };

/** Renders conversations one at a time within one output budget, so each
 * can be printed as soon as it's found. */
export function renderer(options: Options): {
  /** Adds a conversation; false once the budget is spent. */
  add(match: Match): boolean;
  /** Text added since the last call. */
  take(): string;
  stats(): Rendered;
} {
  let pending = "",
    length = 0,
    truncated = false,
    clipped_lines = 0,
    shown_conversations = 0;
  const cap = options.maxOutputChars > 0 ? options.maxOutputChars : Infinity;
  const append = (line: string): boolean => {
    if (length + line.length + 1 > cap) return false;
    pending += line + "\n";
    length += line.length + 1;
    return true;
  };
  function add(match: Match): boolean {
    if (truncated) return false;
    const label = header(match.source, options.workspace);
    const count = match.matching_count ?? match.hits.filter(hit => !hit.context).length;
    const countLabel = `${match.count_limited ? "at least " : ""}${count}`;
    if (options.list || options.count) {
      const line = options.json
        ? JSON.stringify({
            source: match.source,
            ...(options.count ? { count, count_limited: !!match.count_limited } : {}),
          })
        : label + (options.count ? `: ${countLabel}` : "");
      if (!append(line)) {
        truncated = true;
        return false;
      }
      shown_conversations++;
      return true;
    }
    const display: DisplayHit[] = [];
    for (const hit of match.hits) {
      if (options.onlyMatching && hit.context) continue;
      // As in rg, -o prints no empty matches.
      const values = options.onlyMatching
        ? ranges(hit)
            .map(range => hit.text.slice(range.start, range.end))
            .filter(Boolean)
        : [hit.text];
      for (const value of values) {
        const result =
          options.onlyMatching || options.fullLines ? { text: value, clipped: false } : clip(hit, options.maxLineChars);
        if (!options.json) result.text = safe(result.text);
        if (result.clipped) clipped_lines++;
        const item: DisplayHit = { ...hit, text: result.text };
        if (result.clipped || options.onlyMatching || result.text !== hit.text) delete item.submatches;
        if (options.json) delete item.seq;
        if (result.clipped) item.clipped = true;
        display.push(item);
      }
    }
    if (!display.length) return true;
    if (options.json) {
      // Each JSONL record is complete even when the budget ends mid-conversation.
      let shown = false;
      for (const hit of display) {
        let item = hit;
        let line = JSON.stringify({ source: match.source, hits: [item] });
        if (length + line.length + 1 > cap) {
          let lo = 0,
            hi = item.text.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const candidate = { ...item, text: item.text.slice(0, mid) + "…", clipped: true, submatches: undefined };
            if (length + JSON.stringify({ source: match.source, hits: [candidate] }).length + 1 <= cap) lo = mid;
            else hi = mid - 1;
          }
          item = { ...item, text: item.text.slice(0, lo) + "…", clipped: true, submatches: undefined };
          line = JSON.stringify({ source: match.source, hits: [item] });
          if (append(line)) {
            if (!hit.clipped) clipped_lines++;
            shown = true;
          }
          if (shown) shown_conversations++;
          truncated = true;
          return false;
        }
        append(line);
        shown = true;
      }
      if (shown) shown_conversations++;
      return true;
    }
    if (!append(label)) {
      truncated = true;
      return false;
    }
    shown_conversations++;
    let previous: DisplayHit | undefined;
    for (const hit of display) {
      if (previous && (hit.lane !== previous.lane || hit.seq! > previous.seq! + 1) && !append("--")) {
        truncated = true;
        return false;
      }
      const separator = hit.context ? "-" : ":";
      const tool = hit.tool,
        status = tool
          ? `[${[tool.kind, tool.name, tool.exit_code !== null ? `exit=${tool.exit_code}` : (tool.status ?? "status=unrecorded"), tool.exit_code !== null && (tool.status === "interrupted" || (tool.exit_code === 0 && tool.status === "error")) ? tool.status : ""].filter(Boolean).join(" ")}] `
          : "";
      // Line N of the cache file holds the message; N.L is line L of its text.
      const position = hit.message_line > 1 ? `${hit.line}.${hit.message_line}` : `${hit.line}`;
      const prefix = `${hit.lane === "tools" ? "T" : ""}${position}${separator}${safe(hit.role)}${separator}${safe(status)}`;
      const line = prefix + hit.text;
      if (!append(line)) {
        const room = cap - length - prefix.length - 2;
        if (room >= 0 && append(prefix + hit.text.slice(0, room) + "…") && !hit.clipped) clipped_lines++;
        truncated = true;
        return false;
      }
      previous = hit;
    }
    return true;
  }
  return {
    add,
    take() {
      const text = pending;
      pending = "";
      return text;
    },
    stats: () => ({ truncated, clipped_lines, shown_conversations }),
  };
}

export function render(matches: Match[], options: Options): Rendered & { text: string } {
  const output = renderer(options);
  for (const match of matches) if (!output.add(match)) break;
  return { text: output.take(), ...output.stats() };
}
