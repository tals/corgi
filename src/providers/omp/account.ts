//! Subscription limits for the model provider signed in through omp, as `omp usage` reads them.
import * as discovery from "../../discovery";
import { Failure } from "../../failure";
import { getLogger } from "../../log";
import { Quit, run } from "../../subprocess";
import { Info, Text, Window, windows } from "../../usage/account";
import { Cache, cooldown } from "../../usage/account_cache";
import { field, str } from "../common";
import * as codexPlan from "../codex/plan";
import { credential, defaultProvider, identity } from "./accounts";
import { directory } from "./integration";

const log = getLogger("omp.account");
function window(limit: unknown): { ms: number; window: Window } | null {
  const amount = field(limit, "amount"),
    span = field(limit, "window"),
    fraction = field(amount, "usedFraction"),
    ms = field(span, "durationMs"),
    reset = field(span, "resetsAt");
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  const known = typeof ms === "number" && Number.isFinite(ms) && ms > 0;
  return {
    ms: known ? ms : Infinity,
    window: new Window({
      minutes: known ? Math.round(ms / 60000) : null,
      used: Math.round(fraction * 100),
      reset_at: typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? Math.floor(reset / 1000) : null,
    }),
  };
}
/** The shortest and longest of the report's limit windows, and its plan. */
export function applyUsage(info: Info, report: unknown, provider: string) {
  const limits = field(report, "limits"),
    found = (Array.isArray(limits) ? limits : [])
      .map(window)
      .filter(v => v !== null)
      .sort((a, b) => a.ms - b.ms);
  if (!found.length) throw Error("UsageUnavailable");
  info.limits = windows([found[0].window, found.length > 1 ? found[found.length - 1].window : null]);
  info.signed_in = true;
  const metadata = field(report, "metadata"),
    plan = str(metadata, "planType");
  if (plan) info.plan = provider === "openai-codex" ? codexPlan.label(plan) : new Text(plan.slice(0, 160));
}
/** The provider's report for the signed-in account, when omp reads several. */
export function report(value: unknown, provider: string, account: string) {
  const reports = field(value, "reports");
  const mine = (Array.isArray(reports) ? reports : []).filter(r => str(r, "provider") === provider);
  return mine.find(r => account && str(field(r, "metadata"), "accountId") === account) ?? mine[0] ?? null;
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
      provider = defaultProvider(root) || c?.provider || "",
      info = new Info();
    info.account = new Text(who && c?.provider === provider ? who.email : provider || "omp model selection");
    if (!c || c.provider !== provider) return info;
    info.plan = new Text(c.type === "oauth" ? "OAuth" : "API key");
    if (c.type !== "oauth" || this.quit.aborted || quit.aborted) return info;
    const stopping = new Quit(),
      abort = () => stopping.signal();
    quit.abortSignal.addEventListener("abort", abort, { once: true });
    this.quit.abortSignal.addEventListener("abort", abort, { once: true });
    try {
      // Folders signed in to one account share its reading.
      const cache = await Cache.open("omp", JSON.stringify([who?.id ?? root, provider]), stopping);
      try {
        const now = Math.floor(Date.now() / 1000);
        cache.state.info.account = info.account;
        if (!cache.state.info.plan.len) cache.state.info.plan = info.plan;
        if (max_age > 0 && (now < this.retry_at || now - cache.state.info.usage_fetched_at < max_age))
          return cache.state.display(now);
        try {
          const executable = await discovery.resolve("omp", "/tmp"),
            output = await run([executable, "usage", "--json", "--no-extensions", "--provider", provider], {
              cwd: "/tmp",
              env: { ...process.env, PI_CODING_AGENT_DIR: root },
              timeout_ms: 20000,
              max_output: 1024 * 1024,
              quit: stopping,
            });
          if (!output.ok()) throw Error("UsageUnavailable");
          const found = report(JSON.parse(output.stdout.toString()), provider, str(c.data, "accountId"));
          if (!found) throw Error("UsageUnavailable");
          applyUsage(info, found, provider);
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
