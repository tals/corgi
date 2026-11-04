//! Pi's conversations as corgi grep reads them, wherever its settings keep sessions.
import { injected } from "../../launch/history";
import * as search from "../search";
import * as tools from "../search_tools";
import type { ToolRecord } from "../search_tools";
import { accounts } from "./accounts";
import { configDir } from "./integration";
import { sessionRoots } from "./locations";

/** Pi's records, which omp keeps too: a change here bumps both versions. */
export const records = {
  pattern: "**/*.jsonl",
  depth: 2,
  identity(head: any[]) {
    const meta = head.find(v => v?.type === "session");
    return meta
      ? { session: String(meta.id || meta.sessionId || ""), cwd: typeof meta.cwd === "string" ? meta.cwd : "" }
      : null;
  },
  messages(value: unknown, ref: string) {
    const v = tools.object(value),
      message = tools.object(v.message);
    if (v.type !== "message") return [];
    const text = tools.content(message.content);
    return message.role === "user" && injected(text)
      ? []
      : search.prose(message.role, text, v.timestamp ?? message.timestamp, ref);
  },
  tools(value: unknown, ref: string): ToolRecord[] {
    const v = tools.object(value),
      message = tools.object(v.message);
    if (v.type !== "message") return [];
    const stamp = v.timestamp ?? message.timestamp;
    if (message.role === "assistant" && Array.isArray(message.content))
      return message.content.flatMap(item => {
        const block = tools.object(item);
        return block.type === "toolCall"
          ? [
              tools.record(
                tools.call(block.name, block.arguments ?? block.args),
                stamp,
                ref,
                tools.info("call", block.name, block.id),
              ),
            ]
          : [];
      });
    if (message.role === "toolResult")
      return [
        tools.record(
          tools.content(message.content),
          stamp,
          ref,
          tools.info("result", message.toolName, message.toolCallId, tools.outcome(message.details, message.isError)),
        ),
      ];
    return [];
  },
  title: (value: any) => (value?.type === "session_info" && typeof value.name === "string" ? value.name : ""),
};
export const conversations = search.transcripts({
  version: 1,
  home: configDir,
  env: accounts.env,
  folders: root => sessionRoots(root),
  ...records,
});
