//! Ordered migrations at the persistence seam.
import * as json from "../json";
import * as steps from "./steps";
export const checkpoint_version = steps.checkpoint.length + 1;
export const handoff_version = steps.handoff.length + 1;
export type Kind = "checkpoint" | "handoff";
function version(value: any, current: number): number {
  const fields = steps.object(value);
  if (!("version" in fields)) throw Error("MissingStateVersion");
  const field = fields.version;
  if (
    (typeof field !== "number" && typeof field !== "bigint") ||
    field < 1 ||
    (typeof field === "number" && !Number.isInteger(field))
  )
    throw Error("InvalidStateVersion");
  if (field > current) throw Error("UnsupportedStateVersion");
  return Number(field);
}
function migrate(list: steps.Step[], value: any): boolean {
  const before = version(value, list.length + 1);
  for (let i = before - 1; i < list.length; i++) {
    list[i](value);
    value.version = i + 2;
  }
  return before !== list.length + 1;
}
export function decode(
  kind: Kind,
  bytes: string | Uint8Array,
): { value: any; from: number; migrated: boolean } {
  const value = json.parse(
    typeof bytes === "string" ? bytes : Buffer.from(bytes).toString(),
  );
  const from = version(
    value,
    kind === "checkpoint" ? checkpoint_version : handoff_version,
  );
  let migrated = migrate(
    kind === "checkpoint" ? steps.checkpoint : steps.handoff,
    value,
  );
  if (kind === "handoff") {
    if (!("runtime" in value)) throw Error("MissingField");
    migrated = migrate(steps.checkpoint, value.runtime) || migrated;
  }
  return { value, from, migrated };
}
