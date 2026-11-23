// Matching lines for corgi grep: JavaScript regex, one line at a time, with grep's
// case, literal, word, line, context and count flags.

import type { Request } from "./protocol";

/** How case counts: as typed (-s), ignored (-i), or ignored unless a pattern has an uppercase letter (-S). */
type Case = Request<"conversation.grep">["case"];
/** What rg's -s/-i/-S, -F, -w and -x set. */
type Flags = {
  case: Case;
  /** Patterns are literal text. */
  fixed: boolean;
  /** Matches are whole words. */
  word: boolean;
  /** Matches are whole lines; wins over `word`. */
  line: boolean;
};
const plain: Flags = { case: "sensitive", fixed: false, word: false, line: false };
type Query = Flags & {
  patterns: string[];
  before: number;
  after: number;
  maxCount: number;
};
type Submatch = { start: number; end: number };
type Row<L> = { type: "match" | "context"; line: L; submatches: Submatch[] };

// Unicode word characters, so -w treats "café" as one word.
const word = "[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]";

const escape = (pattern: string) => pattern.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
/** Whether `query` ignores case: always, or with -S while its text has no capitals. */
function insensitive(query: Query): boolean {
  const text = query.fixed ? query.patterns.join("") : query.patterns.join("").replace(/\\(?:[pP]\{[^}]*\}|.)/gsu, "");
  return query.case === "insensitive" || (query.case === "smart" && !/\p{Lu}/u.test(text));
}

export function compile(query: Query): RegExp {
  const patterns = query.patterns.map(p => (query.fixed ? escape(p) : p));
  let source = patterns.map(p => `(?:${p})`).join("|");
  if (query.line) source = `^(?:${source})$`;
  else if (query.word) source = `(?<!${word})(?:${source})(?!${word})`;
  // Lines hold no newline, so . matches any character.
  try {
    return new RegExp(source, "gsu" + (insensitive(query) ? "i" : ""));
  } catch (error) {
    throw Error(
      `regex parse error: ${(error as Error).message}. Patterns are JavaScript regex: ` +
        "escape only regex syntax, or pass -F for literal text.",
    );
  }
}

function submatches(regex: RegExp, line: string): Submatch[] {
  const found: Submatch[] = [];
  regex.lastIndex = 0;
  for (let m; (m = regex.exec(line));) {
    found.push({
      start: Buffer.byteLength(line.slice(0, m.index)),
      end: Buffer.byteLength(line.slice(0, m.index + m[0].length)),
    });
    if (!m[0]) regex.lastIndex = m.index + (line.codePointAt(m.index)! > 0xffff ? 2 : 1);
  }
  return found;
}

/** Emits each match with its context, in order, until maxCount matches and
 * their trailing context. Lines hold no newline; callers number them. */
export async function scan<L extends { text: string }>(
  query: Query,
  regex: RegExp,
  lines: Iterable<L>,
  row: (row: Row<L>) => Promise<void>,
): Promise<void> {
  const before: L[] = [];
  let matched = 0,
    after = 0;
  for (const line of lines) {
    const found = matched < query.maxCount ? submatches(regex, line.text) : [];
    if (found.length) {
      for (const context of before) await row({ type: "context", line: context, submatches: [] });
      before.length = 0;
      await row({ type: "match", line, submatches: found });
      matched++;
      after = query.after;
    } else if (after > 0) {
      await row({ type: "context", line, submatches: [] });
      after--;
    } else if (matched >= query.maxCount) break;
    else if (query.before) {
      before.push(line);
      if (before.length > query.before) before.shift();
    }
  }
}

export { plain };
export type { Case, Flags, Query, Row };
