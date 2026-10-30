//! The agent list by activity: the agents pinned to the top, in the order they
//! were put there, then a section for each activity, in the order the user
//! put it in, the agent that entered it last on top. Neighbours in one linked
//! worktree share a subhead, as do neighbours in one workspace in "all"; the
//! subheads follow the order rather than making it.
import * as sidebar from "./sidebar";
import type { Section } from "./agent_order";

// Ready follows working, which most of its agents just left, and leads idle,
// where they go once read.
const order: Section[] = ["pinned", "working", "ready", "idle", "done"];

/** When each agent entered its section, in ms. */
export class Since {
  private seen = new Map<string, { kind: Section; at: number }>();
  /** Each agent's last place in its workspace's section order. */
  private ranks = new Map<string, number>();
  /** A held agent's neighbours in its section when it was opened. */
  private anchors = new Map<string, { above: string | null; below: string | null }>();
  /** An agent first seen dates from `start`, the daemon's word for when its state began. */
  observe(key: string, kind: Section, start: number, now: number): number {
    const last = this.seen.get(key);
    if (last && last.kind === kind) return last.at;
    const at = last ? now : Math.min(start > 0 ? start : now, now);
    this.seen.set(key, { kind, at });
    return at;
  }
  /** The section an agent shows in: the one its state puts it in, except
   * that one read while focused stays ready until focus leaves it. */
  shown(key: string, kind: Exclude<Section, "pinned">, focused: boolean): Exclude<Section, "pinned"> {
    return focused && kind === "idle" && this.seen.get(key)?.kind === "ready" ? "ready" : kind;
  }
  /** Settles each item's place in the section order. The daemon puts an
   * agent it sees go idle first; one `held` among the ready instead stays
   * between the neighbours it had in its section, however the rest move. */
  place(items: Item[], held: ReadonlySet<string>): void {
    const now = new Map(items.map(item => [item.key, item.rank]));
    for (const item of items) {
      if (!held.has(item.key)) {
        this.anchors.delete(item.key);
        continue;
      }
      let anchor = this.anchors.get(item.key);
      if (!anchor) {
        anchor = this.neighbours(item, items);
        this.anchors.set(item.key, anchor);
      }
      const below = anchor.below === null ? undefined : now.get(anchor.below),
        above = anchor.above === null ? undefined : now.get(anchor.above);
      if (below !== undefined) item.rank = below - 0.5;
      else if (above !== undefined) item.rank = above + 0.5;
    }
    for (const item of items) if (!held.has(item.key)) this.ranks.set(item.key, item.rank);
  }
  /** `item`'s neighbours in its workspace's section, by where they were last. */
  private neighbours(item: Item, items: Item[]) {
    const was = this.ranks.get(item.key) ?? item.rank;
    let above: Item | null = null,
      below: Item | null = null;
    for (const other of items) {
      const at = this.ranks.get(other.key);
      if (other === item || at === undefined || other.workspace !== item.workspace || other.section !== item.section)
        continue;
      if (at < was && (above === null || at > this.ranks.get(above.key)!)) above = other;
      if (at > was && (below === null || at < this.ranks.get(below.key)!)) below = other;
    }
    return { above: above?.key ?? null, below: below?.key ?? null };
  }
  /** Forgets agents that are gone. */
  keep(keys: ReadonlySet<string>): void {
    for (const map of [this.seen, this.ranks, this.anchors])
      for (const key of map.keys()) if (!keys.has(key)) map.delete(key);
  }
}

export interface Item {
  /** `pane:N` or `headless:N`. */
  key: string;
  entry: sidebar.Entry;
  workspace: number;
  /** The linked worktree it's listed under; null in the workspace's own checkout. */
  checkout: string | null;
  since: number;
  /** Its place among its workspace's pins, or null. */
  pin: number | null;
  /** Its place in its workspace's activity order; one not there yet goes last. */
  rank: number;
  /** The section it shows in, unless pinned. */
  section: Exclude<Section, "pinned">;
}
export interface Options {
  /** Every workspace is listed, each named in its subheads. */
  all: boolean;
  folded: ReadonlySet<Section>;
  /** Workspace ids in the workspace list's order. */
  workspaces: number[];
  /** A subhead's text: the worktree's branch; for the workspace's own
   * checkout, its branch in one workspace's list, its name in "all". */
  label: (workspace: number, checkout: string | null) => string;
}

