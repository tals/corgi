import { expect, test } from "bun:test";
import { List, type Item, type Status } from "./activity/checklist";
import { visible, window } from "./checklist_view";

const item = (text: string, status: Status, group = ""): Item => ({ text, status, group });
const texts = (list: List, limit?: number, rows?: number) => window(list, limit, rows).items.map(item => item.text);

test("windows group statuses stably across groups without reordering the provider's checklist", () => {
  const list = new List([
    item("Upcoming", "pending", "First"),
    item("Done", "done", "First"),
    item("Working", "active", "First"),
    item("Dropped", "dropped", "Second"),
    item("Blocked", "blocked", "Second"),
  ]);
  const view = window(list);
  expect(view.items.map(item => [item.run, item.status])).toEqual([
    [0, "done"],
    [1, "dropped"],
    [0, "active"],
    [1, "blocked"],
    [0, "pending"],
  ]);
  expect(view.groups.map(group => [group.name, group.items.map(item => item.status)])).toEqual([
    ["First", ["done", "active", "pending"]],
    ["Second", ["dropped", "blocked"]],
  ]);
  expect(list.items.map(item => item.text)).toEqual(["Upcoming", "Done", "Working", "Dropped", "Blocked"]);
});

function checklist(active: number, keep: (item: Item) => boolean = () => true, partial = false) {
  return new List(
    [
      ...Array.from({ length: 10 }, (_, i) => item(`Done ${i}`, "done", "Tasks")),
      ...Array.from({ length: 10 }, (_, i) => item(`Next ${i}`, "pending", "Tasks")),
      ...Array.from({ length: active }, (_, i) => item(`Active ${i}`, "active", "Tasks")),
    ].filter(keep),
    partial,
  );
}

test("context favors upcoming work and merges the context of adjacent active items", () => {
  expect(texts(checklist(1))).toEqual(["Active 0", "Next 0", "Next 1", "Next 2", "Next 3"]);
  expect(texts(checklist(2))).toEqual(["Active 0", "Active 1", "Next 0", "Next 1", "Next 2"]);
  expect(texts(checklist(2), 3)).toEqual(["Active 0", "Active 1", "Next 0"]);
});

test("overflowing active work takes the five main slots before upcoming context", () => {
  expect(texts(checklist(7), 20)).toEqual(["Active 0", "Active 1", "Active 2", "Active 3", "Active 4"]);
  expect(window(checklist(7), 0).items).toEqual([]);
});

test("windows follow the next item or the latest finished work when nothing is active", () => {
  expect(texts(checklist(0))).toEqual(["Next 0", "Next 1", "Next 2", "Next 3", "Next 4"]);
  const done = checklist(0, item => item.status === "done");
  expect(texts(done)).toEqual(["Done 5", "Done 6", "Done 7", "Done 8", "Done 9"]);
  const reopened = new List(done.items.map(item => ({ ...item, status: "pending" as const })));
  expect(texts(reopened)).toEqual(["Done 0", "Done 1", "Done 2", "Done 3", "Done 4"]);
  expect(window(new List()).items).toEqual([]);
});

test("windows fill spare context from the last closed items and count only hidden pending work", () => {
  expect(window(checklist(2)).more_pending).toBe(7);
  const one_next = checklist(2, item => item.status !== "pending" || item.text === "Next 0");
  const view = window(one_next);
  expect(view.items.map(item => item.text)).toEqual(["Done 8", "Done 9", "Active 0", "Active 1", "Next 0"]);
  expect(view.more_pending).toBe(0);
  expect(window(checklist(0, item => item.status === "done", true)).more_pending).toBe(0);
  expect(window(checklist(7, item => item.status !== "pending")).more_pending).toBe(0);
});

test("finished checklists retire a minute after their time; open work stays visible", () => {
  const at = 1_000_000;
  const finished = [item("Shipped", "done", "Work"), item("Not needed", "dropped", "Work")];
  const list = new List(finished, false, at);
  expect(visible(list, at + 59_999_999)).toBe(true);
  expect(visible(list, at + 60_000_000)).toBe(false);
  expect(list.items.map(item => item.text)).toEqual(["Shipped", "Not needed"]);
  for (const status of ["pending", "active", "blocked"] as const)
    expect(visible(new List([finished[0], { ...finished[1], status }], false, at), at + 3_600_000_000)).toBe(true);
});

test("retirement requires a complete inventory and a known time", () => {
  const shipped = [item("Shipped", "done", "Work")];
  expect(visible(new List(shipped, true, 1_000_000), 3_600_000_000)).toBe(true);
  expect(visible(new List(shipped, false, 0), 3_600_000_000)).toBe(true);
  expect(visible(new List(), 3_600_000_000)).toBe(false);
});

