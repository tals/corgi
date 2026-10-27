import type { Caps, Info, Login } from "../adapter";
import type { Keeping, Vocabulary } from "../command_line";
import { dirname } from "node:path";
import { cached } from "../command_line";
export const info: Info = {
  id: "claude",
  label: "Claude Code",
  name: "Claude",
  glyph: "*",
  launcher_key: "l",
  command: "claude",
  programs: {
    names: ["claude", "claude-code"],
    // Claude's daemon launches the versioned native binary directly.
    markers: ["/claude/versions/"],
    scripts: ["/@anthropic-ai/claude-code/cli.js"],
  },
};
export const caps: Caps = {
  prompt_turns: true,
  children_from_hooks: true,
  follows_cd: true,
  titles_once_loaded: false,
  transcript_tools: false,
};
/** How its command line chooses a model, an account and its permission checks. */
export const vocabulary: Vocabulary = {
  config_env: "CLAUDE_CONFIG_DIR",
  account_home: ".",
  model_env: "ANTHROPIC_MODEL",
  yolo: "--dangerously-skip-permissions",
  profile_flags: ["--profile"],
  settings_flags: ["--settings"],
  credential_env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  oauth_env: "CLAUDE_CODE_OAUTH_TOKEN",
  endpoint_env: ["ANTHROPIC_BASE_URL"],
  provider_env: [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_GATEWAY",
  ],
  account(root) {
    const email = identity(root, false)?.email;
    return email ? `${email} (cached)` : null;
  },
};
const state = (dir: string) => cached(dir, ".claude.json", 8 * 1024 * 1024);
/** Who signed in to the settings at `root`. The default account's file
 * sits in HOME instead, `home` when `root` is that account's. */
export function identity(root: string, home: boolean): Login | null {
  const read = (dir: string): Login | null => {
    const account = state(dir)?.oauthAccount,
      email = account?.emailAddress;
    if (typeof email !== "string" || !email) return null;
    return { email, id: `${account.accountUuid || email}/${account.organizationUuid || ""}` };
  };
  return read(root) ?? (home ? read(dirname(root)) : null);
}
/** Its first run at `root` is over: until then it asks for a theme and a login. */
export const onboarded = (root: string) => state(root)?.hasCompletedOnboarding === true;
/** What a resume or fork keeps of a typed `claude` command. */
export const keeping: Keeping = {
  drop: [
    "--resume",
    "-r",
    "--continue",
    "-c",
    "--session-id",
    "--fork-session",
    "--name",
    "-n",
    "--model",
    "--permission-mode",
    "--dangerously-skip-permissions",
    "--print",
    "-p",
    "--output-format",
    "--input-format",
    "--version",
    "-v",
    "--help",
    "-h",
  ],
  flags: [
    "--continue",
    "-c",
    "--fork-session",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--print",
    "-p",
    "--verbose",
    "--ide",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--include-partial-messages",
    "--replay-user-messages",
    "--chrome",
    "--no-chrome",
    "--safe-mode",
    "--mcp-debug",
    "--disable-slash-commands",
    "--version",
    "-v",
    "--help",
    "-h",
  ],
  env: /^(HOME|CLAUDE_CONFIG_DIR|ANTHROPIC_(?!MODEL$)\w+|CLAUDE_CODE_(?!ENTRYPOINT$|SESSION_KIND$)\w+|AWS_\w+|CLOUD_ML_REGION|VERTEX_\w+|DISABLE_\w+|MCP_\w+|MAX_THINKING_TOKENS)$/,
};
