//! The models the prompt's picker offers before any search, matched to how
//! this user runs agents: an agent and account at a time, the one run most
//! first, each opening with the prompt's last pick and the models its agents
//! ran, then the newest of the lineups those belong to. A series' older
//! versions wait for a search unless they're run.
import * as effort from "./providers/effort";
import type { Effort } from "./providers/effort";
import { Provider, adapter, type ByProvider } from "./providers";
import { Model } from "./providers/model";
import { outdated, series, tier } from "./model_series";
import type { Choice, Entry } from "./model_picker";

export type Usage = {
  /** Agents launched per provider, as `runtime.inference.launches` counts them. */
  launches: ByProvider<number>;
  /** What the agents Corgi knows ran with; "" when one didn't say. */
  agents: { provider: Provider; account: string; model: string; effort: Effort | null }[];
  /** The prompt's last pick. */
  last: Choice | null;
  /** Clever Corgi's model; "" for its provider's own. */
  clever: { provider: Provider; model: string } | null;
};

/** Every choice worth offering from `entries`, grouped by agent and account,
 * best group and best choice first. A group opens with the last pick and the
 * models its agents ran, at the effort they ran most, or else its catalog's
 * first current one; the favorite adds a quick one. Unless `widen` is off,
 * as Clever Corgi keeps to the cheap models its catalogs list first, the
 * newest of each lineup those belong to and the catalog's other current
 * models follow, at the effort the group opens with. */
export function suggest(usage: Usage, entries: Entry[], widen = true): Choice[] {
  const groups = new Map<string, Choice[]>(),
    seen = new Set<string>();
  const add = (c: Choice | null) => {
    if (!c || seen.has(key(c))) return;
    seen.add(key(c));
    groups.set(group(c), [...(groups.get(group(c)) ?? []), c]);
  };
  const last = usage.last && lookup(entries, usage.last.provider, usage.last.account, usage.last.model);
  if (last) add(choice(last, usage.last!.effort));
  for (const p of Provider.all) for (const t of tally(usage, entries, p)) add(choice(t.entry, t.effort));
  const order = rank(usage, entries, last),
    old = outdated(entries),
    current = (g: string) => entries.filter(e => group(e) === g && !old.has(e) && !series(e).variant);
  for (const g of order) if (!groups.get(g)?.length) add(current(g)[0] ? choice(current(g)[0], null) : null);
  const favorite = entries.find(e => group(e) === order[0]);
  if (favorite) add(quick(usage, entries, favorite.provider, favorite.account));
  if (widen)
    for (const g of order) {
      const energy = groups.get(g)?.[0]?.effort ?? null,
        newest = current(g);
      for (const c of groups.get(g) ?? []) {
        const lineup = series(c).lineup;
        if (lineup) for (const e of newest) if (series(e).lineup === lineup) add(choice(e, energy));
      }
      for (const e of newest) add(choice(e, energy));
    }
  return order.flatMap(g => groups.get(g) ?? []);
}
/** What the prompt's Auto runs: the newest strong model, as Sonnet or Terra,
 * of the agent and account run most that has one, at the effort that group
 * opens with; else the first suggestion. */
export function auto(usage: Usage, entries: Entry[]): Choice | null {
  const list = suggest(usage, entries),
    old = outdated(entries);
  for (const g of new Set(list.map(group))) {
    const strong = entries.find(e => group(e) === g && !old.has(e) && !series(e).variant && tier(e) === "strong");
    if (strong) return choice(strong, list.find(c => group(c) === g)?.effort ?? null);
  }
  return list[0] ?? null;
}
/** `wanted` when `e` offers it, else its default; null without efforts. */
export function fit(e: Entry, wanted: Effort | null | undefined): Effort | null {
  if (!e.efforts.length) return null;
  if (wanted && e.efforts.includes(wanted)) return wanted;
  return e.default_effort && e.efforts.includes(e.default_effort) ? e.default_effort : null;
}
/** The entry for a model as an agent reports it: its catalog id, a dated or
 * 1M variant, a routed id ("openai-codex/gpt-6-luna") or a family alias
 * ("opus"), preferring `account`. "" is the provider's default model. */
