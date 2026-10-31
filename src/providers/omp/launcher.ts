import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import type { Launcher } from "../adapter";
import { field, str } from "../common";
import * as pi from "../pi/launcher";
import * as accounts from "./accounts";
import { directory } from "./integration";
import { Client } from "./account";
/** Flags that start omp's RPC mode with as little of its own setup as it allows. */
export const bare = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-tools",
  "--no-lsp",
  "--no-pty",
  "--no-title",
];
function defaultModel(root: string) {
  try {
    return str(field(YAML.parse(readFileSync(join(root, "config.yml"), "utf8")), "modelRoles"), "default");
  } catch {
    return "";
  }
}
/** The files in `cwd` whose `modelRoles.default` omp layers over its own:
 * its project config, and the settings files its discovery reads there. */
export function overrides(cwd: string): string[] {
  return [
    join(cwd, ".omp", "config.yml"),
    join(cwd, ".omp", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".cursor", "settings.json"),
    join(cwd, ".gemini", "settings.json"),
  ].filter(file => {
    try {
      const text = readFileSync(file, "utf8");
      return str(field(file.endsWith(".yml") ? YAML.parse(text) : JSON.parse(text), "modelRoles"), "default") !== "";
    } catch {
      return false;
    }
  });
}
export function settingsModel(cwd: string, account = "") {
  const project = defaultModel(join(cwd, ".omp"));
  return project
    ? { model: project, source: "omp project config" }
    : { model: defaultModel(directory(account)), source: "omp user config" };
}
export function open(account = ""): Launcher {
  const client = new Client(account),
    root = directory(account),
    models = new pi.Models({
      command: "omp",
      root,
      flags: bare,
      deadline_ms: 8000,
      source: "Effective omp settings",
      files: [join(root, "config.yml"), join(root, "config.yaml"), join(root, "models.yml")],
      overrides,
      signins: () => accounts.providers(root),
    });
  return {
    account: (quit, max_age) => client.preview(quit, max_age),
    watches: () => [join(root, "config.yml")],
    async model(cwd, quit) {
      try {
        return (await models.get(cwd, quit)) ?? settingsModel(cwd, account);
      } catch {
        // An unavailable catalog keeps the settings preview.
        return settingsModel(cwd, account);
      }
    },
    close() {
      client.close();
      models.close();
    },
  };
}
