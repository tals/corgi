//! Subscription limits for the model provider signed in through Pi.
import * as discovery from "../../discovery";
import { Failure } from "../../failure";
import { getLogger } from "../../log";
import { Quit, run } from "../../subprocess";
import { Info, Text, Window, used, windows } from "../../usage/account";
import { Cache, cooldown } from "../../usage/account_cache";
import { cached } from "../command_line";
import { field, str } from "../common";
import * as codexPlan from "../codex/plan";
import { credential, identity } from "./accounts";
import { directory } from "./integration";

const log = getLogger("pi.account");
function window(value: unknown) {
  const percent = used(field(value, "used_percent"));
  if (percent === null) return null;
  const seconds = field(value, "limit_window_seconds"),
    reset = field(value, "reset_at");
  return new Window({
    minutes: typeof seconds === "number" && Number.isInteger(seconds) && seconds > 0 ? seconds / 60 : null,
    used: percent,
    reset_at: typeof reset === "number" && Number.isInteger(reset) && reset > 0 ? reset : null,
  });
}
/** The ChatGPT subscription shared by Pi and Codex. */
export function applyUsage(info: Info, value: unknown) {
  const limits = field(value, "rate_limit"),
    quota = windows([window(field(limits, "primary_window")), window(field(limits, "secondary_window"))]);
  if (quota === "none") throw Error("UsageUnavailable");
  info.limits = quota;
  info.signed_in = true;
  const plan = str(value, "plan_type");
  if (plan) info.plan = codexPlan.label(plan);
}
export class Client {
  private quit = new Quit();
  private failure = new Failure();
  /** When this folder may try again after its usage read failed. */
  private retry_at = 0;
  constructor(readonly account = "") {}
  close() {
    this.quit.signal();
  }
  async preview(quit: Quit, max_age = 0) {
    const root = directory(this.account),
      c = credential(root),
      who = identity(root),
      provider = str(cached(root, "settings.json"), "defaultProvider") || c?.provider || "",
      info = new Info();
    info.account = new Text(who && c?.provider === provider ? who.email : provider);
    if (!c || c.provider !== provider) return info;
    info.plan = new Text(c.type === "oauth" ? "OAuth" : "API key");
    // Other providers do not share ChatGPT's subscription endpoint.
    if (provider !== "openai-codex" || c.type !== "oauth" || this.quit.aborted || quit.aborted) return info;
    const stopping = new Quit(),
      abort = () => stopping.signal();
    quit.abortSignal.addEventListener("abort", abort, { once: true });
    this.quit.abortSignal.addEventListener("abort", abort, { once: true });
    try {
      // Folders signed in to one account share its reading.
      const cache = await Cache.open("pi", JSON.stringify([who?.id ?? root, provider]), stopping);
      try {
        const now = Math.floor(Date.now() / 1000);
        cache.state.info.account = info.account;
        if (!cache.state.info.plan.len) cache.state.info.plan = info.plan;
        if (max_age > 0 && (now < this.retry_at || now - cache.state.info.usage_fetched_at < max_age))
          return cache.state.display(now);
        try {
          const executable = await discovery.resolve("pi", "/tmp"),
            output = await run([executable, "auth", "print-bearer-token", "--provider", provider], {
              cwd: "/tmp",
              env: { ...process.env, PI_CODING_AGENT_DIR: root },
              timeout_ms: 5000,
              max_output: 16384,
              quit: stopping,
            });
          const token = output.stdout.toString().trim();
          if (!output.ok() || !token) throw Error("CredentialUnavailable");
          const headers: Record<string, string> = { Authorization: `Bearer ${token}` },
            accountId = str(c.value, "accountId");
          if (accountId) headers["ChatGPT-Account-Id"] = accountId;
          const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
            headers,
            redirect: "error",
            signal: AbortSignal.any([stopping.abortSignal, AbortSignal.timeout(5000)]),
          });
          if (!response.ok) throw Error("UsageUnavailable");
          applyUsage(info, await response.json());
          cache.state.update(info, Math.floor(Date.now() / 1000));
          if (this.failure.clear()) log.info("Usage read recovered", { account: this.account });
        } catch {
          cache.state.failed("usage request failed");
          this.retry_at = now + cooldown;
          if (!stopping.aborted && this.failure.changed("UsageUnavailable"))
            log.warn("Usage read failed", { account: this.account });
        }
        cache.save();
        return cache.state.display(Math.floor(Date.now() / 1000));
      } finally {
        cache.close();
      }
    } finally {
      quit.abortSignal.removeEventListener("abort", abort);
      this.quit.abortSignal.removeEventListener("abort", abort);
    }
  }
}