export function lookup(entries: Entry[], provider: Provider, account: string, model: string): Entry | null {
  if (!model) return fallback(entries, provider, account);
  const own = entries.filter(e => e.provider === provider),
    ranked = [...own.filter(e => e.account === account), ...own.filter(e => e.account !== account)],
    wanted = canonical(model);
  return (
    ranked.find(e => e.model === model) ??
    ranked.find(e => canonical(e.model) === wanted) ??
    (/^[a-z]+$/.test(wanted) ? ranked.find(e => canonical(e.model).includes(wanted)) : undefined) ??
    null
  );
}
const key = (c: { provider: Provider; account: string; model: string }) => `${c.provider}\0${c.account}\0${c.model}`;
/** The agent and account a model belongs to. */
const group = (c: { provider: Provider; account: string }) => `${c.provider}\0${c.account}`;
function choice(e: Entry, wanted: Effort | null): Choice {
  return { provider: e.provider, account: e.account, model: e.model, name: e.name, effort: fit(e, wanted) };
}
function canonical(model: string): string {
  const id = Model.resolve(model).id.text();
  return id
    .slice(id.lastIndexOf("/") + 1)
    .replace(/\[1m\]$/, "")
    .toLowerCase();
}
/** A provider's default model: the first its catalog lists, in `account` if it can. */
function fallback(entries: Entry[], provider: Provider, account: string): Entry | null {
  const own = entries.filter(e => e.provider === provider);
  return own.find(e => e.account === account) ?? own.find(e => e.account === "") ?? own[0] ?? null;
}
/** Each agent and account with models, the last pick's first, then the
 * agent launched and seen most, then the account its agents run most. */
function rank(usage: Usage, entries: Entry[], last: Entry | null): string[] {
  const score = (p: Provider) => (usage.launches[p] ?? 0) + usage.agents.filter(a => a.provider === p).length,
    runs = (g: string) => usage.agents.filter(a => group(a) === g).length,
    present = [...new Set(entries.map(group))],
    at = new Map(present.map((g, i) => [g, i])),
    provider = (g: string) => entries[entries.findIndex(e => group(e) === g)].provider;
  return present.sort(
    (a, b) =>
      Number(last !== null && group(last) === b) - Number(last !== null && group(last) === a) ||
      score(provider(b)) - score(provider(a)) ||
      runs(b) - runs(a) ||
      at.get(a)! - at.get(b)!,
  );
}
type Tally = { entry: Entry; count: number; effort: Effort | null; order: number };
/** `provider`'s models its agents ran, most run first, each with the effort
 * it ran at most. Ties go to the agent listed first. */
function tally(usage: Usage, entries: Entry[], provider: Provider): Tally[] {
  const found = new Map<string, { entry: Entry; count: number; order: number; efforts: Map<Effort | null, number> }>();
  usage.agents.forEach((a, order) => {
    if (a.provider !== provider) return;
    const entry = lookup(entries, a.provider, a.account, a.model);
    if (!entry) return;
    let t = found.get(key(entry));
    if (!t) found.set(key(entry), (t = { entry, count: 0, order, efforts: new Map() }));
    t.count++;
    const value = fit(entry, a.effort);
    t.efforts.set(value, (t.efforts.get(value) ?? 0) + 1);
  });
  return [...found.values()]
    .map(t => {
      let best: Effort | null = null,
        most = 0;
      for (const [value, n] of t.efforts)
        if (n > most) {
          best = value;
          most = n;
        }
      return { entry: t.entry, count: t.count, effort: best, order: t.order };
    })
    .sort((a, b) => b.count - a.count || a.order - b.order);
}
/** For small questions: Clever Corgi's model, or else the favorite
 * provider's summary model or a small-sounding one, at its lowest effort. */
function quick(usage: Usage, entries: Entry[], favorite: Provider | undefined, account: string): Choice | null {
  const at = (provider: Provider, model: string) => {
    const found = model ? lookup(entries, provider, account, model) : null;
    return found && choice(found, lowest(found));
  };
  if (usage.clever) {
    const { provider, model } = usage.clever,
      found = at(provider, model || adapter(provider).inference.model);
    if (found) return found;
  }
  if (favorite === undefined) return null;
  const found = at(favorite, adapter(favorite).inference.model);
  if (found) return found;
  const own = entries.filter(e => e.provider === favorite),
    small = [...own.filter(e => e.account === account), ...own].find(e =>
      /\b(?:haiku|mini|nano|flash|lite|luna|small|fast)\b/i.test(`${e.name} ${e.model}`),
    );
  return small ? choice(small, lowest(small)) : null;
}
/** The lowest effort `e` offers, passing over turning thinking off. */
function lowest(e: Entry): Effort | null {
  const on = e.efforts.filter(v => v !== "none" && v !== "off"),
    pool = on.length ? on : e.efforts;
  return pool.reduce<Effort | null>(
    (low, v) => (low === null || effort.levels.indexOf(v) < effort.levels.indexOf(low) ? v : low),
    null,
  );
}
