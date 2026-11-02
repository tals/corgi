import * as discovery from "../../discovery";
import { run as subprocessRun, type Output, type Quit } from "../../subprocess";
import * as claude from "./index";
import { vocabulary } from "./info";
import { field, str, timestampMs, Text } from "../common";
import { Info, Window, used, windows } from "../../usage/account";
import { getLogger } from "../../log";
import { Failure } from "../../failure";
import { Control, cancelled } from "./control";
import { Cache, cooldown } from "../../usage/account_cache";
import * as errors from "../../errors";
import * as spend from "../../usage/spend";
const log = getLogger("claude.account");
function clip(output: Buffer, max = 600) {
  const text = output.toString();
  return text.length > max ? text.slice(0, max) + "…" : text;
}
function window(value: unknown, minutes: number) {
  const percent = used(field(value, "utilization"));
  if (percent === null) return null;
  let raw = str(value, "resets_at"),
    offset = 0;
  const m = raw.match(/([+-])(\d{2}):(\d{2})$/);
  if (m) {
    if (Number(m[2]) > 23 || Number(m[3]) > 59) return new Window({ minutes, used: percent });
    offset = (Number(m[2]) * 60 + Number(m[3])) * 60 * (m[1] === "-" ? -1 : 1);
    raw = raw.slice(0, -6) + "Z";
  }
  const stamp = timestampMs(raw);
  return new Window({ minutes, used: percent, reset_at: stamp === null ? null : Math.floor(stamp / 1000) - offset });
}
/** The limits in a usage reply's `rate_limits`. */
export function limits(value: unknown) {
  return windows([window(field(value, "five_hour"), 300), window(field(value, "seven_day"), 10080)]);
}
/** The account `claude auth status --json` reports. */
export function readAccount(value: any) {
  const info = new Info(),
    logged = field(value, "loggedIn");
  if (typeof logged !== "boolean") return info;
  info.signed_in = logged;
  const method = str(value, "authMethod"),
    api = ["api_key", "api_key_helper"].includes(method),
    external = method === "third_party",
    email = str(value, "email");
  info.email = logged && !api && !external ? email || null : null;
  info.type = !logged
    ? null
    : api
      ? "api_key"
      : external
        ? "external"
        : ["claude.ai", "oauth_token"].includes(method)
          ? "oauth"
          : null;
  info.account = new Text(
    !logged ? "Not signed in" : api ? "API key" : external ? "External provider" : email || "Signed in",
  );
  if (logged) {
    info.plan = api ? new Text("API") : claude.plan(str(value, "subscriptionType"), "");
    if (api || external) info.limits = "metered";
  }
  return info;
}
export function applyUsage(info: Info, value: any, now = Math.floor(Date.now() / 1000)) {
  if (typeof value?.rate_limits_available !== "boolean") throw Error("InvalidUsage");
  if (!value.rate_limits_available) throw Error("UsageUnavailable");
  const quota = limits(value.rate_limits);
  const extra = field(value.rate_limits, "extra_usage");
  const monthly = monthlySpend(extra, now);
  if (quota === "none" && monthly === null && field(extra, "is_enabled") !== false) throw Error("InvalidUsage");
  info.limits = quota === "none" ? "metered" : quota;
  info.spend = monthly;
  info.usage_error = new Text();
  if (typeof value.subscription_type === "string" && value.subscription_type)
    info.plan = claude.plan(value.subscription_type, "");
}
/** The SDK documents extra_usage amounts in minor currency units. Claude's
 * monthly spend limits reset on the first of the month at 00:00 UTC. */
