import * as locale from "../src/locale";
import * as i18n from "../src/i18n";

export const preferenceKey = "corgi.site.language";

export function pathLanguage(path: string): locale.Locale | null {
  const first = path.split("/")[1];
  return locale.locales.find(language => language === first) ?? null;
}

export function choose(path: string, saved: string | null, languages: readonly string[]): locale.Locale {
  return pathLanguage(path) ?? locale.detect({}, saved ? (locale.parse(saved) ?? undefined) : undefined, languages);
}

export function localizedPath(path: string, language: locale.Locale): string {
  const tail = pathLanguage(path) ? path.slice(3) : path;
  return `/${language}${tail === "/" || !tail ? "/" : tail}`;
}

if (typeof document !== "undefined") {
  i18n.setLanguage(locale.parse(document.documentElement.lang) ?? "en");
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(preferenceKey);
  } catch {}
  const selected = choose(location.pathname, saved, navigator.languages);
  if (!pathLanguage(location.pathname) && selected !== "en") {
    location.replace(localizedPath(location.pathname, selected) + location.search + location.hash);
  }
  document.querySelectorAll<HTMLAnchorElement>("[data-language]").forEach(link => {
    link.addEventListener("click", () => {
      try {
        localStorage.setItem(preferenceKey, link.dataset.language!);
      } catch {}
      link.href =
        localizedPath(location.pathname, link.dataset.language as locale.Locale) + location.search + location.hash;
    });
  });
}
