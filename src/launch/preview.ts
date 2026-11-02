import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Quit } from "../subprocess";
import { Provider, adapter, byProvider, Text } from "../providers";
import type { Launcher } from "../providers/adapter";
import { Model } from "../providers/model";
import { Info, serializeLimits } from "../usage/account";
import * as limitHistory from "../usage/limits";
import * as discovery from "../discovery";
import * as accounts from "../accounts";
export { Text };
/** Seconds between account reads while someone uses a viewer, and otherwise. */
export const active_every = 150,
  idle_every = 600;
/** How often the worker looks for an account due a read, in ms. */
const check_ms = 15000;
/** What a row shows of its account's read. */
const account_fields = [
  "signed_in",
  "account",
  "plan",
  "limits",
  "spend",
  "usage_fetched_at",
  "usage_error",
  "usage_needs_consent",
] as const;
export class Option {
  pending = true;
  signed_in: boolean | null = null;
  model = new Text();
  model_name = new Text();
  source = new Text();
  account = new Text();
  plan = new Text();
  limits: Info["limits"] = "none";
  spend: Info["spend"] = null;
  usage_fetched_at = 0;
  usage_error = new Text();
  usage_needs_consent = false;
  history = limitHistory.none();
  spend_history = limitHistory.noSpend();
  toJSON() {
    return { ...this, limits: serializeLimits(this.limits) };
  }
  modelLabel() {
    return this.model_name.len ? this.model_name.text() : this.model.text();
  }
  setModel(model: string, source: string, name = "") {
    this.model = new Text(model);
    this.model_name = name ? new Text(name) : Model.resolve(model).name;
    this.source = new Text(source);
  }
}
export class Preview {
  pending = true;
  options = byProvider(() => new Option());
  installed = byProvider(() => true);
  /** The version of each agent too old to count as installed, or "". */
  outdated = byProvider(() => "");
  /** What each default account is called; "" for one that goes by its agent's name. */
  names = byProvider(() => "");
  /** The accounts besides each default, with what their option reads. */
  accounts: Account[] = [];
  with(fields: Partial<Preview>): Preview {
    return Object.assign(Object.create(Preview.prototype), this, fields);
  }
}
/** An account Corgi knows, as the launcher lists it. */
export type Account = { provider: Provider; account: string; name: string; managed: boolean; option: Option };
export function installed() {
  return byProvider(p => discovery.installed(p));
}
type Row = { provider: Provider; account: string };
/** The folders of one provider signed in to one account. */
type Group = { provider: Provider; id: string; folders: string[] };
/** An account, which several folders may be signed in to. Its usage is read
 * through one of them, the one that worked last; the rest only read their
 * sign-in. */
