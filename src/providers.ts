import { Codex } from "./providers/codex";
import { Claude } from "./providers/claude";
export { Codex, Claude };
export * from "./providers/common";
/** Every provider Corgi integrates with, by name. `Provider` derives from it,
 * so a provider missing from any `ByProvider` record fails to compile. Key
 * order is the order the UI lists them in. */
const registry = { codex: Codex, claude: Claude };
export type Provider = keyof typeof registry;
export type ByProvider<T> = Record<Provider, T>;
const all = Object.keys(registry) as Provider[];
export const Provider = {
  all,
  /** The provider with this name, as protocol and CLI spell it. */
  parse(name: unknown): Provider | null {
    return all.find(p => p === name) ?? null;
  },
  /** The provider whose executable is `name`. */
  named(name: string): Provider | null {
    return all.find(p => registry[p].info.executables.includes(name)) ?? null;
  },
  info(p: Provider) {
    return registry[p].info;
  },
  backend(p: Provider) {
    return Backend.init(p);
  },
};
/** A record with a value for every provider. */
export function byProvider<T>(value: (p: Provider) => T): ByProvider<T> {
  return Object.fromEntries(all.map(p => [p, value(p)])) as ByProvider<T>;
}
export class Backend {
  constructor(public provider: Provider) {}
  static init(provider: Provider) {
    return new Backend(provider);
  }
  get adapter() {
    return new registry[this.provider]();
  }
  hook(v: any) {
    return this.adapter.hook(v);
  }
  nativeEvent(v: any) {
    return this.adapter.nativeEvent(v);
  }
  responseId(v: any) {
    return this.nativeEvent(v).response_id;
  }
  hookEvents() {
    return registry[this.provider].hook_events;
  }
  titleSession(title: string) {
    return registry[this.provider].titleSession(title);
  }
}
