import { appendFileSync } from "node:fs";
import * as clock from "./clock";

export type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;
const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minimum: Level | null = null,
  sink = (line: string) => void process.stderr.write(line);

/** Only the daemon's stderr goes to server.log. `corgi voice --verbose`,
 * whose stderr is its screen, appends to its own `file` instead. */
export function configure(command: string, env: NodeJS.ProcessEnv = process.env, file: string | null = null) {
  minimum = null;
  sink = line => void process.stderr.write(line);
  if (command === "voice" && file) {
    minimum = "info";
    sink = line => void appendFileSync(file, line, { mode: 0o600 });
    return;
  }
  if (command !== "serve" && command !== "__handoff") return;
  switch (env.CORGI_LOG_LEVEL) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      minimum = env.CORGI_LOG_LEVEL;
      break;
    default:
      minimum = "info";
  }
}

function stringify(value: unknown): string {
  const ancestors: object[] = [],
    errors = new WeakMap<Error, object>();
  return JSON.stringify(value, function (_key, value: unknown) {
    if (typeof value === "bigint") return JSON.rawJSON(String(value));
    if (value instanceof Error) {
      let fields = errors.get(value);
      if (!fields) {
        fields = { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause };
        errors.set(value, fields);
      }
      value = fields;
    }
    if (value !== null && typeof value === "object") {
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (ancestors.includes(value)) return "[Circular]";
      ancestors.push(value);
    }
    return value;
  });
}

export function getLogger(scope: string) {
  const write = (level: Level, message: string, fields?: Fields) => {
    if (minimum === null || levels[level] < levels[minimum]) return;
    let line: string;
    try {
      line = stringify({ ...fields, at: clock.milliTimestamp(), message });
    } catch {
      line = stringify({ at: clock.milliTimestamp(), message, logging_error: "Could not serialize fields" });
    }
    try {
      sink(`${level}(${scope}): ${line}\n`);
    } catch {
      // Logging must not interrupt the operation it describes.
    }
  };
  return {
    debug: (message: string, fields?: Fields) => write("debug", message, fields),
    info: (message: string, fields?: Fields) => write("info", message, fields),
    warn: (message: string, fields?: Fields) => write("warn", message, fields),
    error: (message: string, fields?: Fields) => write("error", message, fields),
  };
}
