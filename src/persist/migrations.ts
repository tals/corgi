//! Saved-state decoding. Numeric versions are aliases for checked-in revision IDs.
import { basename } from "node:path";
import * as json from "../json";
import * as values from "./revision_values";
import * as formats from "./formats";
import * as state_formats from "./state_formats";

// XXX: Remove for next protocol bump. Numeric headers remain for pre-baseline peers.
export const checkpoint_version = 6;
export const handoff_version = 7;
export const workspaces_version = 2;
export type Kind = Exclude<formats.Kind, "state" | "viewer">;
export const legacy: Record<Kind, Record<number, string>> = {
  "checkpoint": {
    "1": "f02a7f1348ba",
    "2": "e6040f3691c4",
    "3": "66623983aa75",
    "4": "852a72ce6f71",
    "5": "d58e69e6af6c",
    "6": "1dfaa1773956",
  },
  "handoff": {
    "1": "e853a6493fda",
    "2": "5164afe07e1f",
    "3": "3721a7d79310",
    "4": "35327c122041",
    "5": "f598c67a8c73",
    "6": "38dc0fb4d7d7",
    "7": "3a005bd21b0d",
  },
  "workspaces": {
    "1": "3cb5c87815a8",
    "2": "f4c12b1642bd",
  },
};
const versions = { checkpoint: checkpoint_version, handoff: handoff_version, workspaces: workspaces_version };
function revision(kind: Kind, value: unknown): { id: string; from: string | number } {
  const fields = values.object(value);
  if (fields.format !== undefined) {
    if (!formats.id(fields.format)) throw Error("InvalidStateFormats");
    return { id: fields.format, from: fields.format };
  }
  if (!("version" in fields)) throw Error("MissingStateVersion");
  const field = fields.version;
  if (
    (typeof field !== "number" && typeof field !== "bigint") ||
    field < 1 ||
    (typeof field === "number" && !Number.isInteger(field))
  )
    throw Error("InvalidStateVersion");
  const id = legacy[kind][Number(field)];
  if (!id) throw Error("UnsupportedStateVersion");
  return { id, from: Number(field) };
}
export function decode(
  kind: Kind,
  bytes: string | Uint8Array,
): { value: any; from: string | number; migrated: boolean } {
  return upgrade(kind, json.parse(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString()));
}
function upgrade(kind: Kind, saved: unknown): { value: any; from: string | number; migrated: boolean } {
  const source = revision(kind, saved),
    history = state_formats[kind],
    value = values.object(history.up(saved, source.id));
  let migrated = source.id !== history.current;
  value.version = versions[kind];
  if (value.format !== undefined) value.format = history.current;
  if (kind === "handoff") {
    if (!("runtime" in value)) throw Error("MissingField");
    const runtime = upgrade("checkpoint", value.runtime);
    value.runtime = runtime.value;
    migrated ||= runtime.migrated;
  }
  nameWorkspaces(kind === "handoff" ? value.runtime : value);
  return { value, from: source.from, migrated };
}
/** Older builds saved "" for a workspace named by its folder. Every
 * workspace now keeps a name, so an empty one takes its folder's here,
 * without a version: newer files never hold one, and older builds read the
 * names these files hold as names. */
function nameWorkspaces(value: any) {
  for (const workspace of values.items(value, "workspaces")) {
    const fields = values.object(workspace);
    if (fields.name === "" && typeof fields.cwd === "string") fields.name = basename(fields.cwd) || "/";
  }
}
