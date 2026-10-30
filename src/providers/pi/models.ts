import * as effort from "../effort";
import type { InferenceModel } from "../adapter";
import { Stdio } from "../stdio";
import { field, str } from "../common";
import { cached } from "../command_line";
import { directory } from "./integration";
import { profile } from "./accounts";
import * as discovery from "../../discovery";
import { run, type Quit } from "../../subprocess";

const subscriptions = new Set(["anthropic", "openai", "openai-codex", "github-copilot"]);
function price(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
/** Pi owns model availability, including environment keys and custom endpoints. */
export function parse(value: unknown, auth: unknown, ready?: ReadonlySet<string>): InferenceModel[] {
  const models = field(value, "models");
  if (!Array.isArray(models)) throw Error("InvalidModels");
  const seen = new Set<string>(),
    identities = new Map<string, { user: string; plan: string; subscription: boolean }>();
  return models.flatMap(v => {
    const provider = str(v, "provider"),
      id = str(v, "id"),
      input = field(v, "input"),
      cost = field(v, "cost");
    if (
      (ready !== undefined && !ready.has(provider)) ||
      !provider ||
      provider.includes("/") ||
      !id ||
      /[\s\x00-\x1f\x7f]/.test(provider + id) ||
      !Array.isArray(input) ||
      !input.includes("text")
    )
      return [];
    const efforts = field(v, "reasoning") === true ? effort.list(field(field(v, "thinking"), "efforts")) : [];
    const default_effort = effort.parse(field(field(v, "thinking"), "defaultLevel"));
    const key = provider + "/" + id;
    if (Buffer.byteLength(key) > 512 || seen.has(key)) return [];
    seen.add(key);
    let login = identities.get(provider);
    if (!login) {
      const credential = field(auth, provider),
        who = profile(credential),
        subscription = subscriptions.has(provider) && str(credential, "type") === "oauth";
      login = {
        user: who.email,
        subscription,
        plan: subscription && (provider === "openai" || provider === "openai-codex") ? who.plan : "",
      };
      identities.set(provider, login);
    }
    const { user, subscription, plan } = login,
      input_cost = price(field(cost, "input")),
      output_cost = price(field(cost, "output"));
    // Unpriced custom models also report zeros; don't advertise those as free.
    const priced =
      input_cost !== null && output_cost !== null && (input_cost > 0 || output_cost > 0 || id.endsWith(":free"));
    return [
      {
        id: key,
        ...(efforts.length ? { efforts } : {}),
        ...(default_effort && efforts.includes(default_effort) ? { default_effort } : {}),
        ...(user ? { user } : {}),
        ...(plan ? { plan } : {}),
        name:
          str(v, "name")
            .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
            .slice(0, 160) || id,
        subscription,
        input_cost: priced ? input_cost : null,
        output_cost: priced ? output_cost : null,
      },
    ];
  });
}
export async function read(account: string, quit: Quit): Promise<InferenceModel[]> {
  const executable = await discovery.resolve("pi", "/tmp");
  if (quit.aborted) throw Error("Cancelled");
  const root = directory(account),
    env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root };
  delete env.CORGI_PANE;
  delete env.CORGI_SOCKET;
  const io = Stdio.spawn(
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
    { cwd: "/tmp", env },
  );
  const abort = () => io.close();
  quit.abortSignal.addEventListener("abort", abort, { once: true });
  try {
    io.write({ id: "corgi-models", type: "get_available_models" });
    const deadline = Date.now() + 5000;
    while (!quit.aborted && Date.now() < deadline) {
      for (const v of io.read()) {
        if (str(v, "type") !== "response" || str(v, "id") !== "corgi-models") continue;
        if (field(v, "success") !== true) throw Error("ModelsUnavailable");
        const data = field(v, "data"),
          candidates = parse(data, cached(root, "auth.json"));
        const ready = new Set<string>();
        await Promise.all(
          [...new Set(candidates.map(m => m.id.split("/")[0]))].map(async provider => {
            try {
              const checked = await run([executable, "auth", "check", "--provider", provider, "--json"], {
                cwd: "/tmp",
                env,
                timeout_ms: 5000,
                max_output: 16384,
                quit,
              });
              const result: unknown = JSON.parse(checked.stdout.toString());
              if (checked.ok() && str(result, "status") === "ready" && str(result, "provider") === provider)
                ready.add(provider);
            } catch {
              /* Unverified credentials never make the picker. */
            }
          }),
        );
        return parse(data, cached(root, "auth.json"), ready);
      }
      if (io.exited || io.closed) break;
      await io.wait(deadline);
    }
    throw Error("ModelsUnavailable");
  } finally {
    quit.abortSignal.removeEventListener("abort", abort);
    io.close();
  }
}