function monthlySpend(value: unknown, now: number): spend.Reading | null {
  if (field(value, "is_enabled") !== true) return null;
  const currency = field(value, "currency");
  const exponent = field(value, "decimal_places") ?? spend.currencyExponent(currency);
  const date = new Date(now * 1000);
  return spend.restore({
    used_minor: field(value, "used_credits"),
    limit_minor: field(value, "monthly_limit"),
    currency,
    exponent,
    period_start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000,
    reset_at: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000,
  });
}
/** The model the picker's "default" entry resolves to. */
export function defaultModel(value: any): string {
  const models = value && typeof value === "object" && Array.isArray(value.models) ? value.models : [];
  for (const model of models) if (str(model, "value") === "default") return str(model, "resolvedModel");
  return "";
}
export class Client {
  /** `env` picks the account it reads. */
  constructor(readonly env: NodeJS.ProcessEnv = process.env) {
    this.config = env[vocabulary.config_env] ?? "";
  }
  private config: string;
  private resolve_failure = new Failure();
  private auth_failure = new Failure();
  private usage_failure = new Failure();
  session: Control | null = null;
  identity: string | null = null;
  /** Who signed in, without the folder: folders signed in to one account
   * share its usage reading. */
  login: string | null = null;
  /** When this folder may try again after its usage read failed. */
  retry_at = 0;
  account = new Info();
  next_auth = 0;
  /** The model Claude Code runs when none is configured, as its picker
   * resolves "default"; empty until read. */
  default_model = new Text();
  default_checked = false;
  /** The read-only initialization catalog, without starting a model turn. */
  async models(quit: Quit): Promise<{ info: Info; models: unknown }> {
    const executable = await this.resolve(),
      { account: info } = await this.auth(executable, quit);
    if (info.signed_in !== true) return { info, models: [] };
    this.session = new Control(executable, this.env);
    const initialized = await this.session.ready({ quit, deadline: Date.now() + 5000 });
    return { info, models: field(initialized, "models") };
  }
  close() {
    this.session?.close();
    this.session = null;
  }
  async preview(stopping?: any, quit?: Quit, max_age = 0) {
    try {
      return await this.read(stopping, quit, max_age);
    } catch (e) {
      this.account.usage_error = new Text(
        ["TimedOut", "Timeout"].includes((e as Error).message) ? "request timed out" : "Claude account unavailable",
      );
      return this.account;
    }
  }
  async read(stopping?: any, quit?: Quit, max_age = 0) {
    const now = Math.floor(Date.now() / 1000);
    if (cancelled(stopping) || quit?.aborted) throw Error("Cancelled");
    const executable = await this.resolve();
    if (now >= this.next_auth) {
      this.next_auth = now + 60;
      this.account = new Info();
      const { account, d } = await this.auth(executable, quit);
      if (account.signed_in === true && account.limits !== "metered" && !d.email)
        account.usage_error = new Text("usage account unavailable");
      const login = JSON.stringify({
          email: d.email ?? "",
          organization: d.orgId ?? "",
          method: d.authMethod ?? "",
          provider: d.apiProvider ?? "",
        }),
        identity = JSON.stringify([executable, claude.configDir(this.env), login]);
      this.login = login;
      if (this.identity !== identity) {
        this.close();
        this.identity = identity;
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
    const cache = await Cache.open("claude-cli", this.login!, stopping);
    try {
      cache.state.info.signed_in = this.account.signed_in;
      cache.state.info.account = this.account.account;
      cache.state.info.email = this.account.email;
      cache.state.info.type = this.account.type;
      if (this.account.plan.len) cache.state.info.plan = this.account.plan;
      if (max_age > 0 && (now < this.retry_at || now - cache.state.info.usage_fetched_at < max_age))
        return cache.state.display(now);
      const fresh = Object.assign(new Info(), this.account),
        started = Date.now();
      try {
        if (this.session === null) await this.start(executable, stopping, quit, Date.now() + 5000);
        applyUsage(fresh, await this.session!.request("get_usage", {}, { stopping, quit }), now);
        if (this.usage_failure.clear())
          log.info("Usage read recovered", { account: this.config, ms: Date.now() - started });
      } catch (e) {
        this.close();
        fresh.usage_error = new Text(usageFailure(e));
        this.retry_at = now + cooldown;
        if (!errors.is(e, "Cancelled") && this.usage_failure.changed(e))
          log.warn("Usage read failed", { account: this.config, ms: Date.now() - started, err: e });
      }
      cache.state.update(fresh, now);
      cache.save();
      return cache.state.display(now);
    } finally {
      cache.close();
    }
  }
  private async resolve() {
    const started = Date.now();
    try {
      const executable = await discovery.resolve("claude", null);
      if (!executable) throw Error("FileNotFound");
      if (this.resolve_failure.clear())
        log.info("Executable resolution recovered", { account: this.config, ms: Date.now() - started });
      return executable;
    } catch (error) {
      if (!errors.is(error, "Cancelled") && this.resolve_failure.changed(error))
        log.warn("Executable resolution failed", { account: this.config, ms: Date.now() - started, err: error });
      throw error;
    }
  }
  /** The account `claude auth status` reports, and its reply. */
  private async auth(executable: string, quit?: Quit) {
    let output: Output | null = null;
    const started = Date.now();
    try {
      output = await subprocessRun([executable, "auth", "status", "--json"], {
        cwd: "/tmp",
        env: this.env,
        timeout_ms: 5000,
        max_output: 16384,
        stderr: true,
        quit,
      });
      const exit = "exited" in output.term ? output.term.exited : -1,
        d = JSON.parse(output.stdout.toString()),
        account = readAccount(d);
      if (account.signed_in === null || (exit !== 0 && !(exit === 1 && account.signed_in === false)))
        throw Error("InvalidAccount");
      if (this.auth_failure.clear())
        log.info("Authentication read recovered", { account: this.config, ms: Date.now() - started });
      return { account, d };
    } catch (error) {
      this.close();
      const printed = output && { term: output.term, stdout: clip(output.stdout), stderr: clip(output.stderr) };
      if (!errors.is(error, "Cancelled") && this.auth_failure.changed(error))
        log.warn("Authentication read failed", {
          account: this.config,
          ms: Date.now() - started,
          err: error,
          executable,
          ...printed,
        });
      throw error;
    }
  }
  /** Starts the control session; its initialize reply names the default model. */
  private async start(executable: string, stopping: any, quit: Quit | undefined, deadline: number) {
    this.session = new Control(executable, this.env);
    const initialized = await this.session.ready({ stopping, quit, deadline });
    const model = defaultModel(initialized);
    if (model) this.default_model = new Text(model);
  }
}
function usageFailure(error: unknown): string {
  switch (errors.name(error)) {
    case "Timeout":
      return "request timed out";
    case "UnsupportedUsage":
      return "Claude usage request unsupported";
    case "UsageUnavailable":
      return "usage unavailable for this login";
    default:
      return "Claude usage unavailable";
  }
}