class Login {
  /** When this worker last read it, in ms. */
  read_at = 0;
  /** Someone asked for its usage: the next read fetches it, whatever its age. */
  forced = false;
  reading: Promise<void> | null = null;
  /** The folder whose read worked last. */
  source: string | null = null;
  /** Each folder's own last read. */
  infos = new Map<string, Info>();
  history = limitHistory.none();
  spend = limitHistory.noSpend();
}
/** A fresh usage reading, which other folders of its account can show. */
function usable(info: Info) {
  return info.signed_in === true && info.usage_fetched_at > 0 && !info.usage_error.len;
}
/** Who signed in to `account`, or the folder itself when that's unknown. */
function loginOf(provider: Provider, account: string) {
  const id = accounts.identity(provider, account)?.id;
  return id ? `login:${id}` : `folder:${account}`;
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
  /** Each account's launcher, opened on first use. */
  launchers = new Map<string, Promise<Launcher | null>>();
  /** Accounts by provider and who signed in. */
  logins = new Map<string, Login>();
  /** Seconds between account reads, which the daemon sets from its viewers. */
  every = idle_every;
  private checked = 0;
  private sampling = false;
  private installs: { at: number; installed: Preview["installed"]; outdated: Preview["outdated"] } | null = null;
  /** The folder of each file a launcher reads, watched by file. */
  watching = new Map<string, FSWatcher>();
  private settle: ReturnType<typeof setTimeout> | null = null;
  static start() {
    return new Worker();
  }
  async stop() {
    this.stopping = true;
    this.quit.signal();
    for (const launcher of this.launchers.values()) void launcher.then(l => l?.close());
    for (const watcher of this.watching.values()) watcher.close();
    this.watching.clear();
    if (this.settle) clearTimeout(this.settle);
    await this.pending;
  }
  /** Watches the files `launcher` reads. A file can be replaced rather than
   * written in place, so its folder is watched. */
  private watch(launcher: Launcher) {
    for (const file of launcher.watches?.() ?? []) {
      if (this.watching.has(file)) continue;
      try {
        const watcher = watch(dirname(file), (_event, name) => {
          if (name && name.toString() !== basename(file)) return;
          if (this.settle) clearTimeout(this.settle);
          this.settle = setTimeout(() => {
            this.settle = null;
            this.reread();
          }, 100);
        });
        watcher.on("error", () => {
          watcher.close();
          this.watching.delete(file);
        });
        this.watching.set(file, watcher);
      } catch {}
    }
  }
  /** Reads the rows of folders shown in the last minute again now, and the
   * others when next asked. */
  private reread() {
    if (this.stopping) return;
    const now = Date.now();
    for (const job of this.jobs) {
      job.updated = 0;
      if (now - job.used > 60000) continue;
      job.queued = true;
      job.preview = job.preview.with({ pending: true });
    }
    void this.pump();
  }
  launcher(p: Provider, account = "") {
    const key = p + "\0" + account;
    let launcher = this.launchers.get(key);
    if (!launcher) this.launchers.set(key, (launcher = adapter(p).launcher?.(account) ?? Promise.resolve(null)));
    return launcher;
  }
  preview(cwd: string, refresh = false) {
    return this.request(cwd, false, refresh);
  }
  trackUsage(cwd: string) {
    return this.request(cwd, true);
  }
  /** Reads the accounts due a read, whether or not anyone is subscribed.
   * The daemon calls it every tick, `every` set by how its viewers are used. */
  sample(every: number) {
    this.every = every;
    const now = Date.now();
    if (now - this.checked < check_ms) return;
    this.checked = now;
    this.sampling = true;
    void this.pump();
  }
  request(cwd: string, access: boolean, refresh = false) {
    if (Buffer.byteLength(cwd) > 4096) return new Preview();
    const now = Date.now();
    if (refresh) this.installs = null;
    // A new subscriber reads sign-in again; asking for usage fetches it too.
    if (refresh || access)
      for (const login of this.logins.values()) {
        login.read_at = 0;
        login.forced ||= access;
      }
    let job = this.jobs.find(j => j.cwd === cwd);
    if (job) {
      job.used = now;
      const listed = this.list(job.preview),
        moved =
          job.preview.accounts.length !== listed.accounts.length ||
          job.preview.accounts.some(
            (a, i) =>
              a.provider !== listed.accounts[i].provider ||
              a.account !== listed.accounts[i].account ||
              a.name !== listed.accounts[i].name ||
              a.managed !== listed.accounts[i].managed,
          ) ||
          Provider.all.some(p => job!.preview.names[p] !== listed.names[p]);
      job.preview = listed;
      if (
        moved ||
        ((refresh || now - job.updated > 60000) && !job.preview.pending) ||
        (access && !job.accessing && !job.request_access)
      ) {
        job.queued = true;
        job.request_access ||= access;
        job.preview = job.preview.with({ pending: true });
        void this.pump();
      }
      return job.preview;
    }
    const preview = this.list(new Preview());
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
  /** Account rows come from local state, independently of provider reads. */
  private list(previous: Preview): Preview {
    const now = performance.now();
    if (!this.installs || now - this.installs.at >= 5000) {
      const found = installed();
      this.installs = {
        at: now,
        installed: found,
        outdated: byProvider(p => (found[p] ? "" : (discovery.outdated(p) ?? ""))),
      };
    }
    const { installed: available, outdated } = this.installs,
      names = byProvider(p => accounts.defaultName(p)),
      listed = accounts.known().filter(a => available[a.provider]);
    if (
      Provider.all.every(
        p =>
          previous.installed[p] === available[p] &&
          previous.outdated[p] === outdated[p] &&
          previous.names[p] === names[p],
      ) &&
      previous.accounts.length === listed.length &&
      previous.accounts.every(
        (a, i) =>
          a.provider === listed[i].provider &&
          a.account === listed[i].dir &&
          a.name === listed[i].name &&
          a.managed === listed[i].managed,
      )
    )
      return previous;
    return previous.with({
      installed: available,
      outdated,
      names,
      accounts: listed.map(a => ({
        provider: a.provider,
        account: a.dir,
        name: a.name,
        managed: a.managed,
        option:
          previous.accounts.find(old => old.provider === a.provider && old.account === a.dir)?.option ?? new Option(),
      })),
    });
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
        if (this.stopping) break;
        if (this.sampling) {
          this.sampling = false;
          await this.round();
          continue;
        }
        const job = this.jobs.find(job => job.queued);
        if (!job) break;
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
    await discovery.check();
    if (this.stopping) return;
    this.installs = null;
    job.preview = this.list(job.preview).with({ pending: true });
    // Launchers keep a provider process each, so those of accounts gone close.
    const live = new Set([...Provider.all.map(p => p + "\0"), ...accounts.known().map(a => a.provider + "\0" + a.dir)]);
    for (const [key, launcher] of this.launchers)
      if (!live.has(key)) {
        void launcher.then(l => l?.close());
        this.launchers.delete(key);
      }
    const rows = this.rows(job.preview),
      groups = this.groups(rows);
    await Promise.all(
      rows.map(async ({ provider, account }) => {
        let option: Option;
        try {
          const group = groups.find(g => g.provider === provider && g.folders.includes(account))!;
          option = (await this.option(provider, account, job.cwd, group)) ?? new Option();
        } catch {
          option = new Option();
          option.usage_error = new Text("account read failed");
        }
        option.pending = false;
        if (this.stopping || !this.jobs.includes(job)) return;
        job.preview = job.preview.with(
          account
            ? {
                accounts: job.preview.accounts.map(a =>
                  a.provider === provider && a.account === account ? { ...a, option } : a,
                ),
              }
            : { options: { ...job.preview.options, [provider]: option } },
        );
      }),
    );
    if (this.stopping) return;
    if (this.jobs.includes(job)) {
      job.preview = job.preview.with({ pending: job.queued });
      job.accessing = false;
      job.updated = Date.now();
    }
  }
  private rows(preview: Preview): Row[] {
    return [
      ...Provider.all.filter(p => preview.installed[p]).map(provider => ({ provider, account: "" })),
      ...preview.accounts,
    ];
  }
  private groups(rows: Row[]): Group[] {
    const groups: Group[] = [];
    for (const { provider, account } of rows) {
      const id = loginOf(provider, account),
        group = groups.find(g => g.provider === provider && g.id === id);
      if (group) group.folders.push(account);
      else groups.push({ provider, id, folders: [account] });
    }
    return groups;
  }
  /** Reads the accounts due a read, then shows what they read in every
   * folder's preview, so subscribers needn't wait for their next refresh. */
  private async round() {
    const before = new Map([...this.logins].map(([key, login]) => [key, login.read_at]));
    await Promise.all(this.groups(this.rows(this.list(new Preview()))).map(group => this.read(group)));
    if (this.stopping || [...this.logins].every(([key, login]) => before.get(key) === login.read_at)) return;
    for (const job of this.jobs)
      job.preview = job.preview.with({
        options: byProvider(p => this.shown(p, "", job.preview.options[p])),
        accounts: job.preview.accounts.map(a => ({ ...a, option: this.shown(a.provider, a.account, a.option) })),
      });
  }
  /** Reads an account once `every` seconds have passed: its folders in turn,
   * the one that worked last first, until one reads its usage. Those after
   * it read only their sign-in, and show the reading they share. */
  private read({ provider, id, folders }: Group): Promise<void> {
    const key = provider + "\0" + id;
    let login = this.logins.get(key);
    if (!login) this.logins.set(key, (login = new Login()));
    if (login.reading) return login.reading;
    if (Date.now() - login.read_at < this.every * 1000 && folders.every(f => login.infos.has(f)))
      return Promise.resolve();
    const order = login.source !== null && folders.includes(login.source) ? [login.source] : [];
    for (const folder of folders) if (folder !== login.source) order.push(folder);
    const reading = (async () => {
      // A reading another Corgi fetched this interval will do.
      let max_age = login.forced ? 0 : Math.max(0, this.every - check_ms / 1000),
        found: Info | null = null;
      login.forced = false;
      for (const folder of order) {
        let info = new Info();
        try {
          const launcher = await this.launcher(provider, folder);
          if (launcher) info = await launcher.account(this.quit, max_age);
        } catch {
          info.usage_error = new Text("account read failed");
        }
        if (this.stopping) return;
        login.infos.set(folder, info);
        if (found === null && usable(info)) {
          found = info;
          login.source = folder;
          max_age = Infinity;
        }
      }
      const shown = found ?? [...login.infos.values()].find(info => info.usage_fetched_at > 0);
      if (shown) {
        const history = await limitHistory.update(provider, id, shown, this.stopping);
        login.history = history.sparks;
        login.spend = history.spend;
      }
      login.read_at = Date.now();
      for (const folder of folders) this.shown(provider, folder, new Option());
    })().finally(() => (login.reading = null));
    login.reading = reading;
    return reading;
  }
  /** `base` with what `account`'s folder read, or when that has no fresh
   * usage, the reading another folder signed in to the same account got. */
  private shown(provider: Provider, account: string, base: Option): Option {
    const login = this.logins.get(provider + "\0" + loginOf(provider, account)),
      own = login?.infos.get(account);
    if (!login || !own) return base;
    const source = login.source !== null ? login.infos.get(login.source) : undefined,
      borrowed =
        !usable(own) &&
        source !== undefined &&
        usable(source) &&
        own.signed_in === true &&
        own.account.text() === source.account.text(),
      out = Object.assign(new Option(), base);
    for (const key of account_fields) (out as any)[key] = own[key];
    if (borrowed)
      for (const key of ["limits", "spend", "usage_fetched_at", "usage_error"] as const)
        (out as any)[key] = source[key];
    if (borrowed && source.plan.len) out.plan = source.plan;
    accounts.record(
      provider,
      account,
      Object.assign(new Info(), own, {
        plan: out.plan,
        limits: out.limits,
        spend: out.spend,
        usage_fetched_at: out.usage_fetched_at,
        usage_error: out.usage_error,
      }),
    );
    out.history = login.history;
    out.spend_history = login.spend;
    return out;
  }
  /** What `account` of `p` would start with in `cwd`. */
  private async option(p: Provider, account: string, cwd: string, group: Group): Promise<Option | null> {
    const launcher = await this.launcher(p, account);
    if (!launcher) return null;
    this.watch(launcher);
    await this.read(group);
    if (this.stopping) return null;
    const out = this.shown(p, account, new Option());
    const chosen = await launcher.model(cwd, this.quit);
    if (chosen.model) out.setModel(chosen.model, chosen.source, chosen.model_name);
    else out.source = new Text(chosen.source);
    return out;
  }
}
