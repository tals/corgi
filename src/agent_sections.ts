//! The agent list by activity: the starred agents at the top, in the order they
//! were put there, then a section for each activity, in the order the user
//! put it in, the agent that entered it last on top. Neighbours in one linked
//! worktree share a subhead, as do neighbours in one workspace in "all"; the
//! subheads follow the order rather than making it.
import * as sidebar from "./sidebar";
import * as agentOrder from "./agent_order";
import type { Section } from "./agent_order";

// Ready follows working, which most of its agents just left, and leads idle,
// where they go once read.
const order: Section[] = ["starred", "working", "ready", "idle", "done"];

/** The section an agent's row belongs in; the daemon holds a new one in working. */
export function section(e: sidebar.Entry): Exclude<Section, "starred"> {
  return e.starting ? "working" : agentOrder.section(e.state, e.attention, e.paused);
}
type Place = Pick<Item, "workspace" | "pin" | "section">;
function sameSection(a: Place, b: Place): boolean {
  return a.workspace === b.workspace && (a.pin === null ? b.pin === null && a.section === b.section : b.pin !== null);
}

/** When each agent entered its section, in ms. */
export class Since {
  private seen = new Map<string, { kind: Section; at: number }>();
  /** Each agent's last place in its workspace's section order, and the section it was in. */
  private ranks = new Map<string, { rank: number; at: Place }>();
  /** A held agent's neighbours in its section, and where it was then. */
  private anchors = new Map<string, { above: string | null; below: string | null; at: Place }>();
  /** An agent first seen dates from `start`, the daemon's word for when its state began. */
  observe(key: string, kind: Section, start: number, now: number): number {
    const last = this.seen.get(key);
    if (last && last.kind === kind) return last.at;
    const at = last ? now : Math.min(start > 0 ? start : now, now);
    this.seen.set(key, { kind, at });
    return at;
  }
  /** One read while focused stays ready until left. */
  shown(key: string, kind: Exclude<Section, "starred">, focused: boolean): Exclude<Section, "starred"> {
    return focused && kind === "idle" && this.seen.get(key)?.kind === "ready" ? "ready" : kind;
  }
  /** An explicit drop replaces the neighbours holding a read agent in place. */
  move(key: string, before: string | null): void {
    const saved = this.ranks.get(key);
    if (!saved || key === before) return;
    const others = [...this.ranks]
        .filter(([other, place]) => other !== key && sameSection(saved.at, place.at))
        .sort((a, b) => a[1].rank - b[1].rank),
      index = before === null ? others.length : others.findIndex(([other]) => other === before);
    if (index < 0) return;
    const above = others[index - 1],
      below = others[index];
    this.anchors.set(key, { above: above?.[0] ?? null, below: below?.[0] ?? null, at: saved.at });
    saved.rank = below ? below[1].rank - 0.5 : (above?.[1].rank ?? -0.5) + 0.5;
  }
  /** Settles each item's place in the section order. One `held` among the
   * ready stays between its neighbours; one that leaves gives way to the
   * nearest that stayed. Its neighbours wait while it is away itself. */
  place(items: Item[], held: ReadonlySet<string>): void {
    const byKey = new Map(items.map(item => [item.key, item])),
      away = new Set<string>();
    for (const item of items) {
      if (!held.has(item.key)) {
        this.anchors.delete(item.key);
        continue;
      }
      const rank = (key: string | null) => {
          const other = key === null ? undefined : byKey.get(key);
          return other && other !== item && sameSection(item, other) ? other.rank : undefined;
        },
        gone = (key: string | null) => key !== null && rank(key) === undefined;
      let anchor = this.anchors.get(item.key);
      if (anchor && !sameSection(item, anchor.at)) {
        away.add(item.key);
        continue;
      }
      if (!anchor || gone(anchor.above) || gone(anchor.below) || (anchor.above === null && anchor.below === null)) {
        anchor = {
          ...this.neighbours(item, items),
          at: { workspace: item.workspace, pin: item.pin, section: item.section },
        };
        this.anchors.set(item.key, anchor);
      }
      const below = rank(anchor.below),
        above = rank(anchor.above);
      if (below !== undefined) item.rank = below - 0.5;
      else if (above !== undefined) item.rank = above + 0.5;
    }
    for (const item of items)
      if (!away.has(item.key))
        this.ranks.set(item.key, {
          rank: item.rank,
          at: { workspace: item.workspace, pin: item.pin, section: item.section },
        });
  }
  /** `item`'s neighbours in its workspace's section, by where they were last.
   * One that just entered it has no place there yet. */
  private neighbours(item: Item, items: Item[]) {
    const was = this.ranks.get(item.key)?.rank ?? item.rank,
      last = (other: Item) => this.ranks.get(other.key)!.rank;
    let above: Item | null = null,
      below: Item | null = null;
    for (const other of items) {
      const before = this.ranks.get(other.key);
      if (other === item || !before || !sameSection(item, other) || !sameSection(item, before.at)) continue;
      const at = before.rank;
      if (at < was && (above === null || at > last(above))) above = other;
      if (at > was && (below === null || at < last(below))) below = other;
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
  /** Its place among its workspace's stars, or null. */
  pin: number | null;
  /** Its place in its workspace's activity order; one not there yet goes last. */
  rank: number;
  /** The section it shows in, unless starred. */
  section: Exclude<Section, "starred">;
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
  return { ...item.entry, section: kind, worktree };
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
      kind === "starred" ? item.pin !== null : item.pin === null && item.section === kind,
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
      (a, b) => place(a.workspace) - place(b.workspace) || (kind === "starred" ? a.pin! - b.pin! : before(a, b)),
    );
    const placed = members.map(item => ({
      entry: row(item, kind),
      workspace: item.workspace,
      checkout: item.checkout,
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
