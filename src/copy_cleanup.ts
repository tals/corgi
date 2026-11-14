//! Cleans up text copied from a mouse selection: a command a harness wrapped
//! or continued with backslashes becomes one line, anything else loses the
//! indent its lines share, and a single line is trimmed.
import { displayWidth } from "./text";

/** A selection as the viewer saw it: its lines, the column of its first cell
 * in reading order, the width of the first row's leading whitespace, and the
 * pane's width. Indents count one column per space or tab; Ghostty shows a
 * tab as spaces, so on screen they are spaces. */
export interface Snapshot {
  lines: string[];
  start_x: number;
  first_indent: number;
  width: number;
}
export type Mode = "clean" | "dedent" | "raw";
export type Kind = "command" | "document" | "line" | "raw";
export interface Result {
  text: string;
  kind: Kind;
}
/** What the copy toast says cleanup did: joined a command onto one line,
 * removed a shared indent, or nothing worth saying. */
export type Note = "joined" | "dedented" | null;
/** The toast's note for `result`, cleaned up from `raw`. */
export function note(raw: string, result: Result): Note {
  if (result.text === raw) return null;
  if (result.kind === "command") return "joined";
  return result.kind === "document" ? "dedented" : null;
}
/** The "Copy cleanup" preference. */
export type CopyCleanup = "on_drag" | "with_modifier" | "off";
/** What asked for the copy: a plain drag or triple-click, a drag with Alt or
 * Ctrl held at the press, or a selection attached to a prompt with `@`. */
export type Trigger = "plain" | "modifier" | "mention";

export const values: readonly CopyCleanup[] = ["on_drag", "with_modifier", "off"];
export function parse(value: unknown): CopyCleanup | null {
  return values.find(pref => pref === value) ?? null;
}

/** Cells left of the pane's right edge where a harness stops its rows. 0 is
 * the smallest margin under which every command fixture counts as wrapped. */
export const wrap_margin = 0;
export function wrapColumn(width: number, margin = wrap_margin): number {
  return width - margin;
}

export function mode(pref: CopyCleanup, trigger: Trigger): Mode {
  if (trigger === "mention") return "dedent";
  switch (pref) {
    case "on_drag":
      return trigger === "plain" ? "clean" : "raw";
    case "with_modifier":
      return trigger === "modifier" ? "clean" : "raw";
    case "off":
      return "raw";
  }
}

export function clean(snapshot: Snapshot, mode: Mode): Result {
  const { lines } = snapshot;
  if (mode === "raw") return { text: lines.join("\n"), kind: "raw" };
  if (lines.length <= 1) {
    const line = (lines[0] ?? "").trim();
    return { text: mode === "clean" ? withoutPrompt(line) : line, kind: "line" };
  }
  const trimmed = lines.map(line => line.trimEnd());
  const shown = { ...snapshot, lines: trimmed };
  if (mode === "clean" && !isData(trimmed) && isCommand(shown)) return { text: flatten(shown), kind: "command" };
  return { text: dedent(shown).join("\n"), kind: "document" };
}

/** Each character of `line`, true inside a quoted span. A quote counts only
 * when the same quote closes it later on the line; a lone one, as in
 * "don't", is a plain character. */
export function quoted(line: string): boolean[] {
  const inside = new Array<boolean>(line.length).fill(false);
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if ((c !== '"' && c !== "'") || escaped(line, i)) continue;
    let end = i + 1;
    while (end < line.length && (line[end] !== c || (c === '"' && escaped(line, end)))) end++;
    if (end >= line.length) continue;
    inside.fill(true, i, end + 1);
    i = end;
  }
  return inside;
}
/** Whether an odd run of backslashes precedes `line[i]`. */
function escaped(line: string, i: number): boolean {
  let n = 0;
  while (i - n > 0 && line[i - n - 1] === "\\") n++;
  return n % 2 === 1;
}
/** `line` with its quoted spans blanked out, so their text never counts. */
function unquoted(line: string): string {
  const inside = quoted(line);
  let out = "";
  for (let i = 0; i < line.length; i++) out += inside[i] ? " " : line[i];
  return out;
}

const indent_re = /^[ \t]*/;
function indentOf(line: string): string {
  return indent_re.exec(line)![0];
}
/** Columns of leading whitespace in `line`, a tab counting as one. */
export function indentWidth(line: string): number {
  return indentOf(line).length;
}
/** A selection whose start isn't known, so its first line counts from
 * column 0. */
export function fromColumnZero(lines: string[], width: number): Snapshot {
  return { lines, start_x: 0, first_indent: indentWidth(lines[0] ?? ""), width };
}
const blank = (line: string): boolean => line.trim() === "";

/** Whether any line looks like data: a `key:` mapping, a `- item`, a
 * `#` line, or a bracket the selection leaves open. Quoted text never
 * counts. */
export function isData(lines: string[]): boolean {
  const open = { "(": 0, "[": 0, "{": 0 };
  const closer: Record<string, keyof typeof open> = { ")": "(", "]": "[", "}": "{" };
  for (const line of lines) {
    const lead = line.trimStart();
    if (/^-(\s|$)/.test(lead) || lead.startsWith("#") || isMapping(lead)) return true;
    for (const c of unquoted(line)) {
      if (c in open) open[c as keyof typeof open]++;
      else if (c in closer) open[closer[c]] = Math.max(0, open[closer[c]] - 1);
    }
  }
  return open["("] > 0 || open["["] > 0 || open["{"] > 0;
}
/** `key: value` or `key:`, after an optional `- `; a quoted key counts, a
 * colon inside quotes doesn't. */
