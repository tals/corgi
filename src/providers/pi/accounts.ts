import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Accounts, Login, Signin } from "../adapter";
import { cached } from "../command_line";
import { field, service, str } from "../common";
import { configDir } from "./integration";
import { settingsModel } from "./config";
import * as codexPlan from "../codex/plan";

/** Pi keeps credentials for several model providers in each account folder. */
export function credential(root: string) {
  const auth = cached(root, "auth.json"),
    preferred = str(cached(root, "settings.json"), "defaultProvider");
  const names = [...new Set([preferred, ...Object.keys(auth ?? {})])];
  for (const provider of names) {
    const value = field(auth, provider),
      type = str(value, "type");
    if (type === "api_key" && str(value, "key")) return { provider, value, type };
    if (type === "oauth" && str(value, "access") && str(value, "refresh")) return { provider, value, type };
  }
  return null;
}
function oauth(value: unknown) {
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(str(value, "access").split(".")[1] ?? "", "base64url").toString());
  } catch {}
  const email = (
    str(value, "email") ||
    str(claims, "email") ||
    str(field(claims, "https://api.openai.com/profile"), "email")
  )
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .slice(0, 160);
  return { claims, email };
}
/** Display metadata carried by this provider's own cached OAuth credential. */
export function profile(value: unknown): { email: string; plan: string } {
  const { claims, email } = oauth(value),
    code = str(field(claims, "https://api.openai.com/auth"), "chatgpt_plan_type");
  return {
    email,
    plan: code
      ? codexPlan
          .label(code)
          .text()
          .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
          .slice(0, 160)
      : "",
  };
}
export function identity(root: string): Login | null {
  const c = credential(root);
  if (!c) return null;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  if (c.type === "api_key")
    return { email: `${c.provider} API key`, id: `${c.provider}:key:${hash(str(c.value, "key"))}` };
  const { claims, email: user } = oauth(c.value);
  const workspace =
    str(c.value, "accountId") || str(field(claims, "https://api.openai.com/auth"), "chatgpt_account_id");
  const login: Login = {
    email: user || `${c.provider} OAuth`,
    id: `${c.provider}:${str(claims, "sub") || user || workspace || hash(str(c.value, "refresh"))}/${workspace}`,
  };
  // Only the default provider's sign-in is the subscription Pi runs on.
  const kind = service(c.provider),
    preferred = str(cached(root, "settings.json"), "defaultProvider");
  if (user && kind !== null && (!preferred || c.provider === preferred)) {
    login.service = kind;
    login.workspace = kind === "chatgpt" ? workspace : "";
  }
  return login;
}
export const signin: Signin = {
  started: text => /\S/.test(text),
  step(text) {
    if (/paste.*(code|url)|enter.*(code|url)/i.test(text)) return "code";
    if (/click.*(link|open)|open.*browser/i.test(text) && /https:\/\//.test(text)) return "browser";
    return "method";
  },
  hints: {
    method: "Type /login, then choose a provider and sign in to the account you're adding.",
    browser: "Finish signing in on the provider's page. Return here if Pi asks for a code or URL.",
    code: "Paste the code or URL requested by Pi.",
  },
  ready: root => identity(root) !== null,
  check: root => ["auth", "check", "--provider", credential(root)?.provider ?? ""],
  // Pi's /logout removes its stored credentials; there is no logout CLI.
  logout(root) {
    try {
      unlinkSync(join(root, "auth.json"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  },
  first: [],
  again: null,
};
export const accounts: Accounts = {
  env: "PI_CODING_AGENT_DIR",
  home: configDir,
  prefix: ".pi-",
  identity,
  configured: (root, cwd) => !!settingsModel(cwd, root).model,
  shared: {
    dirs: ["skills", "prompts", "themes"],
    files: ["models.json", "keybindings.json"],
  },
  signin,
};
