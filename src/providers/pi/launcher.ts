import { tmpdir } from "node:os";
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
const max_folders = 64;
/** Which model an agent of Pi's family would start with, asked of it in RPC
 * mode. Each lookup starts the agent, so it asks once for its agent folder,
 * and once for each folder whose own settings set a model, and keeps the
 * answer while what decides it reads the same. */
export class Models {
  private kept = new Map<string, { inputs: string; answer: Chosen | null }>();
  private active = new Set<Stdio>();
  private closed = false;
  constructor(
    private agent: {
      command: "pi" | "omp";
      /** Its agent folder, which `PI_CODING_AGENT_DIR` names. */
      root: string;
      flags: string[];
      deadline_ms: number;
      source: string;
      /** Its own files that decide the model wherever it starts. */
      files: string[];
      /** The files in `cwd` that set a model of their own, if any. */
      overrides: (cwd: string) => string[];
      /** The providers signed in, which pick the model when none is set. */
      signins: () => string[];
    },
  ) {}
  /** The model, or null when the agent can't say. */
  async get(cwd: string, quit: Quit): Promise<Chosen | null> {
    const stopped = () => this.closed || quit.aborted;
    if (stopped()) return null;
    const executable = await discovery.resolve(this.agent.command, cwd);
    if (stopped()) return null;
    // A folder without settings of its own starts with the agent folder's model.
    const own = this.agent.overrides(cwd),
      scope = own.length ? cwd : "",
      inputs = JSON.stringify([
        executable,
        ...[executable, ...this.agent.files, ...own].map(discovery.stamp),
        [...new Set(this.agent.signins())].sort(),
      ]),
      kept = this.kept.get(scope);
    if (kept && kept.inputs === inputs) return kept.answer;
    const answer = await this.ask(executable, scope || tmpdir(), quit);
    // A lookup cut short isn't kept.
    if (stopped()) return answer;
    this.kept.delete(scope);
    this.kept.set(scope, { inputs, answer });
    if (this.kept.size > max_folders) this.kept.delete(this.kept.keys().next().value!);
    return answer;
  }
  private async ask(executable: string, cwd: string, quit: Quit): Promise<Chosen | null> {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: this.agent.root };
    delete env.CORGI_PANE;
    delete env.CORGI_SOCKET;
    const io = Stdio.spawn([executable, ...this.agent.flags], { cwd, env });
    this.active.add(io);
    try {
      io.write({ id: "corgi-model", type: "get_state" });
      const deadline = Date.now() + this.agent.deadline_ms;
      while (!this.closed && !quit.aborted && Date.now() < deadline) {
        for (const value of io.read()) {
          if (str(value, "type") !== "response" || str(value, "id") !== "corgi-model") continue;
          if (field(value, "success") !== true) return null;
          const model = field(field(value, "data"), "model"),
            id = str(model, "id"),
            provider = str(model, "provider");
          return id && provider
            ? { model: provider + "/" + id, model_name: str(model, "name"), source: this.agent.source }
            : null;
        }
        if (io.exited || io.closed) break;
        await io.wait(deadline);
      }
      return null;
    } finally {
      this.active.delete(io);
      io.close();
    }
  }
  close() {
    this.closed = true;
    for (const io of this.active) io.close();
    this.active.clear();
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
  const client = new Client(account),
    root = directory(account),
    models = new Models({
      command: "pi",
      root,
      flags: [
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
      deadline_ms: 5000,
      source: "Effective Pi settings",
      files: [join(root, "settings.json"), join(root, "models.json")],
      overrides: cwd => {
        const project = cached(join(cwd, ".pi"), "settings.json");
        return typeof project?.defaultModel === "string" || typeof project?.defaultProvider === "string"
          ? [join(cwd, ".pi", "settings.json")]
          : [];
      },
      signins: () => Object.keys(cached(root, "auth.json") ?? {}),
    });
  return {
    account: (quit, max_age) => client.preview(quit, max_age),
    async model(cwd, quit) {
      try {
        return (await models.get(cwd, quit)) ?? settingsModel(cwd, account);
      } catch {
        // Older Pi versions and unavailable catalogs keep the settings preview.
        return settingsModel(cwd, account);
      }
    },
    close() {
      client.close();
      models.close();
    },
  };
}
