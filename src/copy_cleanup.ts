//! Cleans up text copied from a mouse selection: a command a harness wrapped,
//! or continued with backslashes or operators, becomes one line, anything
//! else loses the indent its lines share, and a single line is trimmed.
//! Lines the terminal wrapped arrive joined.
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
 * or nothing worth saying. */
export type Note = "joined" | null;
/** The toast's note for `result`, cleaned up from `raw`. */
export function note(raw: string, result: Result): Note {
  return result.kind === "command" && result.text !== raw ? "joined" : null;
}
/** What asked for the copy: a plain drag or triple-click, a drag with Alt or
 * Ctrl held at the press, or a selection attached to a prompt with `@`. */
export type Trigger = "plain" | "modifier" | "mention";

/** Cells left of the pane's right edge where a harness stops its rows. 0 is
 * the smallest margin under which every command fixture counts as wrapped. */
export const wrap_margin = 0;
export function wrapColumn(width: number, margin = wrap_margin): number {
  return width - margin;
}

/** How a copy is cleaned up: Smart Copy cleans up a plain drag, never one
 * with Alt or Ctrl held at the press; a mention is always only dedented. */
export function mode(smart_copy: boolean, trigger: Trigger): Mode {
  switch (trigger) {
    case "mention":
      return "dedent";
    case "plain":
      return smart_copy ? "clean" : "raw";
    case "modifier":
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

/** For each row, whether its trailing backslash continues it onto the next
 * selected row, as a shell reads it: not escaped, not inside single quotes,
 * where backslash and newline stay literal, and not on the last row, whose
 * newline the selection doesn't hold. Quotes carry across rows. */
export function continuations(lines: readonly string[]): boolean[] {
  let quote: "'" | '"' | null = null;
  return lines.map((line, row) => {
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote === "'") {
        if (c === "'") quote = null;
      } else if (c === "\\") i++;
      else if (quote === '"') {
        if (c === '"') quote = null;
      } else if (c === "'" || c === '"') quote = c;
    }
    return row < lines.length - 1 && quote !== "'" && line.endsWith("\\") && !escaped(line, line.length - 1);
  });
}
/** `line` without a `$ ` prompt, when a command follows it. */
function withoutPrompt(line: string): string {
  const rest = /^\$\s+(.*)$/.exec(line)?.[1];
  return rest !== undefined && isPromptCommand(rest) ? rest : line;
}

// Whether text is a command follows Trimmy
// (https://github.com/steipete/Trimmy), which judges the text alone; the
// pane's rows then say which breaks a harness made.

/** Commands a line starts with: Trimmy's, and a few it lacks. */
const known_commands = new Set([
  ...["sudo", "apt", "brew", "git", "python", "pip", "pnpm", "npm", "yarn", "cargo", "bundle", "rails", "go"],
  ...["make", "xcodebuild", "swift", "kubectl", "docker", "podman", "aws", "gcloud", "az", "ls", "cd", "cat"],
  ...["echo", "env", "export", "open", "node", "java", "ruby", "perl", "bash", "zsh", "fish", "pwsh", "sh"],
  ...["rm", "cp", "mv", "mkdir", "curl", "wget", "ssh", "bun", "npx", "gh", "grep", "rg", "find", "tar", "chmod"],
]);
/** Known commands that start prose too, as in "open the door". */
const everyday_commands = new Set([
  ...["go", "sh", "cat", "open", "make", "cd", "ls", "az", "java", "echo", "env", "export", "node", "fish"],
  ...["brew", "bundle", "find"],
]);
/** Second words that make a line led by an everyday command prose. */
const prose_second_words = new Set([
  ...["a", "an", "the", "my", "your", "our", "their", "this", "that", "these", "those", "we", "to", "now"],
  ...["home", "videos", "video", "me"],
]);
/** Whether `word` names a known command, perhaps versioned as in `python3`. */
function isCommandWord(word: string): boolean {
  return known_commands.has(word.replace(/\d[\d.]*$/, ""));
}
/** Whether `text` ends like a sentence, with one of `marks`, rather than
 * on a `.` or `..` path as in `docker build .`. */
