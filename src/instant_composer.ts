import type { Surface } from "./pane/surface";
import type { Provider } from "./providers";
import * as keys from "./keys";
import * as text_area from "./text_area";
import * as text from "./text";
import * as keyboard from "./keyboard";
import * as viewer_native from "./viewer_native";

/** A proposed draft, never application state. Only matching remote pixels confirm it. */
export interface Draft {
  text: string;
  cursor: number;
  goal?: number;
}
export interface Layout {
  lines: string[];
  cursor: { x: number; y: number };
  starts: number[];
}
export interface Composer {
  provider: Provider;
  top: number;
  height: number;
  width: number;
  lines: string[];
  cursor: { x: number; y: number };
  surface: Surface;
}

/** These adapters deliberately exclude Unicode line-breaking, rich input elements,
 * custom prompts and completion menus. A changed agent UI falls back to remote echo. */
export function inspect(surface: Surface, provider: Provider): Composer | null {
  if (provider !== "codex" && provider !== "claude") return null;
  const { cols } = surface;
  let cursor = surface.cursor;
  if (cols < 12 || (!cursor && provider !== "claude")) return null;
  const rows = surface.lines.map(line => Bun.stripANSI(line));
  const prompt = provider === "codex" ? "› " : "❯\u00a0";
  let top = -1;
  for (let y = 0; y <= (cursor?.y ?? rows.length - 1); y++) if (rows[y]?.startsWith(prompt)) top = y;
  if (top < 1) return null;
  const rule = (row: string) => /^─{10,}$/.test(row.trim());
  let end = top + 1;
  if (provider === "claude") {
    if (!rule(rows[top - 1])) return null;
    while (end < rows.length && !rule(rows[end])) end++;
    if (end === rows.length) return null;
  } else {
    if (rows[top - 1].trim()) return null;
    // The footer bounds the box even when hard newlines leave empty rows below
    // the caret. A blank row by itself is not necessarily the end of the draft.
    const footer = rows.findLastIndex(
      (row, i) => i > top + 1 && !rows[i - 1].trim() && /shortcuts|context left|tab to queue|GPT-|gpt-/.test(row),
    );
    if (footer < 0) return null;
    end = footer - 1;
  }
  if (end - top > 8) return null;
  cursor ??= paintedCaret(surface.lines, top, end);
  if (!cursor || cursor.y < top || cursor.y >= end || cursor.x < 2) return null;
  const footer = rows.slice(end).join("\n");
  if (/enter to (?:select|confirm|submit)|esc to cancel|\b(?:NORMAL|VISUAL|INSERT)\b/.test(footer)) return null;
  const width = cols - (provider === "codex" ? 3 : 4);
  if (cursor.x > width + 2) return null;
  for (let y = top + 1; y < end; y++) if (!rows[y].startsWith("  ")) return null;
  const lines = rows.slice(top, end).map(row => row.slice(2).trimEnd());
  // A recognized empty placeholder is decoration, including when confirming edits.
  if (end === top + 1 && cursor.y === top && cursor.x === 2 && /\x1b\[2m/.test(surface.lines[top])) lines[0] = "";
  return {
    provider,
    top,
    height: end - top,
    width,
    surface,
    lines,
    cursor: { x: cursor.x - 2, y: cursor.y - top },
  };
}

/** Claude hides the terminal cursor and paints one inverted cell in its box.
 * Surfaces serialize resolved colors, so inverse video appears as swapped RGBs. */
function paintedCaret(lines: string[], top: number, end: number): Surface["cursor"] {
  const colors = /^\x1b\[0;38;2;(\d+;\d+;\d+);48;2;(\d+;\d+;\d+)m/.exec(lines[top]);
  if (!colors || colors[1] === colors[2]) return null;
  let cursor: Surface["cursor"] = null;
  for (let y = top; y < end; y++) {
    for (const run of lines[y].matchAll(/\x1b\[0;38;2;(\d+;\d+;\d+);48;2;(\d+;\d+;\d+)m([^\x1b]*)/g)) {
      if (run[1] !== colors[2] || run[2] !== colors[1]) continue;
      // Selections, multiple highlights, and rich input are not a caret.
      if (cursor || !/^[\x20-\x7e]$/.test(run[3])) return null;
      cursor = { x: text.displayWidth(Bun.stripANSI(lines[y].slice(0, run.index))), y };
    }
  }
  return cursor;
}

export function seed(composer: Composer): Draft | null {
  if (composer.height !== 1) {
    const value = composer.lines.join("\n");
    if (!plain(value) || /[\[\]]/.test(value)) return null;
    const draft = locate(composer, value);
    if (!draft) return null;
    // Short rows can prove hard breaks. If either soft join produces the same
    // pixels, keep waiting for a known draft instead of guessing its newlines.
    for (let row = 1; row < composer.lines.length; row++) {
      for (const separator of ["", " "]) {
        const lines = composer.lines.slice();
        lines.splice(row - 1, 2, lines[row - 1] + separator + lines[row]);
        const joined = wrap({ text: lines.join("\n"), cursor: 0 }, composer.width, composer.provider);
        if (sameLines(composer, joined)) return null;
      }
    }
    return draft;
  }
  const line = composer.lines[0],
    cursor = composer.cursor.x;
  // Never erase an unrecognized placeholder or arbitrary text after the caret.
  if (cursor === 0 && line) return null;
  if (cursor > line.length || !plain(line) || /[\[\]]/.test(line)) return null;
  return { text: line, cursor };
}

/** Recover a moved caret without reconstructing known hard breaks from pixels. */
export function locate(composer: Composer, value: string): Draft | null {
  const layout = wrap({ text: value, cursor: 0 }, composer.width, composer.provider);
  if (!sameLines(composer, layout)) return null;
  const cursor = layout.starts[composer.cursor.y] + composer.cursor.x;
  const draft = { text: value, cursor };
  if (cursor > value.length || !matches(composer, draft)) return null;
  // Hanging spaces can put several logical offsets at the same cell.
  for (const neighbor of [cursor - 1, cursor + 1])
    if (neighbor >= 0 && neighbor <= value.length && matches(composer, { text: value, cursor: neighbor })) return null;
  return draft;
}

function sameLines(composer: Composer, layout: Layout): boolean {
  return layout.lines.length === composer.lines.length && layout.lines.every((line, i) => line === composer.lines[i]);
}

/** Ghostty translates the pane's keyboard protocol to the editor's legacy keys. */
export function input(data: string): string {
  const decoded = keyboard.decode(data);
  return decoded ? viewer_native.encodeKey(null, decoded) : data;
}

function plain(value: string): boolean {
  return /^[\x20-\x7e\n]*$/.test(value) && !/^[!/]/.test(value);
}

/** A completion token only suspends preview while the caret is in that token. */
export function predictable(draft: Draft): boolean {
  const before = draft.text.slice(0, draft.cursor);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n")) + 1;
  return plain(draft.text) && !/[@$]/.test(draft.text[start] ?? "");
}

/** The agents' ordinary ASCII word wrapping, including an insertion row at the edge. */
export function wrap(draft: Draft, width: number, provider: Provider = "codex"): Layout {
  if (draft.text.includes("\n")) {
    const lines: string[] = [],
      starts: number[] = [];
    let offset = 0,
      cursor = { x: 0, y: 0 };
    for (const paragraph of draft.text.split("\n")) {
      const part = wrap(
        { text: paragraph, cursor: Math.max(0, Math.min(paragraph.length, draft.cursor - offset)) },
        width,
        provider,
      );
      if (draft.cursor >= offset) cursor = { x: part.cursor.x, y: lines.length + part.cursor.y };
      lines.push(...part.lines);
      starts.push(...part.starts.map(start => offset + start));
      offset += paragraph.length + 1;
    }
    return { lines, cursor, starts };
  }
  const starts: number[] = [0];
  let start = 0;
  while (draft.text.length - start > width || (provider === "codex" && draft.text.length - start === width)) {
    const limit = start + width;
    let next = limit;
    if (draft.text.length > limit && draft.text[limit] !== " ") {
      const space = draft.text.lastIndexOf(" ", limit - 1);
      const wordEnd = draft.text.indexOf(" ", space + 1);
      const wordLength = (wordEnd < 0 ? draft.text.length : wordEnd) - space - 1;
      if (space >= start && draft.text.slice(start, space).trim() && (provider === "codex" || wordLength <= width))
        next = space + 1;
    }
    // Interior separators hang at the word break; trailing spaces remain editable.
    if (draft.text.slice(next).trim()) while (draft.text[next] === " ") next++;
    starts.push(next);
    start = next;
    if (start >= draft.text.length) break;
  }
  let row = 0;
  for (let i = 1; i < starts.length; i++) if (starts[i] <= draft.cursor) row = i;
  // Codex hangs overflowing separators at the following row's first column.
  if (provider === "codex" && row + 1 < starts.length && draft.cursor - starts[row] >= width) row++;
  return {
    starts,
    lines: starts.map((at, i) =>
      draft.text
        .slice(at, starts[i + 1])
        .slice(0, width)
        .trimEnd(),
    ),
    cursor: { x: Math.max(0, Math.min(provider === "codex" ? width - 1 : width, draft.cursor - starts[row])), y: row },
  };
}

export function edit(
  draft: Draft,
  data: string,
  multiline = true,
  geometry?: Pick<Composer, "width" | "provider">,
): Draft | null {
  data = input(data);
  const key = keys.parse(data);
  const operation =
    (data === "\n" || key === "ctrl_j") && multiline
      ? "newline"
      : key
        ? text_area.key_edits[key]
        : data.length === 1
          ? text_area.byte_edits[data.charCodeAt(0)]
          : undefined;
  const area = new text_area.TextArea(draft.text, multiline);
  area.caret = draft.cursor;
  area.width = 2049;
  if (operation) {
    if (operation === "up" || operation === "down") {
      if (!multiline || !geometry || !predictable(draft)) return null;
      const layout = wrap(draft, geometry.width, geometry.provider);
      const row = layout.cursor.y + (operation === "up" ? -1 : 1);
      if (row < 0 || row >= layout.lines.length) {
        if (layout.lines.length === 1) return null; // May navigate prompt history.
        return geometry.provider === "claude" ? draft : { ...draft, cursor: row < 0 ? 0 : draft.text.length };
      }
      const goal = draft.goal ?? layout.cursor.x;
      return { text: draft.text, cursor: layout.starts[row] + Math.min(layout.lines[row].length, goal), goal };
    }
    if (
      multiline &&
      geometry?.provider === "claude" &&
      ["line_start", "line_end", "line_backspace", "line_delete"].includes(operation)
    ) {
      const layout = wrap(draft, geometry.width, geometry.provider);
      const row = layout.cursor.y;
      const start = layout.starts[row];
      // Include spaces hanging at a soft wrap, but not a hard newline.
      const next = layout.starts[row + 1] ?? draft.text.length;
      const end = draft.text[next - 1] === "\n" ? next - 1 : next;
      switch (operation) {
        case "line_start":
          return { text: draft.text, cursor: start };
        case "line_end":
          return { text: draft.text, cursor: end };
        case "line_backspace": {
          const from = start === draft.cursor ? Math.max(0, start - 1) : start;
          return { text: draft.text.slice(0, from) + draft.text.slice(draft.cursor), cursor: from };
        }
        case "line_delete": {
          const to = end === draft.cursor ? Math.min(draft.text.length, end + 1) : end;
          return { text: draft.text.slice(0, draft.cursor) + draft.text.slice(to), cursor: draft.cursor };
        }
      }
    }
    // Selection and history need application state that is not present in a draft.
    if (operation.startsWith("select_") || ["cut", "up", "down"].includes(operation)) return null;
    if (operation === "newline" && !multiline) return null;
    if (multiline && operation !== "backspace" && !predictable(draft)) return null;
    area.apply(operation);
    if (geometry?.provider === "codex" && area.caret === draft.cursor) {
      if (operation === "line_start") area.caret = 0;
      if (operation === "line_end") area.caret = draft.text.length;
    }
  } else {
    if (!/^[\x20-\x7e]+$/.test(data)) return null;
    area.insert(data);
  }
  return area.text.length <= 2048 && (multiline ? plain(area.text) : /^[\x20-\x7e]*$/.test(area.text))
    ? { text: area.text, cursor: area.caret }
    : null;
}

export function matches(composer: Composer, draft: Draft): boolean {
  const layout = wrap(draft, composer.width, composer.provider);
  return (
    layout.cursor.x === composer.cursor.x &&
    layout.cursor.y === composer.cursor.y &&
    layout.lines.length === composer.lines.length &&
    layout.lines.every((line, i) => line === composer.lines[i])
  );
}

/** Grow the native input box without writing predicted text into the real terminal. */
export function project(composer: Composer, draft: Draft): Surface | null {
  // URL and hyphenation breakpoints differ between provider versions.
  if (draft.text.length >= composer.width && /[-/\\]/.test(draft.text)) return null;
  const layout = wrap(draft, composer.width, composer.provider);
  if (layout.lines.length > 8) return null;
  const { surface, provider } = composer;
  const lines = surface.lines.slice();
  const delta = layout.lines.length - composer.height;
  let top = composer.top;
  const style = surface.lines[composer.top].match(/^\x1b\[[0-9;]*m/)?.[0] ?? "\x1b[0m";
  const blank = style + " ".repeat(surface.cols) + "\x1b[0m";
  if (provider === "claude") {
    // Claude anchors its lower border. Preserve the transcript above the effort row.
    const header = top - 2;
    if (header - delta < 0 || (delta > 0 && lines.slice(header - delta, header).some(row => Bun.stripANSI(row).trim())))
      return null;
    const heading = lines.slice(header, top);
    for (let y = Math.min(header, header - delta); y < top + composer.height; y++) lines[y] = blank;
    top -= delta;
    for (let i = 0; i < heading.length; i++) lines[top - 2 + i] = heading[i];
  } else {
    const tail = lines.slice(top + composer.height);
    let last = tail.length - 1;
    while (last >= 0 && !Bun.stripANSI(tail[last]).trim()) last--;
    const shift = Math.max(0, top + layout.lines.length + last + 1 - surface.rows);
    if (top - shift < 1) return null;
    if (shift) {
      lines.splice(0, shift);
      top -= shift;
    }
    lines.splice(top, composer.height, ...layout.lines.map(() => blank));
    while (lines.length < surface.rows) lines.push(blank);
    lines.length = surface.rows;
  }
  for (const [i, text] of layout.lines.entries()) {
    const prefix = i === 0 ? promptStyle(surface.lines[composer.top]) : style + "  ";
    lines[top + i] = prefix + "\x1b[22m" + text.padEnd(surface.cols - 2) + "\x1b[0m";
  }
  return { ...surface, lines, cursor: { x: layout.cursor.x + 2, y: top + layout.cursor.y } };
}

function promptStyle(line: string): string {
  let prefix = "",
    cells = 0;
  for (const [token] of line.matchAll(/\x1b\[[0-9;]*m|[^\x1b]/gu)) {
    prefix += token;
    if (!token.startsWith("\x1b") && ++cells === 2) break;
  }
  return prefix;
}