test("windows budget group headings and pending overflow without orphaning a group", () => {
  const list = new List([
    item("Plan", "done", "Preparation"),
    item("Build", "active", "Implementation"),
    item("Wire", "pending", "Implementation"),
    item("Polish", "pending", "Implementation"),
    item("Test", "pending", "Verification"),
    item("Review", "pending", "Verification"),
  ]);
  const full = window(list);
  expect(full.groups.map(group => group.name)).toEqual(["Implementation", "Verification"]);
  expect(full.rows).toBe(7);
  expect(full.more_pending).toBe(0);
  const short = window(list, 5, 6);
  expect(short.groups.map(group => group.name)).toEqual(["Implementation"]);
  expect(short.items.map(item => item.text)).toEqual(["Build", "Wire", "Polish"]);
  expect(short.more_pending).toBe(2);
  expect(short.rows).toBe(5);
  expect(window(list, 5, 1).groups).toEqual([]);
});

test("a group is a run of one label, and a single group needs no heading", () => {
  const apart = new List([
    item("Client", "active", "Build"),
    item("Deploy", "pending", "Ship"),
    item("Server", "pending", "Build"),
  ]);
  expect(window(apart).groups.map(group => [group.name, group.items.map(item => item.text)])).toEqual([
    ["Build", ["Client"]],
    ["Ship", ["Deploy"]],
    ["Build", ["Server"]],
  ]);
  const together = window(new List([item("Client", "active", "Build"), item("Server", "pending", "Build")]));
  expect(together.groups.map(group => [group.name, group.items.length])).toEqual([["", 2]]);
  expect(together.rows).toBe(2);
});

function summary(done: number, pending: number): Item[] {
  return [
    ...Array.from({ length: done }, (_, i) => item(`Done ${i}`, "done", "Work")),
    item("Doing", "active", "Work"),
    ...Array.from({ length: pending }, (_, i) => item(`Next ${i}`, "pending", "Work")),
  ];
}

test("active groups summarize multiple omitted completions without counting other groups or dropped work", () => {
  const items = [item("Old plan", "done", "Earlier"), item("Dropped experiment", "dropped", "Work"), ...summary(2, 6)];
  const view = window(new List(items));
  expect(view.groups.map(group => [group.name, group.more_done])).toEqual([["Work", 2]]);
  expect(view.more_pending).toBe(2);
  expect(view.items.map(item => item.text)).toEqual(["Doing", "Next 0", "Next 1", "Next 2", "Next 3"]);
  const idle = items.map(item => (item.status === "active" ? { ...item, status: "pending" as const } : item));
  expect(window(new List(idle)).groups.every(group => group.more_done === 0)).toBe(true);
});

test("single omitted done and pending items replace their summary rows with actual items", () => {
  const view = window(new List(summary(1, 5)));
  expect(view.items.map(item => item.text)).toEqual([
    "Done 0",
    "Doing",
    "Next 0",
    "Next 1",
    "Next 2",
    "Next 3",
    "Next 4",
  ]);
  expect(view.groups[0].more_done).toBe(0);
  expect(view.more_pending).toBe(0);
  expect(view.rows).toBe(7);
});

test("compact windows budget done summaries and never substitute a one-pending footer", () => {
  const single = new List(summary(0, 5));
  const fits = window(single, 5, 6);
  expect(fits.items.map(item => item.text)).toEqual(["Doing", "Next 0", "Next 1", "Next 2", "Next 3", "Next 4"]);
  expect(fits.more_pending).toBe(0);
  const short = window(single, 5, 5);
  expect(short.items.map(item => item.text)).toEqual(["Doing", "Next 0", "Next 1", "Next 2"]);
  expect(short.more_pending).toBe(2);
  expect(short.rows).toBe(5);
  const done = window(new List(summary(2, 6)), 5, 6);
  expect(done.groups[0].more_done).toBe(2);
  expect(done.more_pending).toBe(3);
  expect(done.rows).toBe(6);
});

test("a lone pending item in another group includes its heading or waits for enough space", () => {
  const list = new List([...summary(0, 4), item("Ship", "pending", "Release")]);
  const full = window(list, 5, 8);
  expect(full.groups.map(group => group.name)).toEqual(["Work", "Release"]);
  expect(full.items.at(-1)?.text).toBe("Ship");
  expect(full.more_pending).toBe(0);
  const short = window(list, 5, 7);
  expect(short.groups.map(group => group.name)).toEqual(["Work"]);
  expect(short.more_pending).toBe(2);
  expect(short.rows).toBe(6);
});
