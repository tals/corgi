import type { Surface } from "./pane/surface";
import type { Provider } from "./providers";

/** A proposed draft, never application state. Only matching remote pixels confirm it. */
export interface Draft {
  text: string;
  cursor: number;
}
export interface Layout {
  lines: string[];
  cursor: { x: number; y: number };
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
  const { cols, cursor } = surface;
  if (!cursor || cols < 12) return null;
  const rows = surface.lines.map(line => Bun.stripANSI(line));
  const prompt = provider === "codex" ? "› " : "❯\u00a0";
  let top = -1;
  for (let y = 0; y <= cursor.y; y++) if (rows[y]?.startsWith(prompt)) top = y;
  if (top < 1) return null;
  const rule = (row: string) => /^─{10,}$/.test(row.trim());
  let end = top + 1;
  if (provider === "claude") {
    if (!rule(rows[top - 1])) return null;
    while (end < rows.length && !rule(rows[end])) end++;
    if (end === rows.length) return null;
  } else {
    if (rows[top - 1].trim()) return null;
    // A full final line has an empty continuation row holding the cursor.
    while (end < rows.length && (rows[end].trim() || end <= cursor.y)) end++;
    if (end + 1 >= rows.length || !/shortcuts|context left|tab to queue|GPT-|gpt-/.test(rows[end + 1])) return null;
  }
  if (cursor.y >= end || cursor.x < 2 || end - top > 8) return null;
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

export function seed(composer: Composer): Draft | null {
  if (composer.height !== 1) return null; // Soft and hard breaks cannot be recovered from pixels.
  const line = composer.lines[0],
    cursor = composer.cursor.x;
  // Never erase an unrecognized placeholder or arbitrary text after the caret.
  if (cursor === 0 && line) return null;
  if (cursor > line.length || !plain(line) || /[\[\]]/.test(line)) return null;
  return { text: line, cursor };
}

function plain(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value) && !/^[!/]/.test(value);
}

/** A completion token only suspends preview while the caret is in that token. */
export function predictable(draft: Draft): boolean {
  const before = draft.text.slice(0, draft.cursor);
  const start = before.lastIndexOf(" ") + 1;
  return plain(draft.text) && !/[@$]/.test(draft.text[start] ?? "");
}

/** The agents' ordinary ASCII word wrapping, including an insertion row at the edge. */
export function wrap(draft: Draft, width: number, provider: Provider = "codex"): Layout {
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
    lines: starts.map((at, i) =>
      draft.text
        .slice(at, starts[i + 1])
        .slice(0, width)
        .trimEnd(),
    ),
    cursor: { x: Math.max(0, Math.min(provider === "codex" ? width - 1 : width, draft.cursor - starts[row])), y: row },
  };
}

export function edit(draft: Draft, data: string): Draft | null {
  let { text, cursor } = draft;
  switch (data) {
    case "\x1b[D":
    case "\x1bOD":
      if (!predictable(draft)) return null;
      cursor = Math.max(0, cursor - 1);
      break;
    case "\x1b[C":
    case "\x1bOC":
      if (!predictable(draft)) return null;
      cursor = Math.min(text.length, cursor + 1);
      break;
    case "\x1b[3~":
      if (!predictable(draft)) return null;
      text = text.slice(0, cursor) + text.slice(cursor + 1);
      break;
    case "\x7f":
    case "\b":
      if (cursor === 0) return null;
      text = text.slice(0, cursor - 1) + text.slice(cursor);
      cursor--;
      break;
    // History, paste, submit and modified keys still belong to the agent.
    default:
      if (!/^[\x20-\x7e]+$/.test(data)) return null;
      text = text.slice(0, cursor) + data + text.slice(cursor);
      cursor += data.length;
  }
  return text.length <= 2048 && plain(text) ? { text, cursor } : null;
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
