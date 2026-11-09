import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Quit } from "../subprocess";
import { Provider, adapter, byProvider, Text } from "../providers";
import type { Launcher, Login as Identity } from "../providers/adapter";
import { Model } from "../providers/model";
import { Info, serializeLimits } from "../usage/account";
import * as limitHistory from "../usage/limits";
import * as discovery from "../discovery";
import * as accounts from "../accounts";
import * as profiles from "../agent_profiles";
import * as row from "./row";
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
  login: Identity | null = null;
  limits: Info["limits"] = "none";
  spend: Info["spend"] = null;
  usage_fetched_at = 0;
  usage_error = new Text();
  usage_needs_consent = false;
  history = limitHistory.none();
  spend_history = limitHistory.noSpend();
  spend_daily: limitHistory.SpendDay[] = [];
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
  configured = byProvider(() => false);
  /** Missing mise tools that can install during an explicit launch. */
  on_demand = byProvider(() => false);
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
export function installed(cwd = process.cwd()) {
  return byProvider(p => discovery.installed(p, cwd));
}
type Row = { provider: Provider; account: string };
/** The folders of one provider signed in to one account. */
type Group = { provider: Provider; id: string; folders: string[] };
/** An account, which several folders may be signed in to. Its usage is read
 * through one of them, the one that worked last; the rest only read their
 * sign-in. */
