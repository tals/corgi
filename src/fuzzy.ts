//! Fuzzy matching for paths in fzf's spirit (its FuzzyMatchV2 with the path
//! scheme): a query's characters in order anywhere in a path, scored higher
//! at the start of a word or a path part, at camelCase humps and digits, in
//! runs, and in the last part, the name. A query of lowercase letters
//! ignores case; one with a capital matches it exactly. Words a space
//! separates each match, in any order.

const score_match = 16;
const gap_start = -3;
const gap_extension = -1;
const bonus_boundary = score_match / 2;
const bonus_non_word = score_match / 2;
const bonus_camel = bonus_boundary + gap_extension;
const bonus_consecutive = -(gap_start + gap_extension);
const first_char_multiplier = 2;
/** After a "/" a part starts, which counts a little more than a word. */
const bonus_delimiter = bonus_boundary + 1;
/** Each character matched in the name, past the path's last "/". */
const bonus_name = 2;

const enum Class {
  White,
  NonWord,
  Delimiter,
  Lower,
  Upper,
  Letter,
  Number,
}
function classOf(c: number): Class {
  if (c >= 97 && c <= 122) return Class.Lower;
  if (c >= 65 && c <= 90) return Class.Upper;
  if (c >= 48 && c <= 57) return Class.Number;
  if (c === 47) return Class.Delimiter;
  if (c === 32 || c === 9 || c === 10 || c === 13) return Class.White;
  if (c < 128) return Class.NonWord;
  const ch = String.fromCharCode(c);
  if (ch.toLowerCase() !== ch) return Class.Upper;
  if (ch.toUpperCase() !== ch) return Class.Lower;
  return /[\p{L}\p{N}]/u.test(ch) ? Class.Letter : Class.NonWord;
}
function bonusFor(previous: Class, current: Class): number {
  if (current > Class.NonWord) {
    if (previous === Class.White) return bonus_boundary;
    if (previous === Class.Delimiter) return bonus_delimiter;
    if (previous === Class.NonWord) return bonus_boundary;
  }
  if ((previous === Class.Lower && current === Class.Upper) || (previous !== Class.Number && current === Class.Number))
    return bonus_camel;
  if (current === Class.NonWord || current === Class.Delimiter) return bonus_non_word;
  if (current === Class.White) return bonus_boundary;
  return 0;
}

const folded = new Map<number, number>();
/** `c` in lowercase, where that's one UTF-16 unit, so offsets stay put. */
function fold(c: number): number {
  if (c < 128) return c >= 65 && c <= 90 ? c + 32 : c;
  let out = folded.get(c);
  if (out === undefined) {
    const lower = String.fromCharCode(c).toLowerCase();
    folded.set(c, (out = lower.length === 1 ? lower.charCodeAt(0) : c));
  }
  return out;
}
/** `text` in lowercase, unit for unit. */
export function lower(text: string): string {
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
  let out = "";
  for (let i = 0; i < text.length; i++) out += String.fromCharCode(fold(text.charCodeAt(i)));
  return out;
}

interface Term {
  text: string;
  sensitive: boolean;
}
/** A query, parsed once for every path it's matched against. */
export interface Pattern {
  terms: Term[];
  /** Any term ignores case, so a path's lowercase is needed. */
  folds: boolean;
}
/** The pattern `query` makes, or null for one with nothing to match. */
export function pattern(query: string): Pattern | null {
  const terms = query
    .split(" ")
    .filter(Boolean)
    .map(word => {
      const sensitive = lower(word) !== word;
      return { text: sensitive ? word : lower(word), sensitive };
    });
  return terms.length ? { terms, folds: terms.some(t => !t.sensitive) } : null;
}
/** A path to match, with its lowercase made once. */
export class Candidate {
  private folded: string | null = null;
  constructor(readonly text: string) {}
  get lower(): string {
    return (this.folded ??= lower(this.text));
  }
}

// One growing matrix shared by every match, as fzf's slab is.
let H = new Int32Array(1024),
  C = new Int32Array(1024);
const ensure = (size: number) => {
  if (H.length >= size) return;
  const length = Math.max(size, H.length * 2);
  H = new Int32Array(length);
  C = new Int32Array(length);
};
let B = new Int32Array(256),
  F = new Int32Array(16);

/** Scores `term` in `text` (as cased for it), from fzf's dynamic program. With `positions`, the
 * matched offsets are added to it. Null when it doesn't match. */
