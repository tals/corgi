import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir as codexConfigDir } from "../codex";
import * as codexLauncher from "../codex/launcher";
import { field, str } from "../common";
import * as codexPlan from "../codex/plan";
import { usage_max_age, type Info } from "../../usage/account";
import type { Quit } from "../../subprocess";
import { accessClaims, credentialLabel, items } from "./api";

export type Subscription = (quit: Quit, max_age: number) => Promise<Info | null>;

/** The native ChatGPT account behind OpenCode's token-sharing connection. */
async function chatgpt(quit: Quit, max_age: number): Promise<Info | null> {
  try {
    const auth = JSON.parse(readFileSync(join(codexConfigDir(), "auth.json"), "utf8"));
    if (str(auth, "auth_mode") !== "chatgpt") return null;
  } catch {
    return null;
  }
  const launcher = codexLauncher.open("");
  try {
    const info = await launcher.account(quit, max_age);
    return info.signed_in === true ? info : null;
  } catch {
    return null;
  } finally {
    launcher.close();
  }
}

export function credential(provider: unknown, credentials: unknown): unknown {
  const integration = str(provider, "integrationID") || str(provider, "id");
  return (
    items(credentials).find(entry => field(entry, "active") === true && str(entry, "integrationID") === integration) ??
    null
  );
}

/** An email claim, without the display label's provider-name fallback. */
export function email(credential: unknown): string | null {
  const value = field(credential, "value"),
    claims = accessClaims(value);
  return (
    label(
      str(value, "email") || str(field(claims, "https://api.openai.com/profile"), "email") || str(claims, "email"),
    ) || null
  );
}
/** Only the active credential's own metadata, without another provider's fallback. */
export function profile(credential: unknown, provider: string): { user: string; plan: string } {
  if (field(credential, "active") !== true) return { user: "", plan: "" };
  const value = field(credential, "value"),
    claims = accessClaims(value),
    code =
      str(credential, "integrationID") === "openai" &&
      str(value, "type") === "oauth" &&
      str(value, "methodID").startsWith("chatgpt-")
        ? str(field(claims, "https://api.openai.com/auth"), "chatgpt_plan_type")
        : "";
  return {
    user: email(credential) || label(credentialLabel(credential, provider)),
    plan: code ? label(codexPlan.label(code).text()) : "",
  };
}
function label(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160);
}

/** Both model discovery and the launcher resolve the same token-sharing identity. */
export async function resolve(
  credential: unknown,
  provider: string,
  quit: Quit,
  subscription: Subscription = chatgpt,
  max_age = usage_max_age,
): Promise<{ user: string; plan: string; shared: Info | null }> {
  if (quit.aborted) throw Error("Cancelled");
  const value = field(credential, "value"),
    own = profile(credential, provider);
  let shared: Info | null = null;
  if (
    field(credential, "active") === true &&
    str(credential, "integrationID") === "openai" &&
    str(value, "type") === "oauth" &&
    str(value, "methodID") === "chatgpt-token-sharing"
  ) {
    try {
      const info = await subscription(quit, max_age);
      if (info?.signed_in === true) shared = info;
    } catch {}
  }
  if (quit.aborted) throw Error("Cancelled");
  const identity = shared?.account.text();
  return {
    user: identity ? label(identity) : own.user,
    plan: shared?.plan.len ? label(shared.plan.text()) : own.plan,
    shared,
  };
}
