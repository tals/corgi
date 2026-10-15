import { test, expect } from "bun:test";
import { realpathSync } from "node:fs";
import { asksHelp, help, parse, usage } from "./cli";

test("help is asked for only before --", () => {
  expect(asksHelp(["move", "3", "--help"])).toBe(true);
  expect(asksHelp(["read", "-h"])).toBe(true);
  expect(asksHelp(["send", "3", "--", "--help"])).toBe(false);
  expect(asksHelp(["send", "3", "help"])).toBe(false);
});
test("usage finds the lines for the longest command a line names", () => {
  expect(usage(help, ["pane", "split", "3", "--righ"]).map(line => line.trim())).toEqual([
    "corgi pane split ID|current --right|--left|--up|--down [--cwd DIR]",
  ]);
  expect(usage(help, ["pane", "move"])).toHaveLength(2);
  expect(usage(help, ["workspace", "new", "X"]).every(line => line.includes("corgi workspace"))).toBe(true);
  expect(usage(help, ["tab", "bogus"]).every(line => line.trim().startsWith("corgi tab "))).toBe(true);
  expect(usage(help, ["bogus"])).toEqual([]);
});

test("command lines are rejected before connecting", async () => {
  const cases: [string[], string?, number?][] = [
    [["pane", "split"]],
    [["pane", "split", "0", "--right"]],
    [["pane", "split", "x", "--right"], "InvalidCharacter"],
    [["pane", "split", "current", "--right"], "NoCallerPane"],
    [["pane", "split", "3"]],
    [["pane", "split", "3", "--right", "--up"]],
    [["pane", "split", "3", "--right", "--unknown"]],
    [["pane", "split", "3", "--right", "--unknown", "value"]],
    [["pane", "split", "3", "--right", "--right"]],
    [["pane", "split", "3", "--righ"]],
    [["tab", "new", "--workspace", "1", "--name"]],
    [["pane", "move", "3"]],
    [["pane", "move", "3", "--new-tab", "--below", "3"]],
    [["pane", "move", "3", "--right-of", "0"]],
    [["pane", "swap", "3"]],
    [["pane", "resize", "3", "--width", "50%", "--height", "50%"]],
    [["pane", "resize", "3", "--width", "50"]],
    [["pane", "resize", "3", "--width", "95%"]],
    [["pane", "close", "3", "--cwd", "/tmp"]],
    [["pane", "read", "3", "--lines", "0"]],
    [["pane", "send", "3"]],
    [["pane", "keys", "3"]],
    [["pane", "keys", "3", "enter", "invalid-key"], "InvalidKey"],
    [["pane", "bogus", "3"]],
    [["tab", "new"], "MissingWorkspace"],
    [["tab", "new", "--workspace", "1", "--name", "one", "--name", "two"]],
    [["tab", "rename", "4", "--clear", "oops"]],
    [["tab", "move", "4", "--before", "6", "--workspace", "1"]],
    [["tab", "merge", "4"]],
    [["workspace", "edit", "2", "--name", "Oops", "--clear"]],
    [["workspace", "close", "2", "--cwd", "/tmp"]],
    [["workspace", "close", "current"], "Usage", 3],
    [["focus", "3"]],
    [["current"], "NoCallerPane"],
    [["list", "extra"]],
    [["list", "--text", "--text"]],
  ];
  for (const [words, error = "Usage", caller = 0] of cases) await expect(parse(words, caller)).rejects.toThrow(error);
});
test("command lines parse to the request the daemon receives", async () => {
  const cases: [string[], any, number?][] = [
    [["list", "--text"], { action: "list", text_mode: true }],
    [["workspace", "list"], { action: "list" }],
    [["current"], { action: "current" }, 5],
    [["focus", "3", "--viewer", "9"], { action: "focus", target: 3, viewer: 9 }],
    [["workspace", "switch", "2"], { action: "workspace.switch", target: 2 }],
    [
      ["tab", "new", "--workspace", "2", "--name", "Build", "--command", "make"],
      { action: "tab.new", command: { "pane.create": { workspace: 2, title: "Build", cwd: "", command: "make" } } },
    ],
    [
      ["tab", "new"],
      { action: "tab.new", command: { "pane.create": { workspace: 0, title: "", cwd: "", command: null } } },
      5,
    ],
    [
      ["tab", "rename", "4", "Backend"],
      { action: "tab.rename", target: 4, command: { "tab.rename": { target: 4, name: "Backend" } } },
    ],
    [
      ["tab", "rename", "4", "--clear"],
      { action: "tab.rename", target: 4, command: { "tab.rename": { target: 4, name: "" } } },
    ],
    [
      ["tab", "move", "4", "--after", "6"],
      { action: "tab.move", target: 4, command: { "tab.move": { target: 4, destination: { after: 6 } } } },
    ],
    [
      ["tab", "move", "4", "--workspace", "2"],
      { action: "tab.move", target: 4, command: { "tab.move": { target: 4, destination: { workspace: 2 } } } },
    ],
    [
      ["tab", "merge", "4", "--below", "7"],
      { action: "tab.merge", target: 4, command: { "tab.merge": { target: 4, other: 7, direction: "down" } } },
    ],
    [["tab", "close", "4"], { action: "tab.close", target: 4, command: { "tab.close": { target: 4 } } }],
    [
      ["pane", "split", "3", "--left", "--command", "make"],
      {
        action: "pane.split",
        target: 3,
        command: { "pane.split": { target: 3, direction: "left", cwd: "", command: "make" } },
      },
    ],
    [
      ["pane", "move", "3", "--left-of", "7"],
      {
        action: "pane.move",
        target: 3,
        command: { "pane.move": { target: 3, destination: { beside: { other: 7, direction: "left" } } } },
      },
    ],
    [
      ["pane", "move", "3", "--new-tab", "--name", "Logs"],
      { action: "pane.move", target: 3, command: { "pane.move": { target: 3, destination: { new_tab: "Logs" } } } },
    ],
    [["pane", "swap", "3", "7"], { action: "pane.swap", target: 3, command: { "pane.swap": { target: 3, other: 7 } } }],
    [
      ["pane", "resize", "3", "--height", "60%"],
      { action: "pane.resize", target: 3, command: { "pane.resize": { target: 3, axis: "vertical", ratio: 600 } } },
    ],
    [["pane", "close", "3"], { action: "pane.close", target: 3, command: { "pane.close": { target: 3 } } }],
    [
      ["pane", "send", "3", "--enter", "--", "--literal"],
      { action: "pane.send", target: 3, command: { "pane.send": { target: 3, text: "--literal", enter: true } } },
    ],
    [
      ["pane", "keys", "3", "ctrl+c", "enter"],
      { action: "pane.keys", target: 3, command: { "pane.keys": { target: 3, text: "ctrl+c enter" } } },
    ],
    [
      ["workspace", "new", "Project", "--cwd", "/tmp"],
      { action: "workspace.new", command: { "workspace.create": { name: "Project", cwd: realpathSync("/tmp") } } },
    ],
    [
      ["workspace", "edit", "2", "--clear", "--cwd", "/tmp"],
      {
        action: "workspace.edit",
        target: 2,
        command: { "workspace.edit": { target: 2, name: "", cwd: realpathSync("/tmp") } },
      },
    ],
    [
      ["workspace", "close", "2"],
      { action: "workspace.close", target: 2, command: { "workspace.close": { target: 2 } } },
    ],
  ];
  for (const [words, want, caller = 0] of cases)
    expect(await parse(words, caller)).toEqual({
      target: 0,
      current: false,
      text_mode: false,
      viewer: null,
      command: null,
      ...want,
    });
  expect(await parse(["pane", "read", "current", "--lines", "10", "--text"], 5)).toEqual({
    action: "pane.read",
    target: 5,
    current: true,
    text_mode: true,
    viewer: null,
    command: { "pane.read": { target: 5, lines: 10 } },
  });
});
