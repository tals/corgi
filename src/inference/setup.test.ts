import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launches, resolve, load, save, initial, loadUses, saveUses, off } from "./setup";

test("auto follows launched agents, then the remembered agent", () => {
  const launches = new Launches();
  expect(resolve("auto", launches, "codex")).toBe("codex");
  expect(resolve("auto", launches, "claude")).toBe("claude");
  launches.record("claude");
  expect(resolve("auto", launches, "codex")).toBe("claude");
  launches.record("codex");
  expect(resolve("auto", launches, "claude")).toBe("codex");
  launches.record("claude");
  launches.record("claude");
  launches.record("codex");
  expect(resolve("auto", launches, "codex")).toBe("claude");
  expect(resolve("codex", launches, "claude")).toBe("codex");
  expect(resolve("off", launches, "claude")).toBeNull();
});

test("setup choice round-trips beside workspace state", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-setup-"));
  try {
    const file = join(root, "nested", "settings.json");
    expect(load(file)).toBeNull();
    save(file, "claude");
    expect(load(file)).toBe("claude");
    save(file, "off");
    expect(load(file)).toBe("off");
    expect(initial("claude")).toBe("claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses save apart from the model choice; an old saved off turns them all off", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-setup-"));
  try {
    const file = join(root, "settings.json");
    expect([loadUses(file), off(file)]).toEqual([{ activity: true, worktrees: true }, false]);
    save(file, "off");
    expect([loadUses(file), off(file)]).toEqual([{ activity: false, worktrees: false }, true]);
    saveUses(file, { activity: false, worktrees: true });
    save(file, "claude");
    expect(load(file)).toBe("claude");
    expect([loadUses(file), off(file)]).toEqual([{ activity: false, worktrees: true }, false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch history restores legacy checkpoint counters", () => {
  const launches = Launches.restore({ codex: 7, claude: 4, latest: "claude" });
  expect(launches.count.codex).toBe(7);
  expect(launches.count.claude).toBe(4);
  expect(resolve("auto", launches, "claude")).toBe("codex");
});
