//! Recover one target from the original cells around a pointer. The daemon
//! that owns the pane has both the conversation's spellings and its files.
import * as evidence from "./link_evidence";
import * as fileRef from "./file_ref";
import type { Files } from "./file_access";

export interface Span {
  row: number;
  start: number;
  end: number;
}
export interface Target {
  uri: string;
  path: boolean;
  spans: Span[];
  file: string | null;
}
export interface Row {
  row: number;
  wrap: boolean;
  continued?: boolean;
  line?: string | null;
  cells: string[];
}

/** Rendered Markdown may show the code span's words without its backticks.
 * Only an exact transcript spelling can turn such a phrase into a file lookup. */
function renderedHint(text: string): boolean {
  return /\/|\.[A-Za-z0-9_]{1,16}\b|\b[A-Z][\p{L}\p{N}_-]* +[A-Z]|\b[A-Z][A-Za-z]*file\b|\b[A-Z]{3}/u.test(text);
}

/** The sentence period may be the first cell after a soft wrap. */
function withPeriod(text: string, next?: string): string {
  return next?.startsWith(".") ? text + next.slice(0, 2) : text;
}

/** A TUI can render inline code in its own style and omit the backticks. */
function styledNames(line: string, indent: number, next?: string): evidence.Token[] {
  const styles = [...line.matchAll(/\x1b\[0;[0-9;:]+m/g)];
  if (styles.length < 2) return [];
  const names: evidence.Token[] = [];
  const visible = withPeriod(Bun.stripANSI(line), next);
  let offset = Bun.stripANSI(line.slice(0, styles[0].index)).length - indent;
  for (const [i, style] of styles.entries()) {
    const part = Bun.stripANSI(line.slice(style.index + style[0].length, styles[i + 1]?.index));
    const trimmed = part.trim(),
      start = offset + part.length - part.trimStart().length,
      single = !trimmed.includes(" "),
      uri = single && trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
    if (
      uri.length <= 1024 &&
      (!single || evidence.nameBeforePeriod(uri, visible, indent + start + uri.length)) &&
      /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic} /._@~#()'&=+\[\]-]+$/u.test(uri)
    )
      names.push({ uri, start, end: start + uri.length, path: true });
    offset += part.length;
  }
  return names;
}

