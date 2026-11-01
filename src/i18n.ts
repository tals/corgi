//! Ordinary template tags; catalogs contain generated native template functions.
import * as locale from "./locale";
import * as generated from "./i18n.generated";
export type { Locale } from "./locale";
export const locales = locale.locales;
export const names = locale.names;
let current = locale.detect(typeof process === "undefined" ? {} : (process.env ?? {}));
const keys = new WeakMap<TemplateStringsArray, string>();

export function language(): locale.Locale {
  return current;
}
export function setLanguage(language: locale.Locale): void {
  current = language;
}
/** Text assets are extracted from their imports, just like literal tags. */
export function document(source: string): string {
  return current === "en" ? source : (generated.messages[current][JSON.stringify([source])]?.() ?? source);
}
export function t(strings: TemplateStringsArray, ...values: generated.Value[]): string {
  if (current !== "en") {
    let key = keys.get(strings);
    if (key === undefined) {
      key = JSON.stringify(strings);
      keys.set(strings, key);
    }
    const message = generated.messages[current][key];
    if (message) return message(...values);
  }
  return String.raw({ raw: strings }, ...values);
}
