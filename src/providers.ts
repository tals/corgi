import * as codex from "./providers/codex";
import * as claude from "./providers/claude";
import * as pi from "./providers/pi";
import * as opencode2 from "./providers/opencode2";
import * as omp from "./providers/omp";
import type { Adapter } from "./providers/adapter";
import { owns } from "./providers/common";
import * as names from "./providers/names";
export type Provider = names.Provider;
export * from "./providers/common";
// Keep module namespaces here: a provider can reach this registry through core
// while its own adapter is still initializing. Resolve the adapter only on use.
const registry = {
  codex,
  claude,
  pi,
  opencode2,
  omp,
} satisfies Record<Provider, { readonly adapter: Adapter }>;
export type ByProvider<T> = Record<Provider, T>;
const adapters = new Map<string, { readonly adapter: Adapter }>(Object.entries(registry));
const all = names.Provider.all;
export const Provider = {
  ...names.Provider,
  /** The provider an executable or script at `path` belongs to. */
  owning(path: string): Provider | null {
    return all.find(p => owns(adapter(p).programs, path)) ?? null;
  },
  /** Adds `provider` until the returned function runs. Tests register a
   * simulated provider to find code that assumes the built-in ones. */
  register(provider: Adapter): () => void {
    if (adapters.has(provider.id)) throw Error("ProviderExists");
    if (!names.Provider.wellFormed(provider.id)) throw Error("InvalidProvider");
    adapters.set(provider.id, { adapter: provider });
    all.push(provider.id as Provider);
    return () => {
      adapters.delete(provider.id);
      all.splice(all.indexOf(provider.id as Provider), 1);
    };
  },
};
/** Everything a provider is and does, for the id data carries. */
export function adapter(p: Provider): Adapter {
  const found = adapters.get(p);
  if (!found) throw Error("UnknownProvider");
  return found.adapter;
}
/** A record with a value for every provider. */
export function byProvider<T>(value: (p: Provider) => T): ByProvider<T> {
  return Object.fromEntries(all.map(p => [p, value(p)])) as ByProvider<T>;
}
