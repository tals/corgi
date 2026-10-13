//! Syntax colors for the review panel: a small lexer per language family,
//! line by line, carrying block comments and multi-line strings across
//! lines. It colors lazily in chunks and keeps the lexer state at each chunk
//! start, so the middle of a large file colors without lexing the rest.

export type Kind = "keyword" | "string" | "number" | "type" | "function" | "property" | "comment" | "punctuation";
/** `[start, end)` of a line colored as `kind`; uncolored text is plain. */
export type Span = [number, number, Kind];

/** Colors stop after this many characters of a line. */
export const max_line = 2000;
const chunk_lines = 200;

interface Grammar {
  keywords: Set<string>;
  literals: Set<string>;
  types: Set<string>;
  line: string[];
  block: [string, string] | null;
  quotes: string;
  /** String delimiters that may span lines. */
  multiline: string[];
  /** A string running to the end of the line, like Zig's `\\`. */
  line_strings: string[];
  capital_types: boolean;
  /** A prefix that makes a builtin, like Zig's `@import`. */
  builtin: string | null;
  /** Names before `:` or `=` are keys (JSON, YAML, TOML). */
  keys: boolean;
}
const set = (s: string) => new Set(s.split(" "));
const c_like = {
  line: ["//"],
  block: ["/*", "*/"] as [string, string],
  quotes: "\"'",
  multiline: [],
  line_strings: [],
  builtin: null,
  keys: false,
};
const grammars: Record<string, Grammar> = {
  typescript: {
    ...c_like,
    keywords: set(
      "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
    ),
    literals: set("true false null undefined NaN Infinity"),
    types: set("string number boolean bigint any unknown never object symbol Array Promise Record Map Set ReadonlySet"),
    quotes: "\"'",
    multiline: ["`"],
    capital_types: true,
  },
  zig: {
    ...c_like,
    block: null,
    keywords: set(
      "addrspace align allowzero and anyframe asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while",
    ),
    literals: set("true false null undefined"),
    types: set(
      "u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f16 f32 f64 f80 f128 bool void type anyerror anyopaque anytype noreturn comptime_int comptime_float c_int c_uint c_long c_char",
    ),
    line_strings: ["\\\\"],
    capital_types: true,
    builtin: "@",
  },
  rust: {
    ...c_like,
    keywords: set(
      "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
    ),
    literals: set("true false None Some Ok Err"),
    types: set(
      "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box",
    ),
    quotes: '"',
    capital_types: true,
  },
  go: {
    ...c_like,
    keywords: set(
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    ),
    literals: set("true false nil iota"),
    types: set(
      "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any",
    ),
    multiline: ["`"],
    capital_types: false,
  },
  c: {
    ...c_like,
    keywords: set(
      "auto break case class const constexpr continue default delete do else enum explicit extern for goto if inline namespace new noexcept operator override private protected public register return sizeof static struct switch template this throw try typedef typename union using virtual volatile while",
    ),
    literals: set("true false NULL nullptr"),
    types: set(
      "bool char double float int long short signed unsigned void size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t",
    ),
    capital_types: false,
  },
  python: {
    ...c_like,
    line: ["#"],
    block: null,
    keywords: set(
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
    ),
    literals: set("True False None"),
    types: set("int str float bool list dict set tuple bytes object"),
    multiline: ['"""', "'''"],
    capital_types: true,
  },
  shell: {
    ...c_like,
    line: ["#"],
    block: null,
    keywords: set(
      "if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit",
    ),
    literals: set("true false"),
    types: set(""),
    capital_types: false,
  },
  json: {
    ...c_like,
    keywords: set(""),
    literals: set("true false null"),
    types: set(""),
    quotes: '"',
    capital_types: false,
    keys: true,
  },
  yaml: {
    ...c_like,
    line: ["#"],
    block: null,
    keywords: set(""),
    literals: set("true false null yes no"),
    types: set(""),
    capital_types: false,
    keys: true,
  },
  toml: {
    ...c_like,
    line: ["#"],
    block: null,
    keywords: set(""),
    literals: set("true false"),
    types: set(""),
    multiline: ['"""', "'''"],
    capital_types: false,
    keys: true,
  },
  css: {
    ...c_like,
    line: [],
    keywords: set("important media import"),
    literals: set(""),
    types: set(""),
    capital_types: false,
    keys: true,
  },
};
const extensions: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "typescript",
  jsx: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  zig: "zig",
  zon: "zig",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  hpp: "c",
  m: "c",
  mm: "c",
  swift: "c",
  java: "c",
  kt: "c",
  cs: "c",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  json: "json",
  jsonc: "json",
  lock: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  css: "css",
  scss: "css",
  md: "markdown",
  markdown: "markdown",
};
/** The language a path colors as, or null for plain text. */
export function language(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Makefile" || name === "Dockerfile") return "shell";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (extensions[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

interface State {
  /** Inside a block comment. */
  block: boolean;
  /** Inside a string that spans lines, closed by this delimiter. */
  string: string | null;
  /** Inside a Markdown code fence. */
  fence: boolean;
}
const start: State = { block: false, string: null, fence: false };

const word = /[A-Za-z_$][\w$]*/y;
const number = /0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y;
const punctuation = /[{}()[\];,.:<>=+\-*/%!&|^~?]+/y;

function stringEnd(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\" && quote !== "'''" && quote !== '"""') i++;
    else if (line.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
}
function nextChar(line: string, from: number): string {
  for (let i = from; i < line.length; i++) if (line[i] !== " " && line[i] !== "\t") return line[i];
  return "";
}
function prevChar(line: string, before: number): string {
  for (let i = before - 1; i >= 0; i--) if (line[i] !== " " && line[i] !== "\t") return line[i];
  return "";
}

/** Lexes one line from `state`, returning its spans and the state after it. */
export function lexLine(lang: string, full: string, state: State): { spans: Span[]; state: State } {
  if (lang === "markdown") return markdown(full, state);
  const g = grammars[lang];
  const line = full.length > max_line ? full.slice(0, max_line) : full;
  const spans: Span[] = [];
  const next: State = { ...state };
  let i = 0;
  if (next.block && g.block) {
    const close = line.indexOf(g.block[1]);
    if (close < 0) return { spans: [[0, line.length, "comment"]], state: next };
    spans.push([0, close + g.block[1].length, "comment"]);
    i = close + g.block[1].length;
    next.block = false;
  }
  if (next.string !== null) {
    const end = stringEnd(line, 0, next.string);
    if (end < 0) return { spans: [[0, line.length, "string"]], state: next };
    spans.push([0, end, "string"]);
    i = end;
    next.string = null;
  }
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (g.line.some(p => line.startsWith(p, i)) && !(lang === "shell" && i > 0 && /\S/.test(line[i - 1]))) {
      spans.push([i, line.length, "comment"]);
      break;
    }
    if (g.line_strings.some(p => line.startsWith(p, i))) {
      spans.push([i, line.length, "string"]);
      break;
    }
    if (g.block && line.startsWith(g.block[0], i)) {
      const close = line.indexOf(g.block[1], i + g.block[0].length);
      if (close < 0) {
        spans.push([i, line.length, "comment"]);
        next.block = true;
        break;
      }
      spans.push([i, close + g.block[1].length, "comment"]);
      i = close + g.block[1].length;
      continue;
    }
    const multi = g.multiline.find(d => line.startsWith(d, i));
    if (multi) {
      const end = stringEnd(line, i + multi.length, multi);
      if (end < 0) {
        spans.push([i, line.length, "string"]);
        next.string = multi;
        break;
      }
      spans.push([i, end, "string"]);
      i = end;
      continue;
    }
    if (g.quotes.includes(ch)) {
      const end = stringEnd(line, i + 1, ch);
      const stop = end < 0 ? line.length : end;
      spans.push([i, stop, g.keys && /[:=]/.test(nextChar(line, stop)) ? "property" : "string"]);
      i = stop;
      continue;
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(line[i + 1] ?? ""))) {
      number.lastIndex = i;
      const m = number.exec(line);
      const end = m ? i + m[0].length : i + 1;
      spans.push([i, end, "number"]);
      i = end;
      continue;
    }
    if (g.builtin && line.startsWith(g.builtin, i)) {
      word.lastIndex = i + g.builtin.length;
      const m = word.exec(line);
      if (m) {
        spans.push([i, i + g.builtin.length + m[0].length, "function"]);
        i += g.builtin.length + m[0].length;
        continue;
      }
    }
    word.lastIndex = i;
    const w = word.exec(line);
    if (w) {
      const name = w[0],
        end = i + name.length,
        after = nextChar(line, end);
      let kind: Kind | null = null;
      if (g.keys && (after === ":" || after === "=") && (lang !== "css" || prevChar(line, i) !== ":"))
        kind = "property";
      else if (g.keywords.has(name)) kind = "keyword";
      else if (g.literals.has(name)) kind = "number";
      else if (g.types.has(name) || (g.capital_types && /^[A-Z][a-z]/.test(name))) kind = "type";
      else if (after === "(") kind = "function";
      if (kind) spans.push([i, end, kind]);
      i = end;
      continue;
    }
    punctuation.lastIndex = i;
    const p = punctuation.exec(line);
    if (p) {
      spans.push([i, i + p[0].length, "punctuation"]);
      i += p[0].length;
      continue;
    }
    i++;
  }
  return { spans, state: next };
}

function markdown(full: string, state: State): { spans: Span[]; state: State } {
  const line = full.length > max_line ? full.slice(0, max_line) : full;
  const next: State = { ...state };
  if (/^\s*(```|~~~)/.test(line)) {
    next.fence = !state.fence;
    return { spans: [[0, line.length, "punctuation"]], state: next };
  }
  if (state.fence) return { spans: [[0, line.length, "string"]], state: next };
  const heading = /^#{1,6}\s/.exec(line);
  if (heading) return { spans: [[0, line.length, "keyword"]], state: next };
  const spans: Span[] = [];
  const bullet = /^\s*(?:[-*+]|\d+[.)])\s/.exec(line) ?? /^\s*>/.exec(line);
  if (bullet) spans.push([0, bullet[0].length, "punctuation"]);
  const inline = /`[^`]*`|\]\([^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(line)))
    spans.push(
      m[0][0] === "`" ? [m.index, m.index + m[0].length, "string"] : [m.index + 1, m.index + m[0].length, "string"],
    );
  return { spans, state: next };
}

/** Colors one side of a file on demand, a chunk at a time. */
export class Highlighter {
  private states: State[] = [start];
  private chunks = new Map<number, Span[][]>();
  constructor(
    private lang: string | null,
    private lines: string[],
  ) {}
  spans(index: number): Span[] {
    if (this.lang === null || index < 0 || index >= this.lines.length) return [];
    const chunk = Math.floor(index / chunk_lines);
    let spans = this.chunks.get(chunk);
    if (!spans) {
      // Lex forward from the last chunk whose start state is known.
      for (let at = this.states.length - 1; at <= chunk; at++) {
        if (this.chunks.has(at) && this.states[at + 1]) continue;
        let state = this.states[at];
        const out: Span[][] = [];
        for (let i = at * chunk_lines; i < Math.min(this.lines.length, (at + 1) * chunk_lines); i++) {
          const lexed = lexLine(this.lang, this.lines[i], state);
          out.push(lexed.spans);
          state = lexed.state;
        }
        this.chunks.set(at, out);
        this.states[at + 1] = state;
      }
      spans = this.chunks.get(chunk)!;
    }
    return spans[index - chunk * chunk_lines] ?? [];
  }
}
