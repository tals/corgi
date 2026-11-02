import { API, data, items } from "./api";
import { field, str } from "../common";
import type { Identity } from "../../account_identity";
import * as accountIdentity from "../../account_identity";
import * as account from "./account";

/** Only public labels and IDs leave OpenCode's credential response. */
export function identities(providers: unknown, credentials: unknown): Map<string, Identity> {
  const active = new Map<string, Identity>();
  for (const entry of items(credentials)) {
    const id = str(entry, "id"),
      integration = str(entry, "integrationID");
    if (field(entry, "active") !== true || !id || !integration || id.length > 1024) continue;
    active.set(
      integration,
      accountIdentity.read({
        id: JSON.stringify(["opencode2", id]),
        name: (str(entry, "label") || integration).replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160),
        directory: null,
        loginId: id,
        email: account.email(entry),
        type: accountIdentity.type(
          str(field(entry, "value"), "type") === "api" ? "api_key" : str(field(entry, "value"), "type"),
        ),
        plan: account.profile(entry, integration).plan || null,
      })!,
    );
  }
  const result = new Map<string, Identity>();
  for (const provider of items(providers)) {
    const id = str(provider, "id"),
      identity = active.get(str(provider, "integrationID") || id);
    if (id && identity) result.set(id, identity);
  }
  return result;
}

/** Shared by all sessions in an observer; refreshed on native account events. */
export class Accounts {
  private entries = new Map<string, { at: number; value: Promise<Map<string, Identity>> }>();
  constructor(private api: API) {}
  invalidate(type: string) {
    if (
      ![
        "credential.updated",
        "credential.switched",
        "integration.updated",
        "provider.updated",
        "config.updated",
      ].includes(type)
    )
      return false;
    this.entries.clear();
    return true;
  }
  async describe(info: unknown): Promise<Identity | null> {
    const cwd = str(field(info, "location"), "directory") || this.api.cwd,
      location = "?location%5Bdirectory%5D=" + encodeURIComponent(cwd);
    try {
      let provider = str(field(info, "model"), "providerID");
      if (!provider) provider = str(data(await this.api.call("GET", "/api/model/default" + location)), "providerID");
      if (!provider) return null;
      let entry = this.entries.get(cwd);
      if (!entry || Date.now() - entry.at >= 30000) {
        if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!);
        entry = {
          at: Date.now(),
          value: Promise.all([
            this.api.call("GET", "/api/provider" + location),
            this.api.call("GET", "/api/credential"),
          ]).then(([providers, credentials]) => identities(providers, credentials)),
        };
        this.entries.set(cwd, entry);
      }
      return (await entry.value).get(provider) ?? null;
    } catch {
      return null;
    }
  }
}
