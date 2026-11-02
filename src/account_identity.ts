import type { Info } from "./usage/account";
import type { Reading } from "./usage/spend";
import * as spend from "./usage/spend";

export type Type = "oauth" | "api_key" | "external";
export interface Usage {
  limits:
    | "none"
    | "metered"
    | "rate_limited"
    | {
        windows: ({ minutes: number | null; used: number; reset_at: number | null } | null)[];
      };
  spend: Reading | null;
  fetched_at: number | null;
  error: string | null;
  needs_consent: boolean;
}
/** Profile and login lookup keys, separate from their display metadata. */
export interface Identity {
  id: string;
  name: string;
  directory: string | null;
  loginId: string | null;
  email: string | null;
  type: Type | null;
  plan: string | null;
  usage: Usage | null;
}

export function type(value: unknown): Type | null {
  switch (value) {
    case "oauth":
    case "api_key":
    case "external":
      return value;
    default:
      return null;
  }
}
const label = (value: unknown, limit = 160): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value)
    ? value
    : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function usage(value: unknown): Usage | null {
  const v = object(value);
  if (!v) return null;
  let limits: Usage["limits"] = "none";
  if (v.limits === "metered" || v.limits === "rate_limited") limits = v.limits;
  else {
    const windows = object(v.limits)?.windows;
    if (Array.isArray(windows) && windows.length <= 2) {
      limits = {
        windows: windows.map(value => {
          const w = object(value),
            used = number(w?.used);
          return w && used !== null && used <= 100
            ? {
                minutes: number(w.minutes),
                used,
                reset_at: number(w.reset_at),
              }
            : null;
        }),
      };
    }
  }
  return {
    limits,
    spend: spend.restore(v.spend),
    fetched_at: number(v.fetched_at),
    error: label(v.error),
    needs_consent: v.needs_consent === true,
  };
}
/** Reuse the account reader's snapshot without starting another request. */
export function details(info: Info) {
  return {
    email: label(info.email),
    type: type(info.type),
    plan: label(info.plan.text()),
    usage:
      info.usage_fetched_at > 0 ||
      info.limits !== "none" ||
      info.spend ||
      info.usage_error.len ||
      info.usage_needs_consent
        ? usage({
            limits: info.limits,
            spend: info.spend,
            fetched_at: info.usage_fetched_at || null,
            error: info.usage_error.text() || null,
            needs_consent: info.usage_needs_consent,
          })
        : null,
  };
}
export function read(value: unknown): Identity | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id || v.id.length > 4096 || /[\x00-\x1f\x7f]/.test(v.id)) return null;
  if (typeof v.name !== "string" || v.name.length > 160 || /[\x00-\x1f\x7f]/.test(v.name)) return null;
  if (v.directory !== null && (typeof v.directory !== "string" || !v.directory.startsWith("/"))) return null;
  return {
    id: v.id,
    name: v.name,
    directory: v.directory,
    loginId: label(v.loginId, 4096),
    email: label(v.email),
    type: type(v.type),
    plan: label(v.plan),
    usage: usage(v.usage),
  };
}
