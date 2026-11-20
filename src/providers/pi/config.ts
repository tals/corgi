import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { directory } from "./integration";

/** A JSON file of Pi's, or null when it's missing or unreadable. */
export async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function settings(cwd: string, account: string) {
  const [user, project] = await Promise.all([
    readJson(join(directory(account), "settings.json")),
    readJson(join(cwd, ".pi", "settings.json")),
  ]);
  const model = typeof project?.defaultModel === "string" ? project.defaultModel : user?.defaultModel;
  const provider = typeof project?.defaultProvider === "string" ? project.defaultProvider : user?.defaultProvider;
  return {
    model: typeof model === "string" ? model : "",
    provider: typeof provider === "string" ? provider : "",
    source: project?.defaultModel ? "Project settings (if trusted)" : "Pi user settings",
  };
}
export async function settingsProvider(cwd: string, account = "") {
  return (await settings(cwd, account)).provider;
}
export async function settingsModel(cwd: string, account = "") {
  const { model, provider, source } = await settings(cwd, account);
  return { model: model ? (provider ? provider + "/" : "") + model : "", source };
}
