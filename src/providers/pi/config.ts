import { join } from "node:path";
import { cached } from "../command_line";
import { directory } from "./integration";

function settings(cwd: string, account: string) {
  const user = cached(directory(account), "settings.json"),
    project = cached(join(cwd, ".pi"), "settings.json");
  const model = typeof project?.defaultModel === "string" ? project.defaultModel : user?.defaultModel;
  const provider = typeof project?.defaultProvider === "string" ? project.defaultProvider : user?.defaultProvider;
  return {
    model: typeof model === "string" ? model : "",
    provider: typeof provider === "string" ? provider : "",
    source: project?.defaultModel ? "Project settings (if trusted)" : "Pi user settings",
  };
}
export function settingsProvider(cwd: string, account = "") {
  return settings(cwd, account).provider;
}
export function settingsModel(cwd: string, account = "") {
  const { model, provider, source } = settings(cwd, account);
  return { model: model ? (provider ? provider + "/" : "") + model : "", source };
}
