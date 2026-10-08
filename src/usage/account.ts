import { Provider } from "../providers";
import { Text } from "../agents";
import { Claude } from "../providers/claude";
import { Codex } from "../providers/codex";
import { field, str, timestampMs } from "../providers/common";
export { Text };
export const usage_max_age = 600;
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
  account = new Text();
  plan = new Text();
  limits: Limits = "none";
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
export function limits(value: any, provider: Provider): Limits {
  const f = Provider.info(provider).limits;
  const windows = f.windows.map((name: string, i: number) => {
    const v = field(value, name),
      used = field(v, f.used);
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
    const reported = field(v, "windowDurationMins"),
      minutes = f.minutes?.[i] ?? (Number.isInteger(reported) && reported > 0 ? reported : null);
    let reset_at: number | null = null;
    if (f.reset === "unix_seconds") {
      const n = field(v, "resetsAt");
      if (Number.isInteger(n) && n > 0) reset_at = n;
    } else {
      let raw = str(v, "resets_at"),
        offset = 0;
      const m = raw.match(/([+-])(\d{2}):(\d{2})$/);
      if (m) {
        if (Number(m[2]) > 23 || Number(m[3]) > 59) return new Window({ minutes, used: Math.round(used) });
        offset = (Number(m[2]) * 60 + Number(m[3])) * 60 * (m[1] === "-" ? -1 : 1);
        raw = raw.slice(0, -6) + "Z";
      }
      const stamp = timestampMs(raw);
      if (stamp !== null) reset_at = Math.floor(stamp / 1000) - offset;
    }
    return new Window({ minutes, used: Math.round(used), reset_at });
  }) as [Window | null, Window | null];
  return windows.every(v => v === null) ? "none" : { windows };
}
export function codexAccount(value: any) {
  const info = new Info(),
    email = str(value, "email"),
    api = str(value, "type") === "apiKey";
  info.signed_in = value !== null;
  info.account = new Text(api ? "API key" : email || (!value ? "Not signed in" : "Signed in"));
  info.plan = api ? new Text("API") : Codex.plan(str(value, "planType"));
  if (api) info.limits = "metered";
  return info;
}
export function claudeAccount(value: any) {
  const info = new Info(),
    logged = field(value, "loggedIn");
  if (typeof logged !== "boolean") return info;
  info.signed_in = logged;
  const method = str(value, "authMethod"),
    api = ["api_key", "api_key_helper"].includes(method),
    external = method === "third_party",
    email = str(value, "email");
  info.account = new Text(
    !logged ? "Not signed in" : api ? "API key" : external ? "External provider" : email || "Signed in",
  );
  if (logged) {
    info.plan = api ? new Text("API") : Claude.plan(str(value, "subscriptionType"), "");
    if (api || external) info.limits = "metered";
  }
  return info;
}

export function resetCountdown(reset_at: number, now: number) {
  return new Window({ reset_at }).countdown(now)!;
}
