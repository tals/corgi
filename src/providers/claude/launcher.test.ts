import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsModel } from "./config";
test("project settings override the user's, and ANTHROPIC_MODEL overrides both", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-claude-model-")),
    config = join(root, "config"),
    project = join(root, "project");
  try {
    mkdirSync(config);
    mkdirSync(join(project, ".claude"), { recursive: true });
    const env = { HOME: root, CLAUDE_CONFIG_DIR: config };
    expect(settingsModel(project, env)).toEqual({ model: "", source: "Account default / provider selection" });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ model: "sonnet" }));
    expect(settingsModel(project, env)).toEqual({ model: "sonnet", source: "User settings" });
    writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({ model: "opus" }));
    expect(settingsModel(project, env)).toEqual({ model: "opus", source: "Project settings (if trusted)" });
    expect(settingsModel(project, { ...env, ANTHROPIC_MODEL: "haiku" })).toEqual({
      model: "haiku",
      source: "ANTHROPIC_MODEL",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
