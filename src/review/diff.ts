//! One file's change as rows to read: both sides of the file, taken from
//! git's diff with the whole file as context, folds over long unchanged runs,
//! and the words that changed inside an edited line. Mirrors herdr-reviewr's
//! `diff.rs`.

/** A file past either budget shows a notice instead of rows. */
export const max_lines = 50_000;
export const max_bytes = 2_000_000;
/** Context kept beside every change; longer unchanged runs fold. */
export const fold_margin = 3;

export type Kind = "context" | "deletion" | "insertion";
/** A line of the diff. Line numbers are 1-based, 0 on the side the line
 * isn't on; `old_at`/`new_at` index that side's lines, -1 likewise. */
export interface Row {
  kind: Kind;
  old_no: number;
  new_no: number;
  old_at: number;
  new_at: number;
}
/** What the pane shows: a row, or a folded run of rows [start, end). */
export type Unit = { kind: "row"; row: number } | { kind: "fold"; start: number; end: number };
/** `[start, end)` character ranges within a line. */
export type Ranges = [number, number][];

export class FileDiff {
  old: string[] = [];
  new: string[] = [];
  rows: Row[] = [];
  units: Unit[] = [];
  adds = 0;
  dels = 0;
  /** Changed words per row, filled a change block at a time as rows show. */
  private emphasis_cache = new Map<number, Ranges | null>();
  text(row: Row): string {
    return row.kind === "deletion" ? this.old[row.old_at] : this.new[row.new_at];
  }
  /** The line number a gutter shows: the new side's, or the old side's for a deletion. */
  static number(row: Row): number {
    return row.kind === "deletion" ? row.old_no : row.new_no;
  }
  /** The widest line number, for the gutter. */
  gutter(): number {
    let widest = 0;
    for (const row of this.rows) widest = Math.max(widest, row.old_no, row.new_no);
    return Math.max(3, String(widest).length);
  }
  /** The changed-word ranges of row `index`, or null when it has no partner. */
  emphasis(index: number): Ranges | null {
    if (!this.emphasis_cache.has(index)) this.pairBlock(index);
    return this.emphasis_cache.get(index) ?? null;
  }
  private pairBlock(index: number): void {
    const rows = this.rows;
    if (rows[index].kind === "context") {
      this.emphasis_cache.set(index, null);
      return;
    }
    let start = index;
    if (rows[start].kind === "insertion") while (start > 0 && rows[start - 1].kind === "insertion") start--;
    while (start > 0 && rows[start - 1].kind === "deletion") start--;
    let split = start;
    while (split < rows.length && rows[split].kind === "deletion") split++;
    let end = split;
    while (end < rows.length && rows[end].kind === "insertion") end++;
    for (let i = start; i < end; i++) this.emphasis_cache.set(i, null);
    if ((split - start) * (end - split) > max_block_pairs) return;
    let from = split;
    for (let d = start; d < split; d++) {
      const old = this.old[rows[d].old_at];
      if (old.length > max_emphasis_line) continue;
      for (let a = from; a < end; a++) {
        const next = this.new[rows[a].new_at];
        if (next.length > max_emphasis_line || this.emphasis_cache.get(a)) continue;
        const found = wordDiff(old, next);
        if (found && found.similarity >= min_similarity) {
          this.emphasis_cache.set(d, found.old);
          this.emphasis_cache.set(a, found.new);
          from = a + 1;
          break;
        }
      }
    }
  }
}

/** Parses `git diff` output for one file, run with enough context to hold
 * the whole file. Returns "binary" when git found no text diff. */
export function parse(patch: string): FileDiff | "binary" {
  const diff = new FileDiff();
  let old_no = 0,
    new_no = 0,
    in_hunk = false;
  for (const line of patch.split("\n")) {
    if (!in_hunk) {
      if (line.startsWith("Binary files ") || line === "GIT binary patch") return "binary";
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        in_hunk = true;
        old_no = Number(hunk[1]) - (Number(hunk[1]) > 0 ? 1 : 0);
        new_no = Number(hunk[2]) - (Number(hunk[2]) > 0 ? 1 : 0);
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old_no = Number(hunk[1]) - 1;
      new_no = Number(hunk[2]) - 1;
      continue;
    }
    const mark = line[0],
      text = line.slice(1);
    if (mark === " ") {
      diff.rows.push({
        kind: "context",
        old_no: ++old_no,
        new_no: ++new_no,
        old_at: diff.old.length,
        new_at: diff.new.length,
      });
      diff.old.push(text);
      diff.new.push(text);
    } else if (mark === "-") {
      diff.rows.push({ kind: "deletion", old_no: ++old_no, new_no: 0, old_at: diff.old.length, new_at: -1 });
      diff.old.push(text);
      diff.dels++;
    } else if (mark === "+") {
      diff.rows.push({ kind: "insertion", old_no: 0, new_no: ++new_no, old_at: -1, new_at: diff.new.length });
      diff.new.push(text);
      diff.adds++;
    } else if (line.startsWith("diff --git ")) in_hunk = false;
  }
  for (const side of [diff.old, diff.new]) for (let i = 0; i < side.length; i++) side[i] = side[i].replace(/\r$/, "");
  diff.units = fold(diff.rows);
  return diff;
}

