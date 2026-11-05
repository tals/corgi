import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { field, str } from "../common";
import { directory } from "./integration";

/** The agent folder's default model, as its config.yml sets it. */
export function defaultModel(root: string) {
  let config: unknown = null;
  try {
    config = YAML.parse(readFileSync(join(root, "config.yml"), "utf8"));
  } catch {}
  return str(field(config, "modelRoles"), "default");
}
export function settingsModel(cwd: string, account = "") {
  const project = defaultModel(join(cwd, ".omp"));
  return project
    ? { model: project, source: "omp project config" }
    : { model: defaultModel(directory(account)), source: "omp user config" };
}
export function settingsProvider(cwd: string, account = "") {
  const { model } = settingsModel(cwd, account);
  return model.includes("/") ? model.slice(0, model.indexOf("/")) : "";
}
