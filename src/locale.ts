//! Locale negotiation shared by the CLI and browser-safe viewer code.
export const locales = ["en", "zh", "ja", "ko", "ru"] as const;
export type Locale = (typeof locales)[number];
export type TranslatedLocale = Exclude<Locale, "en">;
export const translated: readonly TranslatedLocale[] = ["zh", "ja", "ko", "ru"];
export const names: Record<Locale, string> = {
  en: "English",
  zh: "简体中文",
  ja: "日本語",
  ko: "한국어",
  ru: "Русский",
};
export type Environment = Readonly<Record<string, string | undefined>>;

export function parse(value: string): Locale | null {
  const language = value.trim().toLowerCase().replaceAll("_", "-").split(/[.@]/)[0].split("-")[0];
  switch (language) {
    case "en":
    case "zh":
    case "ja":
    case "ko":
    case "ru":
      return language;
    case "c":
    case "posix":
      return "en";
    default:
      return null;
  }
}
export function detect(env: Environment, preference?: Locale, system: readonly string[] = []): Locale {
  const override = env.CORGI_LANG?.trim();
  if (override && override.toLowerCase() !== "auto") return parse(override) ?? "en";
  if (preference) return preference;
  const messages = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (messages && /^(?:C|POSIX)(?:[.@].*)?$/i.test(messages)) return "en";
  for (const language of (env.LANGUAGE ?? "").split(":")) {
    const parsed = parse(language);
    if (parsed) return parsed;
  }
  if (messages) return parse(messages) ?? "en";
  for (const language of system) {
    const parsed = parse(language);
    if (parsed) return parsed;
  }
  return "en";
}

const plurals = new Map<Locale, Intl.PluralRules>();
export function plural(language: Locale, count: number): Intl.LDMLPluralRule {
  let rules = plurals.get(language);
  if (!rules) plurals.set(language, (rules = new Intl.PluralRules(language)));
  return rules.select(count);
}
