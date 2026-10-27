import { createHash } from "node:crypto";
import type { Caps, Info, Login } from "../adapter";
import type { Keeping, Vocabulary } from "../command_line";
import { cached } from "../command_line";
export const info: Info = {
  id: "codex",
  label: "Codex",
  name: "Codex",
  glyph: "†",
  launcher_key: "c",
  command: "codex",
  programs: { names: ["codex"], scripts: ["/@openai/codex/bin/codex.js"] },
};
export const caps: Caps = {
  prompt_turns: false,
  children_from_hooks: false,
  follows_cd: false,
  titles_once_loaded: true,
  transcript_tools: true,
};
/** How its command line chooses a model, an account and its permission checks. */
export const vocabulary: Vocabulary = {
  config_env: "CODEX_HOME",
  account_home: ".codex",
  yolo: "--dangerously-bypass-approvals-and-sandbox",
  profile_flags: ["--profile", "-p"],
  settings_flags: ["--settings", "-c", "--config"],
  credential_env: ["OPENAI_API_KEY"],
  endpoint_env: ["OPENAI_BASE_URL"],
  provider_env: [],
  account(root) {
    const signed = identity(root)?.email;
    return signed === "API key" ? "Profile API key - identity unavailable" : signed ? `${signed} (cached)` : null;
  },
};
/** Who signed in at `root`, "API key" for a key; null when no one has. A
 * ChatGPT login is a user in a workspace, personal or a team's. */
export function identity(root: string): Login | null {
  const auth = cached(root, "auth.json");
  if (!auth) return null;
  if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY)
    return {
      email: "API key",
      id: "key:" + createHash("sha256").update(auth.OPENAI_API_KEY).digest("hex").slice(0, 16),
    };
  try {
    const claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split(".")[1] ?? "", "base64url").toString()),
      email = claims.email,
      workspace = auth.tokens?.account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id || "";
    return typeof email === "string" && email ? { email, id: `${claims.sub || email}/${workspace}` } : null;
  } catch {
    return null;
  }
}
/** What a resume or fork keeps of a typed `codex` command. Approval and
 * sandbox options stay, since its hooks can't tell them apart. */
export const keeping: Keeping = {
  drop: [
    "--model",
    "-m",
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
    "--image",
    "-i",
    "--last",
    "--all",
    "--version",
    "-V",
    "--help",
    "-h",
  ],
  flags: [
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
    "--full-auto",
    "--oss",
    "--search",
    "--no-alt-screen",
    "--last",
    "--all",
    "--version",
    "-V",
    "--help",
    "-h",
  ],
  env: /^(HOME|CODEX_HOME|CODEX_SQLITE_HOME|OPENAI_\w+|AZURE_OPENAI_\w+)$/,
};
