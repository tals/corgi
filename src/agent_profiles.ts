//! Saved launch configurations share an account, but own their name and options.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Provider, adapter } from "./providers";
import * as accounts from "./accounts";
import * as options from "./agent_options";
import * as os from "./os";
import * as agentName from "./agent_name";

export type Profile = {
  id: string;
  provider: Provider;
  account: string;
  name: string;
  options: options.Options;
  yolo: boolean;
};
export const path = () => join(dirname(accounts.path()), "agents.json");
export const validId = (id: string) => /^[a-z0-9-]{1,64}$/.test(id);
export function list(): Profile[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path(), "utf8"));
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw.flatMap((entry): Profile[] => {
      const provider = Provider.parse(entry?.provider),
        settings = options.read(entry?.options);
      if (
        !provider ||
        !settings ||
        typeof entry.id !== "string" ||
        !validId(entry.id) ||
        seen.has(entry.id) ||
        typeof entry.account !== "string" ||
        (entry.account && !entry.account.startsWith("/")) ||
        typeof entry.name !== "string" ||
        !agentName.valid(entry.name)
      )
        return [];
      seen.add(entry.id);
      return [
        {
          id: entry.id,
          provider,
          account: entry.account,
          name: entry.name,
          options: settings,
          yolo: entry.yolo === true,
        },
      ];
    });
  } catch {
    return [];
  }
}
export const find = (id: string) => list().find(p => p.id === id) ?? null;
export function save(profile: Omit<Profile, "id"> & { id?: string }): Profile {
  const settings = options.read(profile.options);
  agentName.check(profile.name);
  if (!settings || (profile.id && !validId(profile.id))) throw Error("InvalidAgentOptions");
  if (settings.env.some(([key]) => key === adapter(profile.provider).accounts.env))
    throw Error("AccountEnvironmentOverride");
  if (profile.account && !accounts.find(profile.provider, profile.account)) throw Error("AccountNotFound");
  const value: Profile = { ...profile, id: profile.id ?? randomUUID(), name: profile.name.trim(), options: settings };
  const all = list(),
    index = all.findIndex(p => p.id === value.id);
  if (index >= 0) all[index] = value;
  else all.push(value);
  os.atomicWrite(path(), JSON.stringify(all, null, 2) + "\n", 0o600, false);
  return value;
}
export function remove(id: string): void {
  os.atomicWrite(
    path(),
    JSON.stringify(
      list().filter(p => p.id !== id),
      null,
      2,
    ) + "\n",
    0o600,
    false,
  );
}
