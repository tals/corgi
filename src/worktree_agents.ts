import * as sidebar from "./sidebar";
import * as worktrees from "./worktrees";
import * as launcherResume from "./launcher_resume";

export interface Selection {
  workspace: number;
  path: string;
}
export const key = (selection: Selection) => `${selection.workspace}:${selection.path}`;
export class State {
  introduced = new Map<string, Selection>();
  expanded = new Set<string>();
  folded = new Set<string>();
  previewed: string | null = null;
  appearing: string | null = null;
  appeared_at = 0;
  animate(entries: sidebar.Entry[], selection: Selection, now: number): sidebar.Entry[] {
    const id = key(selection);
    if (this.appearing !== id) {
      this.appearing = id;
      this.appeared_at = now;
    }
    const progress = Math.min(1, Math.max(0, (now - this.appeared_at) / 220));
    return entries.map((entry, index) => ({
      ...entry,
      worktree: entry.worktree ? { ...entry.worktree, end: index === entries.length - 1 } : null,
      enter: progress < 1 ? 1 - (1 - progress) ** 3 : null,
    }));
  }
}
/** The branch, without the `worktree-` or `worktree/` prefix tools give
 * worktree branches; the header's ⌥ already says it. */
function label(checkout: worktrees.Checkout): string {
  return worktrees.label(checkout).replace(/^worktree[-/](?=.)/, "");
}
function checkoutAt(snapshot: worktrees.Snapshot, path: string): string | null {
  let found: string | null = null;
  for (const entry of snapshot.entries) {
    const root = entry.path.replace(/\/+$/, "");
    if ((path === root || path.startsWith(root + "/")) && (!found || entry.path.length > found.length))
      found = entry.path;
  }
  return found;
}
/** Whether a live agent is listed under the checkout at `path`. */
export function belongs(snapshot: worktrees.Snapshot, path: string, entry: sidebar.Entry): boolean {
  if (!sidebar.isAgent(entry.target) || entry.state === "done") return false;
  const associations = snapshot.agents.filter(a => sidebar.sameTarget(a.target, entry.target));
  return associations.length ? associations.some(a => a.path === path) : checkoutAt(snapshot, entry.cwd) === path;
}
export function group(
  snapshot: worktrees.Snapshot,
  selection: Selection,
  agents: sidebar.Entry[],
  history: launcherResume.Entry[],
  open: ReadonlySet<string>,
  state: State,
  ghost = false,
  pending = false,
): sidebar.Entry[] {
  const checkout = worktrees.linked(snapshot).find(e => e.path === selection.path);
  if (!checkout) return [];
  const live = agents.filter(e => belongs(snapshot, selection.path, e)),
    info = { ...selection, ghost },
    folded = !ghost && state.folded.has(key(selection));
  const header = sidebar.entry({
    target: { worktree: selection.path, workspace: selection.workspace },
    name: label(checkout),
    worktree: info,
    // A folded header stands in for the focused agent it hides.
    focused: folded && live.some(e => e.focused),
    group: {
      agents: live.length,
      working: live.filter(e => e.state === "working").length,
      attention: live.filter(e => e.attention === "needs_input").length,
      folded,
      current: false,
    },
  });
  if (folded) return [header];
  if (live.length) return [header, ...live.map(e => ({ ...e, worktree: info }))];
  const recent = history
    .filter(e => !open.has(`${e.provider}:${e.session}`) && checkoutAt(snapshot, e.cwd) === selection.path)
    .sort((a, b) => b.updated_at - a.updated_at);
  const expanded = state.expanded.has(key(selection));
  const rows = recent.slice(0, expanded ? recent.length : 3).map(e =>
    sidebar.entry({
      target: { recent: e.session, provider: e.provider, workspace: selection.workspace, path: selection.path },
      recent: e,
      worktree: info,
      provider: e.provider,
      name: e.title || e.last || e.first || e.provider,
      cwd: e.cwd,
      state: "done",
      activity: `Recent · ${launcherResume.ageLabel(Math.max(0, Date.now() / 1000 - e.updated_at))} ago`,
    }),
  );
  if (recent.length > 3)
    rows.push(
      sidebar.entry({
        target: { more: selection.path, workspace: selection.workspace },
        worktree: info,
        name: expanded ? "… less" : `… more (${recent.length - 3})`,
      }),
    );
  if (!recent.length)
    rows.push(
      sidebar.entry({
        target: { empty: selection.path, workspace: selection.workspace },
        worktree: info,
        name: pending ? "Loading recent agents…" : "No recent agents",
      }),
    );
  return [header, ...rows];
}
export function grouped(
  snapshot: worktrees.Snapshot | null,
  workspace: number,
  agents: sidebar.Entry[],
  history: launcherResume.Entry[],
  open: ReadonlySet<string>,
  state: State,
): sidebar.Entry[] {
  if (!snapshot) return agents;
  const groups: sidebar.Entry[] = [],
    assigned = new Set<sidebar.Entry>();
  for (const checkout of worktrees.linked(snapshot)) {
    const selection = { workspace, path: checkout.path },
      live = agents.filter(e => belongs(snapshot, checkout.path, e));
    if (!live.length && !state.introduced.has(key(selection))) continue;
    for (const entry of live) assigned.add(entry);
    groups.push(...group(snapshot, selection, agents, history, open, state));
  }
  return [...agents.filter(e => !assigned.has(e)), ...groups];
}
export function index(entries: sidebar.Entry[], selection: Selection): number {
  return entries.findIndex(
    e => "worktree" in e.target && e.target.workspace === selection.workspace && e.target.worktree === selection.path,
  );
}
