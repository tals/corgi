import { test, expect } from "bun:test";
import {
  Inventory,
  Children,
  Shells,
  Ended,
  classify,
  claudeWakeup,
  capacity,
} from "./background_tasks";
test("provider tasks retain identity, descriptions and bounded categories", () => {
  const inventory = Inventory.claude(
    [
      {
        id: "1",
        type: "shell",
        status: "running",
        description: "Check parser",
        command: "bun test",
      },
      { id: "1", type: "shell", command: "bun test" },
      { id: "2", type: "subagent", description: "Ignore" },
      { id: "3", type: "shell", status: "completed", command: "bun build" },
    ],
    123,
  )!;
  expect(inventory.len).toBe(1);
  expect(inventory.items[0].label.text()).toBe("Check parser");
  expect(inventory.items[0].group).toBe("tests");
  expect(inventory.live).toBe(false);
  for (const [command, group] of [
    ["./scripts/zig build test", "tests"],
    ["bun run dev", "servers"],
    ["python3 -m pytest tests", "tests"],
    ["python3 -m http.server 8000", "servers"],
    ["echo 'test server'", "commands"],
  ] as const)
    expect(classify(command)).toBe(group);
  for (let i = 0; i < capacity + 1; i++)
    inventory.append(`task-${i}`, "Build", "bun run build");
  expect(inventory.len).toBe(capacity);
  expect(inventory.truncated).toBe(true);
});
test("a Claude Stop lists its running subagents apart from its commands", () => {
  const entries = [
    {
      id: "b1",
      type: "shell",
      status: "running",
      description: "Run tests",
      command: "bun test",
    },
    {
      id: "a1",
      type: "subagent",
      status: "running",
      description: "Lane A: sidebar",
      agent_type: "general-purpose",
    },
    {
      id: "a1",
      type: "subagent",
      status: "running",
      description: "Lane A: sidebar",
    },
    {
      id: "a2",
      type: "subagent",
      status: "pending",
      description: "Review",
      agent_type: "Explore",
    },
    { id: "a3", type: "subagent", status: "completed", description: "Done" },
    { id: "m1", type: "monitor", status: "running", description: "Watch" },
  ];
  const children = Children.claude(entries)!;
  expect(children.running).toBe(2);
  expect(children.complete()).toBe(true);
  expect(children.items[0].description.text()).toBe("Lane A: sidebar");
  expect(children.items[0].agent_type.text()).toBe("general-purpose");
  expect(children.listed("a2")).toBe(true);
  expect(children.listed("a3")).toBe(false);
  expect(children.listed("b1")).toBe(false);
  expect(Inventory.claude(entries, 1)?.len).toBe(1);
  expect(Children.claude(null)).toBeNull();
  expect(Children.claude([])?.running).toBe(0);
});
test("task labels summarize commands and bound provider prose", () => {
  const inventory = new Inventory();
  for (const [i, [description, command, label]] of [
    [
      "",
      "./scripts/zig build test -Doptimize=ReleaseSafe -Dcodesign=false",
      "Running tests",
    ],
    [
      "",
      "bun run dev --host 0.0.0.0 --port 3000",
      "Running development server",
    ],
    ["", "python3 -c 'a very long inline program'", "Running Python task"],
    [
      "",
      "sh -c 'cd /long/path && complex-command --many-flags'",
      "Running shell task",
    ],
    ["Check parser", "bun test", "Check parser"],
    ["bun test", "bun test", "Running tests"],
    [
      "Run the parser tests and validate all generated fixtures",
      "bun test",
      "Run the parser tests and validate…",
    ],
  ].entries()) {
    inventory.append(String(i), description, command);
    expect(inventory.items[i].label.text()).toBe(label);
  }
});
test("a Claude Stop lists the shells that can wake it, and the transcript ends them", () => {
  const shells = Shells.claude([
    { id: "m1", type: "shell", status: "running", command: "tail -F build.log" },
    { id: "m2", type: "shell", status: "completed" },
    { id: "m1", type: "shell", status: "running" },
    { id: "b1", type: "shell", status: "pending", command: "bun test" },
    { id: "a1", type: "subagent", status: "running" },
    { id: "", type: "shell", status: "running" },
  ]);
  expect(shells.len).toBe(2);
  expect(shells.slice()[0].text()).toBe("m1");
  expect(shells.slice()[1].text()).toBe("b1");
  const ended = new Ended();
  ended.add("x1");
  shells.drop(ended);
  expect(shells.len).toBe(2);
  ended.add("m1");
  ended.add("b1");
  shells.drop(ended);
  expect(shells.len).toBe(0);
  expect(Shells.claude(null).len).toBe(0);
  for (let i = 0; i < Ended.limit + 1; i++) ended.add(`t${i}`);
  expect(ended.len).toBe(Ended.limit);
  expect(ended.listed("x1")).toBe(false);
  expect(ended.listed("t0")).toBe(false);
  expect(ended.listed("t1")).toBe(true);
  expect(ended.listed("t16")).toBe(true);
});
test("only a one-shot cron is a wakeup the conversation waits on", () => {
  for (const [value, result] of [
    [
      [
        {
          id: "c1",
          schedule: "17 13 5 10 *",
          recurring: false,
          prompt: "check CI",
        },
      ],
      true,
    ],
    [
      [
        {
          id: "c1",
          schedule: "*/30 * * * *",
          recurring: true,
          prompt: "failsafe",
        },
      ],
      false,
    ],
    [[{ id: "c1", schedule: "17 13 5 10 *" }], false],
    [[], false],
    [null, false],
  ] as const)
    expect(claudeWakeup(value)).toBe(result);
});
