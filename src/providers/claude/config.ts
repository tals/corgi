import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../common";
import { vocabulary } from "./info";

export function configDir(env = process.env) {
  return configHome(env, vocabulary.config_env, ".claude");
}
function readModel(root: string, relative: string): string | null {
  try {
    const file = join(root, relative),
      s = statSync(file);
    if (!s.isFile() || s.size > 1024 * 1024) return null;
    const model = JSON.parse(readFileSync(file, "utf8"))?.model;
    return typeof model === "string" && model ? model : null;
  } catch {
    return null;
  }
}
/** The model Claude Code's settings choose in `cwd`, and the setting that won. */
export function settingsModel(cwd: string, env = process.env) {
  let chosen = { model: "", source: "Account default / provider selection" };
  const read = (root: string, relative: string, source: string) => {
    const model = readModel(root, relative);
    if (model) chosen = { model, source };
  };
  try {
    read(configDir(env), "settings.json", "User settings");
  } catch {}
  read(cwd, ".claude/settings.json", "Project settings (if trusted)");
  read(cwd, ".claude/settings.local.json", "Local settings (if trusted)");
  if (env.ANTHROPIC_MODEL) chosen = { model: env.ANTHROPIC_MODEL, source: "ANTHROPIC_MODEL" };
  read("/Library/Application Support/ClaudeCode", "managed-settings.json", "Managed settings");
  return chosen;
}
