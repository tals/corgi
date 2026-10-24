import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import type { Launcher } from "../adapter";
import { field, str } from "../common";
import { Stdio } from "../stdio";
import * as discovery from "../../discovery";
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
    client = new Client(account);
  let closed = false;
  return {
    account: (quit, max_age) => client.preview(quit, max_age),
    watches: () => [join(directory(account), "config.yml")],
    async model(cwd, quit) {
      const fallback = settingsModel(cwd, account);
      let io: Stdio | null = null;
      try {
        if (closed || quit.aborted) return fallback;
        const executable = await discovery.resolve("omp", cwd);
        if (closed || quit.aborted) return fallback;
        const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: directory(account) };
        delete env.CORGI_PANE;
        delete env.CORGI_SOCKET;
        io = Stdio.spawn([executable, ...bare], { cwd, env });
        active.add(io);
        io.write({ id: "corgi-model", type: "get_state" });
        const deadline = Date.now() + 8000;
        while (!closed && !quit.aborted && Date.now() < deadline) {
          for (const value of io.read()) {
            if (str(value, "type") !== "response" || str(value, "id") !== "corgi-model") continue;
            if (field(value, "success") !== true) return fallback;
            const model = field(field(value, "data"), "model"),
              id = str(model, "id"),
              provider = str(model, "provider");
            return id && provider
              ? { model: provider + "/" + id, model_name: str(model, "name"), source: "Effective omp settings" }
              : fallback;
          }
          if (io.exited || io.closed) break;
          await io.wait(deadline);
        }
      } catch {
        // An unavailable catalog keeps the settings preview.
      } finally {
        if (io) {
          active.delete(io);
          io.close();
        }
      }
      return fallback;
    },
    close() {
      closed = true;
      client.close();
      for (const io of active) io.close();
      active.clear();
    },
  };
}
