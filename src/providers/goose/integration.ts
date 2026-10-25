import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationStepResult } from "../adapter";
import { configHome } from "../common";
import { atomicWrite } from "../../os";
// The .txt suffix keeps the text loader: .json/.mjs keep their own types
// even with the attribute. The integration writes them under real names.
import hooksJson from "./plugin/hooks.json.txt" with { type: "text" };
import hookScript from "./plugin/corgi-hook.mjs.txt" with { type: "text" };

/** Goose's config dir, mirroring goose's Paths (config/paths.rs). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.GOOSE_PATH_ROOT;
  if (root && root.startsWith("/")) return join(root, "config");
  return join(configHome(env, "XDG_CONFIG_HOME", ".config"), "goose");
}
/** Goose's user plugin dir: ~/.agents/plugins, or under GOOSE_PATH_ROOT. */
export function pluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.GOOSE_PATH_ROOT;
  if (root && root.startsWith("/")) return join(root, ".agents", "plugins");
  if (!env.HOME) throw Error("NoHome");
  return join(env.HOME, ".agents", "plugins");
}
export const directory = (account = "", env: NodeJS.ProcessEnv = process.env) => account || configDir(env);
const pluginDir = (env: NodeJS.ProcessEnv = process.env) => join(pluginsDir(env), "corgi");
const hooksPath = (env: NodeJS.ProcessEnv = process.env) => join(pluginDir(env), "hooks", "hooks.json");
const scriptPath = (env: NodeJS.ProcessEnv = process.env) => join(pluginDir(env), "hooks", "corgi-hook.mjs");
const configPath = (account = "", env: NodeJS.ProcessEnv = process.env) => join(directory(account, env), "config.yaml");

/** A top-level `config.yaml` value in `dir`: the first matching key wins. */
export function configValueAt(dir: string, ...keys: string[]): string {
  let text = "";
  try {
    text = readFileSync(join(dir, "config.yaml"), "utf8");
  } catch {
    return "";
  }
  for (const key of keys) {
    const match = text.match(new RegExp(`^${key}:\\s*["']?([^"'\\s#]+)`, "m"));
    if (match) return match[1];
  }
  return "";
}

