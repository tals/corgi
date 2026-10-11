//! Primitive saved-format validation follows the checked schema snapshot.
import checkpointSchema from "../fixtures/checkpoint.schema" with { type: "text" };
import { Model } from "../layout";
export const checkpoint = checkpointSchema;
function fail(name = "UnexpectedToken"): never {
  throw Error(name);
}
function values(value: any, path: string): any[] {
  let current = [value];
  for (const match of path.slice(1).matchAll(/\.([^.[?|]+)|\[(\d*)\]|(\?)|\|([^.[?|]+)/g)) {
    if (match[1])
      current = current.flatMap(v =>
        v !== null && typeof v === "object" && Object.hasOwn(v, match[1]) ? [v[match[1]]] : [],
      );
    else if (match[2] !== undefined)
      current = current.flatMap(v => {
        if (!Array.isArray(v)) fail();
        if (match[2] && v.length !== Number(match[2])) fail("LengthMismatch");
        return v;
      });
    else if (match[3]) current = current.filter(v => v !== null);
    else current = current.flatMap(v => (v && Object.hasOwn(v, match[4]) ? [v[match[4]]] : []));
  }
  return current;
}
function requireFields(value: any, fields: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  for (const field of fields) if (!Object.hasOwn(value, field)) fail("MissingField");
}
export function validateCheckpoint(value: any): void {
  requireFields(value, [
    "live",
    "saved_at",
    "next_workspace",
    "next_pane",
    "next_session",
    "revision",
    "workspaces",
    "panes",
    "closed",
    "sessions",
  ]);
  for (const field of ["workspaces", "panes", "closed", "sessions", "conversations"]) {
    if (value[field] !== undefined && !Array.isArray(value[field])) fail();
  }
  for (const workspace of value.workspaces) requireFields(workspace, ["id", "name", "cwd", "model"]);
  for (const pane of value.panes) {
    requireFields(pane, ["binding", "id", "cwd", "screen"]);
    requireFields(pane.screen, ["cols", "rows", "data"]);
  }
  for (const closed of value.closed) {
    requireFields(closed, ["cwd", "screen", "tab", "workspace_id"]);
    requireFields(closed.screen, ["cols", "rows", "data"]);
    requireFields(closed.tab, ["id", "root"]);
  }
  for (const actor of value.conversations ?? []) requireFields(actor, ["id", "agent"]);
  for (const session of value.sessions)
    requireFields(session, [
      "binding",
      "id",
      "provider",
      "cwd",
      "workspace_id",
      "pid",
      "stdin",
      "stdout",
      "ready",
      "exited",
      "state",
      "attention",
      "input",
      "output",
      "deferred",
      "events",
      "approvals",
      "tools",
      "next_seq",
      "journal_bytes",
      "resume_hint",
    ]);
  for (const line of checkpointSchema.trim().split("\n")) {
    const [path, type] = line.split(": ");
    for (const item of values(value, path)) {
      if (type === "optional") continue;
      if (type === "one of") {
        if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 1) fail();
        const tags = checkpointSchema
          .split("\n")
          .filter(s => s.startsWith(path + "|"))
          .map(s => s.slice(path.length + 1).split(/[.:]/)[0]);
        if (!tags.includes(Object.keys(item)[0])) fail();
      } else if (type.startsWith("enum ")) {
        if (typeof item !== "string") fail();
        if (!type.slice(5).split(" ").includes(item)) fail("InvalidEnumTag");
      } else if (type === "bool") {
        if (typeof item !== "boolean") fail();
      } else if (type === "string" || type.startsWith("custom bounded_text.")) {
        if (typeof item !== "string" && !Array.isArray(item)) fail();
        if (Array.isArray(item))
          for (const byte of item) {
            if (typeof byte !== "number" || !Number.isInteger(byte)) fail();
            if (byte < 0 || byte > 255) fail("Overflow");
          }
        const size = type.match(/\((\d+)\)/);
        if (size && (typeof item === "string" ? Buffer.byteLength(item) : item.length) > Number(size[1]))
          fail("LengthMismatch");
      } else if (type === "custom layout.Model") Model.fromData(item);
      else {
        const bits = type === "usize" ? 64 : type === "c_int" ? 32 : Number(type.slice(1)),
          signed = type[0] === "i" || type === "c_int";
        if (typeof item !== "bigint" && (typeof item !== "number" || !Number.isInteger(item))) fail();
        if (typeof item === "number" && !Number.isSafeInteger(item)) fail("Overflow");
        const n = BigInt(item),
          min = signed ? -(1n << BigInt(bits - 1)) : 0n,
          max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
        if (n < min || n > max) fail("Overflow");
      }
    }
  }
}
