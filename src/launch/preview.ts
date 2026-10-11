import { Quit } from "../subprocess";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Provider, Each, Text } from "../providers";
import { Model } from "../providers/model";
import { Info, codexAccount, limits, serializeLimits } from "../usage/account";
import { none, update as updateLimitHistory } from "../usage/limits";
import { Pool } from "../inference";
import { Client } from "./claude";
import { Cache, interval } from "../usage/account_cache";
import * as discovery from "../discovery";
import * as errors from "../errors";
export { Text };
export class Option {
  signed_in: boolean | null = null;
  model = new Text();
  model_name = new Text();
  source = new Text();
  account = new Text();
  plan = new Text();
  limits: Info["limits"] = "none";
  usage_fetched_at = 0;
  usage_error = new Text();
  usage_needs_consent = false;
  history = none();
  toJSON() {
    return { ...this, limits: serializeLimits(this.limits) };
  }
  modelLabel() {
    return this.model_name.len ? this.model_name.text() : this.model.text();
  }
  setModel(model: string, source: string) {
    this.model = new Text(model);
    this.model_name = Model.resolve(model).name;
    this.source = new Text(source);
  }
}
export class Preview {
  pending = true;
  options = new Each(new Option(), {
    codex: new Option(),
    claude: new Option(),
  });
  installed = new Each(true);
}
export function installed() {
  const result = new Each(true);
  for (const p of Provider.all) result.set(p, discovery.installed(p));
  return result;
}
export function applyModel(out: Option, value: any, source: string) {
  if (typeof value?.model === "string" && value.model) out.setModel(value.model, source);
}
function readModel(out: Option, root: string, relative: string, source: string) {
  try {
    const file = join(root, relative),
      s = statSync(file);
    if (!s.isFile() || s.size > 1024 * 1024) return;
    applyModel(out, JSON.parse(readFileSync(file, "utf8")), source);
  } catch {}
}
export function claudeModel(cwd: string) {
  const out = new Option();
  out.source = new Text("Account default / provider selection");
  try {
    readModel(out, Provider.info("claude").configDir(), "settings.json", "User settings");
  } catch {}
  readModel(out, cwd, ".claude/settings.json", "Project settings (if trusted)");
  readModel(out, cwd, ".claude/settings.local.json", "Local settings (if trusted)");
  if (process.env.ANTHROPIC_MODEL) out.setModel(process.env.ANTHROPIC_MODEL, "ANTHROPIC_MODEL");
  readModel(out, "/Library/Application Support/ClaudeCode", "managed-settings.json", "Managed settings");
  return out;
}
export class Worker {
  quit = Quit.init();
  stopping = false;
  running = false;
  private pending: Promise<void> | null = null;
  jobs: {
    cwd: string;
    preview: Preview;
    updated: number;
    used: number;
    queued: boolean;
    accessing: boolean;
    request_access: boolean;
  }[] = [];
  pool = new Pool({ config: { provider: "codex", timeout_ms: 5000 } });
  claude_client = new Client();
  accounts = new Map<string, { at: number; info: Info }>();
  static start() {
    return new Worker();
  }
  async stop() {
    this.stopping = true;
    this.quit.signal();
    this.pool.close();
    this.claude_client.close();
    await this.pending;
  }
  preview(cwd: string) {
    return this.request(cwd, false);
  }
  trackUsage(cwd: string) {
    return this.request(cwd, true);
  }
  request(cwd: string, access: boolean) {
    if (Buffer.byteLength(cwd) > 4096) return new Preview();
    const now = Date.now();
    let job = this.jobs.find(j => j.cwd === cwd);
    if (job) {
      job.used = now;
      if ((now - job.updated > 60000 && !job.queued) || (access && !job.accessing && !job.request_access)) {
        job.queued = true;
        job.request_access ||= access;
        job.preview.pending = true;
        void this.pump();
      }
      return job.preview;
    }
    const preview = new Preview();
    preview.installed = installed();
    job = {
      cwd,
      preview,
      updated: 0,
      used: now,
      queued: true,
      accessing: false,
      request_access: access,
    };
    if (this.jobs.length >= 32)
      this.jobs.splice(
        this.jobs.reduce((best, j, i, a) => (j.used < a[best].used ? i : best), 0),
        1,
      );
    this.jobs.push(job);
    void this.pump();
    return preview;
  }
  pump(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.pending) return this.pending;
    const pending = this.drain();
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      })
      .catch(() => {});
    return pending;
  }
  private async drain() {
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs.find(job => job.queued);
        if (!job || this.stopping) break;
        await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }
  async run(job: Worker["jobs"][number]) {
    job.queued = false;
    job.accessing = job.request_access;
    job.request_access = false;
    const result = new Preview();
    result.pending = false;
    result.installed = installed();
    for (const p of Provider.all) {
      if (this.stopping) return;
      if (!result.installed.get(p)) continue;
      let out: Option;
      if (p === "claude") out = claudeModel(job.cwd);
      else {
        out = new Option();
        try {
          const model = await this.pool.configuredModel(job.cwd, this.quit.abortSignal);
          out.setModel(model.text(), "Effective Codex settings");
        } catch {
          out.source = new Text("Model resolved by Codex at startup");
        }
      }
      if (this.stopping) return;
      try {
        const account = p === "claude" ? await this.claude_client.preview(this, this.quit) : await this.codexAccount();
        for (const key of [
          "signed_in",
          "account",
          "plan",
          "limits",
          "usage_fetched_at",
          "usage_error",
          "usage_needs_consent",
        ] as const)
          (out as any)[key] = account[key];
        if (p === "claude" && out.model.len === 0 && this.claude_client.default_model.len > 0)
          out.setModel(this.claude_client.default_model.text(), "Claude Code default");
        out.history = await updateLimitHistory(p, account, this.stopping);
      } catch {
        out.usage_error = new Text("account read failed");
      }
      result.options.set(p, out);
    }
    if (this.jobs.includes(job)) {
      job.preview = result;
      job.preview.pending = job.queued;
      job.accessing = false;
      job.updated = Date.now();
    }
  }
  async codexAccount() {
    const root = Provider.info("codex").configDir();
    let auth: string;
    try {
      auth = readFileSync(join(root, "auth.json"), "utf8");
    } catch {
      auth = root;
    }
    const identity = auth + "\n" + (process.env.OPENAI_API_KEY ?? "");
    const cache = await Cache.open("codex", identity);
    try {
      const now = Math.floor(Date.now() / 1000);
      if (now < cache.state.next_usage) return cache.state.display(now);
      cache.state.next_usage = now + interval;
      cache.save();
      try {
        cache.state.update(await this.pool.configuredAccount(this.quit.abortSignal), Math.floor(Date.now() / 1000));
      } catch (e) {
        cache.state.failed(errors.is(e, "Timeout") ? "request timed out" : "account read failed");
      }
      cache.save();
      return cache.state.display(Math.floor(Date.now() / 1000));
    } finally {
      cache.close();
    }
  }
}
