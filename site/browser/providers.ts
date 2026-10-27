/**
 * The provider registry on the landing page: what each provider is called
 * and how it marks its processes, from the providers' small info modules.
 * The adapters themselves need Node and the native layer. package.json's
 * "browser" field puts this in place of src/providers.ts.
 */
import { info as codex } from "../../src/providers/codex/info";
import { info as claude } from "../../src/providers/claude/info";
import { info as pi } from "../../src/providers/pi/info";
import { info as opencode2 } from "../../src/providers/opencode2/info";
import { info as omp } from "../../src/providers/omp/info";
import type { Info } from "../../src/providers/adapter";
export * from "../../src/providers/common";

const registry = { codex, claude, pi, opencode2, omp } satisfies Record<string, Info>;
export type Provider = keyof typeof registry;
export type ByProvider<T> = Record<Provider, T>;
const all = Object.keys(registry) as Provider[];
export const Provider = {
  all,
  first: all[0],
  parse: (name: unknown): Provider | null => all.find(p => p === name) ?? null,
};
export function adapter(p: Provider): Info {
  return registry[p];
}
export function byProvider<T>(value: (p: Provider) => T): ByProvider<T> {
  return Object.fromEntries(all.map(p => [p, value(p)])) as ByProvider<T>;
}
