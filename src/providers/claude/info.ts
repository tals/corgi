import type { Caps, Info, Login } from "../adapter";
import type { Keeping, Vocabulary } from "../command_line";
import { stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export const info: Info = {
  id: "claude",
  label: "Claude Code",
  name: "Claude",
  brand: "claude",
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
  async account(root) {
    const email = (await identity(root, false))?.email;
    return email ? `${email} (cached)` : null;
  },
};
/** What Corgi reads of a `.claude.json`: who signed in, and whether its first run is over. */
type State = { login: Login | null; onboarded: boolean };
/** Each `.claude.json` as last parsed, with the inode, size and mtime it had.
 * Claude Code rewrites it often and it grows large, so it's parsed again only
 * once it changes. */
const states = new Map<string, { stamp: string; state: State }>();
async function state(dir: string): Promise<State | null> {
  const file = join(dir, ".claude.json");
  try {
    const s = await stat(file, { bigint: true }),
      stamp = `${s.ino}:${s.size}:${s.mtimeNs}`,
      known = states.get(file);
    if (known?.stamp === stamp) return known.state;
    // A read that fails isn't kept: only the file itself says no one signed in.
    const text = await readFile(file, "utf8");
    let value: any = null;
    try {
      value = JSON.parse(text);
    } catch {}
    const account = value?.oauthAccount,
      email = account?.emailAddress,
      workspace = String(account?.organizationUuid || ""),
      state: State = {
        login:
          typeof email === "string" && email
            ? { email, id: `${account.accountUuid || email}/${workspace}`, service: "claude", workspace }
            : null,
        onboarded: value?.hasCompletedOnboarding === true,
      };
    // Read after the stat, it may be newer than its stamp: the next stat differs
    // and reads it again. A file written within the last second could change
    // again within its mtime's clock tick, unseen, so it isn't kept until it's older.
    if (BigInt(Date.now()) - s.mtimeNs / 1_000_000n >= 1000n) states.set(file, { stamp, state });
    else states.delete(file);
    return state;
  } catch {
    states.delete(file);
    return null;
  }
}
/** Who signed in to the settings at `root`. The default account's file
 * sits in HOME instead, `home` when `root` is that account's. */
export async function identity(root: string, home: boolean): Promise<Login | null> {
  const login = (await state(root))?.login ?? (home ? ((await state(dirname(root)))?.login ?? null) : null);
  return login && { ...login };
}
/** Its first run at `root` is over: until then it asks for a theme and a login. */
export const onboarded = async (root: string) => (await state(root))?.onboarded === true;
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
