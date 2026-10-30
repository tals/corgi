/** Agent mode compacts pane output when a coding agent reads through a pipe. */

/** Variables coding agents set in their commands' environments, and the agent
 * each names. `AI_AGENT` and `AGENT` name the agent in their value. */
const variables: [string, string | null][] = [
  ["CLAUDECODE", "claude-code"],
  ["CODEX_CI", "codex"],
  ["CODEX_SANDBOX", "codex"],
  ["CODEX_THREAD_ID", "codex"],
  ["CURSOR_AGENT", "cursor"],
  ["GEMINI_CLI", "gemini-cli"],
  ["COPILOT_AGENT", "copilot"],
  ["COPILOT_CLI", "copilot"],
  ["COPILOT_AGENT_SESSION_ID", "copilot"],
  ["AI_AGENT", null],
  ["AGENT", null],
];
/** The agent whose environment `env` is, or null. */
export function agent(env: Record<string, string | undefined>): string | null {
  for (const [name, agent] of variables) if (env[name]) return agent ?? env[name]!;
  return null;
}
/** Whether agent mode is on: `--agent`/`--no-agent`, then `CORGI_AGENT_MODE`,
 * then a known agent writing to something other than a terminal. */
export function enabled(flag: boolean | null, env: Record<string, string | undefined>, terminal: boolean): boolean {
  if (flag !== null) return flag;
  if (env.CORGI_AGENT_MODE === "1") return true;
  if (env.CORGI_AGENT_MODE === "0") return false;
  return !terminal && agent(env) !== null;
}
