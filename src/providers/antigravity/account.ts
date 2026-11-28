//! Subscription limits for Google Antigravity CLI, read via `agy -p /usage --output-format json`.
import { join } from "node:path";
import * as discovery from "../../discovery";
import * as errors from "../../errors";
import { Failure } from "../../failure";
import { getLogger } from "../../log";
import { Quit, run } from "../../subprocess";
import { Info, Text, Window, used, windows, type Limits } from "../../usage/account";
import { Cache, cooldown } from "../../usage/account_cache";
import { field, planLabel, str, timestampMs } from "../common";
import { directory, identity, read } from "./config";

const log = getLogger("antigravity.account");

function windowMinutes(value: string): number | null {
  const s = value.trim().toLowerCase();
  switch (s) {
    case "weekly":
    case "week":
      return 10080;
    case "daily":
    case "day":
      return 1440;
    case "hourly":
    case "hour":
      return 60;
    default: {
      const m = /^(\d+)(m|h|d|w)$/.exec(s);
      if (!m) return null;
      const n = Number(m[1]);
      if (!Number.isSafeInteger(n) || n <= 0) return null;
      const unit = { m: 1, h: 60, d: 1440, w: 10080 }[m[2] as "m" | "h" | "d" | "w"];
      return n * unit;
    }
  }
}

function resetAt(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return null;
  let offset = 0;
  if (m[3] !== "Z") {
    const hours = Number(m[5]),
      mins = Number(m[6]);
    if (hours > 23 || mins > 59) return null;
    offset = (hours * 60 + mins) * 60 * (m[4] === "-" ? -1 : 1);
  }
  const frac = m[2] ? "." + m[2].slice(0, 3).padEnd(3, "0") : "",
    stamp = timestampMs(m[1] + frac + "Z");
  if (stamp === null) return null;
  const seconds = Math.floor(stamp / 1000) - offset;
  return seconds > 0 ? seconds : null;
}

function bucketWindow(bucket: unknown): { id: string; minutes: number | null; window: Window } | null {
  if (field(bucket, "disabled") === true) return null;
  const remaining = field(bucket, "remaining_fraction");
  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) return null;
  const percent = used((1 - remaining) * 100);
  if (percent === null) return null;
  const id = str(bucket, "id"),
    span = str(bucket, "window") || id.split("-").at(-1) || "",
    minutes = windowMinutes(span);
  return {
    id,
    minutes,
    window: new Window({
      minutes,
      used: percent,
      reset_at: resetAt(field(bucket, "reset_time")),
    }),
  };
}

