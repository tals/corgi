import { dirname, join } from "node:path";
import { Provider, Each } from "../providers";
import * as settings from "../settings";
import type { Choice } from "./harness";
export { Provider };
export type { Choice };
export class Launches {
  count = new Each(0);
  latest: Provider | null = null;
  static restore(value: any) {
    const launches = new Launches();
    for (const provider of Provider.all)
      launches.count.set(provider, value?.[provider] ?? value?.count?.[provider] ?? 0);
    launches.latest = value?.latest ?? null;
    return launches;
  }
  record(provider: Provider) {
    this.count.set(provider, Math.min(0xffffffff, this.count.get(provider) + 1));
    this.latest = provider;
  }
  favorite(fallback: Provider) {
    const best = Math.max(...Provider.all.map(p => this.count.get(p)));
    const leaders = Provider.all.filter(p => this.count.get(p) === best);
    return leaders.length === 1 ? leaders[0] : (this.latest ?? fallback);
  }
}
export class Status {
  choice: Choice = "auto";
  provider: Provider | null = null;
  model = "";
  locked = false;
  launches = new Each(0);
  models = new Each("");
}
export function resolve(choice: Choice, launches: Launches, remembered: Provider) {
  return choice === "off" ? null : choice === "auto" ? launches.favorite(remembered) : choice;
}
export function model(provider: Provider | null) {
  return provider === null
    ? ""
    : (process.env.CORGI_INFERENCE_MODEL ?? process.env.CORGI_SUMMARY_MODEL ?? Provider.info(provider).summary_model);
}
export function initial(saved: Choice | null) {
  if (saved !== null) return saved;
  if (process.env.CORGI_SUMMARY_COMMAND === "off") return "off";
  const name = process.env.CORGI_INFERENCE_PROVIDER ?? "auto";
  return ["auto", "codex", "claude", "off"].includes(name) ? (name as Choice) : "off";
}
export function load(file: string): Choice | null {
  const v = settings.read(file).inference;
  return v === "auto" || v === "codex" || v === "claude" || v === "off" ? v : null;
}
export function save(file: string, choice: Choice) {
  settings.update(file, { inference: choice });
}

export const path = settings.path;