function endsSentence(text: string, marks = /[.?!]$/): boolean {
  return marks.test(text) && !/(^|\s)\.\.?$/.test(text);
}
/** Whether a line starts like a command: a word of command characters,
 * perhaps after `sudo`, with no full stop ending the line. */
function isCommandLine(line: string): boolean {
  const text = line.trim();
  if (text === "" || endsSentence(text, /\.$/)) return false;
  return text.startsWith("[[") || /^(sudo\s+)?[A-Za-z0-9./~_-]+(\s|$)/.test(text);
}
/** Whether what follows a `$ ` is a command rather than a price or a
 * sentence. */
function isPromptCommand(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || endsSentence(trimmed)) return false;
  const punctuated = /[-./~$0-9]/.test(trimmed);
  return (punctuated || isCommandWord(firstWord(trimmed).toLowerCase())) && isCommandLine(trimmed);
}
/** Whether some row starts with a known command, an everyday one only
 * where it doesn't read as prose. Unlike Trimmy, the first row gets the
 * prose test too: a harness wraps "make sure the build is green" as well. */
function startsWithKnownCommand(rows: readonly string[]): boolean {
  return rows.some(row => {
    const word = firstWord(row);
    if (word.startsWith("./") || word.startsWith("~/")) return true;
    const lower = word.toLowerCase();
    if (!isCommandWord(lower)) return false;
    if (!everyday_commands.has(lower)) return true;
    const words = row.trim().split(/\s+/);
    return words.length < 4 && !prose_second_words.has(words[1]?.toLowerCase() ?? "");
  });
}
const command_punctuation: readonly RegExp[] = [
  /@/,
  /(^|\s)--[A-Za-z0-9][A-Za-z0-9_-]*/m,
  /(^|\s)-[A-Za-z](\s|$)/m,
  /\b[A-Za-z_][A-Za-z0-9_]*=/,
  /(^|\s)(\.\/|~\/|\/)/m,
  /(^|\s)\.[A-Za-z0-9_-]+/m,
  /[<>]/,
];
const code_keyword =
  /^\s*(import|package|namespace|using|template|class|struct|enum|extension|protocol|interface|func|def|fn|let|var|public|private|internal|open|protected|if|for|while)\b/m;
/** Whether text has braces and a declaration or control keyword. */
function isSourceCode(text: string): boolean {
  return (/[{}]/.test(text) || text.toLowerCase().includes("begin")) && code_keyword.test(text);
}
/** Whether most rows are bullets, numbered items or bare words. */
function isList(rows: readonly string[]): boolean {
  const filled = rows.filter(row => !blank(row));
  if (filled.length < 2) return false;
  const items = filled.filter(row => /^([-*•]\s+\S|[0-9]+[.)]\s+\S|[A-Za-z0-9]{4,}$)/.test(row.trim()));
  return items.length > filled.length / 2;
}
/** Whether a command's later rows go on indented, or with an operator or
 * a flag. */
function continuesIndented(rows: readonly string[]): boolean {
  if (rows.length < 2 || !isCommandLine(rows[0])) return false;
  let indented = false;
  for (const row of rows.slice(1)) {
    if (blank(row)) continue;
    if (/^\s/.test(row)) indented = true;
    else if (!/^(\||&&|;|>|2>|<|-)/.test(row)) return false;
  }
  return indented;
}
/** Whether `rows`, without the indent they share, read as a shell command,
 * scored as Trimmy scores them at its normal setting, with flags as one
 * more signal. */
