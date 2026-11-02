import * as locale from "../src/locale";

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

function saved(): string | null {
  try {
    return localStorage.getItem(preferenceKey);
  } catch {
    return null;
  }
}

/** Sends a visit to a path without a language to the visitor's own, if not
 * English. English pages run this from their head, before they paint. */
export function redirect(): void {
  const selected = choose(location.pathname, saved(), navigator.languages);
  if (!pathLanguage(location.pathname) && selected !== "en")
    location.replace(localizedPath(location.pathname, selected) + location.search + location.hash);
}

/** The language picker's choice holds for later visits. */
export function rememberChoices(): void {
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
