//! A model's series and version, read from its catalog name: "Opus 5.5" is
//! Claude's opus at 5.5, "GPT-6.1-Sol" GPT's sol at 6.1. The picker leaves
//! a series' older versions to search, and offers the newest of a lineup it
//! knows beside the one the user runs.
import { Model } from "./providers/model";

type Named = { provider: string; account: string; model: string; name: string };
export type Series = {
  /** What a newer version replaces: the route and the name's words but its version. */
  key: string;
  /** The route and the name's first word, whose newest major version dates the rest. */
  brand: string;
  /** The route and a family released together, as Claude's opus, sonnet and
   * haiku; null for one Corgi doesn't know. */
  lineup: string | null;
  version: number[] | null;
  /** The version is a snapshot's date ("4o-2024-08-06", "large-2411",
   * "4-0613"): it orders its series, not its brand's majors. */
  dated: boolean;
  /** A fast, free or preview build of another model. */
  variant: boolean;
};

const lineups: [string, RegExp][] = [
  ["claude", /^(?:claude )?(?:opus|sonnet|haiku|fable|mythos)$/],
  ["gpt", /^gpt(?: [a-z]+)?$/],
];
const variants = new Set(["fast", "free", "preview", "exp", "experimental"]);

export function series(e: { model: string; name: string }): Series {
  const slash = e.model.lastIndexOf("/"),
    route = slash < 0 ? "" : e.model.slice(0, slash),
    words = (e.name || Model.resolve(e.model).label() || e.model)
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .split(/[\s_-]+/)
      .filter(Boolean),
    at = words.findIndex(w => /^v?\d+(?:\.\d+)*$/.test(w)),
    version = at < 0 ? null : words[at].replace(/^v/, "").split(".").map(Number),
    rest = words.filter((_, i) => i !== at),
    base = rest.filter(w => !variants.has(w)).join(" "),
    lineup = lineups.find(([, pattern]) => pattern.test(base))?.[0];
  return {
    key: `${route}:${rest.join(" ")}`,
    brand: `${route}:${rest[0] ?? ""}`,
    lineup: lineup ? `${route}:${lineup}` : null,
    version,
    // No version number runs to four digits in one part; a date does.
    dated: at >= 0 && /^\d{4,}$/.test(words[at]),
    variant: rest.some(w => variants.has(w)),
  };
}
export type Tier = "light" | "strong" | "heavy";
const tiers: [Tier, Set<string>][] = [
  ["light", new Set(["haiku", "luna", "mini", "nano", "flash", "lite", "small"])],
  ["strong", new Set(["sonnet", "terra"])],
  ["heavy", new Set(["opus", "sol", "astra", "fable", "mythos"])],
];
/** How heavy a model is by its name: Haiku and Luna light, Sonnet and Terra
 * strong, Opus and Sol heavy; null for a name Corgi doesn't know. */
export function tier(e: { model: string; name: string }): Tier | null {
  const words = (e.name || Model.resolve(e.model).label() || e.model).toLowerCase().split(/[\s_.-]+/);
  return tiers.find(([, names]) => words.some(w => names.has(w)))?.[0] ?? null;
}
/** Where a routed model comes from, as "GitHub Copilot" for
 * "github-copilot/gpt-6.1-sol"; "" for one that isn't routed. */
export function routeName(model: string): string {
  const slash = model.indexOf("/");
  if (slash < 0) return "";
  const route = model.slice(0, slash);
  return route_names[route] ?? route;
}
const route_names: Record<string, string> = {
  "github-copilot": "GitHub Copilot",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
};
/** The entries a newer one in the same catalog replaces: an older version of
 * its series, or one a major version behind its brand's newest. */
export function outdated<T extends Named>(entries: T[]): Set<T> {
  const read = entries.map(e => ({ e, s: series(e), catalog: `${e.provider}\0${e.account}\0` })),
    newest = new Map<string, number[]>(),
    major = new Map<string, number>();
  for (const { s, catalog } of read) {
    if (!s.version) continue;
    const was = newest.get(catalog + s.key);
    if (!was || compare(s.version, was) > 0) newest.set(catalog + s.key, s.version);
    if (!s.dated) major.set(catalog + s.brand, Math.max(major.get(catalog + s.brand) ?? 0, s.version[0]));
  }
  return new Set(
    read
      .filter(
        ({ s, catalog }) =>
          s.version &&
          (compare(s.version, newest.get(catalog + s.key)!) < 0 ||
            (!s.dated && s.version[0] < major.get(catalog + s.brand)!)),
      )
      .map(r => r.e),
  );
}
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