function looksLikeCommand(rows: readonly string[]): boolean {
  const text = rows.join("\n");
  const continuation = text.includes("\\\n");
  const joiner = /[|&]/.test(text);
  const prompt = /(^|\n)\s*\$/.test(text);
  const path = /[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+/.test(text);
  const strong = continuation || joiner || prompt || path;
  if (!strong && !startsWithKnownCommand(rows) && !command_punctuation.some(re => re.test(text))) return false;
  if (!strong && isSourceCode(text)) return false;
  const signals = [
    continuation,
    joiner,
    prompt,
    continuesIndented(rows),
    rows.filter(row => !blank(row)).every(isCommandLine),
    /^\s*(sudo\s+)?[A-Za-z0-9./~_-]+/m.test(text),
    path,
    /(^|\s)--?[A-Za-z]/m.test(text),
  ];
  return signals.filter(Boolean).length >= 2;
}

/** Rows a command a harness wrapped may span; Trimmy's limit. Backslash
 * continuations may run to `max_continued_rows`. */
const max_wrapped_rows = 4;
const max_continued_rows = 10;
/** Whether the selection is one command: every row break goes on with it,
 * and its text reads as one. */
function isCommand(s: Snapshot): boolean {
  const { lines } = s;
  const continues = continuations(lines);
  const limit = continues.some(Boolean) ? max_continued_rows : max_wrapped_rows;
  if (lines.length > limit) return false;
  const own = dedent(s);
  // The token a split carried onto this row, if any.
  let carry = "";
  for (let i = 0; i + 1 < lines.length; i++) {
    const words = own[i].trim().split(/\s+/);
    const token = (words.length === 1 ? carry : "") + words[words.length - 1];
    const split = splits(s, i, token);
    if (!joins(s, own, continues, i, split)) return false;
    carry = split ? token : "";
  }
  return !isList(own) && looksLikeCommand(own);
}
/** Whether `row` ends in `|`, `&&` or `;` outside quotes, and unescaped:
 * `find … -exec rm {} \;` ends in text. */
function endsWithOperator(row: string): boolean {
  const text = unquoted(row).trimEnd();
  const operator = /(\||&&|;)$/.exec(text);
  return operator !== null && !escaped(text, operator.index);
}
/** Whether the break after row `i` goes on with the same command: a
 * backslash, or `|`, `&&` or `;` ending the row, as a shell reads them; a
 * pipe opening the next row after a command or a pipe; or a harness wrap, unless the
 * next row starts a command of its own rather than the rest of a `split`
 * word. */
function joins(s: Snapshot, own: readonly string[], continues: readonly boolean[], i: number, split: boolean): boolean {
  if (continues[i] || endsWithOperator(own[i])) return true;
  const next = own[i + 1].trimStart();
  const row = withoutPrompt(own[i].trimStart());
  if (/^(\||&&)/.test(next) && (isCommandLine(row) || /^(\||&&)/.test(row))) return true;
  return isWrap(s, i) && (split || !(isCommandWord(firstWord(next)) || /^\$\s/.test(next)));
}

/** The command on one line: indents, a `$ ` prompt and backslash
 * continuations go, and rows join with a space, or with none inside a word
 * the harness split or a backslash continued, as a shell would read it. */
function flatten(s: Snapshot): string {
  // Each row without the indent the rows share, so a continuation's own
  // indent still shows.
  const own = dedent(s);
  const continues = continuations(s.lines);
  let out = "";
  // The token a split carried onto this row, if any.
  let carry = "";
  s.lines.forEach((raw, i) => {
    let line = raw.trim();
    if (i === 0) line = withoutPrompt(line);
    const backslash = continues[i];
    // A shell deletes backslash-newline, so a word goes on unless whitespace
    // stood before the backslash or starts the next row.
    let tight = false;
    if (backslash) {
      const body = line.slice(0, -1);
      const next = own[i + 1] ?? "";
      tight = body !== "" && !/\s$/.test(body) && next !== "" && !/^\s/.test(next);
      line = body.trimEnd();
    }
    if (line === "") {
      carry = "";
      return;
    }
    out += line;
    if (i === s.lines.length - 1) return;
    const words = line.split(/\s+/);
    const token = (words.length === 1 ? carry : "") + words[words.length - 1];
    const joined = backslash ? tight : splits(s, i, token);
    carry = !backslash && joined ? token : "";
    if (!joined) out += " ";
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
  // A flag is `-` and a letter or a second `-`; `-0123…` can go on a URL.
  if (/^(-[A-Za-z-]|\||&&|;|>|<|2>|&>)/.test(word)) return false;
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
