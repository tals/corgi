//! Tool calls and results as corgi grep keeps them, whatever provider recorded them.
type RecordValue = Record<string, unknown>;
export type Tool = {
  kind: "call" | "result";
  name: string;
  call_id: string;
  status: "success" | "error" | "running" | "interrupted" | null;
  exit_code: number | null;
  call_ref?: string;
  result_ref?: string;
};
export type ToolRecord = {
  role: "tool";
  text: string;
  timestamp: number | null;
  ref: string;
  tool: Tool;
  /** Its outcome was read from the result's text, which only some tools' results report. */
  from_text?: boolean;
};

/** The tool name of a command the user ran themselves, with `!` or its like. */
export const userShell = "user-shell";

export function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

export function timestamp(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Render values as plain text instead of JSON escaping commands, quotes and newlines.
function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, child]) => `${key}: ${readable(child)}`)
      .join("\n");
  }
  return "";
}

function argumentsText(value: unknown): string {
  if (typeof value !== "string") return readable(value);
  try {
    return readable(JSON.parse(value));
  } catch {
    return value;
  }
}

/** The text blocks of a result's content. */
export function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(object)
    .filter(block => ["text", "input_text", "output_text"].includes(String(block.type)))
    .map(block => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** A call as its tool's name, then its arguments as plain text. */
export function call(name: unknown, args: unknown): string {
  return [typeof name === "string" ? name : "tool", argumentsText(args)].filter(Boolean).join("\n");
}

function exitCode(...values: unknown[]): number | null {
  for (const value of values) {
    const v = object(value);
    for (const key of ["exit_code", "exitCode", "returnCode", "return_code"])
      if (typeof v[key] === "number" && Number.isInteger(v[key])) return v[key] as number;
  }
  return null;
}
/** A result's outcome from its recorded fields; `text` is what its output text reported. */
export function outcome(
  value: unknown,
  failed?: unknown,
  interrupted?: unknown,
  text: { code: number | null; running: boolean } = { code: null, running: false },
): Pick<Tool, "status" | "exit_code"> {
  const v = object(value),
    code = exitCode(v, v.metadata, v.details) ?? text.code;
  return {
    exit_code: code,
    status:
      interrupted === true
        ? "interrupted"
        : failed === true || (code !== null && code !== 0)
          ? "error"
          : text.running
            ? "running"
            : code === 0 || failed === false
              ? "success"
              : null,
  };
}
export function info(
  kind: Tool["kind"],
  name: unknown,
  id: unknown,
  status: Pick<Tool, "status" | "exit_code"> = { status: null, exit_code: null },
): Tool {
  return { kind, name: typeof name === "string" ? name : "", call_id: typeof id === "string" ? id : "", ...status };
}
/** A record of one tool message; an empty result still shows. */
export function record(text: string, stamp: unknown, ref: string, tool: Tool, from_text = false): ToolRecord {
  return {
    role: "tool",
    text: text || "(empty result)",
    timestamp: timestamp(stamp),
    ref,
    tool,
    ...(from_text ? { from_text: true } : {}),
  };
}
/** Pair only provider-issued IDs; arbitrary text mentioning an exit code is not
 * an outcome. A result whose outcome came from its text keeps it only for a
 * call `reportsText` accepts. */
export function link(records: ToolRecord[], reportsText: (call: string) => boolean = () => false): ToolRecord[] {
  const calls = new Map<string, Tool[]>();
  for (const record of records) {
    const tool = record.tool;
    if (tool.kind === "call") {
      tool.call_ref = record.ref;
      if (tool.call_id) {
        const list = calls.get(tool.call_id) ?? [];
        list.push(tool);
        calls.set(tool.call_id, list);
      }
    } else {
      tool.result_ref = record.ref;
      const paired = calls.get(tool.call_id);
      const call = paired?.[0];
      if (record.from_text && !reportsText(call?.name ?? "")) {
        tool.status = null;
        tool.exit_code = null;
      }
      if (!call) continue;
      tool.name ||= call.name;
      tool.call_ref = call.call_ref;
      for (const entry of paired!)
        Object.assign(entry, { status: tool.status, exit_code: tool.exit_code, result_ref: record.ref });
    }
  }
  return records;
}