/** The lines of a top-level `plugins:` block: its indent, and each child's key. */
function pluginsBlock(lines: string[]): { at: number; indent: number } | null {
  const at = lines.findIndex(l => /^plugins:\s*(#.*)?$/.test(l));
  if (at < 0) return null;
  return { at, indent: lines[at].search(/\S/) };
}
function childBlock(lines: string[], at: number, indent: number, key: string): { at: number; indent: number } | null {
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const lineIndent = line.search(/\S/);
    if (lineIndent <= indent) return null;
    if (new RegExp(`^\\s*${key}:\\s*(#.*)?$`).test(line)) return { at: i, indent: lineIndent };
  }
  return null;
}
/** Whether config.yaml enables the corgi plugin. */
export function pluginEnabled(yaml: string): boolean {
  const lines = yaml.split("\n");
  const plugins = pluginsBlock(lines);
  if (!plugins) return false;
  const corgi = childBlock(lines, plugins.at, plugins.indent, "corgi");
  if (!corgi) return false;
  for (let i = corgi.at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (line.search(/\S/) <= corgi.indent) return false;
    const m = /^\s*enabled:\s*(true|false)\s*(#.*)?$/.exec(line);
    if (m) return m[1] === "true";
  }
  return false;
}
/** config.yaml with the corgi plugin enabled. Text edit, not a YAML parse. */
export function ensurePluginEnabled(yaml: string): string {
  const lines = yaml.split("\n");
  const plugins = pluginsBlock(lines);
  if (!plugins) {
    const block = ["plugins:", "  corgi:", "    enabled: true"];
    if (yaml === "") return block.join("\n") + "\n";
    return [...lines, ...(lines[lines.length - 1] === "" ? [] : [""]), ...block].join("\n") + "\n";
  }
  const corgi = childBlock(lines, plugins.at, plugins.indent, "corgi");
  if (!corgi) {
    lines.splice(plugins.at + 1, 0, "  corgi:", "    enabled: true");
    return lines.join("\n");
  }
  for (let i = corgi.at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (line.search(/\S/) <= corgi.indent) break;
    const m = /^(\s*enabled:\s*)false(\s*(#.*)?)$/.exec(line);
    if (m) {
      lines[i] = m[1] + "true" + m[2];
      return lines.join("\n");
    }
    if (/^\s*enabled:\s*true\s*(#.*)?$/.test(line)) return lines.join("\n");
  }
  lines.splice(corgi.at + 1, 0, "    enabled: true");
  return lines.join("\n");
}
/** config.yaml with the corgi plugin entry removed. */
export function removePluginEntry(yaml: string): string {
  const lines = yaml.split("\n");
  const plugins = pluginsBlock(lines);
  if (!plugins) return yaml;
  const corgi = childBlock(lines, plugins.at, plugins.indent, "corgi");
  if (!corgi) return yaml;
  let end = corgi.at + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      end++;
      continue;
    }
    if (line.search(/\S/) <= corgi.indent) break;
    end++;
  }
  lines.splice(corgi.at, end - corgi.at);
  return lines.join("\n");
}
function writeManaged(path: string, source: string, marker: string | null): "added" | "present" {
  let old: string | null = null;
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw Error("NotRegular");
    old = readFileSync(path, "utf8");
    if (marker && !old.startsWith(marker) && old !== source) {
      // A foreign file in corgi's own plugin dir: keep it, then take over.
      atomicWrite(path + ".corgi-backup", old, 0o600, false);
    }
  }
  if (old === source) return "present";
  atomicWrite(path, source, 0o600, false);
  return "added";
}
function writeConfig(path: string, enable: boolean): "added" | "present" | "absent" {
  const exists = existsSync(path);
  if (!exists && !enable) return "absent";
  const yaml = exists ? readFileSync(path, "utf8") : "";
  const next = enable ? ensurePluginEnabled(yaml) : removePluginEntry(yaml);
  if (next === yaml) return exists && enable ? "present" : "absent";
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWrite(path, next, 0o600, false);
  return "added";
}
function step(
  op: "install" | "status" | "uninstall",
  account = "",
  env: NodeJS.ProcessEnv = process.env,
): IntegrationStepResult[] {
  const root = directory(account, env);
  const hooks = hooksPath(env),
    script = scriptPath(env),
    config = configPath(account, env);
  const hooksResult: IntegrationStepResult = { item: "hooks", path: hooks, outcome: "absent" };
  const scriptResult: IntegrationStepResult = { item: "hooks", path: script, outcome: "absent" };
  const configResult: IntegrationStepResult = { item: "config", path: config, outcome: "absent" };
  try {
    if (!existsSync(root) && op !== "install") {
      return [
        { ...hooksResult, path: root, outcome: "no_config" },
        { ...scriptResult, path: root, outcome: "no_config" },
        { ...configResult, path: root, outcome: "no_config" },
      ];
    }
    if (op === "status") {
      const hookOld = existsSync(hooks) ? readFileSync(hooks, "utf8") : null;
      const scriptOld = existsSync(script) ? readFileSync(script, "utf8") : null;
      const configOld = existsSync(config) ? readFileSync(config, "utf8") : null;
      return [
        { ...hooksResult, outcome: hookOld === hooksJson ? "present" : hookOld ? "partial" : "absent" },
        { ...scriptResult, outcome: scriptOld === hookScript ? "present" : scriptOld ? "partial" : "absent" },
        { ...configResult, outcome: configOld !== null && pluginEnabled(configOld) ? "present" : "absent" },
      ];
    }
    if (op === "uninstall") {
      const had = existsSync(pluginDir(env));
      if (had) rmSync(pluginDir(env), { recursive: true, force: true });
      const configOutcome = writeConfig(config, false);
      return [
        { ...hooksResult, path: pluginDir(env), outcome: had ? "removed" : "absent" },
        { ...scriptResult, path: pluginDir(env), outcome: had ? "removed" : "absent" },
        { ...configResult, outcome: configOutcome === "added" ? "removed" : configOutcome },
      ];
    }
    mkdirSync(join(hooks, ".."), { recursive: true });
    const hookOutcome = writeManaged(hooks, hooksJson, null);
    const scriptOutcome = writeManaged(script, hookScript, "// Corgi's Goose integration.");
    const configOutcome = writeConfig(config, true);
    return [
      { ...hooksResult, outcome: hookOutcome },
      { ...scriptResult, outcome: scriptOutcome },
      { ...configResult, outcome: configOutcome },
    ];
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return [
      { ...hooksResult, outcome: "failed", error },
      { ...scriptResult, outcome: "failed", error },
      { ...configResult, outcome: "failed", error },
    ];
  }
}
export async function install(account = "", env: NodeJS.ProcessEnv = process.env): Promise<IntegrationStepResult[]> {
  return step("install", account, env);
}
export async function status(account = "", env: NodeJS.ProcessEnv = process.env): Promise<IntegrationStepResult[]> {
  return step("status", account, env);
}
export async function uninstall(account = "", env: NodeJS.ProcessEnv = process.env): Promise<IntegrationStepResult[]> {
  return step("uninstall", account, env);
}
export async function startup(account = "", env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!(await import("../../discovery")).installed("goose")) return;
  const results = await install(account, env);
  for (const r of results) if (r.outcome === "failed") console.error("hook setup:", r.error);
}
export function snippet(): string {
  return [
    "# Corgi's Goose integration (managed by `corgi integration install goose`):",
    "# a `corgi` plugin dir under ~/.agents/plugins/ holding hooks/hooks.json",
    "# and hooks/corgi-hook.mjs, enabled in config.yaml with:",
    "# plugins:",
    "#   corgi:",
    "#     enabled: true",
  ].join("\n");
}
