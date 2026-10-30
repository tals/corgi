import { test, expect } from "bun:test";
import * as cli_args from "./cli_args";

test("help is a request before validating command arguments", () => {
  for (const [args, topic] of [
    [["--help"], []],
    [["-h"], []],
    [["help"], []],
    [["--no-agent", "--help"], []],
    [
      ["--help", "pane", "read"],
      ["pane", "read"],
    ],
    [
      ["pane", "read", "--help"],
      ["pane", "read"],
    ],
    [
      ["help", "pane", "read"],
      ["pane", "read"],
    ],
    [
      ["pane", "help", "read"],
      ["pane", "read"],
    ],
    [
      ["pane", "read", "--bad", "-h"],
      ["pane", "read", "--bad"],
    ],
    [["--skill", "--help"], ["--skill"]],
    [["agent", "--help"], ["agent"]],
    [
      ["account", "add", "--help"],
      ["account", "add"],
    ],
  ])
    expect(cli_args.parse(args)).toEqual({ kind: "help", topic });
  for (const group of ["tab", "pane", "workspace", "launcher", "headless", "integration"])
    expect(cli_args.parse([group])).toEqual({ kind: "help", topic: [group] });
});

test("option values, --, provider arguments and internal commands remain literal", () => {
  for (const args of [
    ["pane", "send", "3", "--", "--help", "--agent"],
    ["tab", "new", "--name", "--help", "--command", "--agent"],
    ["launcher", "edit", "pi", "--flags", "--help"],
    ["agent", "codex", "--help", "--agent", "--version"],
    ["agent", "pi", "help"],
    ["__handoff", "--help"],
    ["account", "rename", "work", "help"],
  ])
    expect(cli_args.parse(args)).toEqual({ kind: "command", args, agent: null });
});

test("mode flags are parsed once, with the last flag winning", () => {
  expect(cli_args.parse(["--agent", "list", "--no-agent"])).toEqual({
    kind: "command",
    args: ["list"],
    agent: false,
  });
  expect(cli_args.parse(["--agent", "agent", "pi", "--no-agent"])).toEqual({
    kind: "command",
    args: ["agent", "pi", "--no-agent"],
    agent: true,
  });
});

test("bare account still lists accounts and no command still attaches", () => {
  for (const args of [[], ["account"], ["update"]])
    expect(cli_args.parse(args)).toEqual({ kind: "command", args, agent: null });
  expect(cli_args.parse(["--version"])).toEqual({ kind: "version" });
  expect(cli_args.parse(["--skill"])).toEqual({ kind: "skill" });
});
