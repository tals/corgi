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

/** Cells on the hovered row that could belong to a multi-row token. Run once
 * for a resting pointer; the daemon resolves actual cell widths and barriers. */
export function regions(lines: string[], y: number): Span[] {
  const firstRow = Math.max(0, y - 7);
  const rows = lines.slice(firstRow, y + 8).map(line => Bun.stripANSI(line).trimEnd());
  const at = y - firstRow,
    row = rows[at];
  if (!row?.trim() || !rows.some(r => /[/.#:(]/.test(r))) return [];
  const spans: Span[] = [];
  const plain = /^[\x20-\x7e]*$/.test(row),
    indent = row.length - row.trimStart().length;
  for (let first = 0; first <= at; first++) {
    let joined = "",
      anchor = 0,
      second = 0;
    for (let last = first; last < Math.min(first + 8, rows.length); last++) {
      const part = rows[last].trimStart();
      if (!part) break;
      const start = joined.length;
      joined += part;
      if (last === at) anchor = start;
      if (last === first + 1) second = start;
      if (last < at || last === first) continue;
      for (const token of evidence.tokens(joined)) {
        if (token.start >= second || token.end <= start) continue;
        const lo = plain ? indent + Math.max(0, token.start - anchor) : 0,
          hi = plain ? Math.min(row.length, indent + token.end - anchor) : Infinity;
        if (!spans.some(s => s.start === lo && s.end === hi)) spans.push({ row: y, start: lo, end: hi });
      }
    }
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

export function inspect(rows: Row[], x: number, y: number, known: Pick<evidence.Dictionary, "has"> | null) {
  const missing = new Set<string>(),
    range = { start: 0, end: 65536 };
  const matches: Candidate[] = [];
  const probe = { missing, range, matches };
  const anchor = rows.findIndex(row => row.row === y);
  if (anchor < 0) return probe;
  const pieces = rows.map((row, i) => piece(row, !(row.continued || rows[i - 1]?.wrap), !row.wrap));

  for (let first = Math.max(0, anchor - 7); first <= anchor; first++) {
    let text = "",
      sure = true,
      plausible = true,
      listing = false;
    const starts: number[] = [];
    for (let last = first; last < Math.min(rows.length, first + 8); last++) {
      const p = pieces[last];
      if (p.start >= p.end) break;
      if (last > first && !rows[last - 1].wrap) {
        const prev = pieces[last - 1],
          width = prev.row.cells.length,
          end = prev.cols[prev.end];
        // A directory listing also spells a plausible (and often real) path.
        listing ||= /^\s*[^\s]+\/$/.test(prev.text.slice(0, prev.end)) && end * 2 < width;
        sure = false;
        plausible &&= end + Math.min(8, Math.floor(width / 4)) >= width;
      }
      starts.push(text.length);
      text += p.text.slice(p.start, p.end);
      if (last <= first || last < anchor) continue;
      for (const token of evidence.tokens(text)) {
        if (token.start >= starts[1] || token.end <= starts.at(-1)!) continue;
        if (listing && token.path) continue;
        const attested = known?.has(token.uri) === true;
        // A bounded window cannot establish a target ending inside a real soft wrap.
        if (
          (p.row.wrap &&
            /^[.,;:!?\x27)\]}]*$/.test(text.slice(token.end)) &&
            !/^\s/.test(pieces[last + 1]?.text ?? "")) ||
          ((rows[first].continued || rows[first - 1]?.wrap) &&
            token.start === 0 &&
            !/\s$/.test(pieces[first - 1]?.text ?? "")) ||
          text.slice(token.start, token.end).includes("\0")
        )
          continue;
        const spans = starts.map((offset, i) => {
          const part = pieces[first + i];
          return {
            row: part.row.row,
            start: part.cols[part.start + Math.max(0, token.start - offset)],
            end: part.cols[Math.min(part.end, part.start + token.end - offset)],
          };
        });
        const at = spans[anchor - first];
        // A miss and its evidence watch cover every cell with the same candidates.
        if (x < at.start) range.end = Math.min(range.end, at.start);
        else if (x >= at.end) range.start = Math.max(range.start, at.end);
        else {
          range.start = Math.max(range.start, at.start);
          range.end = Math.min(range.end, at.end);
        }
        if (x < at.start || x >= at.end) continue;
        if (!attested && !sure) missing.add(token.uri);
        if (!sure && !attested && (!plausible || !token.path)) continue;
        matches.push({
          target: { uri: token.uri, path: token.path, spans, file: null },
          rank: attested ? 2 : sure ? 1 : 0,
        });
      }
    }
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
