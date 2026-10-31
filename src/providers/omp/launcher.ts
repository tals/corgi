import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import type { Launcher } from "../adapter";
import { field, str } from "../common";
import { Stdio } from "../stdio";
import { Answers, effective, stamp } from "../pi/launcher";
import * as discovery from "../../discovery";
import { credentials } from "./accounts";
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
export function settingsModel(cwd: string, account = "") {
  const project = defaultModel(join(cwd, ".omp"));
  return project
    ? { model: project, source: "omp project config" }
    : { model: defaultModel(directory(account)), source: "omp user config" };
}
export function open(account = ""): Launcher {
  const active = new Set<Stdio>(),
    answers = new Answers(),
    client = new Client(account);
  let closed = false;
  return {
    account: (quit, max_age) => client.preview(quit, max_age),
    watches: () => [join(directory(account), "config.yml")],
    async model(cwd, quit) {
      const fallback = settingsModel(cwd, account),
        stopped = () => closed || quit.aborted;
      try {
        if (stopped()) return fallback;
        const executable = await discovery.resolve("omp", cwd);
        if (stopped()) return fallback;
        const root = directory(account),
          env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root };
        delete env.CORGI_PANE;
        delete env.CORGI_SOCKET;
        // Without a configured default, omp picks from the providers signed in.
        const inputs = JSON.stringify([
          executable,
          stamp(executable),
          stamp(join(root, "config.yml")),
          stamp(join(cwd, ".omp", "config.yml")),
          [...new Set(credentials(root).map(c => c.provider))].sort(),
        ]);
        const ask = () =>
          effective([executable, ...bare], cwd, env, {
            quit,
            closed: () => closed,
            active,
            deadline_ms: 8000,
            source: "Effective omp settings",
          });
        return (await answers.get(cwd, inputs, ask, stopped)) ?? fallback;
      } catch {
        // An unavailable catalog keeps the settings preview.
        return fallback;
      }
    },
    close() {
      closed = true;
      client.close();
      for (const io of active) io.close();
      active.clear();
    },
  };
}
