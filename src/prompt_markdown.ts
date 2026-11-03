//! A reply's Markdown as thread lines. marked parses it as pi-tui sets it up
//! for Pi: strikethrough takes two tildes, `$…$` math shows as Unicode, and
//! a streaming code block's half-typed closing fence waits. Corgi lays it
//! out: wrapped by its text area, colored from the palette, and code colored
//! as the review panel colors it.
import { renderLatex } from "@earendil-works/pi-tui/dist/latex.js";
import { Marked, type MarkedToken, type Token, type TokenizerExtension, type Tokens } from "marked";
import * as palette from "./palette";
import { fence } from "./prompt_conversations";
import * as syntax from "./review/syntax";
import { TextArea } from "./text_area";
import { displayWidth } from "./text";
import * as reference from "./review/reference";

export type Seg = { text: string; style: string; review?: reference.Reference };
/** A thread line: its runs, and when it goes on with the line above once
 * copied, what joins them and how many of its columns are only indent. A
 * `conversations` block comes out whole, for the prompt to draw as a list. */
export type Line = Text | { conversations: string[] };
type Text = { segs: Seg[]; cont?: { join: string; skip: number } };

/** Math that pi-tui's tokenizers found; `pending` while it's unclosed. */
type Latex = { type: "latex" | "latexBlock"; raw: string; text: string; pending?: boolean };
type Tok = MarkedToken | Latex;
const kids = (tokens: Token[] | undefined) => (tokens ?? []) as Tok[];

// The tokenizers are pi-tui's (MIT, Mario Zechner), so replies parse as they
// do in Pi.
const strict_del = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
function escaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && source[at] === "\\"; at--) slashes++;
  return slashes % 2 === 1;
}
function closing(source: string, mark: string, from: number): number {
  let at = source.indexOf(mark, from);
  while (at >= 0 && escaped(source, at)) at = source.indexOf(mark, at + mark.length);
  return at;
}
/** Unclosed `$…` that reads as math on its way, not as a price. */
function mathy(source: string): boolean {
  return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}
const inline_marks: [string, string][] = [
  ["$$", "$$"],
  ["\\(", "\\)"],
  ["\\[", "\\]"],
];
function inlineLatex(source: string): Latex | undefined {
  const [open, close] =
    inline_marks.find(([open]) => source.startsWith(open)) ??
    (source.startsWith("$") && !/^\$\s/.test(source) ? ["$", "$"] : ["", ""]);
  if (!open) return undefined;
  const end = closing(source, close, open.length);
  if (end >= 0 && open === "$") {
    // Prices, shell variables and code stay text: "$5 and $10", "$HOME/bin".
    const body = source.slice(1, end),
      after = source.slice(end + 1);
    if (
      /\s$/.test(body) ||
      /^\d/.test(after) ||
      (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(body) && /^[A-Za-z_][A-Za-z0-9_]*/.test(after)) ||
      body.includes("`")
    )
      return undefined;
  }
  if (end < 0) {
    const pending = source.slice(open.length);
    return open.startsWith("\\") || mathy(pending)
      ? { type: "latex", raw: source, text: pending, pending: true }
      : undefined;
  }
  const text = source.slice(open.length, end);
  if (!text || text.includes("\n")) return undefined;
  return { type: "latex", raw: source.slice(0, end + close.length), text };
}
function blockLatex(source: string): Latex | undefined {
  const dollars = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
  if (dollars?.[1]) return { type: "latexBlock", raw: dollars[0], text: dollars[1].trim() };
  const brackets = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
  if (brackets?.[1]) return { type: "latexBlock", raw: brackets[0], text: brackets[1].trim() };
  const open_brackets = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (open_brackets) return { type: "latexBlock", raw: open_brackets[0], text: open_brackets[1], pending: true };
  const open_dollars = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (open_dollars?.[1] && mathy(open_dollars[1]))
    return { type: "latexBlock", raw: open_dollars[0], text: open_dollars[1], pending: true };
  return undefined;
}
const latex: TokenizerExtension[] = [
  {
    name: "latexBlock",
    level: "block",
    start(source) {
      const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
      return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
    },
    tokenizer: blockLatex,
  },
  {
    name: "latex",
    level: "inline",
    start(source) {
      const at = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(i => i >= 0);
      return at.length ? Math.min(...at) : undefined;
    },
    tokenizer: inlineLatex,
  },
];
const parser = new Marked({
  tokenizer: {
    // Only between two tildes: "~5 to ~10 minutes" stays as typed.
    del(source) {
      const match = strict_del.exec(source);
      if (!match) return undefined;
      return { type: "del", raw: match[0], text: match[2], tokens: this.lexer.inlineTokens(match[2]) };
    },
  },
  extensions: latex,
});
/** A streaming code block's half-typed closing fence, dropped so the block
 * doesn't grow a line of backticks and lose it again. */
