import type { Target } from "./agent_order";

export interface Base {
  ref: string;
  name: string;
  head: string;
}
export interface Comparison {
  ahead: bigint;
  behind: bigint;
}
export interface Changes {
  total: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
}
export interface Checkout {
  path: string;
  head: string;
  branch: string | null;
  primary: boolean;
  bare: boolean;
  detached: boolean;
  locked: string | null;
  prunable: string | null;
  available: boolean;
  comparison: Comparison | null;
  changes: Changes | null;
  stale: boolean;
}
export interface Association {
  target: Target;
  path: string;
  source: "cwd" | "write";
  stale: boolean;
}
export interface Snapshot {
  common_dir: string;
  base: Base | null;
  entries: Checkout[];
  agents: Association[];
  stale: boolean;
}
export function linked(snapshot: Snapshot | null): Checkout[] {
  return snapshot?.entries.filter(e => !e.primary && !e.bare && !dead(e)) ?? [];
}
export function dead(checkout: Checkout): boolean {
  return !checkout.available && checkout.prunable !== null && checkout.locked === null;
}
export function label(checkout: Checkout): string {
  return (
    checkout.branch?.replace(/^refs\/heads\//, "") ?? (checkout.detached ? checkout.head.slice(0, 8) : "No commits")
  );
}

// Successful structured edits are stronger evidence than a launch directory.
// This is current location evidence, not a persisted work history.
const writes = new WeakMap<object, string[]>();
export function recordWrites(agent: object, paths: string[]): void {
  if (paths.length) writes.set(agent, paths.slice(0, 32));
}
export function writtenPaths(agent: object): string[] {
  return writes.get(agent) ?? [];
}
export function clearWrites(agent: object): void {
  writes.delete(agent);
}
