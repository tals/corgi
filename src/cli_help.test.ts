import { test, expect } from "bun:test";
import * as cli_help from "./cli_help";

test("help and usage select exact subcommands, including former combined spellings", () => {
  expect(cli_help.usage(["workspace", "new", "X"])).toEqual(["  corgi workspace new NAME [--cwd DIR]"]);
  expect(cli_help.usage(["launcher", "show", "codex"])).toEqual(["  corgi launcher show AGENT... [--workspace ID]"]);
  expect(cli_help.usage(["update", "status"])).toEqual(["  corgi update status"]);
  expect(cli_help.usage(["pane", "move"])).toHaveLength(2);
  expect(cli_help.usage(["bogus"])).toEqual([]);
  expect(cli_help.usage(["tab", "bogus"]).every(line => line.startsWith("  corgi tab "))).toBe(true);
  expect(cli_help.render(["pane", "read", "3"])).toContain("Reads 100 lines by default");
  expect(cli_help.render(["pane", "read"])).not.toContain("corgi tab");
  expect(cli_help.render(["launcher", "edit"])).toContain("--flags FLAGS");
  expect(cli_help.render(["launcher", "clone"])).toContain("--effort LEVEL|default");
  expect(cli_help.render(["action"])).toContain(cli_help.actionNames);
  expect(() => cli_help.render(["bogus"])).toThrow("UnknownCommand");
});

test("every control command has focused help and groups have their commands", () => {
  for (const name of Object.keys(cli_help.controls)) {
    const args = name.split("."),
      help = cli_help.render(args);
    expect(help).toContain(`corgi ${args.join(" ")}`);
    expect(cli_help.render([args[0]])).toContain(`corgi ${args.join(" ")}`);
    expect(help).toContain("--json");
  }
});
