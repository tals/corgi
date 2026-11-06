//! What the launcher shows about Claude Code: its account and usage through
//! its control channel, and the model its settings choose.
import type { Launcher } from "../adapter";
import { Client } from "./account";
import { vocabulary } from "./info";
import { settingsModel } from "./config";
export function open(account: string): Launcher {
  const env = account ? { ...process.env, [vocabulary.config_env]: account } : process.env,
    client = new Client(env);
  return {
    account: (quit, max_age, cwd) => client.preview(quit, quit, max_age, cwd),
    async model(cwd) {
      const chosen = settingsModel(cwd, env),
        fallback = client.defaultFor(cwd);
      if (chosen.model || !fallback) return chosen;
      return { model: fallback, source: "Claude Code default" };
    },
    close: () => client.close(),
  };
}
