//! Claude Code's conversations as corgi grep reads them: one transcript per
//! session in each project folder, without subagents' or SDK runs'.
import { join } from "node:path";
import { injected } from "../../launch/history";
import * as search from "../search";
import * as tools from "../search_tools";
import type { ToolRecord } from "../search_tools";
import { configDir } from "./index";
import { vocabulary } from "./info";

/** A slash command as the user typed it, "/name args"; empty when it had no arguments. */
function command(text: string): string {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1].trim() ?? "",
    args = /<command-args>([^]*?)<\/command-args>/.exec(text)?.[1].trim() ?? "";
  return name && args ? `${name} ${args}` : "";
}
const conversational = (v: Record<string, any>) =>
  (v.type === "user" || v.type === "assistant") && !v.isMeta && !v.isCompactSummary && !v.isSidechain;
/** A command the user ran with `!`, and its output, whose record names the command's as its parent. */
function userShell(v: Record<string, any>, text: string, ref: string): ToolRecord[] {
  const input = /^<bash-input>([^]*?)<\/bash-input>/.exec(text);
  if (input)
    return [
      tools.record(
        tools.call(tools.userShell, { command: input[1] }),
        v.timestamp,
        ref,
        tools.info("call", tools.userShell, v.uuid),
      ),
    ];
  if (!/^<bash-(?:stdout|stderr)>/.test(text)) return [];
  const output = [...text.matchAll(/<bash-(stdout|stderr)>([^]*?)<\/bash-\1>/g)]
    .map(m => m[2])
    .filter(Boolean)
    .join("\n");
  return [tools.record(output, v.timestamp, ref, tools.info("result", tools.userShell, v.parentUuid))];
}
function toolRecords(value: unknown, ref: string): ToolRecord[] {
  const v = tools.object(value),
    message = tools.object(v.message);
  if (!conversational(v)) return [];
  const shell = v.type === "user" ? userShell(v, tools.content(message.content).trimStart(), ref) : [];
  if (shell.length) return shell;
  if (!Array.isArray(message.content)) return [];
  const records: ToolRecord[] = [];
  for (const item of message.content) {
    const block = tools.object(item);
    if (v.type === "assistant" && block.type === "tool_use")
      records.push(
        tools.record(tools.call(block.name, block.input), v.timestamp, ref, tools.info("call", block.name, block.id)),
      );
    if (v.type === "user" && block.type === "tool_result")
      records.push(
        tools.record(
          tools.content(block.content),
          v.timestamp,
          ref,
          tools.info(
            "result",
            "",
            block.tool_use_id,
            tools.outcome(v.toolUseResult, block.is_error, tools.object(v.toolUseResult).interrupted),
          ),
        ),
      );
  }
  return records;
}
export const conversations = search.transcripts({
  version: 1,
  home: configDir,
  env: vocabulary.config_env,
  folders: root => [join(root, "projects")],
  pattern: "**/*.jsonl",
  depth: 2,
  identity(records) {
    const meta = records.find(v => v?.cwd && v.sessionId);
    if (!meta) return null;
    if (meta.isSidechain || meta.entrypoint === "sdk-cli") return "excluded";
    return { session: String(meta.id || meta.sessionId), cwd: String(meta.cwd) };
  },
  messages(value, ref) {
    const v = tools.object(value),
      message = tools.object(v.message);
    if (!conversational(v)) return [];
    const role = message.role ?? v.type;
    let text = tools.content(message.content);
    if (role === "user" && /^<command-(?:name|message)>/.test(text.trimStart())) text = command(text);
    return role === "user" && injected(text) ? [] : search.prose(role, text, v.timestamp, ref);
  },
  tools: toolRecords,
  title: value => (value?.type === "custom-title" && typeof value.customTitle === "string" ? value.customTitle : ""),
});
