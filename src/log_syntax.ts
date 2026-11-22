//! Colors for a log line: its time, its level, `key=value` pairs, quoted
//! strings and numbers. Levels take the UI's status colors, which mean the
//! same thing there; the rest take the code colors.
import type { Kind as CodeKind } from "./review/syntax";

export type Level = "error" | "warn" | "info" | "debug";
export type Kind = CodeKind | Level;
/** `[start, end)` of a line colored as `kind`. */
export type Span = [number, number, Kind];

const levels: Record<string, Level> = {
  fatal: "error",
  panic: "error",
  crit: "error",
  critical: "error",
  error: "error",
  err: "error",
  eror: "error",
  alert: "error",
  emerg: "error",
  warn: "warn",
  warning: "warn",
  wrn: "warn",
  info: "info",
  inf: "info",
  notice: "info",
  debug: "debug",
  dbg: "debug",
  trace: "debug",
  trc: "debug",
  verbose: "debug",
};
/** Only this much of a line is searched for its time and level. */
const head = 96;
const time =
  /^\[?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?|[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2})\]?/;
// A level stands alone, in brackets, or as a level field's value.
const level =
  /(?:^|[\s[("'|])(?:level[=:]\s*"?)?(FATAL|PANIC|CRIT(?:ICAL)?|ERROR|ERR|EROR|ALERT|EMERG|WARN(?:ING)?|WRN|INFO|INF|NOTICE|DEBUG|DBG|TRACE|TRC|VERBOSE|fatal|panic|critical|error|warn(?:ing)?|info|notice|debug|trace)(?=[\s\]):"'|]|$)/;
// A word is taken whole, a key when `=` follows it, so a long one is scanned once.
const token =
  /([A-Za-z_][\w.-]*)(=?)|"(?:[^"\\]|\\.)*"?|(?<!\w)'(?:[^'\\]|\\.)*'|-?\b\d+(?:\.\d+)?(?:(?:ms|us|µs|ns|s|m|h|[KMGT]i?B|[kKMG]B)\b|%)?/g;

/** The colored runs of `line`, in order and apart. */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  const lead = line.length - line.trimStart().length;
  const stamp = time.exec(line.slice(lead));
  if (stamp) {
    out.push([lead, lead + stamp[0].length, "comment"]);
    at = lead + stamp[0].length;
  }
  const found = level.exec(line.slice(at, head));
  let level_at = -1,
    level_end = -1;
  if (found) {
    level_end = at + found.index + found[0].length;
    level_at = level_end - found[1].length;
  }
  token.lastIndex = at;
  for (let m = token.exec(line); m !== null; m = token.exec(line)) {
    const start = m.index,
      end = start + m[0].length;
    // A plain word.
    if (m[1] && !m[2]) continue;
    if (level_at >= 0 && start >= level_at && start < level_end) continue;
    if (level_at >= start && level_at < end) {
      // The level sits inside this run, as `level=error`: color its key alone.
      if (m[1]) out.push([start, start + m[1].length, "property"]);
      continue;
    }
    if (m[1]) out.push([start, start + m[1].length, "property"]);
    else out.push([start, end, m[0][0] === '"' || m[0][0] === "'" ? "string" : "number"]);
  }
  if (level_at >= 0) out.push([level_at, level_end, levels[found![1].toLowerCase()] ?? "info"]);
  return out.sort((a, b) => a[0] - b[0]);
}
/** The line's level, when it names one near its start. */
export function levelOf(line: string): Level | null {
  for (const span of spans(line))
    if (span[2] === "error" || span[2] === "warn" || span[2] === "info" || span[2] === "debug") return span[2];
  return null;
}
