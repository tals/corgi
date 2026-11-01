//! Display names are text, independent of account folders and agent IDs.
import * as i18n from "./i18n";
import { byteLength } from "./text";

export const limit = 160;
export const message = () => i18n.t`Use a nonblank name up to 160 bytes, without control characters.`;
export const accountMessage = () =>
  i18n.t`Use a nonblank name up to 160 bytes, without control characters. The account name default is reserved.`;
export function valid(value: unknown): value is string {
  return (
    typeof value === "string" && !!value.trim() && byteLength(value) <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value)
  );
}
export function check(value: string, empty = false): void {
  if (!(empty && value === "") && !valid(value)) throw Error("InvalidAgentName");
}
