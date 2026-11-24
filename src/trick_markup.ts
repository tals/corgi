import type { Span } from "./tricks";
import * as process_name from "./process_name";
import { Provider, adapter } from "./providers";

/** Icon references name bundled assets, never files or URLs. */
export function icon(reference: string): Span | null {
  if (reference === "unknown") return { text: "?" };
  if (reference.startsWith("provider:")) {
    const provider = Provider.parse(reference.slice(9));
    return provider ? { text: adapter(provider).glyph } : null;
  }
  if (!reference.startsWith("brand:")) return null;
  const mark = process_name.brand(reference.slice(6));
  if (!mark) return null;
  const provider = Provider.all.find(provider => process_name.brandOf(provider) === mark);
  return { text: provider ? adapter(provider).glyph : mark.slice(0, 2), icon: mark, color: { brand: mark } };
}

export function escape(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/gu, " ").replace(/[\\*`!()]/g, "\\$&");
}

/** A bounded inline format: emphasis, code, escapes and bundled icons. */
export function parse(text: string): Span[] {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 512) throw Error("InvalidString");
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text)) throw Error("ControlCharacter");
  const result: Span[] = [];
  let plain = "";
  const push = (span: Span) => {
    if (result.length >= 16) throw Error("InvalidSpans");
    result.push(span);
  };
  const flush = () => {
    if (plain) push({ text: plain });
    plain = "";
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\" && i + 1 < text.length) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (text.startsWith("!(", i)) {
      const end = text.indexOf(")", i + 2);
      const mark = end < 0 ? null : icon(text.slice(i + 2, end));
      if (mark) {
        flush();
        push(mark);
        i = end + 1;
        continue;
      }
    }
    const delimiter = text.startsWith("**", i) ? "**" : text[i] === "*" || text[i] === "`" ? text[i] : "";
    const found = delimiter ? span(text, i + delimiter.length, delimiter) : null;
    if (found) {
      flush();
      push({
        text: found.text,
        ...(delimiter === "**" ? { bold: true } : delimiter === "*" ? { italic: true } : { color: "muted" }),
      });
      i = found.end;
      continue;
    }
    plain += text[i++];
  }
  flush();
  return result;
}
/** The text of a span starting at `start` up to its closing `delimiter`, and
 * where it ends; escapes hide delimiters. Null when empty or unclosed. */
function span(text: string, start: number, delimiter: string): { text: string; end: number } | null {
  let inner = "";
  for (let i = start; i < text.length;) {
    if (text[i] === "\\" && i + 1 < text.length) {
      inner += text[i + 1];
      i += 2;
    } else if (text.startsWith(delimiter, i)) return inner ? { text: inner, end: i + delimiter.length } : null;
    else inner += text[i++];
  }
  return null;
}