function matchTerm(term: string, text: string, original: string, positions: number[] | null): number | null {
  const m = term.length,
    n = text.length;
  if (m === 0) return 0;
  if (m > n) return null;
  // Where each character first fits in order, and the last place the last can go.
  if (F.length < m) F = new Int32Array(m * 2);
  let at = 0;
  for (let i = 0; i < m; i++) {
    at = text.indexOf(term[i], at);
    if (at < 0) return null;
    F[i] = at++;
  }
  const last = text.lastIndexOf(term[m - 1]);
  const from = F[0],
    width = last - from + 1;
  if (B.length < n) B = new Int32Array(n * 2);
  const name = original.lastIndexOf("/", original.length - 2);
  let previous = from > 0 ? classOf(original.charCodeAt(from - 1)) : Class.Delimiter;
  for (let j = from; j <= last; j++) {
    const current = classOf(original.charCodeAt(j));
    B[j] = bonusFor(previous, current) + (j > name ? bonus_name : 0);
    previous = current;
  }
  ensure(m * width);
  // The first character's row.
  let best = 0,
    best_at = -1,
    in_gap = false,
    previous_h = 0;
  const first = term.charCodeAt(0);
  for (let j = from; j <= last; j++) {
    const k = j - from;
    if (text.charCodeAt(j) === first) {
      H[k] = score_match + B[j] * first_char_multiplier;
      C[k] = 1;
      in_gap = false;
    } else {
      H[k] = Math.max(previous_h + (in_gap ? gap_extension : gap_start), 0);
      C[k] = 0;
      in_gap = true;
    }
    previous_h = H[k];
    if (m === 1 && C[k] > 0 && H[k] > best) {
      best = H[k];
      best_at = j;
    }
  }
  // The rows after it.
  for (let i = 1; i < m; i++) {
    const row = i * width,
      up = row - width,
      c = term.charCodeAt(i);
    in_gap = false;
    for (let j = from; j < F[i]; j++) {
      H[row + j - from] = 0;
      C[row + j - from] = 0;
    }
    for (let j = F[i]; j <= last; j++) {
      const k = j - from;
      const s2: number = j > F[i] ? H[row + k - 1] + (in_gap ? gap_extension : gap_start) : 0;
      let s1 = 0,
        consecutive = 0;
      // The characters before it fit before it, as `F` found: a score worn
      // to 0 by gaps still matches.
      if (text.charCodeAt(j) === c) {
        s1 = H[up + k - 1] + score_match;
        let b = B[j];
        consecutive = C[up + k - 1] + 1;
        if (consecutive > 1) {
          const fb = B[j - consecutive + 1];
          // A word that starts inside a run starts a run of its own.
          if (b >= bonus_boundary && b > fb) consecutive = 1;
          else b = Math.max(b, bonus_consecutive, fb);
        }
        if (s1 + b < s2) {
          s1 += B[j];
          consecutive = 0;
        } else s1 += b;
      }
      C[row + k] = consecutive;
      in_gap = s1 < s2;
      const score = Math.max(s1, s2, 0);
      H[row + k] = score;
      if (i === m - 1 && score > best) {
        best = score;
        best_at = j;
      }
    }
  }
  if (best_at < 0) return null;
  if (positions) {
    let i = m - 1,
      j = best_at,
      prefer = true;
    const found: number[] = [];
    while (j >= from) {
      const row = i * width,
        k = j - from,
        s = H[row + k];
      const s1 = i > 0 && j >= F[i] && k > 0 ? H[row - width + k - 1] : 0,
        s2 = j > F[i] ? H[row + k - 1] : 0;
      if (C[row + k] > 0 && s > s1 && (s > s2 || (s === s2 && prefer))) {
        found.push(j);
        if (i === 0) break;
        i--;
      }
      prefer = C[row + k] > 1 || (row + width + k + 1 < m * width && C[row + width + k + 1] > 0);
      j--;
    }
    positions.push(...found);
  }
  return best;
}
/** How well `p` matches `c`, or null when it doesn't. */
export function score(p: Pattern, c: Candidate): number | null {
  let total = 0;
  for (const term of p.terms) {
    const s = matchTerm(term.text, term.sensitive ? c.text : c.lower, c.text, null);
    if (s === null) return null;
    total += s;
  }
  return total;
}
/** The offsets of `text`'s characters that `p` matches, in order, to highlight. */
export function positions(p: Pattern, text: string): number[] {
  const out: number[] = [];
  const c = new Candidate(text);
  for (const term of p.terms) if (matchTerm(term.text, term.sensitive ? text : c.lower, text, out) === null) return [];
  return [...new Set(out)].sort((a, b) => a - b);
}
