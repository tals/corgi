/** Provider identities, available before loading their adapters. */
const builtins = ["codex", "claude", "pi", "opencode2", "omp"] as const;
export type Provider = (typeof builtins)[number];
const all: Provider[] = [...builtins];
export const Provider = {
  all,
  first: all[0],
  /** What `corgi-hook` forwards; native/hook.zig checks the same shape. */
  wellFormed(id: string): boolean {
    return /^[a-z0-9]{1,32}$/.test(id);
  },
  parse(name: unknown): Provider | null {
    return all.find(p => p === name) ?? null;
  },
};