class Login {
  /** The latest workspace whose executable can read this account. */
  cwd = process.cwd();
  /** When this worker last read it, in ms. */
  read_at = 0;
  /** Someone asked for its usage: the next read fetches it, whatever its age. */
  forced = false;
  reading: Promise<void> | null = null;
  /** A refresh arrived after the current account read started. */
  stale = false;
  /** The folder whose read worked last. */
  source: string | null = null;
  /** Each folder's own last read. */
  infos = new Map<string, Info>();
  history = limitHistory.none();
  spend = limitHistory.noSpend();
  daily: limitHistory.SpendDay[] = [];
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
/** An account's launcher, taking one call at a time: a background round and a
 * folder's preview can both read it, and an account reader isn't safe to
 * enter twice. Closing waits for the calls already made, and a call after it
 * starts nothing. */
export class OneAtATime implements Launcher {
  private free: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly launcher: Launcher) {}
  async account(quit: Quit, max_age: number, cwd?: string) {
    const done = await this.turn();
    try {
      return this.closed ? new Info() : await this.launcher.account(quit, max_age, cwd);
    } finally {
      done();
    }
  }
  async model(cwd: string, quit: Quit) {
    const done = await this.turn();
    try {
      return this.closed ? { model: "", source: "" } : await this.launcher.model(cwd, quit);
    } finally {
      done();
    }
  }
  watches() {
    return this.launcher.watches?.() ?? [];
  }
  async close() {
    const done = await this.turn();
    try {
      this.closed = true;
      this.launcher.close();
    } finally {
      done();
    }
  }
  /** Waits for the calls before this one; call what it returns when this one ends. */
  private async turn(): Promise<() => void> {
    const before = this.free,
      { promise, resolve } = Promise.withResolvers<void>();
    this.free = promise;
    await before;
    return resolve;
  }
}
export class Worker {
  quit = Quit.init();
  stopping = false;
  running = false;
  private pending: Promise<void> | null = null;
  /** The round of account reads under way, beside the jobs. */
  private rounding: Promise<void> | null = null;
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
  /** The rows taken out of Manage agents, which it doesn't read. */
  removed: row.Removed = { agent_hidden: byProvider(() => false), account_hidden: [], commands: [] };
  private checked = 0;
  private sampling = false;
  private cached_accounts = new Map<string, Preview>();
  private installs: {
    at: number;
    cwd: string;
    installed: Preview["installed"];
    configured: Preview["configured"];
    outdated: Preview["outdated"];
    on_demand: Preview["on_demand"];
  } | null = null;
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
    await Promise.all([this.pending, this.rounding]);
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
    this.installs = null;
    const now = Date.now();
    for (const job of this.jobs) {
      job.updated = 0;
      if (now - job.used > 60000) continue;
      job.queued = true;
      job.preview = job.preview.with({ pending: true });
    }
    void this.pump();
  }
  private finding = new Map<string, Promise<void>>();
  /** Rescan the requested workspace and invalidate every cached preview. */
  async rediscover(providers: readonly Provider[], cwd = process.cwd()) {
    await Promise.all(
      providers.map(provider => {
        const key = provider + "\0" + cwd;
        let pending = this.finding.get(key);
        if (!pending) {
          pending = discovery.rescan([provider], cwd).finally(() => this.finding.delete(key));
          this.finding.set(key, pending);
        }
        return pending;
      }),
    );
    this.reread();
  }
  /** Follows the rows Manage agents took out, reading again once they changed. */
  follow(removed: row.Removed) {
    if (row.sameRemoved(removed, this.removed)) return;
    this.removed = row.removedOf(removed);
    this.close(this.skipped());
    this.reread();
  }
  /** Closes the launchers of the rows `gone` names. They keep a provider process each. */
  private close(gone: (l: row.Launch) => boolean) {
    for (const [key, launcher] of this.launchers) {
      const [provider, account] = key.split("\0") as [Provider, string];
      if (!gone({ provider, account })) continue;
      void launcher.then(l => l?.close());
      this.launchers.delete(key);
    }
  }
  launcher(p: Provider, account = "") {
    const key = p + "\0" + account;
    let launcher = this.launchers.get(key);
    if (!launcher) this.launchers.set(key, (launcher = this.open(p, account)));
    return launcher;
  } /** `p`'s launcher for `account`, taking one call at a time. */
  private async open(p: Provider, account: string): Promise<Launcher | null> {
    const launcher = await adapter(p).launcher?.(account);
    return launcher ? new OneAtATime(launcher) : null;
  }

  preview(cwd: string, refresh = false) {
    return this.request(cwd, false, refresh);
  }
  /** Latest account snapshot: no job, discovery, provider read or refresh. */
  cached(cwd: string) {
    return this.cached_accounts.get(cwd) ?? new Preview().with({ pending: false });
  }
  trackUsage(cwd: string) {
    return this.request(cwd, true);
  }
  /** Reads the accounts due a read, whether or not anyone is subscribed.
   * The daemon calls it every tick, `every` set by how its viewers are used. */
  sample(every: number) {
    this.every = every;
    const now = Date.now();
    if (this.sampling || now - this.checked < check_ms) return;
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
        login.stale = true;
        login.forced ||= access && login.cwd === cwd;
      }
    let job = this.jobs.find(j => j.cwd === cwd);
    if (job) {
      job.used = now;
      const listed = this.list(job.preview, cwd),
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
        refresh ||
        (now - job.updated > 60000 && !job.preview.pending) ||
        (access && !job.accessing && !job.request_access)
      ) {
        job.queued = true;
        job.request_access ||= access;
        job.preview = job.preview.with({ pending: true });
        void this.pump();
      }
      return job.preview;
    }
    const preview = this.list(new Preview(), cwd);
    // Keep settled account availability when a different folder starts reading its models.
    preview.options = byProvider(p => this.shown(p, "", preview.options[p], cwd));
    preview.accounts = preview.accounts.map(a => ({ ...a, option: this.shown(a.provider, a.account, a.option, cwd) }));
    job = {
      cwd,
      preview,
      updated: 0,
      used: now,
      queued: true,
      accessing: false,
      request_access: access,
    };
    if (this.jobs.length >= 32) {
      const [oldest] = this.jobs.splice(
        this.jobs.reduce((best, j, i, a) => (j.used < a[best].used ? i : best), 0),
        1,
      );
      this.cached_accounts.delete(oldest.cwd);
    }
    this.jobs.push(job);
    void this.pump();
    return preview;
  }
  /** Account rows come from local state, independently of provider reads. */
  private list(previous: Preview, cwd = process.cwd()): Preview {
    const now = performance.now();
    if (!this.installs || this.installs.cwd !== cwd || now - this.installs.at >= 5000) {
      const found = installed(cwd),
        on_demand = byProvider(p => !found[p] && discovery.onDemand(p, cwd));
      this.installs = {
        at: now,
        cwd,
        installed: found,
        configured: byProvider(p => (found[p] || on_demand[p]) && accounts.configured(p, cwd)),
        on_demand,
        outdated: byProvider(p => (found[p] ? "" : (discovery.outdated(p, cwd) ?? ""))),
      };
    }
    const { installed: available, configured, outdated, on_demand } = this.installs,
      names = accounts.defaultNames(),
      listed = accounts.known().filter(a => available[a.provider] || on_demand[a.provider]);
    if (
      Provider.all.every(
        p =>
          previous.installed[p] === available[p] &&
          previous.configured[p] === configured[p] &&
          previous.on_demand[p] === on_demand[p] &&
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
      configured,
      on_demand,
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
  /** Starts what's due, and settles once it's done. A round runs beside the
   * jobs: a subscriber's read shares the round's reads of its accounts rather
   * than waiting on all of them, one of which may hang. */
  pump(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.sampling && !this.rounding) {
      const rounding = this.round().finally(() => {
        this.sampling = false;
        this.checked = Date.now();
        if (this.rounding === rounding) this.rounding = null;
      });
      this.rounding = rounding;
      void rounding.catch(() => {});
    }
    if (!this.pending) {
      const pending = this.drain();
      this.pending = pending;
      void pending
        .finally(() => {
          if (this.pending !== pending) return;
          this.pending = null;
          // A job queued while the drain was finishing hasn't run.
          if (this.jobs.some(job => job.queued)) void this.pump();
        })
        .catch(() => {});
    }
    return Promise.all([this.pending, this.rounding]).then(() => {});
  }
  private async drain() {
    this.running = true;
    try {
      for (;;) {
        if (this.stopping) break;
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
    await discovery.check(job.cwd);
    if (this.stopping) return;
    this.installs = null;
    const skip = this.skipped();
    job.preview = this.withSkipped(this.list(job.preview, job.cwd).with({ pending: true }), skip, job.cwd);
    job.preview = job.preview.with({
      options: byProvider(p =>
        job.preview.installed[p]
          ? job.preview.options[p]
          : Object.assign(new Option(), job.preview.options[p], { pending: false }),
      ),
    });
    const rows = this.rows(job.preview, skip),
      groups = this.groups(rows);
    // Launchers of rows it no longer reads, such as accounts gone, close.
    const live = new Set(rows.map(l => l.provider + "\0" + l.account));
    this.close(l => !live.has(l.provider + "\0" + l.account));
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
        this.cached_accounts.set(job.cwd, job.preview);
      }),
    );
    if (this.stopping) return;
    if (this.jobs.includes(job)) {
      job.preview = job.preview.with({ pending: job.queued });
      this.cached_accounts.set(job.cwd, job.preview);
      job.accessing = false;
      job.updated = Date.now();
    }
  }
  /** Which rows it doesn't read: those removed that no saved agent or command runs in. */
  private skipped(): (l: row.Launch) => boolean {
    const used = profiles.list();
    return l => row.removed(this.removed, l, used);
  }
  /** The rows it reads: installed providers' own and their accounts', but those skipped. */
  private rows(preview: Preview, skip: (l: row.Launch) => boolean): Row[] {
    return [
      ...Provider.all.filter(p => preview.installed[p]).map(provider => ({ provider, account: "" })),
      ...preview.accounts,
    ].filter(l => !preview.on_demand[l.provider] && !skip(l));
  }
  /** A removed row's option: who signed in, so Add agent can offer it back.
   * Nothing asks its servers: the provider's own files say, or for one whose
   * files don't, such as OpenCode, this worker's last read of it. An
   * account's folder that neither names is signed out. */
  private signedIn({ provider, account }: row.Launch, cwd: string): Option {
    const option = new Option(),
      who = accounts.identity(provider, account),
      last = who
        ? undefined
        : this.logins.get(provider + "\0" + loginOf(provider, account) + "\0" + cwd)?.infos.get(account);
    option.pending = false;
    if (who) {
      option.signed_in = true;
      option.account = new Text(who.email);
    } else if (last) {
      option.signed_in = last.signed_in;
      option.account = last.account;
    } else if (account) option.signed_in = false;
    return option;
  }
  /** `preview` with its skipped rows showing only who signed in. */
  private withSkipped(preview: Preview, skip: (l: row.Launch) => boolean, cwd: string): Preview {
    const own = (l: row.Launch, option: Option) =>
      preview.on_demand[l.provider] || skip(l) ? this.signedIn(l, cwd) : option;
    return preview.with({
      options: byProvider(p => own({ provider: p, account: "" }, preview.options[p])),
      accounts: preview.accounts.map(a => ({ ...a, option: own(a, a.option) })),
    });
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
    const skip = this.skipped(),
      directories = new Set(this.jobs.length ? this.jobs.map(job => job.cwd) : [process.cwd()]);
    for (const cwd of directories) {
      await discovery.check(cwd);
      if (this.stopping) return;
      this.installs = null;
      const listed = this.list(new Preview(), cwd);
      this.close(skip);
      await Promise.all(this.groups(this.rows(listed, skip)).map(group => this.read(group, cwd)));
      if (this.stopping) return;
      const shown = (l: row.Launch, option: Option) =>
        listed.on_demand[l.provider] || skip(l)
          ? this.signedIn(l, cwd)
          : this.shown(l.provider, l.account, option, cwd);
      this.cached_accounts.set(
        cwd,
        listed.with({
          pending: false,
          options: byProvider(p => shown({ provider: p, account: "" }, listed.options[p])),
          accounts: listed.accounts.map(a => ({ ...a, option: shown(a, a.option) })),
        }),
      );
      for (const job of this.jobs.filter(job => job.cwd === cwd))
        job.preview = this.list(job.preview, cwd).with({
          options: byProvider(p => shown({ provider: p, account: "" }, job.preview.options[p])),
          accounts: job.preview.accounts.map(a => ({ ...a, option: shown(a, a.option) })),
        });
    }
  }
  /** Reads an account once `every` seconds have passed: its folders in turn,
   * the one that worked last first, until one reads its usage. Those after
   * it read only their sign-in, and show the reading they share. */
  private read({ provider, id, folders }: Group, cwd = process.cwd()): Promise<void> {
    const key = provider + "\0" + id + "\0" + cwd;
    let login = this.logins.get(key);
    if (!login) {
      login = new Login();
      login.forced = this.jobs.some(job => job.cwd === cwd && job.accessing);
      this.logins.set(key, login);
    }
    const directory = (login.cwd = cwd);
    // A fresh reading asked for since the one under way began comes after it.
    if (login.reading && login.stale) return this.again(login.reading, { provider, id, folders }, cwd);
    if (login.reading) return login.reading;
    if (Date.now() - login.read_at < this.every * 1000 && folders.every(f => login.infos.has(f)))
      return Promise.resolve();
    const order = login.source !== null && folders.includes(login.source) ? [login.source] : [];
    for (const folder of folders) if (folder !== login.source) order.push(folder);
    login.stale = false;
    const reading = (async () => {
      // A reading another Corgi fetched this interval will do.
      let max_age = login.forced ? 0 : Math.max(0, this.every - check_ms / 1000),
        found: Info | null = null;
      login.forced = false;
      for (const folder of order) {
        let info = new Info();
        try {
          const launcher = await this.launcher(provider, folder);
          if (launcher) info = await launcher.account(this.quit, max_age, directory);
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
        login.daily = history.daily;
      }
      login.read_at = login.stale ? 0 : Date.now();
    })().finally(() => (login.reading = null));
    login.reading = reading;
    return reading;
  }
  /** Reads `group` again once `reading`, which began before someone asked for a fresh one, ends. */
  private async again(reading: Promise<void>, group: Group, cwd: string): Promise<void> {
    await reading;
    return this.read(group, cwd);
  }
  /** `base` with what `account`'s folder read, or when that has no fresh
   * usage, the reading another folder signed in to the same account got. */
  private shown(provider: Provider, account: string, base: Option, cwd: string): Option {
    const login = this.logins.get(provider + "\0" + loginOf(provider, account) + "\0" + cwd),
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
    out.login = accounts.identity(provider, account);
    out.history = login.history;
    out.spend_history = login.spend;
    out.spend_daily = login.daily;
    return out;
  }
  /** What `account` of `p` would start with in `cwd`. */
  private async option(p: Provider, account: string, cwd: string, group: Group): Promise<Option | null> {
    const launcher = await this.launcher(p, account);
    if (!launcher) return null;
    this.watch(launcher);
    await this.read(group, cwd);
    if (this.stopping) return null;
    const out = this.shown(p, account, new Option(), cwd);
    const chosen = await launcher.model(cwd, this.quit);
    if (chosen.model) out.setModel(chosen.model, chosen.source, chosen.model_name);
    else out.source = new Text(chosen.source);
    return out;
  }
}
