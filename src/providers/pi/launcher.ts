import { statSync } from "node:fs";
import { join } from "node:path";
import type { Launcher } from "../adapter";
import { cached } from "../command_line";
import { field, str } from "../common";
import { Stdio } from "../stdio";
import * as discovery from "../../discovery";
import type { Quit } from "../../subprocess";
import { directory } from "./integration";
import { Client } from "./account";
type Chosen = { model: string; model_name?: string; source: string };
/** A lookup that failed stands this long before the agent is asked again. */
export const retry_ms = 5 * 60000;
const max_folders = 64;
/** A file as a lookup reads it: its size and change time, or "" when it's missing. */
export function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}
/** Each folder's effective model, kept while what decides it reads the same.
 * The launcher reads every folder it shows again each minute, and each
 * lookup starts the agent. */
export class Answers {
  private kept = new Map<string, { inputs: string; at: number; answer: Chosen | null }>();
  /** The answer kept for `cwd`, or what `ask` finds; a lookup cut short isn't kept. */
  async get(cwd: string, inputs: string, ask: () => Promise<Chosen | null>, stopped: () => boolean) {
    const kept = this.kept.get(cwd);
    if (kept && kept.inputs === inputs && (kept.answer || Date.now() - kept.at < retry_ms)) return kept.answer;
    const answer = await ask();
    if (stopped()) return answer;
    this.kept.delete(cwd);
    this.kept.set(cwd, { inputs, at: Date.now(), answer });
    if (this.kept.size > max_folders) this.kept.delete(this.kept.keys().next().value!);
    return answer;
  }
}
/** Asks an agent in RPC mode which model it would start with in `cwd`. */
export async function effective(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { quit: Quit; closed: () => boolean; active: Set<Stdio>; deadline_ms: number; source: string },
): Promise<Chosen | null> {
  const io = Stdio.spawn(argv, { cwd, env });
  options.active.add(io);
  try {
    io.write({ id: "corgi-model", type: "get_state" });
    const deadline = Date.now() + options.deadline_ms;
    while (!options.closed() && !options.quit.aborted && Date.now() < deadline) {
      for (const value of io.read()) {
        if (str(value, "type") !== "response" || str(value, "id") !== "corgi-model") continue;
        if (field(value, "success") !== true) return null;
        const model = field(field(value, "data"), "model"),
          id = str(model, "id"),
          provider = str(model, "provider");
        return id && provider
          ? { model: provider + "/" + id, model_name: str(model, "name"), source: options.source }
          : null;
      }
      if (io.exited || io.closed) break;
      await io.wait(deadline);
    }
    return null;
  } finally {
    options.active.delete(io);
    io.close();
  }
}
export function settingsModel(cwd: string, account = "") {
  const user = cached(directory(account), "settings.json"),
    project = cached(join(cwd, ".pi"), "settings.json");
  const model = typeof project?.defaultModel === "string" ? project.defaultModel : user?.defaultModel;
  const provider = typeof project?.defaultProvider === "string" ? project.defaultProvider : user?.defaultProvider;
  return {
    model: typeof model === "string" ? (provider ? provider + "/" : "") + model : "",
    source: project?.defaultModel ? "Project settings (if trusted)" : "Pi user settings",
  };
}
export function open(account = ""): Launcher {
  const active = new Set<Stdio>(),
    answers = new Answers(),
    client = new Client(account);
  let closed = false;
  return {
    account: (quit, max_age) => client.preview(quit, max_age),
    async model(cwd, quit) {
      const fallback = settingsModel(cwd, account),
        stopped = () => closed || quit.aborted;
      try {
        if (stopped()) return fallback;
        const executable = await discovery.resolve("pi", cwd);
        if (stopped()) return fallback;
        const root = directory(account),
          env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root };
        delete env.CORGI_PANE;
        delete env.CORGI_SOCKET;
        const inputs = JSON.stringify([
          executable,
          stamp(executable),
          stamp(join(root, "settings.json")),
          stamp(join(cwd, ".pi", "settings.json")),
          Object.keys(cached(root, "auth.json") ?? {}).sort(),
        ]);
        const ask = () =>
          effective(
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
            cwd,
            env,
            { quit, closed: () => closed, active, deadline_ms: 5000, source: "Effective Pi settings" },
          );
        return (await answers.get(cwd, inputs, ask, stopped)) ?? fallback;
      } catch {
        // Older Pi versions and unavailable catalogs keep the settings preview.
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
