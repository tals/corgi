import { test, expect } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { File, command, counted, merged, removed } from "./hooks_file";
import * as claude from "./claude";
import * as codex from "./codex";
const ours = command("claude");
test("hook removal takes out only Corgi's handlers and reports where the rest moved", () => {
  const theirs = { type: "command", command: "herdr-hook session" },
    original = JSON.stringify({ model: "opus", hooks: { SessionStart: [{ hooks: [theirs] }] } }),
    removal = removed(merged(original, claude.events, ours)!, ours)!;
  expect(JSON.parse(removal.text)).toEqual(JSON.parse(original));
  expect(removal.removed).toContainEqual({ event: "SessionStart", group: 1, handler: 0 });
  expect(removal.moved).toEqual([
    [
      { event: "SessionStart", group: 0, handler: 0 },
      { event: "SessionStart", group: 0, handler: 0 },
    ],
  ]);
  expect(removed(removal.text, ours)).toBeNull();
});
test("hook removal renumbers handlers after Corgi's and drops what it empties", () => {
  const handler = { type: "command", command: ours },
    theirs = { type: "command", command: "theirs" },
    removal = removed(
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [handler] }, { matcher: "x", hooks: [handler, theirs] }],
          PreToolUse: [{ hooks: [handler] }],
        },
      }),
      ours,
    )!;
  expect(JSON.parse(removal.text)).toEqual({ hooks: { Stop: [{ matcher: "x", hooks: [theirs] }] } });
  expect(removal.moved).toEqual([
    [
      { event: "Stop", group: 1, handler: 1 },
      { event: "Stop", group: 0, handler: 0 },
    ],
  ]);
  expect(removed(JSON.stringify({ hooks: { Stop: [{ hooks: [handler] }] } }), ours)!.text).toBe("{}");
  expect(removed("{}", ours)).toBeNull();
  expect(() => removed("[]", ours)).toThrow("InvalidHookSettings");
});
test("hook status counts the events that run Corgi's handler", () => {
  const all = merged("{}", claude.events, ours)!,
    some = JSON.parse(all);
  delete some.hooks.Stop;
  expect(counted(all, claude.events, ours)).toEqual([claude.events.length, claude.events.length]);
  expect(counted(JSON.stringify(some), claude.events, ours)).toEqual([claude.events.length - 1, claude.events.length]);
  expect(counted("{}", claude.events, ours)).toEqual([0, claude.events.length]);
});
test("installing leaves hook settings that already have every hook untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-hooks-")),
    file = new File("claude", directory, "settings.json", claude.events);
  try {
    const all = JSON.parse(merged("{}", claude.events, ours)!),
      written = JSON.stringify({ theme: "dark", hooks: all.hooks });
    writeFileSync(file.path, written);
    expect(file.install().outcome).toBe("present");
    expect(readdirSync(directory)).toEqual(["settings.json"]);
    expect(readFileSync(file.path, "utf8")).toBe(written);
    delete all.hooks.SubagentStop;
    writeFileSync(file.path, JSON.stringify({ theme: "dark", hooks: all.hooks }));
    expect(file.install().outcome).toBe("added");
    expect(counted(readFileSync(file.path, "utf8"), claude.events, ours)).toEqual([
      claude.events.length,
      claude.events.length,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("an account whose settings link to the default's gets its hooks there, and the link stays", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-hooks-")),
    home = join(root, "home"),
    work = join(root, "work"),
    elsewhere = join(root, "dotfiles.json");
  try {
    mkdirSync(home);
    mkdirSync(work);
    writeFileSync(join(home, "settings.json"), '{"theme":"dark"}');
    symlinkSync(join(home, "settings.json"), join(work, "settings.json"));
    const file = new File("claude", work, "settings.json", claude.events, home);
    expect(file.install().outcome).toBe("added");
    expect(lstatSync(join(work, "settings.json")).isSymbolicLink()).toBe(true);
    expect(counted(readFileSync(join(home, "settings.json"), "utf8"), claude.events, ours)).toEqual([
      claude.events.length,
      claude.events.length,
    ]);
    expect(new File("claude", home, "settings.json", claude.events).install().outcome).toBe("present");
    expect(readdirSync(work)).toEqual(["settings.json"]);
    // A link anywhere else stays as it is.
    writeFileSync(elsewhere, "{}");
    rmSync(join(work, "settings.json"));
    symlinkSync(elsewhere, join(work, "settings.json"));
    expect(new File("claude", work, "settings.json", claude.events, home).install().outcome).toBe("failed");
    expect(readFileSync(elsewhere, "utf8")).toBe("{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("hook install names Corgi's handlers and leaves ones it added unnamed as they are", () => {
  const handler = command("codex"),
    added = JSON.parse(merged("{}", codex.events, handler)!);
  expect(added.hooks.Stop).toEqual([
    { hooks: [{ type: "command", command: handler, timeout: 2, statusMessage: "Reporting to Corgi" }] },
  ]);
  for (const groups of Object.values<any>(added.hooks)) delete groups[0].hooks[0].statusMessage;
  expect(merged(JSON.stringify(added), codex.events, handler)).toBeNull();
});
