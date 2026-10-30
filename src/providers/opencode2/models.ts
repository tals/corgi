import type { InferenceModel } from "../adapter";
import type { Quit } from "../../subprocess";
import { field, str } from "../common";
import { API, items } from "./api";
import { Probes } from "./probes";
import * as account from "./account";
import { adapter as codex } from "../codex";
import { adapter as claude } from "../claude";

const probes = new Probes();

function price(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** OpenCode owns availability, including environment keys and custom providers. */
export function parse(models: unknown, providers: unknown, credentials: unknown): InferenceModel[] {
  const sources = items(providers),
    logins = items(credentials),
    subscriptions = new Set(
      logins
        .filter(entry => {
          if (field(entry, "active") !== true) return false;
          const value = field(entry, "value"),
            integration = str(entry, "integrationID");
          return (
            str(value, "type") === "oauth" &&
            (integration === "anthropic" ||
              integration === "github-copilot" ||
              (integration === "openai" && str(value, "methodID").startsWith("chatgpt-")))
          );
        })
        .map(entry => str(entry, "integrationID")),
    );
  const subscribed = new Set(
    sources
      .filter(entry => subscriptions.has(str(entry, "integrationID") || str(entry, "id")))
      .map(entry => str(entry, "id")),
  );
  const seen = new Set<string>(),
    identities = new Map<string, { user: string; plan: string }>();
  return items(models).flatMap(entry => {
    const provider = str(entry, "providerID"),
      id = str(entry, "id"),
      input = field(field(entry, "capabilities"), "input"),
      output = field(field(entry, "capabilities"), "output");
    if (
      field(entry, "enabled") !== true ||
      !provider ||
      /[/#]/.test(provider) ||
      !id ||
      /[\s\x00-\x1f\x7f#]/.test(provider + id) ||
      !Array.isArray(input) ||
      !input.includes("text") ||
      !Array.isArray(output) ||
      !output.includes("text")
    )
      return [];
    const key = provider + "/" + id;
    if (Buffer.byteLength(key) > 512 || seen.has(key)) return [];
    seen.add(key);
    let identity = identities.get(provider);
    if (!identity) {
      const definition = sources.find(p => str(p, "id") === provider) ?? { id: provider };
      identity = account.profile(account.credential(definition, credentials), str(definition, "name") || provider);
      identities.set(provider, identity);
    }
    const { user, plan } = identity,
      costs = field(entry, "cost"),
      cost = Array.isArray(costs) ? (costs.find(c => field(c, "tier") === null) ?? costs[0]) : null;
    return [
      {
        id: key,
        ...(user ? { user } : {}),
        ...(plan ? { plan } : {}),
        name:
          str(entry, "name")
            .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
            .slice(0, 160) || id,
        subscription: subscribed.has(provider),
        input_cost: price(field(cost, "input")),
        output_cost: price(field(cost, "output")),
      },
    ];
  });
}

export async function read(
  _account: string,
  quit: Quit,
  subscription?: account.Subscription,
): Promise<InferenceModel[]> {
  if (quit.aborted) throw Error("Cancelled");
  return (await API.peek("/tmp", api => discover(api, quit, subscription))) ?? [];
}

/** Launcher choices only; listing models must never probe them with a prompt. */
export async function catalog(quit: Quit): Promise<InferenceModel[]> {
  if (quit.aborted) throw Error("Cancelled");
  return (
    (await API.peek("/tmp", async api => {
      const location = "?location%5Bdirectory%5D=" + encodeURIComponent(api.cwd);
      const [models, providers, credentials] = await Promise.all(
        ["/api/model" + location, "/api/provider" + location, "/api/credential"].map(path =>
          api.call("GET", path, undefined, quit),
        ),
      );
      return parse(models, providers, credentials);
    })) ?? []
  );
}

async function discover(api: API, quit: Quit, subscription?: account.Subscription) {
  const location = "?location%5Bdirectory%5D=" + encodeURIComponent(api.cwd);
  const [models, providers, credentials] = await Promise.all(
    ["/api/model" + location, "/api/provider" + location, "/api/credential"].map(path =>
      api.call("GET", path, undefined, quit),
    ),
  );
  // Subscription catalogs may omit prices. Use the native adapters' cheap
  // inference defaults as evidence, not an alphabetically first legacy model.
  const preferred = new Set(
    items(providers).flatMap(provider => {
      const integration = str(provider, "integrationID") || str(provider, "id"),
        model =
          integration === "openai" ? codex.inference.model : integration === "anthropic" ? claude.inference.model : "";
      return model ? [str(provider, "id") + "/" + model] : [];
    }),
  );
  const available = parse(models, providers, credentials);
  await Promise.all(
    items(providers).map(async provider => {
      const group = available.filter(model => model.id.startsWith(str(provider, "id") + "/"));
      if (!group.length) return;
      const identity = await account.resolve(
        account.credential(provider, credentials),
        str(provider, "name") || str(provider, "id"),
        quit,
        subscription,
      );
      for (const model of group) {
        if (identity.user) model.user = identity.user;
        if (identity.plan) model.plan = identity.plan;
      }
    }),
  );
  return probes.check(api, available, credentials, quit, Date.now(), preferred);
}
