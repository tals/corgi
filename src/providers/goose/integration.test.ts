import { test, expect } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePluginEnabled, install, pluginEnabled, removePluginEntry, status, uninstall } from "./integration";
test("Goose config edits enable, keep and remove the corgi entry", () => {
  expect(pluginEnabled("")).toBe(false);
  expect(pluginEnabled(ensurePluginEnabled(""))).toBe(true);
  const other = "plugins:\n  other:\n    enabled: true\n";
  const added = ensurePluginEnabled(other);
  expect(pluginEnabled(added)).toBe(true);
  expect(added).toContain("other:");
  const disabled = "plugins:\n  corgi:\n    enabled: false\n";
  expect(pluginEnabled(ensurePluginEnabled(disabled))).toBe(true);
  expect(pluginEnabled(removePluginEntry(ensurePluginEnabled(disabled)))).toBe(false);
  expect(removePluginEntry(other)).toBe(other);
});
test("Goose config edits match existing indent and never duplicate keys", () => {
  const four = "plugins:\n    other:\n      enabled: true\n";
  const added = ensurePluginEnabled(four);
  expect(pluginEnabled(added)).toBe(true);
  expect(added).toContain("    corgi:\n      enabled: true");
  expect(added).toContain("    other:\n      enabled: true");
  const empty = "plugins: {}\n";
  const flowed = ensurePluginEnabled(empty);
  expect(pluginEnabled(flowed)).toBe(true);
  expect(flowed).toBe("plugins: {corgi: {enabled: true}}\n");
  expect(flowed.match(/^plugins:/gm)?.length).toBe(1);
  const flow = "plugins: {other: {enabled: true}}\n";
  const flowedOther = ensurePluginEnabled(flow);
  expect(pluginEnabled(flowedOther)).toBe(true);
  expect(flowedOther).toBe("plugins: {other: {enabled: true}, corgi: {enabled: true}}\n");
  expect(flowedOther.match(/^plugins:/gm)?.length).toBe(1);
  expect(ensurePluginEnabled("plugins: {corgi: {enabled: true}}\n")).toBe("plugins: {corgi: {enabled: true}}\n");
  expect(pluginEnabled(ensurePluginEnabled("plugins: {corgi: {enabled: false}}\n"))).toBe(true);
  expect(ensurePluginEnabled("plugins:\n  corgi: {enabled: false}\n")).toBe("plugins:\n  corgi: {enabled: true}\n");
  expect(pluginEnabled(ensurePluginEnabled("plugins:\n  corgi: {enabled: true}\n"))).toBe(true);
  expect(() => ensurePluginEnabled("plugins: {\n  other: true\n}\n")).toThrow();
  expect(() => ensurePluginEnabled("plugins:\n  corgi: true\n")).toThrow();
  expect(removePluginEntry("plugins: {other: {enabled: true}, corgi: {enabled: true}}\n")).toBe(
    "plugins: {other: {enabled: true}}\n",
  );
  expect(removePluginEntry("plugins:\n  corgi: {enabled: true}\n  other:\n    enabled: true\n")).toBe(
    "plugins:\n  other:\n    enabled: true\n",
  );
});
test("Goose integration installs, reports and uninstalls in a temp root", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-goose-"));
  const env = { ...process.env, GOOSE_PATH_ROOT: root };
  try {
    const added = await install("", env);
    expect(added.map(r => r.outcome)).toEqual(["added", "added", "added"]);
    const hooks = join(root, ".agents", "plugins", "corgi", "hooks", "hooks.json");
    const script = join(root, ".agents", "plugins", "corgi", "hooks", "corgi-hook.mjs");
    const config = join(root, "config", "config.yaml");
    expect(existsSync(hooks)).toBe(true);
    expect(existsSync(script)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(hooks, "utf8")).hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "SessionEnd", "Stop", "PreToolUse", "PostToolUse", "PostToolUseFailure"]),
    );
    expect(readFileSync(script, "utf8").startsWith("// Corgi's Goose integration.")).toBe(true);
    expect(pluginEnabled(readFileSync(config, "utf8"))).toBe(true);
    const again = await install("", env);
    expect(again.map(r => r.outcome)).toEqual(["present", "present", "present"]);
    const reported = await status("", env);
    expect(reported.map(r => r.outcome)).toEqual(["present", "present", "present"]);
    const removed = await uninstall("", env);
    expect(removed.map(r => r.outcome)).toEqual(["removed", "removed", "removed"]);
    expect(existsSync(join(root, ".agents", "plugins", "corgi"))).toBe(false);
    expect(pluginEnabled(readFileSync(config, "utf8"))).toBe(false);
    const gone = await status("", env);
    expect(gone.map(r => r.outcome)).toEqual(["absent", "absent", "absent"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Goose integration backs up config.yaml before rewriting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-goose-"));
  const env = { ...process.env, GOOSE_PATH_ROOT: root };
  try {
    const config = join(root, "config", "config.yaml");
    mkdirSync(join(config, ".."), { recursive: true });
    const original = "active_provider: openai\n";
    writeFileSync(config, original);
    const added = await install("", env);
    expect(added.map(r => r.outcome)).toEqual(["added", "added", "added"]);
    expect(readFileSync(config + ".corgi-backup", "utf8")).toBe(original);
    expect(lstatSync(config + ".corgi-backup").mode & 0o777).toBe(0o600);
    const again = await install("", env);
    expect(again.map(r => r.outcome)).toEqual(["present", "present", "present"]);
    expect(readFileSync(config + ".corgi-backup", "utf8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Goose integration leaves a foreign plugin dir alone on status", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-goose-"));
  const env = { ...process.env, GOOSE_PATH_ROOT: root };
  try {
    const hooks = join(root, ".agents", "plugins", "corgi", "hooks", "hooks.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(hooks, ".."), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(hooks, JSON.stringify({ hooks: {} }));
    const reported = await status("", env);
    expect(reported[0].outcome).toBe("partial");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
);