/** Folds each unchanged run longer than the margin, keeping `fold_margin`
 * lines next to every change. A run that would hide one line stays open. */
export function fold(rows: Row[]): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "context") {
      out.push({ kind: "row", row: i });
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "context") j++;
    const head = i === 0,
      tail = j === rows.length,
      keep_before = head ? 0 : fold_margin,
      keep_after = tail ? 0 : fold_margin;
    if (!(head && tail) && j - i - keep_before - keep_after >= 2) {
      for (let k = i; k < i + keep_before; k++) out.push({ kind: "row", row: k });
      out.push({ kind: "fold", start: i + keep_before, end: j - keep_after });
      for (let k = j - keep_after; k < j; k++) out.push({ kind: "row", row: k });
    } else for (let k = i; k < j; k++) out.push({ kind: "row", row: k });
    i = j;
  }
  return out;
}

/** A fold's identity across rebuilds: its first hidden line's new-side number. */
export function foldAnchor(diff: FileDiff, unit: Unit): number {
  return unit.kind === "fold" ? diff.rows[unit.start].new_no : 0;
}

/** The units with each fold in `opened` (by anchor) replaced by its rows. */
export function shown(diff: FileDiff, opened: ReadonlySet<number>): Unit[] {
  if (opened.size === 0) return diff.units;
  const out: Unit[] = [];
  for (const unit of diff.units) {
    if (unit.kind === "fold" && opened.has(foldAnchor(diff, unit)))
      for (let row = unit.start; row < unit.end; row++) out.push({ kind: "row", row });
    else out.push(unit);
  }
  return out;
}

export function isChange(diff: FileDiff, unit: Unit | undefined): boolean {
  return unit !== undefined && unit.kind === "row" && diff.rows[unit.row].kind !== "context";
}

/** Where each hunk starts among `units`: a change after an unchanged unit. */
export function hunkStarts(diff: FileDiff, units: Unit[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < units.length; i++)
    if (isChange(diff, units[i]) && !(i > 0 && isChange(diff, units[i - 1]))) out.push(i);
  return out;
}

/** Two lines below this word similarity are different lines, not one edited
 * line, so they get no changed-word emphasis (herdr-reviewr's bar). */
export const min_similarity = 0.7;
/** Lines this long skip emphasis: a minified line would cost too much. */
const max_emphasis_line = 1000;
/** A change block with more deletion-insertion pairs than this skips emphasis. */
const max_block_pairs = 20_000;
/** Word pairs a single comparison may weigh. */
const max_word_pairs = 40_000;

const words = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

/** The share of characters two lines keep, and the ranges each changed:
 * the longest common run of words, with changed words joined across
 * whitespace and trimmed of it. */
export function wordDiff(a: string, b: string): { similarity: number; old: Ranges; new: Ranges } | null {
  const left = words(a),
    right = words(b),
    n = left.length,
    m = right.length;
  if (n === 0 || m === 0 || n * m > max_word_pairs) return null;
  const width = m + 1,
    table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const kept_left = new Array<boolean>(n).fill(false),
    kept_right = new Array<boolean>(m).fill(false);
  let i = 0,
    j = 0,
    common = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      kept_left[i] = kept_right[j] = true;
      common += left[i].length;
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return {
    similarity: (2 * common) / (a.length + b.length),
    old: changed(left, kept_left, a),
    new: changed(right, kept_right, b),
  };
}
function changed(tokens: string[], kept: boolean[], text: string): Ranges {
  const raw: Ranges = [];
  let at = 0;
  tokens.forEach((token, k) => {
    if (!kept[k]) {
      const last = raw[raw.length - 1];
      if (last && last[1] === at) last[1] += token.length;
      else raw.push([at, at + token.length]);
    }
    at += token.length;
  });
  const merged: Ranges = [];
  for (const range of raw) {
    const last = merged[merged.length - 1];
    if (last && /^\s*$/.test(text.slice(last[1], range[0]))) last[1] = range[1];
    else merged.push([range[0], range[1]]);
  }
  return merged
    .map(([s, e]): [number, number] => {
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      return [s, e];
    })
    .filter(([s, e]) => e > s);
}
