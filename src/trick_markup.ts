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
    const end = delimiter ? text.indexOf(delimiter, i + delimiter.length) : -1;
    if (end > i + delimiter.length) {
      flush();
      push({
        text: text.slice(i + delimiter.length, end),
        ...(delimiter === "**" ? { bold: true } : delimiter === "*" ? { italic: true } : { color: "muted" }),
      });
      i = end + delimiter.length;
      continue;
    }
    plain += text[i++];
  }
  flush();
  return result;
}
