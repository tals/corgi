import * as discovery from "../discovery";
import { run as subprocessRun, type Quit } from "../subprocess";
import { Provider, Text } from "../providers";
import { Claude } from "../providers/claude";
import { str } from "../providers/common";
import { Info, claudeAccount, limits } from "../usage/account";
import { Control, cancelled } from "./control";
import { Cache, interval, cooldown } from "../usage/account_cache";
export function applyUsage(info: Info, value: any) {
  if (typeof value?.rate_limits_available !== "boolean") throw Error("InvalidUsage");
  if (!value.rate_limits_available) throw Error("UsageUnavailable");
  const quota = limits(value.rate_limits, "claude");
  if (quota === "none") throw Error("InvalidUsage");
  info.limits = quota;
  info.usage_error = new Text();
  if (typeof value.subscription_type === "string" && value.subscription_type)
    info.plan = Claude.plan(value.subscription_type, "");
}
/** The model the picker's "default" entry resolves to. */
export function defaultModel(value: any): string {
  const models = value && typeof value === "object" && Array.isArray(value.models) ? value.models : [];
  for (const model of models) if (str(model, "value") === "default") return str(model, "resolvedModel");
  return "";
}
export class Client {
  session: Control | null = null;
  cursor = 0n;
  next_id = 0n;
  identity: string | null = null;
  account = new Info();
  next_auth = 0;
  next_usage = 0;
  /** The model Claude Code runs when none is configured, as its picker
   * resolves "default"; empty until read. */
  default_model = new Text();
  default_checked = false;
  close() {
    this.session?.close();
    this.session = null;
    this.cursor = 0n;
  }
  async preview(stopping?: any, quit?: Quit) {
    try {
      return await this.read(stopping, quit);
    } catch (e) {
      this.account.usage_error = new Text(
        ["TimedOut", "Timeout"].includes((e as Error).message) ? "request timed out" : "Claude account unavailable",
      );
      return this.account;
    }
  }
  async read(stopping?: any, quit?: Quit) {
    const now = Math.floor(Date.now() / 1000);
    if (cancelled(stopping) || quit?.aborted) throw Error("Cancelled");
    const executable = await discovery.resolve("claude", null);
    if (!executable) throw Error("FileNotFound");
    if (now >= this.next_auth) {
      this.next_auth = now + 60;
      this.account = new Info();
      const output = await subprocessRun([executable, "auth", "status", "--json"], {
        cwd: "/tmp",
        timeout_ms: 5000,
        max_output: 16384,
        quit,
      });
      const stdout = output.stdout.toString(),
        exit = "exited" in output.term ? output.term.exited : -1;
      let d: any;
      try {
        d = JSON.parse(stdout);
      } catch (error) {
        this.close();
        throw error;
      }
      const account = claudeAccount(d);
      if (account.signed_in === null || (exit !== 0 && !(exit === 1 && account.signed_in === false))) {
        this.close();
        throw Error("InvalidAccount");
      }
      if (account.signed_in === true && account.limits !== "metered" && !d.email)
        account.usage_error = new Text("usage account unavailable");
      const identity = JSON.stringify({
        executable,
        root: Provider.info("claude").configDir(),
        email: d.email ?? "",
        organization: d.orgId ?? "",
        method: d.authMethod ?? "",
        provider: d.apiProvider ?? "",
      });
      if (this.identity !== identity) {
        this.close();
        this.identity = identity;
        this.next_usage = 0;
        this.default_model = new Text();
        this.default_checked = false;
      }
      this.account = account;
    }
    if (this.account.signed_in === true && !this.default_checked && this.session === null) {
      this.default_checked = true;
      try {
        await this.start(executable, stopping, quit, Date.now() + 5000);
      } catch {
        this.close();
      }
    }
    if (this.account.signed_in !== true || this.account.limits === "metered" || this.account.usage_error.len) {
      this.close();
      return this.account;
    }
    const cache = await Cache.open("claude-cli", this.identity!, stopping);
    try {
      cache.state.info.signed_in = this.account.signed_in;
      cache.state.info.account = this.account.account;
      if (this.account.plan.len) cache.state.info.plan = this.account.plan;
      if (now < cache.state.next_usage) return cache.state.display(now);
      cache.state.next_usage = now + interval;
      cache.save();
      const fresh = Object.assign(new Info(), this.account);
      try {
        if (this.session === null) await this.start(executable, stopping, quit, Date.now() + 5000);
        applyUsage(fresh, await this.session!.request("get_usage", {}, { stopping, quit }));
      } catch (e) {
        this.close();
        fresh.usage_error = new Text(
          (e as Error).message === "Timeout"
            ? "request timed out"
            : (e as Error).message === "UnsupportedUsage"
              ? "Claude usage request unsupported"
              : (e as Error).message === "UsageUnavailable"
                ? "usage unavailable for this login"
                : "Claude usage unavailable",
        );
        cache.state.next_usage = now + cooldown;
      }
      cache.state.update(fresh, now);
      cache.save();
      return cache.state.display(now);
    } finally {
      cache.close();
    }
  }
  /** Starts the control session; its initialize reply names the default model. */
  private async start(executable: string, stopping: any, quit: Quit | undefined, deadline: number) {
    this.session = new Control("claude", executable);
    const initialized = await this.session.ready({ stopping, quit, deadline });
    const model = defaultModel(initialized);
    if (model) this.default_model = new Text(model);
  }
}
