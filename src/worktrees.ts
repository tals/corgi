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
  /** Lines added and removed against HEAD, untracked text files included. */
  added: number;
  removed: number;
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
  /** When `git worktree add` made it, in ms; null when Git kept no record. */
  created: number | null;
  /** The later of HEAD's commit and the newest save to an uncommitted file, in ms. */
  edited: number | null;
  stale: boolean;
}
/** A few words on what a worktree holds that main doesn't. */
export interface Brief {
  path: string;
  /** Null until the first is written. */
  label: string | null;
  /** Writing while one is asked for or amended; failed when the last try failed. */
  phase: "ready" | "writing" | "failed";
  /** Whether the worktree is still as the label found it. */
  current: boolean;
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
const locations = new WeakMap<object, { cwd: string; writes: string[] }>();
export function recordLocation(agent: object, cwd: string, writes: string[]): void {
  locations.set(agent, { cwd, writes: writes.slice(0, 32) });
}
export function recordWrites(agent: object, paths: string[]): void {
  if (paths.length) recordLocation(agent, observedDirectory(agent), paths);
}
export function observedDirectory(agent: object): string {
  return locations.get(agent)?.cwd ?? "";
}
export function writtenPaths(agent: object): string[] {
  return locations.get(agent)?.writes ?? [];
}
export function clearWrites(agent: object): void {
  locations.delete(agent);
}
/** A worktree being removed, as the daemon reports it: Git deleting it,
 * then done, stopped by the user, or failed with an error name. */
export interface Removal {
  /** Which removal: each one the daemon starts gets the next. */
  id: number;
  path: string;
  phase: "deleting" | "done" | "stopped" | "failed";
  error: string;
}
export function removal(value: any): Removal | null {
  const phases: Removal["phase"][] = ["deleting", "done", "stopped", "failed"];
  if (!value || typeof value.path !== "string" || !phases.includes(value.phase)) return null;
  return {
    id: Number(value.id) || 0,
    path: value.path,
    phase: value.phase,
    error: typeof value.error === "string" ? value.error : "",
  };
}