function trimFence(tokens: Tok[]): void {
  const last = tokens.at(-1);
  if (last?.type === "list") return trimFence(kids(last.items.at(-1)?.tokens));
  if (last?.type === "blockquote") return trimFence(kids(last.tokens));
  if (last?.type !== "code") return;
  const fence = /^(`{3,}|~{3,})/.exec(last.raw)?.[1],
    tail = last.raw.split("\n").pop();
  if (!fence || !tail || tail.length >= fence.length || tail !== fence[0].repeat(tail.length)) return;
  last.text = last.text.slice(0, -tail.length).replace(/\n$/, "");
}

/** While a reply streams, its last line's open `**`, `~~` and code span
 * close, and a mark nothing follows yet waits, so text doesn't flip between
 * plain and styled as the rest arrives. */
export function settle(text: string): string {
  let fenced = false;
  for (const line of text.split("\n")) if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fenced = !fenced;
  if (fenced) return text;
  const from = text.lastIndexOf("\n") + 1;
  let line = text.slice(from);
  const open: { mark: string; at: number }[] = [];
  let code: { mark: string; at: number } | null = null;
  for (let i = 0; i < line.length;) {
    if (line[i] === "`") {
      let end = i;
      while (line[end] === "`") end++;
      const mark = line.slice(i, end);
      if (!code) code = { mark, at: i };
      else if (mark === code.mark) code = null;
      i = end;
    } else if (code) i++;
    else if (line[i] === "\\") i += 2;
    else if (line.startsWith("**", i) || line.startsWith("~~", i)) {
      const mark = line.slice(i, i + 2);
      if (open.at(-1)?.mark === mark) open.pop();
      else open.push({ mark, at: i });
      i += 2;
    } else i++;
  }
  // Half a `**` or `~~`: after a space it's opening, and after text it's
  // closing one that's open; otherwise it may end `*italic*`.
  const half = /(^|[^*~])([*~])$/.exec(line);
  if (half && !code && (/^\s?$/.test(half[1]) || open.some(m => m.mark === half[2].repeat(2))))
    line = line.slice(0, -1);
  // A code span opens inside the marks before it, so it closes first.
  const marks = code ? [...open, code] : open;
  while (marks.length && !line.slice(marks.at(-1)!.at + marks.at(-1)!.mark.length).trim())
    line = line.slice(0, marks.pop()!.at);
  return (
    text.slice(0, from) +
    line +
    marks
      .reverse()
      .map(m => m.mark)
      .join("")
  );
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  larr: "←",
  rarr: "→",
  times: "×",
};
/** Text with its HTML entities as what they name: marked leaves them for a browser. */
function decode(text: string): string {
  return text.replace(/&(#\d+|#[xX][\da-fA-F]+|[A-Za-z]+);/g, (whole, name: string) => {
    if (name[0] !== "#") return entities[name] ?? whole;
    const code = /^#[xX]/.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

type Look = {
  fg: palette.Token;
  bg?: palette.Token;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};
let styles = new Map<string, string>(),
  generation = 0;
palette.derived(() => {
  styles = new Map();
  generation++;
});
/** A look's escape, or with `kind` its code color over it. */
function sgr(look: Look, kind?: syntax.Kind): string {
  const key = [look.fg, look.bg, look.bold, look.italic, look.underline, look.strike, kind].join(" ");
  let out = styles.get(key);
  if (out === undefined) {
    out = new palette.Style({ ...look, bg: look.bg ?? "bg" }).sgr();
    if (kind) out += palette.fgRgb(palette.syntax[kind]);
    styles.set(key, out);
  }
  return out;
}
const width = (segs: Seg[]) => segs.reduce((n, seg) => n + displayWidth(seg.text), 0);
const plain = (segs: Seg[]) => segs.map(seg => seg.text).join("");

/** Inline tokens as runs; a hard or soft line break as "\n". */
function inline(tokens: Tok[], look: Look, out: Seg[] = [], recognize = true): Seg[] {
  const put = (text: string, as = look) => {
    if (text) out.push({ text, style: sgr(as) });
  };
  for (const t of tokens)
    switch (t.type) {
      case "text":
        if (t.tokens?.length) inline(kids(t.tokens), look, out, recognize);
        else {
          const text = decode(t.text);
          let at = 0;
          for (const match of recognize ? reference.mentions(text) : []) {
            put(text.slice(at, match.start));
            out.push({
              text: text.slice(match.start, match.end),
              style: sgr(look),
              review: match.ref,
            });
            at = match.end;
          }
          put(text.slice(at));
        }
        break;
      case "escape":
        put(t.text);
        break;
      case "strong":
        inline(kids(t.tokens), { ...look, fg: "strong", bold: true }, out, recognize);
        break;
      case "em":
        inline(kids(t.tokens), { ...look, italic: true }, out, recognize);
        break;
      case "del":
        inline(kids(t.tokens), { ...look, strike: true }, out, recognize);
        break;
      case "codespan": {
        const ref = recognize ? reference.code(t.text) : null;
        out.push({
          text: ref ? reference.label(ref) : t.text.replace(/\n/g, " "),
          style: sgr({ fg: "strong", bg: "surface", bold: look.bold, underline: !!ref && !ref.implicit }),
          ...(ref ? { review: ref } : {}),
        });
        break;
      }
      case "link": {
        const target = reference.parse(t.href) ?? reference.code(t.href);
        const ref = target ? { folder: target.folder, source: target.source } : null;
        const parts = inline(kids(t.tokens), { ...look, underline: true }, [], false);
        out.push(...parts.map(({ review: _review, ...seg }) => (ref ? { ...seg, review: ref } : seg)));
        // An address shown as itself doesn't follow in parentheses.
        if (!ref && t.text !== t.href && t.text !== t.href.replace(/^(mailto:|https?:\/\/)/, ""))
          put(` (${t.href})`, { fg: "faint" });
        break;
      }
      case "image":
        put(t.text || t.href, { fg: "muted", italic: true });
        break;
      case "br":
        put("\n");
        break;
      case "html":
        put(t.raw);
        break;
      case "latex":
        put(t.pending ? t.raw : (renderLatex(t.text) ?? t.raw));
        break;
      case "checkbox":
        break;
      default:
        if ("text" in t && typeof t.text === "string") put(decode(t.text));
    }
  return out;
}
/** Runs split at their line breaks. */
function split(segs: Seg[]): Seg[][] {
  const out: Seg[][] = [[]];
  for (const seg of segs)
    seg.text.split("\n").forEach((text, i) => {
      if (i) out.push([]);
      if (text) out.at(-1)!.push({ ...seg, text });
    });
  return out;
}
/** The runs of `segs` between offsets `start` and `end` of their text. */
function slice(segs: Seg[], start: number, end: number): Seg[] {
  const out: Seg[] = [];
  let at = 0;
  for (const seg of segs) {
    const from = Math.max(start, at),
      to = Math.min(end, at + seg.text.length);
    if (from < to) out.push({ ...seg, text: seg.text.slice(from - at, to - at) });
    at += seg.text.length;
  }
  return out;
}
/** Runs broken between words to lines `room` wide, each after the first
 * with the spaces its break took. */
function wrap(segs: Seg[], room: number): { segs: Seg[]; join: string | null }[] {
  const text = plain(segs),
    lines = new TextArea(text).lines(Math.max(1, room));
  return lines.map((line, i) => ({
    segs: slice(segs, line.start, line.end),
    join: i ? text.slice(lines[i - 1].end, line.start) : null,
  }));
}

/** Where lines go: after `first` until one has, then after `rest`. */
type Pen = { first: Seg[]; rest: Seg[]; used: boolean };
type Ctx = { out: Line[]; room: number; base: Look; depth: number; pen: Pen };
const room = (c: Ctx) => Math.max(1, c.room - width(c.pen.rest));
function put(c: Ctx, segs: Seg[], join: string | null = null): void {
  const lead = c.pen.used ? c.pen.rest : c.pen.first;
  c.pen.used = true;
  const line: Text = { segs: [...lead, ...segs] };
  if (join !== null) line.cont = { join, skip: width(c.pen.rest) };
  c.out.push(line);
}
/** Runs as lines: at their breaks, then between words. */
function flow(c: Ctx, segs: Seg[]): void {
  for (const part of split(segs)) for (const piece of wrap(part, room(c))) put(c, piece.segs, piece.join);
}
/** A context whose lines also go after `first`, then `rest`. */
function within(c: Ctx, first: Seg[], rest: Seg[], base = c.base, depth = c.depth): Ctx {
  const lead = c.pen.used ? c.pen.rest : c.pen.first;
  return { ...c, base, depth, pen: { first: [...lead, ...first], rest: [...c.pen.rest, ...rest], used: false } };
}
function blocks(c: Ctx, tokens: Tok[], tight = false): void {
  let last: Tok | null = null,
    spaced = false;
  for (const t of tokens) {
    if (t.type === "space") {
      spaced = true;
      continue;
    }
    if (t.type === "def" || t.type === "checkbox") continue;
    // Blocks are a blank line apart, but not in a tight list's items, nor
    // a list from the line that runs into it.
    const runs_in = (last?.type === "paragraph" || last?.type === "text") && t.type === "list";
    if (last && !tight && (spaced || !runs_in)) put(c, []);
    block(c, t);
    last = t;
    spaced = false;
  }
}
function block(c: Ctx, t: Tok): void {
  switch (t.type) {
    case "paragraph":
      return flow(c, inline(kids(t.tokens), c.base));
    case "text":
      return flow(c, t.tokens ? inline(kids(t.tokens), c.base) : [{ text: decode(t.text), style: sgr(c.base) }]);
    case "heading": {
      const look: Look =
        t.depth === 1
          ? { fg: "strong", bold: true, underline: true }
          : t.depth === 2
            ? { fg: "strong", bold: true }
            : { fg: "text", bold: true };
      return flow(c, inline(kids(t.tokens), look));
    }
    case "code":
      return code(c, t);
    case "latexBlock": {
      const shown = (!t.pending && renderLatex(t.text, { display: true })) || t.raw.trim();
      return flow(c, [{ text: shown, style: sgr(c.base) }]);
    }
    case "list":
      return list(c, t);
    case "table":
      return table(c, t);
    case "blockquote": {
      const bar = [{ text: "│ ", style: sgr({ fg: "line" }) }],
        inner = within(c, bar, bar, { fg: "muted" });
      blocks(inner, kids(t.tokens));
      c.pen.used ||= inner.pen.used;
      return;
    }
    case "hr":
      return put(c, [{ text: "─".repeat(room(c)), style: sgr({ fg: "line" }) }]);
    case "html":
      return flow(c, [{ text: t.raw.trimEnd(), style: sgr({ fg: "muted" }) }]);
    default:
      if ("text" in t && typeof t.text === "string") flow(c, [{ text: decode(t.text), style: sgr(c.base) }]);
  }
}
const bullets = ["•", "◦", "▪"];
function list(c: Ctx, t: Tokens.List): void {
  const start = t.start === "" ? 1 : t.start,
    marks = t.items.map((item, i) => {
      const box = item.task ? (item.checked ? "☑" : "☐") : "";
      if (t.ordered) return box ? `${start + i}. ${box}` : `${start + i}.`;
      return box || bullets[c.depth % bullets.length];
    }),
    w = Math.max(...marks.map(displayWidth));
  t.items.forEach((item, i) => {
    if (i && t.loose) put(c, []);
    const mark = " ".repeat(w - displayWidth(marks[i])) + marks[i] + " ",
      inner = within(
        c,
        [{ text: mark, style: sgr({ fg: "muted" }) }],
        [{ text: " ".repeat(w + 1), style: sgr(c.base) }],
        c.base,
        c.depth + 1,
      );
    blocks(inner, kids(item.tokens), !t.loose);
    if (!inner.pen.used) put(inner, []);
    c.pen.used = true;
  });
}
/** Fence names the review panel's file extensions don't spell. */
const languages: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  shell: "sh",
  console: "sh",
  shellsession: "sh",
  "c++": "cpp",
  objc: "m",
  kotlin: "kt",
  csharp: "cs",
};
function language(info: string): string | null {
  const name = info.toLowerCase();
  return name ? syntax.language(`code.${languages[name] ?? name}`) : null;
}
function code(c: Ctx, t: Tokens.Code): void {
  if (t.lang?.trim() === "commits") {
    // Older agents used a special fence. Keep its references as ordinary inline links.
    const segs: Seg[] = [];
    for (const value of t.text
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)) {
      if (segs.length) segs.push({ text: ", ", style: sgr(c.base) });
      const ref = reference.parse(value) ?? reference.code(value);
      segs.push({
        text: ref ? reference.label(ref) : value,
        style: sgr({ ...c.base, underline: !!ref && !ref.implicit }),
        ...(ref ? { review: ref } : {}),
      });
    }
    flow(c, segs);
    return;
  }
  const info = /^\S*/.exec(t.lang ?? "")![0];
  if (info === fence) {
    c.out.push({ conversations: t.text.split("\n") });
    c.pen.used = true;
    return;
  }
  const lang = language(info),
    lines = t.text.replace(/\t/g, "    ").split("\n"),
    lit = new syntax.Highlighter(lang, lines),
    look: Look = { fg: lang ? "text" : "muted" },
    pad = [{ text: "  ", style: sgr(c.base) }],
    inner = within(c, pad, pad);
  lines.forEach((line, i) => {
    const segs: Seg[] = [];
    let at = 0;
    for (const [start, end, kind] of lit.spans(i)) {
      if (start > at) segs.push({ text: line.slice(at, start), style: sgr(look) });
      segs.push({ text: line.slice(Math.max(start, at), end), style: sgr(look, kind) });
      at = end;
    }
    if (at < line.length) segs.push({ text: line.slice(at), style: sgr(look) });
    for (const piece of wrap(segs, room(inner))) put(inner, piece.segs, piece.join);
  });
  c.pen.used = true;
}
function table(c: Ctx, t: Tokens.Table): void {
  const n = t.header.length,
    cells = room(c) - (3 * n + 1);
  if (!n) return;
  if (cells < n) return flow(c, [{ text: t.raw.trimEnd(), style: sgr(c.base) }]);
  const rows = [
      t.header.map(cell => inline(kids(cell.tokens), { fg: "strong", bold: true })),
      ...t.rows.map(row => row.map(cell => inline(kids(cell.tokens), c.base))),
    ],
    widths = columns(rows, n, cells),
    laid = rows.map(row => widths.map((w, i) => split(row[i] ?? []).flatMap(part => wrap(part, w).map(p => p.segs)))),
    border = sgr({ fg: "line" }),
    blank = sgr(c.base),
    rule = (left: string, mid: string, right: string) =>
      put(c, [{ text: left + widths.map(w => "─".repeat(w)).join(mid) + right, style: border }]),
    // Rows a line apart when one wraps, so they don't run together.
    tall = laid.slice(1).some(row => row.some(cell => cell.length > 1));
  rule("┌─", "─┬─", "─┐");
  laid.forEach((row, r) => {
    if (r === 1) rule("├─", "─┼─", "─┤");
    else if (r > 1 && tall) rule("├─", "─┼─", "─┤");
    const h = Math.max(1, ...row.map(cell => cell.length));
    for (let k = 0; k < h; k++) {
      const segs: Seg[] = [{ text: "│ ", style: border }];
      row.forEach((cell, i) => {
        if (i) segs.push({ text: " │ ", style: border });
        const text = cell[k] ?? [],
          gap = widths[i] - width(text),
          left = t.align[i] === "right" ? gap : t.align[i] === "center" ? Math.floor(gap / 2) : 0;
        if (left > 0) segs.push({ text: " ".repeat(left), style: blank });
        segs.push(...text);
        if (gap - left > 0) segs.push({ text: " ".repeat(gap - left), style: blank });
      });
      segs.push({ text: " │", style: border });
      put(c, segs);
    }
  });
  rule("└─", "─┴─", "─┘");
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** Column widths, as pi-tui fits them: each as wide as its widest cell when
 * that fits, otherwise shrunk toward its longest word (at most 30), each in
 * proportion to what it would give up. */
function columns(rows: Seg[][][], n: number, room: number): number[] {
  const natural = Array<number>(n).fill(0),
    words = Array<number>(n).fill(1);
  for (const row of rows)
    for (let i = 0; i < n; i++) {
      const text = plain(row[i] ?? []);
      natural[i] = Math.max(natural[i], ...text.split("\n").map(displayWidth));
      words[i] = Math.max(words[i], Math.min(30, Math.max(0, ...text.split(/\s+/).map(displayWidth))));
    }
  let least = words;
  if (sum(least) > room) {
    least = Array<number>(n).fill(1);
    const spare = room - n,
      weight = sum(words.map(w => w - 1));
    if (spare > 0) {
      const grow = words.map(w => (weight > 0 ? Math.floor(((w - 1) / weight) * spare) : 0));
      least = least.map((w, i) => w + grow[i]);
      for (let i = 0, left = spare - sum(grow); left > 0 && i < n; i++, left--) least[i]++;
    }
  }
  if (sum(natural) <= room) return natural.map((w, i) => Math.max(w, least[i]));
  const potential = sum(natural.map((w, i) => Math.max(0, w - least[i]))),
    extra = Math.max(0, room - sum(least)),
    out = least.map((w, i) => w + (potential > 0 ? Math.floor((Math.max(0, natural[i] - w) / potential) * extra) : 0));
  for (let left = room - sum(out); left > 0;) {
    let grew = false;
    for (let i = 0; i < n && left > 0; i++)
      if (out[i] < natural[i]) {
        out[i]++;
        left--;
        grew = true;
      }
    if (!grew) break;
  }
  return out;
}

/** `text` as lines `room` wide; a reply still streaming closes what it left open. */
export function layout(text: string, room: number, partial = false): Line[] {
  const tokens = parser.lexer(partial ? settle(text) : text) as Tok[];
  if (partial) trimFence(tokens);
  const c: Ctx = { out: [], room, base: { fg: "text" }, depth: 0, pen: { first: [], rest: [], used: false } };
  blocks(c, tokens);
  return c.out.length ? c.out : [{ segs: [] }];
}
const laid = new WeakMap<object, { text: string; room: number; partial: boolean; generation: number; lines: Line[] }>();
/** A reply's lines, kept while its text, the room and the palette stay the same. */
export function lines(reply: { text: string; partial: boolean }, room: number): Line[] {
  const kept = laid.get(reply);
  if (
    kept?.text === reply.text &&
    kept.room === room &&
    kept.partial === reply.partial &&
    kept.generation === generation
  )
    return kept.lines;
  const out = layout(reply.text, room, reply.partial);
  laid.set(reply, { text: reply.text, room, partial: reply.partial, generation, lines: out });
  return out;
}
