import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { YAML } from "bun";
import type { Accounts, Login } from "../adapter";
import { field, str } from "../common";
import { configDir } from "./integration";

export type Credential = { provider: string; type: "oauth" | "api_key"; data: unknown; identity: string };
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160);
/** The model provider of the agent folder's default model, as its config.yml sets it. */
export function defaultProvider(root: string) {
  let config: unknown = null;
  try {
    config = YAML.parse(readFileSync(join(root, "config.yml"), "utf8"));
  } catch {}
  const model = str(field(config, "modelRoles"), "default");
  return model.includes("/") ? model.slice(0, model.indexOf("/")) : "";
}
/** The sign-ins omp keeps in the folder's database, enabled ones in the order it added them. */
export function credentials(root: string): Credential[] {
  const path = join(root, "agent.db");
  if (!existsSync(path)) return [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db
      .query(
        "SELECT provider, credential_type, data, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id",
      )
      .all() as { provider: unknown; credential_type: unknown; data: unknown; identity_key: unknown }[];
    return rows.flatMap(r => {
      if (typeof r.provider !== "string" || typeof r.data !== "string") return [];
      if (r.credential_type !== "oauth" && r.credential_type !== "api_key") return [];
      let data: unknown;
      try {
        data = JSON.parse(r.data);
      } catch {
        return [];
      }
      return [
        {
          provider: r.provider,
          type: r.credential_type,
          data,
          identity: typeof r.identity_key === "string" ? r.identity_key : "",
        },
      ];
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
/** The sign-in for the folder's default model, else its first. */
export function credential(root: string): Credential | null {
  const all = credentials(root),
    preferred = defaultProvider(root);
  return all.find(c => c.provider === preferred) ?? all[0] ?? null;
}
export function identity(root: string): Login | null {
  const c = credential(root);
  if (!c) return null;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  if (c.type === "api_key")
    return { email: `${c.provider} API key`, id: `${c.provider}:key:${hash(str(c.data, "key"))}` };
  const email = clean(str(c.data, "email"));
  return {
    email: email || `${c.provider} OAuth`,
    id: `${c.provider}:${c.identity || email || hash(str(c.data, "refresh"))}/${str(c.data, "accountId")}`,
  };
}
export const accounts: Accounts = {
  env: "PI_CODING_AGENT_DIR",
  home: configDir,
  prefix: ".omp-",
  identity,
  shared: { dirs: ["skills", "prompts", "themes", "rules", "agents"], files: ["models.yml"] },
  // omp keeps several sign-ins in one folder already; Corgi only follows the default one.
  signin: null,
};
