import type { Launcher } from "../adapter";
import { field, str } from "../common";
import { Stdio } from "../stdio";
import * as discovery from "../../discovery";
import { directory } from "./integration";
import { Client } from "./account";
import { settingsModel } from "./config";
export function open(account = ""): Launcher {
  const active = new Set<Stdio>(),
    client = new Client(account);
  let closed = false;
  return {
    account: (quit, max_age, cwd) => client.preview(quit, max_age, cwd),
    async model(cwd, quit) {
      const fallback = settingsModel(cwd, account);
      let io: Stdio | null = null;
      try {
        if (closed || quit.aborted) return fallback;
        const executable = await discovery.resolve("pi", cwd);
        if (closed || quit.aborted) return fallback;
        const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: directory(account) };
        delete env.CORGI_PANE;
        delete env.CORGI_SOCKET;
        io = Stdio.spawn(
          [
            executable,
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-tools",
            "--no-mcp",
            "--offline",
          ],
          { cwd, env },
        );
        active.add(io);
        io.write({ id: "corgi-model", type: "get_state" });
        const deadline = Date.now() + 5000;
        while (!closed && !quit.aborted && Date.now() < deadline) {
          for (const value of io.read()) {
            if (str(value, "type") !== "response" || str(value, "id") !== "corgi-model") continue;
            if (field(value, "success") !== true) return fallback;
            const model = field(field(value, "data"), "model"),
              id = str(model, "id"),
              provider = str(model, "provider");
            return id && provider
              ? { model: provider + "/" + id, model_name: str(model, "name"), source: "Effective Pi settings" }
              : fallback;
          }
          if (io.exited || io.closed) break;
          await io.wait(deadline);
        }
      } catch {
        // Older Pi versions and unavailable catalogs keep the settings preview.
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
