/** Site-only messages extend, rather than copy, Corgi's translations. */
import * as corgi from "../src/i18n";
import * as generated from "./i18n.generated";

export { language, setLanguage, locales, names } from "../src/i18n";
export type { Locale } from "../src/i18n";

export function t(strings: TemplateStringsArray, ...values: generated.Value[]): string {
  const language = corgi.language();
  const message = language === "en" ? null : generated.messages[language][JSON.stringify(strings)];
  return message ? message(...values) : corgi.t(strings, ...values);
}

/** HTML messages are extracted by the site check, with their inline markup. */
export function html(source: string): string {
  const language = corgi.language();
  return (
    (language === "en" ? null : generated.messages[language][JSON.stringify([source])]?.()) ?? corgi.document(source)
  );
}
