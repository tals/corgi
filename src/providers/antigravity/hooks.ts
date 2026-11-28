import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as hooksFile from "../hooks_file";
import { field, str, Hooks, type Hook } from "../common";
import type { IntegrationStepResult } from "../adapter";
import { customizations, validSession } from "./config";
import * as status from "./status";
const codec = new Hooks();
const events = {
  SessionStart: "SessionStart",
  PreInvocation: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  Stop: "Stop",
} as const;
const writes = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "notebook_edit"]);
export function decode(v: unknown): Hook {
  const session = str(v, "conversationId"),
    event = str(v, "hookEventName");
  if (!validSession(session) || !Object.hasOwn(events, event)) return null;
  if (event === "PreInvocation" && field(v, "invocationNum") > 0) return null;
  const tool = field(v, "toolCall"),
    args = field(tool, "args"),
    toolName = str(tool, "name"),
    filename = str(args, "TargetFile");
  const hook = codec.decode({
    hook_event_name:
      event === "PostToolUse" && str(v, "error") ? "PostToolUseFailure" : events[event as keyof typeof events],
    session_id: session,
    cwd: str(v, "cwd"),
    model: str(v, "modelName"),
    transcript_path: str(v, "transcriptPath"),
    prompt_id:
      event === "PreInvocation" && Number.isSafeInteger(field(v, "initialNumSteps"))
        ? "step-" + field(v, "initialNumSteps")
        : "",
    tool_name: toolName,
    tool_input: {
      description: str(args, "toolSummary") || str(args, "Description"),
      file_path: filename || str(args, "AbsolutePath") || str(args, "DirectoryPath"),
      command: str(args, "CommandLine"),
      query: str(args, "Query"),
    },
  });
  if (!hook) return null;
  if (hook.kind === "prompt" && field(v, "initialNumSteps") === 0) hook.initial_request = str(v, "lastUserInput");
  if (hook.kind === "tool_finish" && writes.has(toolName) && isAbsolute(filename)) hook.writes = [filename];
  if (hook.kind === "tool_start")
    hook.asking = ["ask_question", "ask_permission", "ask_custom_permission"].includes(toolName);
  if (hook.kind === "tool_start" && !hook.asking) hook.confirm = "screen";
  if (event === "Stop") {
    const reason = str(v, "terminationReason");
    hook.outcome =
      reason === "USER_CANCELED"
        ? "interrupted"
        : str(v, "error") || reason === "ERROR" || reason.startsWith("MAX_")
          ? "failed"
          : "completed";
  }
  return hook;
}
// An empty stdout leaves agy's permission decision alone. Even an empty JSON
// object on PreToolUse is a decision and would deny the user's tool calls.
const handler = { type: "command", command: hooksFile.command("antigravity"), timeout: 3 };
const handlers = Object.fromEntries(
  Object.keys(events).map(event => [
    event,
    event.endsWith("ToolUse") ? [{ matcher: "", hooks: [handler] }] : [handler],
  ]),
);
const name = "Reporting to Corgi";
function hooks(op: "install" | "uninstall" | "status", account: string): IntegrationStepResult[] {
  const dir = customizations(account),
    file = new hooksFile.File("antigravity", dir, "hooks.json", []);
  const base = { item: "hooks", path: file.path };
  try {
    if (!existsSync(dir)) {
      if (op !== "install") return [{ ...base, outcome: "no_config" }];
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const change = (before: string) => {
      const root = JSON.parse(before);
      if (!root || typeof root !== "object" || Array.isArray(root)) throw Error("InvalidHookSettings");
      const current = root[name];
      // Never replace a user's same-named hook or undo an explicit disable.
      if (current !== undefined) {
        const { enabled, ...rest } = current;
        if (!isDeepStrictEqual(rest, handlers)) throw Error("HookNameConflict");
        if (op !== "uninstall") return enabled === false ? "disabled" : null;
        delete root[name];
      } else {
        if (op === "uninstall") return null;
        root[name] = handlers;
      }
      return JSON.stringify(root, null, 2);
    };
    if (op === "status") {
      const needed = change(existsSync(file.path) ? readFileSync(file.path, "utf8") : "{}");
      return [{ ...base, outcome: needed === null ? "present" : needed === "disabled" ? "partial" : "absent" }];
    }
    let disabled = false;
    const result = file.edit(before => {
      const next = change(before);
      disabled = next === "disabled";
      return disabled ? null : next;
    }, op === "install");
    const changed = result === "changed";
    return [
      {
        ...base,
        outcome:
          op === "install" ? (disabled ? "partial" : changed ? "added" : "present") : changed ? "removed" : "absent",
      },
      ...(op === "uninstall" ? file.cleanup([file.path + ".corgi-backup"]) : []),
    ];
  } catch (e) {
    return [hooksFile.failed("hooks", file.path, e)];
  }
}
export function integration(op: "install" | "uninstall" | "status", account: string) {
  return [...hooks(op, account), ...status.integration(op, account)];
}
