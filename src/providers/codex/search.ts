//! Codex's conversations as corgi grep reads them: rollout files, archived and compressed ones too.
import { join } from "node:path";
import { injected } from "../../launch/history";
import * as search from "../search";
import * as tools from "../search_tools";
import type { ToolRecord } from "../search_tools";
import { configDir } from "./index";
import { vocabulary } from "./info";

/** Tools whose output text reports how the command ended. */
const shells = ["exec_command", "shell", "shell_command", "run_command", "write_stdin"];
/** A result's outcome: its fields, or the envelope Codex's shell tools write. */
function outcome(output: unknown) {
  if (typeof output !== "string") return tools.outcome(output);
  let fields: unknown = {};
  try {
    fields = JSON.parse(output);
  } catch {
    /* Some Codex tools use a text envelope. */
  }
  const header = output.split(/\n(?:Final output|Output):(?:\n|$)/, 1)[0],
    text = { code: null as number | null, running: false };
  if (/^(?:Chunk ID:|Wall time:)/.test(header)) {
    const found = /(?:^|\n)(?:Process exited with code|Exit code:) (-?\d+)(?:\n|$)/.exec(header);
    if (found) text.code = Number(found[1]);
    text.running = /(?:^|\n)Process running with session ID \d+(?:\n|$)/.test(header);
  }
  return tools.outcome(fields, undefined, undefined, text);
}
/** A command the user ran themselves, which Codex records with its result in the user's turn. */
function userShell(text: string, stamp: unknown, ref: string): ToolRecord[] {
  const found = /^\s*<user_shell_command>\s*<command>\s*([^]*?)\s*<\/command>\s*<result>\s*([^]*?)\s*<\/result>/.exec(
    text,
  );
  if (!found) return [];
  const [, command, result] = found,
    code = /^Exit code: (-?\d+)$/m.exec(result),
    output = /(?:^|\n)Output:\n([^]*)$/.exec(result)?.[1] ?? result,
    id = `${tools.userShell}:${ref}`,
    outcome = tools.outcome({}, undefined, undefined, { code: code ? Number(code[1]) : null, running: false });
  return [
    tools.record(tools.call(tools.userShell, { command }), stamp, ref, tools.info("call", tools.userShell, id)),
    tools.record(output, stamp, ref, tools.info("result", tools.userShell, id, outcome)),
  ];
}
function toolRecords(value: unknown, ref: string): ToolRecord[] {
  const v = tools.object(value),
    payload = tools.object(v.payload);
  if (v.type !== "response_item") return [];
  if (payload.type === "message" && payload.role === "user")
    return userShell(tools.content(payload.content), v.timestamp, ref);
  if (payload.type === "function_call" || payload.type === "custom_tool_call")
    return [
      tools.record(
        tools.call(payload.name, payload.arguments ?? payload.input),
        v.timestamp,
        ref,
        tools.info("call", payload.name, payload.call_id),
      ),
    ];
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")
    return [
      tools.record(
        typeof payload.output === "string" ? payload.output : tools.content(payload.output),
        v.timestamp,
        ref,
        tools.info("result", "", payload.call_id, outcome(payload.output)),
        true,
      ),
    ];
  return [];
}
export const conversations = search.transcripts({
  version: 1,
  home: configDir,
  env: vocabulary.config_env,
  folders: root => [join(root, "sessions"), join(root, "archived_sessions")],
  pattern: "**/*.jsonl{,.zst}",
  identity(records) {
    const meta = records.find(v => v?.type === "session_meta")?.payload;
    if (!meta) return null;
    if (JSON.stringify(meta.source ?? "").includes("subagent")) return "excluded";
    return { session: String(meta.id || meta.sessionId || ""), cwd: typeof meta.cwd === "string" ? meta.cwd : "" };
  },
  messages(value, ref) {
    const v = tools.object(value),
      p = tools.object(v.payload);
    if (v.type !== "response_item" || p.type !== "message") return [];
    const text = tools.content(p.content);
    return p.role === "user" && injected(text) ? [] : search.prose(p.role, text, v.timestamp, ref);
  },
  tools: toolRecords,
  reportsText: name => shells.includes(name.split(".").at(-1) ?? ""),
});
