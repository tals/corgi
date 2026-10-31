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
  /** Whether the process its lock names still runs; null when it names none. */
  holder: Holder | null;
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
}
export interface Association {
  target: Target;
  path: string;
  source: "cwd" | "write";
  stale: boolean;
}
export interface Placement {
  common_dir: string;
  entries: { path: string; source: Association["source"]; stale: boolean }[];
}
const placements = new WeakMap<object, Placement>();
export function placement(agent: object): Placement | null {
  return placements.get(agent) ?? null;
}
export function recordPlacement(agent: object, common_dir: string, entries: Association[]): void {
  placements.set(agent, { common_dir, entries: entries.map(({ path, source, stale }) => ({ path, source, stale })) });
}
export function placed(agent: object, snapshot: Snapshot, target: Target): Association[] | null {
  const saved = placement(agent);
  if (!saved || saved.common_dir !== snapshot.common_dir) return null;
  return saved.entries
    .filter(e => snapshot.entries.some(checkout => checkout.path === e.path && !dead(checkout)))
    .map(e => ({ ...e, target, stale: e.stale || snapshot.stale }));
}
export function restorePlacement(agent: object, value: unknown): void {
  if (value == null) return;
  const saved = value as Placement;
  if (
    typeof saved.common_dir !== "string" ||
    !saved.common_dir.startsWith("/") ||
    !Array.isArray(saved.entries) ||
    saved.entries.length > 32 ||
    saved.entries.some(
      e =>
        !e ||
        typeof e.path !== "string" ||
        !e.path.startsWith("/") ||
        !["cwd", "write"].includes(e.source) ||
        typeof e.stale !== "boolean",
    )
  )
    throw Error("InvalidCheckpoint");
  placements.set(agent, structuredClone(saved));
}
export interface Snapshot {
  common_dir: string;
  base: Base | null;
  entries: Checkout[];
  agents: Association[];
  stale: boolean;
}
export function snapshot(value: any): Snapshot | null {
  if (!value || !Array.isArray(value.entries)) return null;
  const count = (v: unknown): bigint | null => {
    if (typeof v !== "bigint" && typeof v !== "number" && typeof v !== "string") return null;
    try {
      const n = BigInt(v);
      return n >= 0n ? n : null;
    } catch {
      return null;
    }
  };
  // An older daemon sends no times.
  const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return {
    common_dir: value.common_dir ?? "",
    base: value.base ? { ref: value.base.ref ?? "", name: value.base.name ?? "", head: value.base.head ?? "" } : null,
    stale: value.stale === true,
    entries: value.entries.map((e: any) => {
      const ahead = count(e.comparison?.ahead),
        behind = count(e.comparison?.behind);
      return {
        path: e.path ?? "",
        head: e.head ?? "",
        branch: e.branch ?? null,
        primary: e.primary === true,
        bare: e.bare === true,
        detached: e.detached === true,
        locked: e.locked ?? null,
        holder: e.holder === "running" || e.holder === "exited" ? e.holder : null,
        prunable: e.prunable ?? null,
        available: e.available === true,
        comparison: ahead === null || behind === null ? null : { ahead, behind },
        changes: e.changes
          ? {
              total: Number(e.changes.total ?? 0),
              staged: Number(e.changes.staged ?? 0),
              modified: Number(e.changes.modified ?? 0),
              untracked: Number(e.changes.untracked ?? 0),
              conflicted: Number(e.changes.conflicted ?? 0),
              added: Number(e.changes.added ?? 0),
              removed: Number(e.changes.removed ?? 0),
            }
          : null,
        created: time(e.created),
        edited: time(e.edited),
        stale: e.stale === true,
      };
    }),
    agents: (value.agents ?? []).flatMap((a: any) => {
      const target =
        a.target?.pane !== undefined
          ? { pane: Number(a.target.pane) }
          : a.target?.headless !== undefined
            ? { headless: Number(a.target.headless) }
            : null;
      return target
        ? [{ target, path: a.path ?? "", source: a.source === "write" ? "write" : "cwd", stale: a.stale === true }]
        : [];
    }),
  };
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
export type Holder = "running" | "exited";
/** A lock's reason read for who took it: Claude Code locks the worktrees it
 * makes with "claude session NAME (pid N start DATE)". Other reasons are
 * free text, with no one named. */
export function lockNote(reason: string): { by: string; pid: number | null; start: string | null } {
  const match = reason.match(/^(.*?)\s*\(pid (\d+)(?: start ([^)]*))?\)\s*$/);
  if (!match || !match[1]) return { by: reason, pid: null, start: null };
  return { by: match[1], pid: Number(match[2]), start: match[3]?.trim() || null };
}

/** How an agent's directory is known: it announced moving there (Claude's
 * EnterWorktree), it chose that directory for a command, or its commands
 * ran in its own folder, as they do when it names none. */
export type Basis = "moved" | "named" | "default";
/** Where an agent's latest turn worked. */
export interface Location {
  cwd: string;
  writes: string[];
  /** Every directory the turn's commands ran in. */
  ran: string[];
  basis: Basis;
}

// Successful structured edits are stronger evidence than a launch directory.
// This is current location evidence, not a work history.
const locations = new WeakMap<object, Location>();
export function recordLocation(agent: object, location: Location): void {
  locations.set(agent, { ...location, writes: location.writes.slice(0, 32), ran: location.ran.slice(0, 16) });
}
export function recordWrites(agent: object, paths: string[]): void {
  const old = locations.get(agent) ?? { cwd: "", writes: [], ran: [], basis: "default" };
  if (paths.length) recordLocation(agent, { ...old, writes: paths });
}
export function observed(agent: object): Location | null {
  return locations.get(agent) ?? null;
}
export function restoreLocation(agent: object, value: unknown): void {
  if (value == null) return;
  const location = value as Location;
  const paths = (v: unknown, max: number): v is string[] =>
    Array.isArray(v) && v.length <= max && v.every(p => typeof p === "string" && p.startsWith("/"));
  if (
    typeof location.cwd !== "string" ||
    (location.cwd !== "" && !location.cwd.startsWith("/")) ||
    !paths(location.writes, 32) ||
    !paths(location.ran, 16) ||
    !["moved", "named", "default"].includes(location.basis)
  )
    throw Error("InvalidCheckpoint");
  recordLocation(agent, location);
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
