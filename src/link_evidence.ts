//! Spellings a conversation and its terminal rows can compare, with the
//! visible UTF-16 offsets needed to turn a match back into terminal cells.
import { byteLength } from "./text";

export interface Token {
  uri: string;
  start: number;
  end: number;
  path: boolean;
}

const max_path = 1024;
const max_url = 4096;

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

function plain(text: string, start: number, raw: string, quote: string | null): Token | null {
  const after = start + raw.length + Number(quote !== null);
  if (!/[/.:(#]/.test(raw) && !/[:(#,]/.test(text[after] ?? "")) return null;
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
      !/^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200d /._+@~(),'&=\[\]-]+$/u.test(name)
    )
      return null;
    // An external suffix is a location too; the quote stays outside the span.
    where ??= suffix(text, end + 1);
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
  return pathLike(name, where !== null) ? { uri: name + (where?.uri ?? ""), start, end, path: true } : null;
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

export function* tokens(text: string): Generator<Token> {
  // Plain prose without a slash, dot or line number cannot name a target.
  if (!/[/.]|[:(]\d|#L\d|", line \d/.test(text)) return;
  const scan = /[a-z][\w+.-]*:\/\/|["'`]|[\p{L}\p{N}\p{M}\p{Extended_Pictographic}\u200d/._+@~-]+/giu;
  const body = /[^\s<>"`\x00-\x1f\x7f]*/uy;
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
    if (start > 0 && !/[\s([{<'"`=:,|]/.test(text[start - 1])) continue;
    if (raw === '"' || raw === "'" || raw === "`") {
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
const edge_bytes = 8192;
let revision = 0;

/** The most recently seen targets for one conversation. The revision only
 * moves on membership changes and is distinct across this daemon's sessions. */
export class Dictionary {
  private recent = new Map<string, string>();
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
    const missing = [...older.recent].filter(([uri]) => !this.has(uri)).slice(this.recent.size - capacity);
    if (!missing.length) return;
    this.recent = new Map([...missing, ...this.recent]);
    this.revision = ++revision;
  }
  clear() {
    if (!this.recent.size) return;
    this.recent.clear();
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
    for (const { uri } of tokens(text)) this.remember(uri);
    // Normalized tool arguments put one field on a line. A path field's
    // value can contain literal spaces without shell quotes.
    for (const [, value] of text.matchAll(/^(?:file_path|path|filename): ([^\r\n]{1,1024})$/gm)) {
      if (!value.includes(" ")) continue;
      const found = plain(value, 0, value, '"');
      if (found) this.remember(found.uri);
    }
  }
  private remember(uri: string) {
    const known = this.recent.get(uri);
    if (known !== undefined) {
      this.recent.delete(known);
      this.recent.set(known, known);
      return;
    }
    if (this.recent.size >= capacity) this.recent.delete(this.recent.keys().next().value!);
    // Own the small spelling without retaining a tool output through a substring.
    const owned = Buffer.from(uri).toString();
    this.recent.set(owned, owned);
    this.revision = ++revision;
  }
}
