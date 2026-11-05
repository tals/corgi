import { field, str, Text } from "../common";
import { Info, Window, used, windows } from "../../usage/account";
import * as spend from "../../usage/spend";
import { plan } from "./index";
/** The account an app server's `account/read` reports. */
export function account(value: any) {
  const info = new Info(),
    email = str(value, "email"),
    api = str(value, "type") === "apiKey";
  info.signed_in = value !== null;
  info.email = api ? null : email || null;
  info.type = api ? "api_key" : str(value, "type") === "chatgpt" ? "oauth" : null;
  info.account = new Text(api ? "API key" : email || (!value ? "Not signed in" : "Signed in"));
  info.plan = api ? new Text("API") : plan(str(value, "planType"));
  if (api) info.limits = "metered";
  return info;
}
function window(value: unknown) {
  const percent = used(field(value, "usedPercent"));
  if (percent === null) return null;
  const minutes = field(value, "windowDurationMins"),
    reset = field(value, "resetsAt");
  return new Window({
    minutes: Number.isInteger(minutes) && minutes > 0 ? minutes : null,
    used: percent,
    reset_at: Number.isInteger(reset) && reset > 0 ? reset : null,
  });
}
/** The limits in an `account/rateLimits/read` reply's snapshot. */
export function limits(value: unknown) {
  return windows([window(field(value, "primary")), window(field(value, "secondary"))]);
}
/** Hundredths of a credit, from the decimal string Codex reports. */
function credits(value: unknown) {
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Math.round(Number(value) * 100) : null;
}
/** A snapshot's `individualLimit`, which Codex's /status shows as its
 * "Monthly credit limit". It reports the reset; the period is the month before. */
export function monthlySpend(value: unknown): spend.Reading | null {
  const used = credits(field(value, "used")),
    limit = credits(field(value, "limit")),
    reset = field(value, "resetsAt");
  if (used === null || limit === null || !Number.isSafeInteger(reset)) return null;
  // A reset on the 31st follows a period from the last day of a shorter month.
  const end = new Date(reset * 1000),
    last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0)),
    day = Math.min(end.getUTCDate(), last.getUTCDate());
  return spend.restore({
    used_minor: used,
    limit_minor: limit,
    currency: null,
    exponent: 2,
    period_start: Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), day) / 1000 + (reset % 86400),
    reset_at: reset,
  });
}
