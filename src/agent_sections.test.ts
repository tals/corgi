import { test, expect } from "bun:test";
import * as agentSections from "./agent_sections";
import { section } from "./agent_order";
import { entry, isSection, type Attention, type State } from "./sidebar";

const item = (
  pane: number,
  state: State,
  fields: Partial<agentSections.Item> & { attention?: Attention } = {},
): agentSections.Item => ({
  key: `pane:${pane}`,
  entry: entry({
    target: { pane },
    name: `agent ${pane}`,
    provider: "claude",
    state,
    attention: fields.attention ?? "none",
  }),
  workspace: 1,
  checkout: null,
  since: pane,
  section: section(state, fields.attention ?? "none"),
  pin: null,
  rank: 0,
  ...fields,
});
const options = (fields: Partial<agentSections.Options> = {}): agentSections.Options => ({
  all: false,
  folded: new Set(),
  workspaces: [1, 2],
  label: (workspace, checkout) => (checkout ?? `ws${workspace}`).replace(/^\/repo\//, ""),
  ...fields,
});
const rows = (entries: ReturnType<typeof agentSections.arrange>) =>
  entries.map(e =>
    "pane" in e.target ? e.target.pane : isSection(e.target) ? `${e.target.section} ${e.group.agents}` : `· ${e.name}`,
  );

test("sections go in a fixed order, ready under working, newest first, neighbours in a worktree under one subhead", () => {
  const out = agentSections.arrange(
    [
      item(1, "idle"),
      item(2, "working"),
      item(3, "blocked"),
      item(4, "working", { checkout: "/repo/topic", since: 50 }),
      item(5, "working", { since: 9 }),
      item(6, "idle", { attention: "finished" }),
      item(7, "done"),
      item(8, "working", { checkout: "/repo/fix", since: 40 }),
      item(9, "working", { checkout: "/repo/topic", since: 1 }),
    ],
    options({ folded: new Set(["done"]) }),
  );
  // One waiting on the user stays among those at work.
  // Ready sits under working, which its agents just left.
  // Each agent's own place orders the section; a worktree it shares with its
  // neighbours labels them, and one met again gets a second subhead.
  expect(rows(out)).toEqual([
    "working 6",
    "· topic",
    4,
    "· fix",
    8,
    // The workspace's own checkout is named where it follows a worktree.
    "· ws1",
    5,
    3,
    2,
    "· topic",
    9,
    "ready 1",
    6,
    "idle 1",
    1,
    "done 1",
  ]);
  expect(out[7]).toMatchObject({ section: "working", worktree: null, state: "blocked" });
  expect(out[5].group.branch).toBe(true);
  expect(out[1].group.branch).toBe(true);
  expect(out[2]).toMatchObject({ section: "working", worktree: { workspace: 1, path: "/repo/topic", ghost: false } });
  expect(out[1].target).toEqual({ section: "working", workspace: 1, checkout: "/repo/topic", run: 0 });
  expect(out[9].target).toEqual({ section: "working", workspace: 1, checkout: "/repo/topic", run: 1 });
  // A blank row parts each section from the one above it.
  expect(out.filter(e => isSection(e.target)).map(e => e.group.gap)).toEqual([false, true, true, true]);
  expect(out.at(-1)!.group.folded).toBe(true);
});

test("a section keeps the order it was put in, ahead of agents it doesn't place yet", () => {
  const out = agentSections.arrange(
    [
      item(1, "working", { rank: 1 }),
      item(2, "working", { rank: 0 }),
      item(3, "working", { rank: 2, since: 99 }),
      item(4, "working", { rank: 3, since: 50 }),
      item(5, "working", { rank: 3, since: 60 }),
    ],
    options(),
  );
  expect(rows(out)).toEqual(["working 5", 2, 1, 3, 5, 4]);
});

test("pins keep their order above the sections, each workspace's together", () => {
  const out = agentSections.arrange(
    [
      item(1, "working", { pin: 1 }),
      item(2, "blocked", { pin: 0, checkout: "/repo/topic" }),
      item(3, "idle", { workspace: 2, pin: 0 }),
      item(4, "idle"),
    ],
    options(),
  );
  expect(rows(out)).toEqual(["starred 3", 2, 1, 3, "idle 1", 4]);
  expect(out[1].section).toBe("starred");
  // In "all", each workspace and each of its worktrees gets a subhead.
  const all = agentSections.arrange(
    [
      item(1, "working", { pin: 0 }),
      item(2, "working", { workspace: 2, since: 9 }),
      item(3, "working", { checkout: "/repo/topic" }),
      item(4, "working", { workspace: 2, pin: 0 }),
    ],
    options({ all: true }),
  );
  // A section's place is among its own workspace's agents, so each workspace's
  // keep together, however recent another workspace's are.
  expect(rows(all)).toEqual(["starred 2", "· ws1", 1, "· ws2", 4, "working 2", "· topic", 3, "· ws2", 2]);
});

test("a folded section stands in for the focused agent it hides", () => {
  const focused = item(1, "working");
  focused.entry.focused = true;
  const out = agentSections.arrange([focused, item(2, "idle")], options({ folded: new Set(["working"]) }));
  expect(rows(out)).toEqual(["working 1", "idle 1", 2]);
  expect(out[0].focused).toBe(true);
});

test("an agent's time starts when it enters a section, or for one first seen, when its state began", () => {
  const since = new agentSections.Since();
  expect(since.observe("pane:1", "working", 100, 500)).toBe(100);
  expect(since.observe("pane:1", "working", 300, 600)).toBe(100);
  expect(since.observe("pane:1", "idle", 300, 700)).toBe(700);
  // Without a time from the daemon, or one from the future, it starts now.
  expect(since.observe("pane:2", "idle", 0, 800)).toBe(800);
  expect(since.observe("pane:3", "idle", 900, 800)).toBe(800);
  since.keep(new Set(["pane:2"]));
  expect(since.observe("pane:1", "idle", 50, 1000)).toBe(50);
});
test("an unread agent opened stays among the ready until focus leaves it", () => {
  const since = new agentSections.Since();
  since.observe("pane:1", since.shown("pane:1", "ready", false), 0, 100);
  // Focusing it reads it: its state says idle, but it stays put.
  expect(since.shown("pane:1", "idle", true)).toBe("ready");
  since.observe("pane:1", "ready", 0, 200);
  expect(since.shown("pane:1", "idle", true)).toBe("ready");
  expect(since.shown("pane:1", "idle", false)).toBe("idle");
  // Other moves aren't held.
  expect(since.shown("pane:1", "working", true)).toBe("working");
});
test("an agent keeps its place when a neighbour in its worktree leaves the section", () => {
  const idle = (me: string) => [
    item(1, me, { checkout: "/repo/wt", rank: 0 }),
    item(2, "idle", { rank: 1 }),
    item(3, "idle", { rank: 2 }),
    item(4, "idle", { checkout: "/repo/wt", rank: 3 }),
  ];
  const agents = (out: ReturnType<typeof agentSections.arrange>) =>
    out.filter(e => e.section === "idle" && "pane" in e.target).map(e => ("pane" in e.target ? e.target.pane : 0));
  expect(agents(agentSections.arrange(idle("idle"), options()))).toEqual([1, 2, 3, 4]);
  expect(agents(agentSections.arrange(idle("working"), options()))).toEqual([2, 3, 4]);
});
test("an agent held among the ready stays between its neighbours while others move", () => {
  const since = new agentSections.Since(),
    ready = (ranks: Record<number, number>, held: number[]) => {
      const items = Object.entries(ranks).map(([pane, rank]) =>
        item(Number(pane), "idle", { attention: "finished", rank }),
      );
      since.place(items, new Set(held.map(pane => `pane:${pane}`)));
      return agentSections.arrange(items, options()).flatMap(e => ("pane" in e.target ? [e.target.pane] : []));
    };
  // Ready: A, B, C.
  expect(ready({ 1: 0, 2: 1, 3: 2 }, [])).toEqual([1, 2, 3]);
  // Opening B reads it; the daemon puts it first, and it stays put.
  expect(ready({ 2: 0, 1: 1, 3: 2 }, [2])).toEqual([1, 2, 3]);
  // D finishes and goes on top; B still sits between A and C.
  expect(ready({ 4: 0, 2: 1, 1: 2, 3: 3 }, [2])).toEqual([4, 1, 2, 3]);
  // Left, B takes the place the daemon gave it.
  expect(ready({ 4: 0, 2: 1, 1: 2, 3: 3 }, [])).toEqual([4, 2, 1, 3]);
});
test("a held ready agent keeps to the next neighbour when one leaves", () => {
  const since = new agentSections.Since(),
    ready = (ranks: Record<number, number>, held: number[], working: number[] = []) => {
      const items = Object.entries(ranks).map(([pane, rank]) =>
        working.includes(Number(pane))
          ? item(Number(pane), "working", { rank })
          : item(Number(pane), "idle", { attention: "finished", rank }),
      );
      since.place(items, new Set(held.map(pane => `pane:${pane}`)));
      return agentSections
        .arrange(items, options())
        .filter(e => e.section === "ready")
        .flatMap(e => ("pane" in e.target ? [e.target.pane] : []));
    };
  // Ready: C, A, B.
  expect(ready({ 3: 0, 1: 1, 2: 2 }, [])).toEqual([3, 1, 2]);
  // Opening B raises it; it stays below A.
  expect(ready({ 2: 0, 3: 1, 1: 2 }, [2])).toEqual([3, 1, 2]);
  // A goes to work and is raised; B stays below C.
  expect(ready({ 1: 0, 2: 1, 3: 2 }, [2], [1])).toEqual([3, 2]);
});
test("dragging a held ready agent replaces its neighbours until focus leaves", () => {
  const since = new agentSections.Since(),
    ready = (order: number[], held: boolean) => {
      const items = order.map((pane, rank) => item(pane, "idle", { attention: "finished", rank }));
      since.place(items, new Set(held ? ["pane:2"] : []));
      return agentSections.arrange(items, options()).flatMap(e => ("pane" in e.target ? [e.target.pane] : []));
    };
  expect(ready([1, 2, 3], false)).toEqual([1, 2, 3]);
  expect(ready([2, 1, 3], true)).toEqual([1, 2, 3]);
  since.move("pane:2", null);
  expect(ready([1, 3, 2], true)).toEqual([1, 3, 2]);
  // Another arrival stays above the reader's new place.
  expect(ready([4, 1, 3, 2], true)).toEqual([4, 1, 3, 2]);
  since.move("pane:2", "pane:1");
  expect(ready([4, 2, 1, 3], true)).toEqual([4, 2, 1, 3]);
  since.move("pane:2", "pane:4");
  expect(ready([2, 4, 1, 3], true)).toEqual([2, 4, 1, 3]);
  expect(ready([4, 1, 3, 2], false)).toEqual([4, 1, 3, 2]);
});
test("a held ready agent starred and unstarred keeps its place", () => {
  const since = new agentSections.Since(),
    ready = (ranks: Record<number, number>, starred: number[] = []) => {
      const items = Object.entries(ranks).map(([pane, rank]) =>
        item(Number(pane), "idle", { attention: "finished", rank, pin: starred.includes(Number(pane)) ? 0 : null }),
      );
      since.place(items, new Set(["pane:2"]));
      return agentSections
        .arrange(items, options())
        .filter(e => e.section === "ready")
        .flatMap(e => ("pane" in e.target ? [e.target.pane] : []));
    };
  since.place(
    [1, 2, 3].map(pane => item(pane, "idle", { attention: "finished", rank: pane - 1 })),
    new Set(),
  );
  expect(ready({ 2: 0, 1: 1, 3: 2 })).toEqual([1, 2, 3]);
  expect(ready({ 2: 0, 1: 1, 3: 2 }, [2])).toEqual([1, 3]);
  expect(ready({ 2: 0, 1: 1, 3: 2 })).toEqual([1, 2, 3]);
});
test("a held ready agent stops following a neighbour that leaves its section", () => {
  for (const change of ["working", "starred", "workspace", "closed"] as const) {
    const since = new agentSections.Since(),
      ready = (pane: number, rank: number) => item(pane, "idle", { attention: "finished", rank }),
      place = (items: agentSections.Item[], held: boolean) => {
        since.place(items, new Set(held ? ["pane:2"] : []));
        return agentSections
          .arrange(
            items.filter(i => i.workspace === 1),
            options(),
          )
          .filter(e => e.section === "ready")
          .map(e => e.target);
      };
    expect(place([ready(1, 0), ready(2, 1), ready(3, 2)], false)).toEqual([{ pane: 1 }, { pane: 2 }, { pane: 3 }]);
    expect(place([ready(1, 1), ready(2, 0), ready(3, 2)], true)).toEqual([{ pane: 1 }, { pane: 2 }, { pane: 3 }]);
    const neighbour = ready(3, 0);
    switch (change) {
      case "working":
        neighbour.section = "working";
        break;
      case "starred":
        neighbour.pin = 0;
        break;
      case "workspace":
        neighbour.workspace = 2;
        break;
      case "closed":
        break;
    }
    expect(place([ready(1, 2), ready(2, 1), ...(change === "closed" ? [] : [neighbour])], true)).toEqual([
      { pane: 1 },
      { pane: 2 },
    ]);
    // Returning at the top must not pull the reader up with it.
    expect(place([ready(1, 2), ready(2, 1), ready(3, 0)], true)).toEqual([{ pane: 3 }, { pane: 1 }, { pane: 2 }]);
  }
});
test("a held ready agent alone in its section lets one that enters go on top", () => {
  const since = new agentSections.Since(),
    place = (items: agentSections.Item[], held: number[]) => {
      since.place(items, new Set(held.map(pane => `pane:${pane}`)));
      return agentSections
        .arrange(items, options())
        .filter(e => e.section === "ready")
        .flatMap(e => ("pane" in e.target ? [e.target.pane] : []));
    },
    ready = (pane: number, rank: number) => item(pane, "idle", { attention: "finished", rank });
  // B is read and held, alone in ready; A works below where B was.
  expect(place([ready(2, 0), item(1, "working", { rank: 1 })], [2])).toEqual([2]);
  // A finishes and is raised; it goes above B, though it was below B in working.
  expect(place([ready(1, 0), ready(2, 1)], [2])).toEqual([1, 2]);
  expect(place([ready(1, 0), ready(2, 1)], [2])).toEqual([1, 2]);
});
