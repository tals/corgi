//! Spellings a conversation and its terminal rows can compare, with the
//! visible UTF-16 offsets needed to turn a match back into terminal cells.
import { byteLength } from "./text";

export interface Token {
  uri: string;
  start: number;
  end: number;
  path: boolean;
  /** Includes the matching Markdown delimiters; the visible link excludes them. */
  code?: { start: number; end: number };
}

const max_path = 1024;
const max_url = 4096;
const familiar_name = /^[A-Z](?:[A-Za-z]*file|[A-Z0-9_-]{2,})$/;

/** A single code word can name a file at the end of a sentence. */
export function nameBeforePeriod(name: string, text: string, after: number): boolean {
  return (
    text[after] === "." &&
    (after + 1 === text.length || /[\s"')\]}”’]/u.test(text[after + 1])) &&
    /^[\p{L}\p{M}\p{N}_-]+$/u.test(name) &&
    /\p{L}/u.test(name)
  );
}

function pathLike(path: string, numbered: boolean) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name || path.startsWith("//") || !/[\p{L}\p{Extended_Pictographic}]/u.test(path)) return false;
  if (numbered || path.includes("/") || /^\.[^.]+$/.test(name)) return true;
  const extension = /\.([A-Za-z0-9_]{1,16})$/.exec(name);
  return extension !== null && /[a-z]/i.test(extension[1]);
}

// The same diagnostic spellings as the native plain-path detector. The URI
// carries :line:column whatever the program printed.
function suffix(text: string, at: number) {
  const pattern =
    /:([0-9]{1,9})(?!\d)(?::([0-9]{1,9})(?!\d))?|\(([0-9]{1,9})(?:, ?([0-9]{1,9}))?\)|#L([0-9]{1,9})(?!\d)/y;
  pattern.lastIndex = at;
  const m = pattern.exec(text);
  if (!m) return null;
  const line = Number(m[1] ?? m[3] ?? m[5]),
    col = Number(m[2] ?? m[4]);
  return line ? { uri: ":" + line + (col ? ":" + col : ""), end: pattern.lastIndex } : null;
}

