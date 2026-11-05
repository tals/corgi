import { test, expect } from "bun:test";
import { Inventory, Ended, classify, capacity } from "./background_tasks";
import * as claudeConversation from "../providers/claude/conversation";
test("provider tasks retain identity, descriptions and bounded categories", () => {
  const inventory = claudeConversation.inventory(
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
  for (let i = 0; i < capacity + 1; i++) inventory.append(`task-${i}`, "Build", "bun run build");
  expect(inventory.len).toBe(capacity);
  expect(inventory.truncated).toBe(true);
});
test("task labels summarize commands and bound provider prose", () => {
  const inventory = new Inventory();
  for (const [i, [description, command, label]] of [
    ["", "./scripts/zig build test -Doptimize=ReleaseSafe -Dcodesign=false", "Running tests"],
    ["", "bun run dev --host 0.0.0.0 --port 3000", "Running development server"],
    ["", "python3 -c 'a very long inline program'", "Running Python task"],
    ["", "sh -c 'cd /long/path && complex-command --many-flags'", "Running shell task"],
    ["Check parser", "bun test", "Check parser"],
    ["bun test", "bun test", "Running tests"],
    ["Run the parser tests and validate all generated fixtures", "bun test", "Run the parser tests and validate…"],
  ].entries()) {
    inventory.append(String(i), description, command);
    expect(inventory.items[i].label.text()).toBe(label);
  }
});
test("a Claude Stop lists the Monitors that can wake it, and the transcript ends them", () => {
  const monitors = new Set(["m1", "m2", "b1"]);
  const shells = claudeConversation.shells(
    [
      { id: "m1", type: "shell", status: "running", command: "tail -F build.log" },
      { id: "m2", type: "shell", status: "completed" },
      { id: "m1", type: "shell", status: "running" },
      { id: "b1", type: "shell", status: "pending", command: "bun test" },
      { id: "a1", type: "subagent", status: "running" },
      { id: "", type: "shell", status: "running" },
      // A background command no Monitor started, such as a dev server.
      { id: "s1", type: "shell", status: "running", command: "bun run dev" },
    ],
    monitors,
  );
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
  expect(claudeConversation.shells(null, monitors).len).toBe(0);
  for (let i = 0; i < Ended.limit + 1; i++) ended.add(`t${i}`);
  expect(ended.len).toBe(Ended.limit);
  expect(ended.listed("x1")).toBe(false);
  expect(ended.listed("t0")).toBe(false);
  expect(ended.listed("t1")).toBe(true);
  expect(ended.listed("t16")).toBe(true);
});
