import { Text } from "../agents";
import type { Reading } from "./spend";
import type { Type } from "../account_identity";
export { Text };
/** Seconds a reading shows before it reads as stale: two idle reads apart,
 * so one failed read doesn't flag it. */
export const usage_max_age = 1200;
export type Limits = "none" | "metered" | "rate_limited" | { windows: [Window | null, Window | null] };
export function serializeLimits(value: Limits) {
  return typeof value === "string" ? { [value]: {} } : value;
}
export function restoreLimits(value: any): Limits {
  if (["none", "metered", "rate_limited"].includes(value)) return value;
  if (value && typeof value === "object") {
    for (const kind of ["none", "metered", "rate_limited"] as const) if (Object.hasOwn(value, kind)) return kind;
    if (Array.isArray(value.windows) && value.windows.length === 2)
      return {
        windows: value.windows.map((window: any) => (window === null ? null : new Window(window))) as [
          Window | null,
          Window | null,
        ],
      };
  }
  throw Error("InvalidLimits");
}
export class Info {
  signed_in: boolean | null = null;
  /** Structured identity, separate from the account column's fallback text. */
  email: string | null = null;
  type: Type | null = null;
  login_id: string | null = null;
  account = new Text();
  plan = new Text();
  limits: Limits = "none";
  spend: Reading | null = null;
  usage_fetched_at = 0;
  usage_error = new Text();
  usage_needs_consent = false;
  toJSON() {
    return { ...this, limits: serializeLimits(this.limits) };
  }
}
export class Window {
  minutes: number | null = null;
  used = 0;
  reset_at: number | null = null;
  constructor(v: Partial<Window> = {}) {
    Object.assign(this, v);
  }
  label() {
    const n = this.minutes;
    if (n === null || n <= 0) return "Window";
    return n % 1440 === 0 ? `${n / 1440}d` : n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  }
  countdown(now: number) {
    if (this.reset_at === null) return null;
    const seconds = Math.max(0, this.reset_at - now);
    if (!seconds) return "now";
    const m = Math.ceil(seconds / 60),
      days = Math.floor(m / 1440),
      hours = Math.floor(m / 60) % 24,
      mins = m % 60;
    if (days) return `${days}d` + (hours ? ` ${hours}h` : mins ? ` ${mins}m` : "");
    if (hours) return `${hours}h` + (mins ? ` ${mins}m` : "");
    return `${mins}m`;
  }
}
export function expired(fetched_at: number, now: number) {
  return fetched_at <= 0 || Math.max(0, now - fetched_at) >= usage_max_age;
}
/** A window's percent used, rounded, if `value` is one. */
export function used(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}
export function windows(pair: [Window | null, Window | null]): Limits {
  return pair.every(v => v === null) ? "none" : { windows: pair };
}

export function resetCountdown(reset_at: number, now: number) {
  return new Window({ reset_at }).countdown(now)!;
}