function plain(
  text: string,
  start: number,
  raw: string,
  quote: string | null,
  after = start + raw.length + Number(quote !== null),
): Token | null {
  const code = quote === "`";
  if (!code && !/[/.:(#]/.test(raw) && !/[:(#,]/.test(text[after] ?? "")) return null;
  if (raw.length > max_path || byteLength(raw) > max_path) return null;
  let name = raw;
  let end = start + name.length;
  let where = null;
  if (quote) {
    // A quoted name can include spaces, punctuation and its diagnostic suffix.
    const inside = /(?::\d+(?::\d+)?|\(\d+(?:, ?\d+)?\)|#L\d+)$/.exec(name);
    if (inside) where = suffix(name, inside.index);
    if (where && inside) name = name.slice(0, inside.index);
    if (
      !name ||
      name !== name.trim() ||
      !/^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200d /._+@~(),`'&=#\[\]-]+$/u.test(name)
    )
      return null;
    // An external suffix is a location too; the quote stays outside the span.
    where ??= suffix(text, after);
    if (!where && quote === '"') {
      const python = /, line ([1-9]\d{0,8})(?!\d)/y;
      python.lastIndex = end + 1;
      const m = python.exec(text);
      if (m) where = { uri: ":" + Number(m[1]), end };
    }
  } else {
    name = name.replace(/\.+$/, "");
    end = start + name.length;
    where = suffix(text, end);
    if (where) end = where.end;
  }
  return (code &&
    !name.endsWith("/") &&
    (familiar_name.test(name) ||
      (name.includes(" ") && /[\p{L}\p{N}]/u.test(name)) ||
      nameBeforePeriod(name, text, after))) ||
    pathLike(name, where !== null)
    ? { uri: name + (where?.uri ?? ""), start, end, path: true }
    : null;
}

/** The URL ends before unmatched closing brackets and sentence punctuation.
 * A quoted apostrophe can still be part of a word inside the URL. */
function urlEnd(text: string, start: number, end: number): number {
  const pairs = "()[]{}";
  const balance = [0, 0, 0];
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === "'" && !/[A-Za-z0-9]/.test(text[i + 1] ?? "")) {
      end = i;
      break;
    }
    const pair = pairs.indexOf(c);
    if (pair !== -1) balance[pair >> 1] += pair % 2 === 0 ? 1 : -1;
  }
  while (end > start) {
    const c = text[end - 1],
      pair = pairs.indexOf(c);
    if (pair !== -1 && pair % 2 === 1 && balance[pair >> 1] < 0) balance[pair >> 1]++;
    else if (!".,;:!?'".includes(c)) break;
    end--;
  }
  return end;
}

/** Pair whole backtick runs in each paragraph, even when their contents
 * aren't a filename. A closing delimiter cannot open a second span. */
export function codePairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  if (!text.includes("`")) return pairs;
  const runs = [...text.matchAll(/`+|\r?\n[ \t]*\r?\n/g)];
  const next = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const { 0: run, index } = runs[i];
    if (run[0] !== "`") {
      next.clear();
      continue;
    }
    const close = next.get(run.length);
    if (close !== undefined) pairs.set(index, close);
    next.set(run.length, index);
  }
  let after = 0;
  for (const { 0: run, index } of runs) {
    const close = pairs.get(index);
    if (close === undefined) continue;
    let slash = index;
    while (slash > 0 && text[slash - 1] === "\\") slash--;
    if (index < after || (index - slash) % 2) pairs.delete(index);
    else {
      after = close + run.length;
      if (
        run.length >= 3 &&
        !text.slice(text.lastIndexOf("\n", index - 1) + 1, index).trim() &&
        text.indexOf("\n", index) >= 0 &&
        text.indexOf("\n", index) < close
      )
        pairs.delete(index);
    }
  }
  return pairs;
}

export function* tokens(text: string, paragraphPairs?: ReadonlyMap<number, number>, offset = 0): Generator<Token> {
  // Plain prose without a slash, dot or line number cannot name a target.
  if (!/[/.`]|[:(]\d|#L\d|", line \d/.test(text)) return;
  const scan = /[a-z][\w+.-]*:\/\/|`+|["']|[\p{L}\p{N}\p{M}\p{Extended_Pictographic}\u200d/._+@~-]+/giu;
  const body = /[^\s<>"`\x00-\x1f\x7f]*/uy;
  const pairs = paragraphPairs ?? codePairs(text);
  let m;
  while ((m = scan.exec(text))) {
    const raw = m[0],
      start = m.index;
    if (raw.endsWith("://")) {
      body.lastIndex = scan.lastIndex;
      const rest = body.exec(text)![0];
      // Discard long tokens before bracket counting. Revisit closing quotes
      // and punctuation so the next adjacent quoted URL gets its own match.
      const end = rest.length <= max_url ? urlEnd(text, start + raw.length, body.lastIndex) : body.lastIndex;
      scan.lastIndex = Math.max(scan.lastIndex, end);
      if (!/^https?:\/\/$/i.test(raw) || !rest || rest[0] === "/" || end <= start + raw.length || end - start > max_url)
        continue;
      const uri = text.slice(start, end);
      if (byteLength(uri) <= max_url) yield { uri, start, end, path: false };
      continue;
    }
    if (raw[0] === "`") {
      const paired = pairs.get(offset + start);
      if (paired === undefined) continue;
      const close = paired - offset;
      // A screen window may cut through a pair or join backtick runs at a hard break.
      if (
        close < scan.lastIndex ||
        close - scan.lastIndex > max_path + 2 ||
        !text.startsWith(raw, close) ||
        text[close - 1] === "`" ||
        text[close + raw.length] === "`"
      )
        continue;
      const original = text.slice(scan.lastIndex, close);
      const content = original.replace(/\r\n|[\r\n]/g, " ");
      const pad = Number(content.startsWith(" ") && content.endsWith(" "));
      const after = close + raw.length;
      const found = plain(text, scan.lastIndex + pad, content.slice(pad, content.length - pad), "`", after);
      if (found) {
        yield { ...found, end: close - pad, code: { start, end: after } };
        scan.lastIndex = after;
      }
      continue;
    }
    if (start > 0 && !/[\s([{<'"`=:,|]/.test(text[start - 1])) continue;
    if (raw === '"' || raw === "'") {
      const ahead = text.slice(scan.lastIndex, scan.lastIndex + max_path + 1);
      const close = ahead.indexOf(raw);
      if (close < 1) continue;
      const found = plain(text, start + 1, ahead.slice(0, close), raw);
      if (found) {
        yield found;
        scan.lastIndex = start + close + 2;
      }
      continue;
    }
    const found = plain(text, start, raw, null);
    if (found) {
      yield found;
      scan.lastIndex = Math.max(scan.lastIndex, found.end);
    }
  }
}

const capacity = 256;
const unqualified_limit = 32;
const edge_bytes = 8192;
let revision = 0;

/** The most recently seen targets for one conversation. The revision only
 * moves on membership changes and is distinct across this daemon's sessions. */
export class Dictionary {
  private recent = new Map<string, string>();
  private unqualified = new Set<string>();
  revision = 0;
  has(uri: string): boolean {
    return this.recent.has(uri);
  }
  get full() {
    return this.recent.size >= capacity;
  }
  /** Fill any open slots with the most recent spellings from before a handoff. */
  addOlder(older: Dictionary) {
    if (this.full) return;
    const missing: [string, string][] = [],
      unqualified: string[] = [];
    for (const entry of [...older.recent].reverse()) {
      const uri = entry[0];
      if (this.has(uri)) continue;
      if (older.unqualified.has(uri)) {
        if (this.unqualified.size + unqualified.length >= unqualified_limit) continue;
        unqualified.push(uri);
      }
      missing.push(entry);
      if (this.recent.size + missing.length === capacity) break;
    }
    if (!missing.length) return;
    this.recent = new Map([...missing.reverse(), ...this.recent]);
    this.unqualified = new Set([...unqualified.reverse(), ...this.unqualified]);
    this.revision = ++revision;
  }
  clear() {
    if (!this.recent.size) return;
    this.recent.clear();
    this.unqualified.clear();
    this.revision = ++revision;
  }
  add(text: string) {
    if (text.length <= edge_bytes * 2 && byteLength(text) <= edge_bytes * 2) {
      this.scan(text);
      return;
    }
    // Large tool outputs often put the command near the start and the result
    // near the end. Only complete lines can supply an untruncated spelling.
    const first = Buffer.from(text.slice(0, edge_bytes)).subarray(0, edge_bytes);
    const last = Buffer.from(text.slice(-edge_bytes)).subarray(-edge_bytes);
    const end = first.lastIndexOf(10),
      start = last.indexOf(10);
    if (end >= 0) this.scan(first.toString("utf8", 0, end));
    if (start >= 0) this.scan(last.toString("utf8", start + 1));
  }
  private scan(text: string) {
    for (const { uri, code } of tokens(text))
      this.remember(uri, !!code && !familiar_name.test(uri) && !pathLike(uri, /:\d+$/.test(uri)));
    // Normalized tool arguments put one field on a line. A path field's
    // value can contain literal spaces without shell quotes.
    for (const [, value] of text.matchAll(/^(?:file_path|path|filename): ([^\r\n]{1,1024})$/gm)) {
      if (!value.includes(" ")) continue;
      const found = plain(value, 0, value, '"');
      if (found) this.remember(found.uri);
    }
  }
  private remember(uri: string, unqualified = false) {
    const known = this.recent.get(uri);
    if (known !== undefined) {
      this.recent.delete(known);
      this.recent.set(known, known);
      if (this.unqualified.delete(known) && unqualified) this.unqualified.add(known);
      return;
    }
    // Extensionless code spans also include commands. They can replace one
    // another, but cannot evict paths or URLs from a full dictionary.
    if (this.full || (unqualified && this.unqualified.size >= unqualified_limit)) {
      const oldest =
        this.unqualified.values().next().value ?? (unqualified ? undefined : this.recent.keys().next().value);
      if (oldest === undefined) return;
      this.recent.delete(oldest);
      this.unqualified.delete(oldest);
    }
    // Own the small spelling without retaining a tool output through a substring.
    const owned = Buffer.from(uri).toString();
    this.recent.set(owned, owned);
    if (unqualified) this.unqualified.add(owned);
    this.revision = ++revision;
  }
}

/** One viewer can be waiting for a transcript to confirm the link under its pointer. */
export class HoverWatch {
  target: { pane: number; actor: number; binding: bigint; dictionary_revision: number; spellings: Set<string> } | null =
    null;
  private refresh_pane: number | null = null;
  revision = 0;
  sent_revision = 0;

  clear() {
    this.target = null;
    this.refresh_pane = null;
  }
  check(dictionary: Dictionary | null) {
    const target = this.target;
    if (!target || !dictionary || dictionary.revision === target.dictionary_revision) return;
    target.dictionary_revision = dictionary.revision;
    for (const spelling of target.spellings) {
      if (!dictionary.has(spelling)) continue;
      this.refresh_pane = target.pane;
      this.target = null;
      this.revision++;
      break;
    }
  }
  /** A fresh stream also receives the last match, in case its predecessor disconnected. */
  recheck(streaming: boolean) {
    if (this.refresh_pane === null || (streaming && this.sent_revision === this.revision)) return undefined;
    return { pane: this.refresh_pane, seq: this.revision };
  }
}