function isMapping(text: string): boolean {
  const rest = text.startsWith("- ") ? text.slice(2).trimStart() : text;
  const key = /^("[^"]*"|'[^']*'|[^\s:"']+)/.exec(rest);
  if (!key) return false;
  const after = rest.slice(key[0].length);
  return after === ":" || after.startsWith(": ") || after.startsWith(":\t");
}

/** Where row `i` ends on screen, or null for a line wider than the pane:
 * the terminal soft-wrapped it, so no harness wrapped it at this width. */
function rowEnd(s: Snapshot, i: number): number | null {
  const end = (i === 0 ? s.start_x : 0) + displayWidth(s.lines[i]);
  return end > s.width ? null : end;
}
function firstWord(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}
/** Whether the break after row `i` is one a harness made: the next line's
 * first word would not have fit after the row, with a space, before the
 * wrap column. A word wider than a row never fits anywhere, so a harness
 * splits it rather than moving it down whole. */
export function isWrap(s: Snapshot, i: number, margin = wrap_margin): boolean {
  const end = rowEnd(s, i);
  const next = s.lines[i + 1];
  const word = displayWidth(firstWord(next));
  const column = wrapColumn(s.width, margin);
  if (end === null || indentWidth(next) + word > column) return false;
  return end + 1 + word > column;
}

/** Whether `line` ends in a backslash continuation; an escaped backslash
 * doesn't continue it. */
const continued = (line: string): boolean => line.endsWith("\\") && !escaped(line, line.length - 1);
function withoutPrompt(line: string): string {
  return line.startsWith("$ ") ? line.slice(2).trimStart() : line;
}
const signals: readonly RegExp[] = [
  /^-[A-Za-z-]/, // a flag
  /^(\/|\.\/|\.\.\/|~\/)/, // a path
  /^(>>?|<|2>|&>)/, // a redirect
];
function isCommand(s: Snapshot): boolean {
  const { lines } = s;
  const breaks = lines.slice(1).map((_, i) => i);
  if (lines.some(continued) && breaks.every(i => continued(lines[i]) || isWrap(s, i))) return true;
  if (lines.length > 3 || !breaks.every(i => isWrap(s, i))) return false;
  const first = lines[0].trimStart();
  const prompt = first.startsWith("$ ");
  if (!/^[A-Za-z0-9._\-/~]+$/.test(firstWord(withoutPrompt(first)))) return false;
  if (prompt) return true;
  return lines.some(line => {
    const text = unquoted(line);
    if (/\||&&/.test(text)) return true;
    return text.split(/\s+/).some(token => signals.some(signal => signal.test(token)));
  });
}

/** The command on one line: indents, a `$ ` prompt and backslash
 * continuations go, and rows join with a space, or with none inside a path
 * or URL the harness split. */
function flatten(s: Snapshot): string {
  let out = "";
  // The token a split carried onto this row, if any.
  let carry = "";
  s.lines.forEach((raw, i) => {
    let line = raw.trim();
    if (i === 0) line = withoutPrompt(line);
    const backslash = continued(line);
    if (backslash) line = line.slice(0, -1).trimEnd();
    if (line === "") {
      carry = "";
      return;
    }
    out += line;
    if (i === s.lines.length - 1) return;
    const words = line.split(/\s+/);
    const token = (words.length === 1 ? carry : "") + words[words.length - 1];
    carry = !backslash && splits(s, i, token) ? token : "";
    if (!carry) out += " ";
  });
  return out.trimEnd();
}
/** Whether row `i` ends inside `token`, a word the harness split at the
 * edge: the row reaches the wrap column, the next row goes on with neither a
 * flag, a shell operator nor a new path (`~/`, `./`, `../`, or `/` after a
 * `/` outside a scheme), and the token rejoined is wider than
 * a row, since a harness moves a word that fits down whole. */
function splits(s: Snapshot, i: number, token: string): boolean {
  const end = rowEnd(s, i);
  if (end === null || end < wrapColumn(s.width)) return false;
  const next = s.lines[i + 1];
  const word = firstWord(next);
  if (/^(-|\||&&|;|>|<|2>|&>)/.test(word)) return false;
  // A relative or home path never goes on from a split word.
  if (/^(~\/|\.\/|\.\.\/)/.test(word)) return false;
  // Two slashes meet only in a scheme, as in `https:/` + `/host`.
  if (token.endsWith("/") && word.startsWith("/") && !token.endsWith(":/") && !token.endsWith("://")) return false;
  return displayWidth(token + word) > wrapColumn(s.width) - indentWidth(next);
}

/** The lines without the indent they share, trailing whitespace removed.
 * The first line's indent counts from column 0, where its row starts on
 * screen; a first line selected from mid-line keeps out of the count and
 * loses its leading whitespace. Blank lines stay and don't count. Each
 * space or tab is one indent column. */
function dedent(s: Snapshot): string[] {
  const { lines, start_x, first_indent } = s;
  const middle = start_x > first_indent;
  let shared: string | null = null;
  for (const line of lines.slice(1)) {
    if (blank(line)) continue;
    const indent = indentOf(line);
    shared = shared === null ? indent : commonPrefix(shared, indent);
  }
  // Columns of the first row's indent before `start_x` weren't selected,
  // so only the selected part can disagree with the rest.
  let width = shared?.length ?? first_indent;
  if (!middle && !blank(lines[0])) {
    const seen = indentOf(lines[0]);
    width = Math.min(width, first_indent);
    if (shared !== null)
      for (let col = start_x; col < width; col++) {
        if (seen[col - start_x] === shared[col]) continue;
        width = col;
        break;
      }
  }
  if (shared === null && (middle || blank(lines[0]))) width = 0;
  return lines.map((line, i) => {
    if (i > 0) return blank(line) ? "" : line.slice(width);
    if (middle) return line.trimStart();
    return line.slice(Math.max(0, width - start_x));
  });
}
function commonPrefix(a: string, b: string): string {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}
