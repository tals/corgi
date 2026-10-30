import { test, expect, spyOn } from "bun:test";
import { run } from "./main";
import * as cli_help from "./cli_help";

test("root help is the full reference regardless of agent mode", async () => {
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  const previous = process.env.CORGI_AGENT_MODE;
  try {
    for (const mode of ["0", "1"]) {
      process.env.CORGI_AGENT_MODE = mode;
      for (const args of [["--help"], ["--agent", "--help"], ["--no-agent", "--help"]]) {
        output.mockClear();
        await run(args);
        expect(output.mock.calls[0][0]).toBe(cli_help.render());
        expect(String(output.mock.calls[0][0])).toContain("corgi shutdown");
      }
    }
  } finally {
    output.mockRestore();
    if (previous === undefined) delete process.env.CORGI_AGENT_MODE;
    else process.env.CORGI_AGENT_MODE = previous;
  }
});

test("help returns before executing commands or reading stdin", async () => {
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    for (const [args, topic] of [
      [["shutdown", "--help"], ["shutdown"]],
      [["serve", "--help"], ["serve"]],
      [["reload", "-h"], ["reload"]],
      [
        ["account", "remove", "work", "--help"],
        ["account", "remove"],
      ],
      [
        ["integration", "uninstall", "--help"],
        ["integration", "uninstall"],
      ],
      [
        ["pane", "send", "--stdin", "--help"],
        ["pane", "send"],
      ],
      [
        ["help", "pane", "read"],
        ["pane", "read"],
      ],
      [["--skill", "--help"], ["--skill"]],
      [["agent", "--help"], ["agent"]],
    ]) {
      output.mockClear();
      await run(args);
      expect(output.mock.calls[0][0]).toBe(cli_help.render(topic));
    }
  } finally {
    output.mockRestore();
  }
});
