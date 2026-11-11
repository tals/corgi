//! Account jobs exclude other mutations and launches until they settle.
import type { Provider } from "./providers";
const held = new Set<string>();
const key = (provider: Provider, account: string) => `${provider}:${account}`;
export function check(provider: Provider, account: string): void {
  if (held.has(key(provider, account))) throw Error("AccountInUse");
}
export function take(provider: Provider, account: string): () => void {
  check(provider, account);
  const id = key(provider, account);
  held.add(id);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    held.delete(id);
  };
}