function normalizeModel(name: string): string {
  return name
    .trim()
    .replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, "")
    .replace(/-(?:low|medium|high|xhigh|max)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function listedModels(description: string): string[] {
  const colon = description.indexOf(":");
  if (colon < 0) return [];
  return description
    .slice(colon + 1)
    .split(",")
    .map(normalizeModel)
    .filter(Boolean);
}

type Group = {
  name: string;
  models: string[];
  ids: string[];
  quota: Limits;
};

function parseGroup(value: unknown): Group | null {
  const raw = field(value, "buckets"),
    found = (Array.isArray(raw) ? raw : [])
      .map(bucketWindow)
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  if (!found.length) return null;
  const last = found.findLast(b => b.minutes !== null) ?? found[found.length - 1],
    quota = windows([found[0].window, last === found[0] ? null : last.window]);
  if (quota === "none") return null;
  return {
    name: str(value, "name").toLowerCase(),
    models: listedModels(str(value, "description")),
    ids: found.map(b => b.id.toLowerCase()),
    quota,
  };
}

function isGeminiGroup(group: Group): boolean {
  return group.name.includes("gemini") || group.ids.some(id => id.startsWith("gemini-"));
}

function isPartnerGroup(group: Group): boolean {
  return group.name.includes("claude") || group.name.includes("gpt") || group.ids.some(id => id.startsWith("3p-"));
}

function selectGroup(groups: Group[], model: string): Group {
  const target = normalizeModel(model);
  if (target) {
    const exact = groups.find(group => group.models.includes(target));
    if (exact) return exact;
    if (/\b(?:claude|gpt)\b/.test(target)) {
      const partner = groups.find(isPartnerGroup);
      if (partner) return partner;
    }
    if (/\b(?:gemini|orchestrator)\b/.test(target)) {
      const gemini = groups.find(isGeminiGroup);
      if (gemini) return gemini;
    }
  }
  return groups.find(isGeminiGroup) ?? groups[0];
}

/** Applies the structured `agy -p /usage --output-format json` payload for `model`'s quota group. */
export function applyUsage(info: Info, value: unknown, model = "") {
  if (str(value, "status") !== "SUCCESS") throw Error("UsageUnavailable");
  const command = field(value, "command"),
    name = str(command, "name");
  if (name !== "usage" && name !== "quota") throw Error("UsageUnavailable");
  const data = field(command, "data"),
    raw = field(data, "groups");
  if (!Array.isArray(raw)) throw Error("UsageUnavailable");
  const groups = raw.map(parseGroup).filter((g): g is Group => g !== null);
  if (!groups.length) throw Error("UsageUnavailable");
  const chosen = selectGroup(groups, model);
  info.limits = chosen.quota;
  info.signed_in = true;
  info.usage_error = new Text();
  const tier = str(data, "plan_tier") || str(data, "plan");
  if (tier) info.plan = planLabel(tier);
}

function failureMessage(error: unknown): string {
  switch (errors.name(error)) {
    case "TimedOut":
    case "Timeout":
      return "request timed out";
    default:
      return "usage request failed";
  }
}

export class Client {
  private quit = new Quit();
  private failure = new Failure();
  /** When this folder may try again after its usage read failed. */
  private retry_at = 0;
  /** When an uncached sign-in probe may run again. */
  private next_auth = 0;
  constructor(readonly account = "") {}
  close() {
    this.quit.signal();
  }
  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.account ? { HOME: this.account } : {}),
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    };
    delete env.CORGI_PANE;
    delete env.CORGI_SOCKET;
    return env;
  }
  /** Checks whether `agy` has a usable login without triggering an interactive OAuth flow. */
  private async checkAuth(executable: string, stopping: Quit): Promise<boolean | null> {
    const reply = await run([executable, "models"], {
      cwd: "/tmp",
      env: this.env(),
      timeout_ms: 8000,
      max_output: 128 * 1024,
      stderr: true,
      quit: stopping,
    });
    if (reply.ok()) {
      const hasModel = reply.stdout
        .toString()
        .split(/\r?\n/)
        .some(line => /^[\w.-]+\t\S/.test(line));
      return hasModel ? true : null;
    }
    if (/please sign in|not authenticated|unauthenticated|authentication required/i.test(reply.stderr.toString()))
      return false;
    throw Error("UsageUnavailable");
  }
  private async fetchUsage(executable: string, stopping: Quit): Promise<unknown> {
    let auth_required = false,
      stderr_tail = "";
    const inner = new Quit(),
      relay = () => inner.signal();
    stopping.abortSignal.addEventListener("abort", relay, { once: true });
    if (stopping.aborted) inner.signal();
    try {
      const output = await run(
        [executable, "-p", "/usage", "--output-format", "json", "--settings", '{"disableSlashCommands":false}'],
        {
          cwd: "/tmp",
          env: this.env(),
          timeout_ms: 20000,
          max_output: 256 * 1024,
          stderr: true,
          quit: inner,
          on_output(bytes, stream) {
            if (stream !== "stderr" || auth_required) return;
            stderr_tail = (stderr_tail + bytes.toString()).slice(-4096);
            if (/authentication required|waiting for authentication/i.test(stderr_tail)) {
              auth_required = true;
              inner.signal();
            }
          },
        },
      );
      if (auth_required) throw Error("AuthRequired");
      if (!output.ok()) throw Error("UsageUnavailable");
      return JSON.parse(output.stdout.toString());
    } catch (error) {
      if (auth_required) throw Error("AuthRequired");
      throw error;
    } finally {
      stopping.abortSignal.removeEventListener("abort", relay);
    }
  }
  async preview(quit: Quit, max_age = 0, cwd = "/tmp"): Promise<Info> {
    const root = directory(this.account),
      [settings, login] = await Promise.all([read(join(root, "settings.json")), identity(this.account)]),
      provider = str(settings, "modelProvider"),
      model = str(settings, "model"),
      info = new Info();
    if (provider === "gemini") {
      if (process.env.GEMINI_API_KEY) {
        info.signed_in = true;
        info.account = new Text("API key");
        info.plan = new Text("API");
        info.limits = "metered";
      } else {
        info.signed_in = false;
        info.account = new Text("Not signed in");
      }
      return info;
    }
    if (login) {
      info.signed_in = true;
      info.account = new Text(login.email);
    }
    if (this.quit.aborted || quit.aborted) return info;
    const stopping = new Quit(),
      abort = () => stopping.signal();
    quit.abortSignal.addEventListener("abort", abort, { once: true });
    this.quit.abortSignal.addEventListener("abort", abort, { once: true });
    try {
      const cache = await Cache.open("antigravity", JSON.stringify([login?.id ?? root, model]), stopping);
      try {
        const now = Math.floor(Date.now() / 1000);
        if (login) {
          cache.state.info.signed_in = true;
          cache.state.info.account = info.account;
        } else if (max_age > 0 && now < this.next_auth && cache.state.info.signed_in !== true) {
          return cache.state.display(now);
        }
        if (
          max_age > 0 &&
          (now < this.retry_at ||
            (cache.state.info.signed_in === true && now - cache.state.info.usage_fetched_at < max_age))
        )
          return cache.state.display(now);
        try {
          const executable = await discovery.resolve("antigravity", cwd);
          const authed = await this.checkAuth(executable, stopping);
          this.next_auth = Math.floor(Date.now() / 1000) + 60;
          if (authed === false) {
            info.signed_in = false;
            info.account = new Text("Not signed in");
            info.limits = "none";
            cache.state.update(info, Math.floor(Date.now() / 1000));
            cache.save();
            return cache.state.display(Math.floor(Date.now() / 1000));
          }
          if (authed !== true) {
            if (!login) return info;
            throw Error("UsageUnavailable");
          }
          if (!login) {
            info.signed_in = true;
            info.account = new Text("Signed in");
          }
          applyUsage(info, await this.fetchUsage(executable, stopping), model);
          cache.state.update(info, Math.floor(Date.now() / 1000));
          if (this.failure.clear()) log.info("Usage read recovered", { account: this.account });
        } catch (error) {
          if (stopping.aborted) return cache.state.display(Math.floor(Date.now() / 1000));
          if (errors.is(error, "AuthRequired")) {
            info.signed_in = false;
            info.account = new Text("Not signed in");
            info.limits = "none";
            cache.state.update(info, Math.floor(Date.now() / 1000));
            cache.save();
            return cache.state.display(Math.floor(Date.now() / 1000));
          }
          if (!login && cache.state.info.signed_in !== true) {
            this.next_auth = Math.floor(Date.now() / 1000) + 60;
            return info;
          }
          cache.state.failed(failureMessage(error));
          this.retry_at = now + cooldown;
          if (this.failure.changed(error)) log.warn("Usage read failed", { account: this.account, err: error });
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
