import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tokens } from "../launch/tokens";
import * as commands from "./commands";

test("saved command references are durable, private and only expand their exact contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-saved-commands-")),
    previous = process.env.XDG_STATE_HOME,
    original = "printf '%s' '" + "résumé ".repeat(500) + "'";
  process.env.XDG_STATE_HOME = directory;
  try {
    expect(commands.exportCommand(null)).toBeNull();
    expect(commands.exportCommand("echo short")).toBe("echo short");
    const reference = commands.exportCommand(original)!,
      tokens = new Tokens(reference);
    tokens.next();
    const file = tokens.next()!,
      before = statSync(file);
    expect(readFileSync(file, "utf8")).toBe(original + "\n");
    expect(before.mode & 0o777).toBe(0o600);
    expect(commands.exportCommand(original)).toBe(reference);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(commands.importCommand(reference)).toBe(original);
    expect(commands.importCommand(reference + " &")).toBe(reference + " &");
    expect(commands.importCommand(reference.replace(/[a-f0-9]{64}/, "0".repeat(64)))).not.toBe(original);
    rmSync(file);
    expect(commands.importCommand(reference)).toBe(reference);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
