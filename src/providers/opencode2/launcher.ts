//! What the launcher shows for OpenCode: the model its TUI last selected,
//! the account behind that model's provider, and the subscription Corgi can
//! read for it. Model names, free plans and credentials come from OpenCode's
//! own state and API; no model or provider table is duplicated here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Launcher } from "../adapter";
import { field, str } from "../common";
import { Info, Text } from "../../usage/account";
import type { Quit } from "../../subprocess";
import { API, items, model, object, stateDir } from "./api";
import * as account from "./account";

type Selected = {
  providerID: string;
  model: string;
  name: string;
  free: boolean;
  source: string;
};

/** The TUI's current model. `/api/model/default` is the app's static default,
 * not the model the current session and the new-session picker show. */
function preference() {
  try {
    const value = JSON.parse(readFileSync(join(stateDir(), "model.json"), "utf8")),
      recent = field(value, "recent");
    if (!Array.isArray(recent)) return null;
    for (const item of recent) {
      const providerID = str(item, "providerID"),
        modelID = str(item, "modelID");
      if (!providerID || !modelID) continue;
      const variant = str(field(value, "variant"), providerID + "/" + modelID);
      return { providerID, modelID, variant: variant === "default" ? "" : variant };
    }
  } catch {}
  return null;
}

/** OpenCode calls a model free when its catalog has costs and all are zero. */
function free(value: unknown) {
  const cost = field(value, "cost");
  return Array.isArray(cost) && cost.length > 0 && cost.every(c => field(c, "input") === 0);
}

function decode(value: unknown, variant = ""): Selected | null {
  const entry = object(value),
    providerID = str(entry, "providerID"),
    id = str(entry, "id");
  if (!providerID || !id) return null;
  return {
    providerID,
    model: model({ ...entry, variant }),
    name: str(entry, "name") || id,
    free: free(entry),
    source: "",
  };
}

async function chosen(api: API, cwd: string, quit: Quit): Promise<Selected | null> {
  const wanted = preference();
  if (wanted) {
    try {
      const entries = items(
        await api.call("GET", "/api/model?location%5Bdirectory%5D=" + encodeURIComponent(cwd), undefined, quit),
      );
      const found = entries.find(
        entry => str(entry, "providerID") === wanted.providerID && str(entry, "id") === wanted.modelID,
      );
      const selected = found ? decode(found, wanted.variant) : null;
      if (selected) return { ...selected, source: "OpenCode's selected model" };
    } catch {}
  }
  try {
    const reply = object(
      await api.call("GET", "/api/model/default?location%5Bdirectory%5D=" + encodeURIComponent(cwd), undefined, quit),
    );
    const selected = reply.data === null ? null : decode(reply.data);
    return selected ? { ...selected, source: "OpenCode's default model" } : null;
  } catch {
    return null;
  }
}

function planName(providerID: string, type: string, method: string) {
  if (type === "key" || type === "api_key") return new Text("API key");
  if (type === "env") return new Text("Environment");
  if (providerID === "openai" && method.startsWith("chatgpt-")) return new Text("ChatGPT");
  return new Text(type === "oauth" ? "OAuth" : providerID);
}

/** The account behind the chosen model's provider. */
async function identify(connection: API, quit: Quit, max_age: number, subscription?: account.Subscription) {
  const selected = await chosen(connection, process.cwd(), quit),
    info = new Info();
  if (!selected) return info;
  info.signed_in = true;
  if (selected.providerID === "opencode") {
    info.account = new Text("OpenCode");
    info.plan = new Text(selected.free ? "Free" : "OpenCode");
    return info;
  }
  const credentials = await connection.call("GET", "/api/credential", undefined, quit),
    providers = items(await connection.call("GET", "/api/provider", undefined, quit)),
    definition = providers.find(entry => str(entry, "id") === selected.providerID) ?? { id: selected.providerID },
    provider = str(definition, "name") || selected.providerID,
    credential = account.credential(definition, credentials);
  if (!credential) {
    info.signed_in = null;
    info.account = new Text(provider);
    info.plan = new Text(selected.free ? "Free" : provider);
    return info;
  }
  const value = field(credential, "value"),
    type = str(value, "type"),
    method = str(value, "methodID"),
    identity = await account.resolve(credential, provider, quit, subscription, max_age);
  info.login_id = str(credential, "id") || null;
  info.email = account.email(credential);
  info.type = type === "oauth" ? "oauth" : type === "api" || type === "api_key" ? "api_key" : null;
  if (identity.shared) return Object.assign(new Info(), identity.shared, { login_id: info.login_id });
  info.account = new Text(identity.user || provider);
  info.plan = selected.free
    ? new Text("Free")
    : identity.plan
      ? new Text(identity.plan)
      : planName(str(credential, "integrationID"), type, method);
  return info;
}

export function open(_account = "", subscription?: account.Subscription): Launcher {
  return {
    async account(quit, max_age) {
      return (await API.peek(process.cwd(), api => identify(api, quit, max_age, subscription))) ?? new Info();
    },
    async model(cwd, quit) {
      const selected = await API.peek(cwd, api => chosen(api, cwd, quit)).catch(() => null);
      return selected
        ? { model: selected.model, model_name: selected.name, source: selected.source }
        : { model: "", source: "Model resolved by OpenCode at startup" };
    },
    // The TUI saves each model picked in `/model` here at once.
    watches: () => [join(stateDir(), "model.json")],
    close() {},
  };
}
