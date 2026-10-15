import { dirname, join } from "node:path";
import { Provider, byProvider } from "../providers";
import type { ByProvider } from "../providers";
import * as settings from "../settings";
import type { Choice } from "./harness";
export type { Choice };
export class Launches {
  count: ByProvider<number> = byProvider(() => 0);
  latest: Provider | null = null;
  static restore(value: any) {
    const launches = new Launches();
    for (const provider of Provider.all) launches.count[provider] = value?.[provider] ?? value?.count?.[provider] ?? 0;
    launches.latest = value?.latest ?? null;
    return launches;
  }
  record(provider: Provider) {
    this.count[provider] = Math.min(0xffffffff, this.count[provider] + 1);
    this.latest = provider;
  }
  favorite(fallback: Provider) {
    const best = Math.max(...Provider.all.map(p => this.count[p]));
    const leaders = Provider.all.filter(p => this.count[p] === best);
    return leaders.length === 1 ? leaders[0] : (this.latest ?? fallback);
  }
}
/** What Corgi asks the model for. Each turns off on its own; the model
 * choice says only who answers. Smart Links' names go with Smart Links. */
export type Use = "activity" | "worktrees";
export const uses: Use[] = ["activity", "worktrees"];
export type Uses = Record<Use, boolean>;
const use_keys: Record<Use, string> = {
  activity: "activity_summaries",
  worktrees: "worktree_briefs",
};
export const allUses = (on: boolean): Uses => ({ activity: on, worktrees: on });
export class Status {
  choice: Choice = "auto";
  provider: Provider | null = null;
  model = "";
  locked = false;
  launches: ByProvider<number> = byProvider(() => 0);
  models: ByProvider<string> = byProvider(() => "");
  uses: Uses = allUses(true);
}
export function resolve(choice: Choice, launches: Launches, remembered: Provider) {
  return choice === "off" ? null : choice === "auto" ? launches.favorite(remembered) : choice;
}
export function model(provider: Provider | null) {
  return provider === null
    ? ""
    : (process.env.CORGI_INFERENCE_MODEL ?? process.env.CORGI_SUMMARY_MODEL ?? Provider.info(provider).summary_model);
}
/** A choice as settings and the environment spell it. */
export function parseChoice(value: unknown): Choice | null {
  return value === "auto" || value === "off" ? value : Provider.parse(value);
}
export function initial(saved: Choice | null) {
  if (saved !== null) return saved;
  if (process.env.CORGI_SUMMARY_COMMAND === "off") return "off";
  const name = process.env.CORGI_INFERENCE_PROVIDER ?? "auto";
  return parseChoice(name) ?? "off";
}
export function load(file: string): Choice | null {
  return parseChoice(settings.read(file).inference);
}
export function save(file: string, choice: Choice) {
  settings.update(file, { inference: choice });
}
/** Whether the model is off: a choice saved before uses were separate, or
 * the environment's. */
export function off(file: string) {
  const saved = settings.read(file);
  return saved.inference === "off" || (saved.inference === undefined && initial(null) === "off");
}
/** The saved uses. An "off" turns each use off until one is saved. */
export function loadUses(file: string): Uses {
  const saved = settings.read(file),
    out = allUses(!off(file));
  for (const use of uses) if (typeof saved[use_keys[use]] === "boolean") out[use] = saved[use_keys[use]] as boolean;
  return out;
}
export function saveUses(file: string, changed: Partial<Uses>) {
  settings.update(file, Object.fromEntries(Object.entries(changed).map(([use, on]) => [use_keys[use as Use], on])));
}

export const path = settings.path;