function header(
  target: sidebar.Target,
  name: string,
  rows: { entry: sidebar.Entry }[],
  folded: boolean,
  worktree: sidebar.Entry["worktree"],
  gap = false,
) {
  const group = { agents: 0, working: 0, attention: 0, folded, current: false, gap };
  for (const item of rows) sidebar.tally(group, item.entry.state, item.entry.attention);
  return sidebar.entry({
    target,
    name,
    worktree,
    // A folded header stands in for the focused agent it hides.
    focused: folded && rows.some(item => item.entry.focused),
    group,
  });
}
function row(item: Item, kind: Section): sidebar.Entry {
  const worktree = item.checkout === null ? null : { workspace: item.workspace, path: item.checkout, ghost: false };
  return { ...item.entry, section: kind, since_ms: item.since, worktree };
}
/** Your order, then the newest first among those it doesn't place. */
const before = (a: Item, b: Item) => a.rank - b.rank || b.since - a.since;

export function arrange(items: Item[], o: Options): sidebar.Entry[] {
  const out: sidebar.Entry[] = [],
    place = (workspace: number) => {
      const i = o.workspaces.indexOf(workspace);
      return i < 0 ? o.workspaces.length : i;
    };
  for (const kind of order) {
    const members = items.filter(item =>
      kind === "pinned" ? item.pin !== null : item.pin === null && item.section === kind,
    );
    if (!members.length) continue;
    const folded = o.folded.has(kind);
    // A blank row parts each section from the one above.
    out.push(header({ section: kind }, kind, members, folded, null, out.length > 0));
    if (folded) continue;
    // Each agent's own place orders the section; the subheads follow it. Its
    // place is among its workspace's agents, so in "all" each workspace's
    // agents keep together, in the workspace list's order.
    members.sort(
      (a, b) => place(a.workspace) - place(b.workspace) || (kind === "pinned" ? a.pin! - b.pin! : before(a, b)),
    );
    const placed = members.map(item => ({
      entry: row(item, kind),
      workspace: item.workspace,
      checkout: kind === "pinned" ? null : item.checkout,
    }));
    out.push(...labelled(placed, kind, o.all, o.label));
  }
  return out;
}

/** An agent row, in the workspace and checkout it belongs to. */
export interface Placed {
  entry: sidebar.Entry;
  workspace: number;
  checkout: string | null;
}
/** `rows` with a subhead over each run of neighbours in one linked worktree,
 * or in "all", one workspace's own checkout. In one workspace's list its own
 * checkout is named only where it follows a worktree's rows, to show where
 * those stop. The subheads follow the order; they never make it. */
export function labelled(rows: Placed[], kind: Section | null, all: boolean, label: Options["label"]): sidebar.Entry[] {
  const out: sidebar.Entry[] = [],
    runs = new Map<string, number>(),
    same = (a: Placed | undefined, b: Placed) =>
      a !== undefined && a.workspace === b.workspace && a.checkout === b.checkout;
  rows.forEach((item, i) => {
    const { workspace, checkout } = item,
      last = rows[i - 1],
      after = !all && checkout === null && last?.workspace === workspace && last.checkout !== null;
    if (!same(last, item) && (all || checkout !== null || after)) {
      const key = `${workspace}:${checkout ?? ""}`,
        run = runs.get(key) ?? 0;
      runs.set(key, run + 1);
      let end = i + 1;
      while (end < rows.length && same(rows[end - 1], rows[end])) end += 1;
      const subhead = header(
        { section: kind, workspace, checkout, run },
        label(workspace, checkout),
        rows.slice(i, end),
        false,
        checkout === null ? null : { workspace, path: checkout, ghost: false },
      );
      subhead.group.branch = checkout !== null || after;
      out.push(subhead);
    }
    out.push(item.entry);
  });
  return out;
}
