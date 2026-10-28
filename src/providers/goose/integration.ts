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

/** Goose's configured provider: `active_provider` first, older keys after. */
export function configProvider(dir: string): string {
  return configValueAt(dir, "active_provider", "GOOSE_PROVIDER", "provider", "default_provider");
}

/** The model of `provider`'s block under `providers:`, else a top-level key. */
export function configModel(dir: string, provider: string): string {
  let text = "";
  try {
    text = readFileSync(join(dir, "config.yaml"), "utf8");
  } catch {
    return "";
  }
  if (provider) {
    const lines = text.split("\n");
    const at = lines.findIndex(l => {
      const m = l.match(/^(\s*)([^:\s][^:]*):\s*(#.*)?$/);
      return m !== null && m[2] === provider;
    });
    if (at >= 0) {
      const indent = lines[at].match(/^\s*/)?.[0].length ?? 0;
      for (let i = at + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
        if ((line.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
        const m = line.match(/^\s+model:\s*["']?([^"'\s#]+)/);
        if (m) return m[1];
      }
    }
  }
  return configValueAt(dir, "GOOSE_MODEL", "model", "default_model");
}

/** A top-level `plugins:` block: its line, indent, and flow text when the
 * value sits on the same line. Throws when the line's shape is unrecognized
 * rather than letting a later edit duplicate the key. */
function pluginsBlock(lines: string[]): { at: number; indent: number; flow: string | null } | null {
  const at = lines.findIndex(l => /^plugins:/.test(l));
  if (at < 0) return null;
  const line = lines[at];
  if (/^plugins:\s*(#.*)?$/.test(line)) return { at, indent: lines[at].search(/\S/), flow: null };
  const flow = /^plugins:\s*(\{.*\})\s*$/.exec(line);
  if (flow) return { at, indent: lines[at].search(/\S/), flow: flow[1] };
  throw Error("UnsupportedPluginsStyle");
}
function childBlock(
  lines: string[],
  at: number,
  indent: number,
  key: string,
): { at: number; indent: number; flow: string | null } | null {
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const lineIndent = line.search(/\S/);
    if (lineIndent <= indent) return null;
    if (new RegExp(`^\\s*${key}:\\s*(#.*)?$`).test(line)) return { at: i, indent: lineIndent, flow: null };
    const flow = new RegExp(`^\\s*${key}:\\s*(\\{.*\\})\\s*$`).exec(line);
    if (flow) return { at: i, indent: lineIndent, flow: flow[1] };
    if (new RegExp(`^\\s*(?:"${key}"|'${key}'|${key})\\s*:`).test(line)) throw Error("UnsupportedPluginsStyle");
  }
  return null;
}
/** The first child's indent under `at`, setting the block's child indent. */
function firstChildIndent(lines: string[], at: number, indent: number): number | null {
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const lineIndent = line.search(/\S/);
    if (lineIndent <= indent) return null;
    return lineIndent;
  }
  return null;
}
/** The top-level entries of a flow mapping's inner text, quotes respected. */
function flowEntries(inner: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote !== null) {
      if (quote === "'" && ch === "'" && inner[i + 1] === "'") i++;
      else if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      entries.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  entries.push(inner.slice(start).trim());
  return entries.filter(e => e !== "");
}
/** Whether a flow mapping's inner text has balanced brackets and quotes. */
function flowBalanced(inner: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote !== null) {
      if (quote === "'" && ch === "'" && inner[i + 1] === "'") i++;
      else if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && quote === null;
}
/** The value of `key:` among flow entries, quoted keys included. */
function flowValue(entries: string[], key: string): string | null {
  const pattern = new RegExp(`^(?:"${key}"|'${key}'|${key})\\s*:\\s*`);
  for (const entry of entries) {
    const m = pattern.exec(entry);
    if (m) return entry.slice(m[0].length).trim();
  }
  return null;
}
/** Entries with `key:` replaced by `replacement`, or appended when absent. */
function flowSet(entries: string[], key: string, replacement: string): string[] {
  const pattern = new RegExp(`^(?:"${key}"|'${key}'|${key})\\s*:`);
  let found = false;
  const next = entries.map(entry => {
    if (pattern.test(entry)) {
      found = true;
      return replacement;
    }
    return entry;
  });
  if (!found) next.push(replacement);
  return next;
}
/** Whether config.yaml enables the corgi plugin. */
export function pluginEnabled(yaml: string): boolean {
  const lines = yaml.split("\n");
  const plugins = pluginsBlock(lines);
  if (!plugins) return false;
  if (plugins.flow !== null) {
    const inner = plugins.flow.slice(1, -1);
    if (!flowBalanced(inner)) throw Error("UnsupportedPluginsStyle");
    const corgi = flowValue(flowEntries(inner), "corgi");
    if (corgi === null || !corgi.startsWith("{")) return false;
    return flowValue(flowEntries(corgi.slice(1, -1)), "enabled") === "true";
  }
  const corgi = childBlock(lines, plugins.at, plugins.indent, "corgi");
  if (!corgi) return false;
  if (corgi.flow !== null) {
    const inner = corgi.flow.slice(1, -1);
    if (!flowBalanced(inner)) throw Error("UnsupportedPluginsStyle");
    return flowValue(flowEntries(inner), "enabled") === "true";
  }
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
  if (plugins.flow !== null) {
    const inner = plugins.flow.slice(1, -1);
    if (!flowBalanced(inner)) throw Error("UnsupportedPluginsStyle");
    const entries = flowEntries(inner);
    const corgi = flowValue(entries, "corgi");
    if (corgi === null) {
      lines[plugins.at] = "plugins: {" + [...entries, "corgi: {enabled: true}"].join(", ") + "}";
      return lines.join("\n");
    }
    if (!corgi.startsWith("{")) throw Error("UnsupportedPluginsStyle");
    const cInner = corgi.slice(1, -1);
    if (!flowBalanced(cInner)) throw Error("UnsupportedPluginsStyle");
    const cEntries = flowEntries(cInner);
    if (flowValue(cEntries, "enabled") === "true") return yaml;
    const nextCorgi = "corgi: {" + flowSet(cEntries, "enabled", "enabled: true").join(", ") + "}";
    lines[plugins.at] = "plugins: {" + flowSet(entries, "corgi", nextCorgi).join(", ") + "}";
    return lines.join("\n");
  }
  const corgi = childBlock(lines, plugins.at, plugins.indent, "corgi");
  if (!corgi) {
    const child = firstChildIndent(lines, plugins.at, plugins.indent) ?? plugins.indent + 2;
    lines.splice(plugins.at + 1, 0, " ".repeat(child) + "corgi:", " ".repeat(child + 2) + "enabled: true");
    return lines.join("\n");
  }
  if (corgi.flow !== null) {
    const inner = corgi.flow.slice(1, -1);
    if (!flowBalanced(inner)) throw Error("UnsupportedPluginsStyle");
    const cEntries = flowEntries(inner);
    if (flowValue(cEntries, "enabled") === "true") return yaml;
    lines[corgi.at] =
      " ".repeat(corgi.indent) + "corgi: {" + flowSet(cEntries, "enabled", "enabled: true").join(", ") + "}";
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
  lines.splice(corgi.at + 1, 0, " ".repeat(corgi.indent + 2) + "enabled: true");
  return lines.join("\n");
}
/** config.yaml with the corgi plugin entry removed. */
export function removePluginEntry(yaml: string): string {
  const lines = yaml.split("\n");
  const plugins = pluginsBlock(lines);
  if (!plugins) return yaml;
  if (plugins.flow !== null) {
    const inner = plugins.flow.slice(1, -1);
    if (!flowBalanced(inner)) throw Error("UnsupportedPluginsStyle");
    const entries = flowEntries(inner);
    if (flowValue(entries, "corgi") === null) return yaml;
    lines[plugins.at] =
      "plugins: {" +
      entries.filter(entry => !new RegExp(`^(?:"corgi"|'corgi'|corgi)\\s*:`).test(entry)).join(", ") +
      "}";
    return lines.join("\n");
  }
  const corgi = childBlock(lines, plugins.at, plugins.indent, "corgi");
  if (!corgi) return yaml;
  if (corgi.flow !== null) {
    lines.splice(corgi.at, 1);
    return lines.join("\n");
  }
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
  if (exists) atomicWrite(path + ".corgi-backup", yaml, 0o600, false);
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
