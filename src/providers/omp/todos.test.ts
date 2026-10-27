import { expect, test } from "bun:test";
import { List } from "../../activity/checklist";
import { parse } from "./todos";
import { decode } from "./index";

test("omp checklists flatten phases into groups and map every omp status", () => {
  const statuses = ["pending", "in_progress", "blocked", "completed", "abandoned"];
  const list = parse(
    {
      phases: [
        { name: "Build", tasks: statuses.map(status => ({ content: status, status })) },
        { name: "Ship", tasks: [{ content: "Release", status: "pending" }] },
      ],
    },
    7,
  );
  expect(list.items).toEqual([
    { text: "pending", status: "pending", group: "Build" },
    { text: "in_progress", status: "active", group: "Build" },
    { text: "blocked", status: "blocked", group: "Build" },
    { text: "completed", status: "done", group: "Build" },
    { text: "abandoned", status: "dropped", group: "Build" },
    { text: "Release", status: "pending", group: "Ship" },
  ]);
  expect(list.at).toBe(7);
  expect(parse({ phases: [] })).toEqual(new List());
  expect(parse(undefined)).toEqual(new List());
  expect(parse({ phases: "bad" })).toEqual(new List());
});

test("omp statuses need strict enum equality, and an unreadable status leaves the list partial", () => {
  const invalid: unknown[] = [
    ["pending"],
    {},
    { toString: () => "pending" },
    { toString: null, valueOf: null },
    null,
    0,
    true,
    "toString",
    "constructor",
    "unknown",
  ];
  const list = parse({
    phases: [
      null,
      "bad phase",
      { tasks: "bad tasks" },
      {
        name: 42,
        tasks: [
          null,
          "bad task",
          [],
          { content: {}, status: "pending" },
          { content: " Keep\n going ", status: "pending" },
        ],
      },
    ],
  });
  expect(list).toEqual(new List([{ text: "Keep going", status: "pending", group: "" }]));
  for (const status of invalid) {
    const unread = parse({ phases: [{ name: "", tasks: [{ content: "Invalid", status }] }] });
    expect(unread.items).toEqual([]);
    expect(unread.partial).toBe(true);
  }
});

test("omp's task limit spans phases", () => {
  const tasks = Array.from({ length: 32 }, () => ({ content: "Task", status: "pending" }));
  const phases = [
    { name: "First", tasks },
    { name: "Second", tasks },
  ];
  expect(parse({ phases }).partial).toBe(false);
  const list = parse({ phases: [...phases, { name: "Third", tasks }] });
  expect(list.items).toHaveLength(64);
  expect(list.items.some(item => item.group === "Third")).toBe(false);
  expect(list.partial).toBe(true);
});

test("omp checklist hooks carry the edit's time when the extension knows it", () => {
  const phases = [{ name: " Work\n", tasks: [{ content: " Ship\n safely ", status: "blocked" }] }];
  const hook = decode({ event: "Todos", session: "session", at: 1_700_000_000_000, todos: { phases } });
  expect(hook?.kind).toBe("checklist");
  expect(hook?.checklist).toEqual(
    new List([{ text: "Ship safely", status: "blocked", group: "Work" }], false, 1_700_000_000_000_000),
  );
  for (const at of [undefined, -1, 1.5, "1", Number.MAX_VALUE])
    expect(decode({ event: "Todos", session: "session", at, todos: { phases } })?.checklist?.at).toBe(0);
  expect(decode({ event: "Todos", session: "session", todos: { phases: [] } })?.checklist).toEqual(new List());
  expect(decode({ event: "Todos", session: "session", todos: {} })).toBeNull();
});
