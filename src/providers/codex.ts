import { field, str, Hooks, nativeEvent, Text, planLabel } from "./common";
import { info } from "./codex_info";
export const Method = [
  "turn/started",
  "turn/completed",
  "thread/started",
  "thread/tokenUsage/updated",
  "item/started",
  "item/completed",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/call",
  "item/tool/requestUserInput",
] as const;
export const ItemType = [
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
] as const;
export const RolloutKind = ["session_meta", "turn_context", "event_msg", "response_item"] as const;
export const EventKind = [
  "task_started",
  "task_complete",
  "turn_complete",
  "turn_aborted",
  "token_count",
  "message",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "web_search_call",
] as const;
export class Rollout {
  type: string | null = null;
  timestamp = "";
  payload: any = null;
  static decode(v: any) {
    return Object.assign(new Rollout(), {
      type: RolloutKind.includes(str(v, "type") as any) ? str(v, "type") : null,
      timestamp: str(v, "timestamp"),
      payload: field(v, "payload"),
    });
  }
  payloadType() {
    const t = str(this.payload, "type");
    return EventKind.includes(t as any) ? t : null;
  }
}
export class Codex {
  static info = info;
  static Method = Method;
  static ItemType = ItemType;
  static RolloutKind = RolloutKind;
  static EventKind = EventKind;
  static Rollout = Rollout;
  static hook_events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
    "PreCompact",
    "Interrupt",
    "PostCompact",
  ];
  hooks = new Hooks();
  hook(v: any) {
    return this.hooks.decode(v);
  }
  nativeEvent(v: any) {
    const method = str(v, "method"),
      params = field(v, "params"),
      thread = str(params, "threadId"),
      turn = field(params, "turn"),
      result = field(v, "result") ?? params;
    const status = str(turn, "status");
    return nativeEvent({
      session: thread || str(field(result, "thread"), "id"),
      thread,
      turn: str(turn, "id"),
      phase: method === "turn/started" ? "working" : method === "turn/completed" ? "completed" : "none",
      outcome: ["completed", "interrupted", "failed"].includes(status) ? (status as any) : "completed",
      request_id: method ? field(v, "id") : null,
      response_id: v && typeof v === "object" && ("result" in v || "error" in v) ? field(v, "id") : null,
      initialize: str(v, "id") === "__corgi_init",
      initialization_failed: !!v && Object.hasOwn(v, "error"),
      tool_request: [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/call",
        "item/tool/requestUserInput",
      ].includes(method),
    });
  }
  static titleSession(title: string) {
    let found: Text | null = null;
    for (const word of title.split(/[ |\t]+/)) {
      const s = word.length === 36 ? word : word.length === 32 && word.endsWith("...") ? word.slice(0, 29) : "";
      if (!s || !/^([\da-f]{8})-([\da-f]{4})-([\da-f]{4})-([\da-f]{4})-([\da-f]{5}|[\da-f]{12})$/i.test(s)) continue;
      if (found) return null;
      found = new Text(s);
    }
    return found;
  }
  static plan(code: string) {
    const names: Record<string, string> = {
      prolite: "Pro 100",
      pro: "Pro 200",
      promax: "Pro 500",
      team: "Business",
      self_serve_business_usage_based: "Business",
      self_serve_business_prolite: "Business Premium",
      business: "Enterprise",
      ent26: "Enterprise",
      enterprise_cbp_usage_based: "Enterprise",
      enterprise_cbp_automation: "Enterprise (Automation)",
    };
    return names[code] ? new Text(names[code]) : planLabel(code);
  }
}
