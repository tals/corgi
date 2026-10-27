import * as codex from "./providers/codex";
import * as claude from "./providers/claude";
import * as pi from "./providers/pi";
import * as opencode2 from "./providers/opencode2";
import type { Adapter } from "./providers/adapter";
import { owns } from "./providers/common";
export * from "./providers/common";
/** Every provider Corgi integrates with, by id. `Provider` derives from it,
 * so a provider missing from any `ByProvider` record fails to compile. Key
 * order is the order the UI lists them in. */
const registry = {
  codex: codex.adapter,
  claude: claude.adapter,
  pi: pi.adapter,
  opencode2: opencode2.adapter,
} satisfies Record<string, Adapter>;
export type Provider = keyof typeof registry;
export type ByProvider<T> = Record<Provider, T>;
const adapters = new Map<string, Adapter>(Object.entries(registry));
const all = [...adapters.keys()] as Provider[];
export const Provider = {
  all,
  /** The provider Corgi offers before the user picks one: the first it lists. */
  first: all[0],
  /** The provider with this id, as protocol and CLI spell it. */
  parse(name: unknown): Provider | null {
    return all.find(p => p === name) ?? null;
  },
  /** The provider an executable or script at `path` belongs to. */
  owning(path: string): Provider | null {
    return all.find(p => owns(adapter(p).programs, path)) ?? null;
  },
  /** Adds `provider` until the returned function runs. Tests register a
   * simulated provider to find code that assumes the built-in ones. */
  register(provider: Adapter): () => void {
    if (adapters.has(provider.id)) throw Error("ProviderExists");
    adapters.set(provider.id, provider);
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
  return found;
}
/** A record with a value for every provider. */
export function byProvider<T>(value: (p: Provider) => T): ByProvider<T> {
  return Object.fromEntries(all.map(p => [p, value(p)])) as ByProvider<T>;
}
