//! Display names are text, independent of account folders and agent IDs.
import { byteLength } from "./text";

export const limit = 160;
export const message = "Use a nonblank name up to 160 bytes, without control characters.";
export function valid(value: unknown): value is string {
  return (
    typeof value === "string" && !!value.trim() && byteLength(value) <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value)
  );
}
export function check(value: string, empty = false): void {
  if (!(empty && value === "") && !valid(value)) throw Error("InvalidAgentName");
}