function* screenTokens(
  text: string,
  phrases: boolean,
  firstEnd: number,
  lastStart: number,
  pairs: ReadonlyMap<number, number>,
  offset: number,
  styled?: evidence.Token[],
  next?: string,
) {
  const source = text.endsWith("`") ? withPeriod(text, next) : text;
  for (const token of evidence.tokens(source, pairs, offset))
    if (token.end <= text.length) yield { token, phrase: false };
  for (const token of styled ?? []) {
    if (text.slice(token.start, token.end) === token.uri) yield { token, phrase: true };
  }
  if (!phrases || !renderedHint(text)) return;
  const words = /[\p{L}\p{M}\p{N}\p{Extended_Pictographic}_./@~#()'&=+\[\]-]+/gu;
  const recent: number[] = [];
  let end = 0;
  for (const word of text.matchAll(words)) {
    const start = word.index;
    if (recent.length && !/^ +$/.test(text.slice(end, start))) recent.length = 0;
    recent.push(start);
    if (recent.length > 8) recent.shift();
    if (recent[0] >= firstEnd) break;
    end = start + word[0].length;
    if (end <= lastStart) continue;
    const finish = end - (word[0].match(/[.,]+$/)?.[0].length ?? 0);
    if (finish <= start) continue;
    for (const from of recent) {
      if (from >= firstEnd || finish - from > 1024) continue;
      const uri = text.slice(from, finish);
      // Bare ordinary words and sentences don't trigger transcript lookups.
      if (from === start ? !/^(?:[A-Z][A-Za-z]*file|[A-Z][A-Z0-9_-]{2,})$/.test(uri) : !renderedHint(uri)) continue;
      yield { token: { uri, start: from, end: finish, path: true } as evidence.Token, phrase: true };
    }
  }
}

function* windows(parts: string[], anchor: number, phrases: boolean, styled: evidence.Token[], wraps?: boolean[]) {
  if (!parts[anchor]?.trim()) return;
  let top = anchor,
    bottom = anchor;
  while (top > 0 && parts[top - 1].trim()) top--;
  while (bottom + 1 < parts.length && parts[bottom + 1].trim()) bottom++;
  if (!styled.length && !parts.slice(top, bottom + 1).some(r => /[/.#:(`"]/.test(r) || (phrases && /[A-Z]/.test(r))))
    return;
  let joined = "",
    paragraph = "";
  const starts: number[] = [],
    wordStarts: number[] = [];
  for (let row = top; row <= bottom; row++) {
    if (row > top && !wraps?.[row - 1]) paragraph += "\n";
    starts[row] = joined.length;
    wordStarts[row] = paragraph.length;
    joined += parts[row];
    paragraph += parts[row];
  }
  // Pair delimiters once with the real paragraph breaks. Translate their positions
  // for the spelling that removes breaks; inserting spaces keeps offsets unchanged.
  const pairs = evidence.codePairs(paragraph);
  const joinedAt = (pos: number) => {
    const row = wordStarts.findLastIndex(start => start <= pos);
    return pos - wordStarts[row] + starts[row];
  };
  const joinedPairs = new Map<number, number>();
  for (const [open, close] of pairs) {
    const begin = joinedAt(open),
      end = joinedAt(close);
    // Removing a break between backticks can create an earlier closing delimiter.
    if (/[`\\]\n`/.test(paragraph.slice(open, close + 1))) {
      const run = paragraph.slice(open).match(/^`+/)![0];
      if (evidence.codePairs(joined.slice(begin, end + run.length)).get(0) !== end - begin) continue;
    }
    joinedPairs.set(begin, end);
  }
  const forms = [{ text: joined, starts, pairs: joinedPairs, spaced: false }];
  if (paragraph.length !== joined.length)
    forms.push({ text: paragraph.replaceAll("\n", " "), starts: wordStarts, pairs, spaced: true });
  for (let first = anchor; first >= Math.max(top, anchor - 7); first--) {
    for (let last = anchor; last <= Math.min(bottom, first + 7); last++) {
      for (const form of forms) {
        const base = form.starts[first],
          text = form.text.slice(base, form.starts[last] + parts[last].length);
        const spaced = form.spaced;
        if (
          spaced &&
          (form.starts[last] - base === starts[last] - starts[first] ||
            !(text.includes("`") || (phrases && renderedHint(text))))
        )
          continue;
        const second = last > first ? form.starts[first + 1] - base : Infinity,
          tail = form.starts[last] - base;
        for (const { token, phrase } of screenTokens(
          text,
          phrases,
          second,
          tail,
          form.pairs,
          base,
          first === last ? styled : undefined,
          !wraps || wraps[last] ? parts[last + 1] : undefined,
        )) {
          if (!token.code && !phrase && (last === first || spaced)) continue;
          const extent = token.code ?? token;
          if (last > first && (extent.start >= second || extent.end <= tail)) continue;
          yield { first, last, text, starts: form.starts, base, token, phrase, spaced };
        }
      }
    }
  }
}

/** Cells on the hovered row that could belong to a recovered target. */
export function regions(lines: string[], y: number, phrases = false): Span[] {
  const first = Math.max(0, y - 7),
    rows = lines.slice(first, y + 8).map(line => Bun.stripANSI(line).trimEnd()),
    at = y - first,
    row = rows[at];
  if (!row) return [];
  const spans: Span[] = [];
  const plain = /^[\x20-\x7e]*$/.test(row),
    indent = row.length - row.trimStart().length;
  const styled = phrases ? styledNames(lines[y], indent, rows[at + 1]) : [];
  for (const { starts, base, token } of windows(
    rows.map(r => r.trimStart()),
    at,
    phrases,
    styled,
  )) {
    const offset = starts[at] - base;
    const start = plain ? indent + Math.max(0, token.start - offset) : 0,
      end = plain ? Math.min(row.length, indent + token.end - offset) : Infinity;
    if (!plain || (start === indent && end === row.length)) return [{ row: y, start, end }];
    if (end > start && !spans.some(s => s.start === start && s.end === end)) spans.push({ row: y, start, end });
  }
  return spans;
}

interface Piece {
  text: string;
  start: number;
  end: number;
  cols: number[];
  row: Row;
}
function piece(row: Row, trimLeft: boolean, trimRight: boolean): Piece {
  let text = "";
  const cols: number[] = [];
  for (const [x, cell] of row.cells.entries()) {
    for (let i = 0; i < cell.length; i++) cols.push(x);
    text += cell;
  }
  cols.push(row.cells.length);
  const start = trimLeft ? text.length - text.trimStart().length : 0;
  const end = trimRight ? text.trimEnd().length : text.length;
  return { text, start, end, cols, row };
}
interface Candidate {
  target: Target;
  rank: number;
}
/** Hash the same canonical rows at both ends when output overtakes the request. */
export function fingerprint(lines: string[]): bigint {
  return BigInt.asUintN(64, BigInt(Bun.hash(lines.join("\n"))));
}

export function inspect(
  rows: Row[],
  x: number,
  y: number,
  known: Pick<evidence.Dictionary, "has"> | null,
  phrases = known !== null,
) {
  const missing = new Set<string>(),
    range = { start: 0, end: 65536 };
  const matches: Candidate[] = [];
  const probe = { missing, range, matches };
  const anchor = rows.findIndex(row => row.row === y);
  if (anchor < 0) return probe;
  const pieces = rows.map((row, i) => piece(row, !(row.continued || rows[i - 1]?.wrap), !row.wrap));

  const parts = pieces.map(p => p.text.slice(p.start, p.end));
  for (const { first, last, text, starts, base, token, phrase, spaced } of windows(
    parts,
    anchor,
    phrases,
    phrases && rows[anchor].line
      ? styledNames(rows[anchor].line, pieces[anchor].start, rows[anchor].wrap ? parts[anchor + 1] : undefined)
      : [],
    rows.map(r => r.wrap),
  )) {
    // The visible window may begin or end in the middle of a longer token.
    if (
      (token.code &&
        ((token.code.end === text.length &&
          rows[last].wrap &&
          (parts[last + 1] === undefined || parts[last + 1].startsWith("`"))) ||
          (token.code.start === 0 &&
            rows[first].continued &&
            (parts[first - 1] === undefined || parts[first - 1].endsWith("`"))))) ||
      (rows[last].wrap &&
        /^[.,;:!?')\]}]*$/.test(text.slice(token.end)) &&
        !/^\s/.test(pieces[last + 1]?.text ?? "") &&
        !token.code &&
        !(phrase && evidence.nameBeforePeriod(token.uri, parts[last + 1] ?? "", 0))) ||
      ((rows[first].continued || rows[first - 1]?.wrap) &&
        token.start === 0 &&
        !/\s$/.test(pieces[first - 1]?.text ?? "")) ||
      text.slice(token.start, token.end).includes("\0")
    )
      continue;
    let sure = true,
      plausible = true,
      listing = false;
    for (let i = first; i < last; i++) {
      if (rows[i].wrap) continue;
      const prev = pieces[i],
        width = prev.row.cells.length,
        end = prev.cols[prev.end];
      sure = false;
      plausible &&= end + Math.min(8, Math.floor(width / 4)) >= width;
      listing ||= /^\s*[^\s]+\/$/.test(prev.text.slice(0, prev.end)) && end * 2 < width;
    }
    if (listing && token.path && !token.code) continue;
    const spans: Span[] = [];
    for (let i = first; i <= last; i++) {
      const p = pieces[i],
        offset = starts[i] - base;
      const lo = p.start + Math.max(0, token.start - offset),
        hi = Math.min(p.end, p.start + token.end - offset);
      if (hi > lo) spans.push({ row: p.row.row, start: p.cols[lo], end: p.cols[hi] });
    }
    const at = spans.find(s => s.row === y);
    if (!at) continue;
    // A miss and its evidence watch cover every cell with the same candidates.
    if (x < at.start) range.end = Math.min(range.end, at.start);
    else if (x >= at.end) range.start = Math.max(range.start, at.end);
    else {
      range.start = Math.max(range.start, at.start);
      range.end = Math.min(range.end, at.end);
    }
    if (x < at.start || x >= at.end) continue;
    const attested = known?.has(token.uri) === true;
    if (!attested && (!sure || phrase) && (!phrase || missing.size < 64)) missing.add(token.uri);
    if (phrase && !attested) continue;
    if (!sure && !attested && !token.code && (!plausible || !token.path)) continue;
    matches.push({
      target: { uri: token.uri, path: token.path, spans, file: null },
      rank: (token.code ? 16 : 0) + (attested ? 8 : 0) + (sure ? 2 : 0) + Number(spaced),
    });
  }
  matches.sort((a, b) => b.rank - a.rank || b.target.uri.length - a.target.uri.length);
  return probe;
}

export async function resolve(
  probe: ReturnType<typeof inspect>,
  files: Pick<Files, "find">,
  cwd: string,
): Promise<Target | null> {
  const tried = new Set<string>();
  for (const { target } of probe.matches) {
    if (tried.has(target.uri)) continue;
    if (!target.path) return target;
    const ref = fileRef.parse(target.uri, true);
    if (!ref || tried.size >= 4) continue;
    tried.add(target.uri);
    const info = await files.find(ref.path, cwd).catch(() => null);
    if (info) return { ...target, file: info.path };
  }
  return null;
}
