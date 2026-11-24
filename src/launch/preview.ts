import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Quit } from "../subprocess";
import { Provider, adapter, byProvider, Text, type ByProvider } from "../providers";
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
/** A folder a viewer asked about this recently is on screen: a subscribed
 * viewer asks every tick. One that isn't, and isn't a workspace's or a
 * worktree's any longer, leaves the refresh. */
const shown_ms = 60000;
/** How long a folder's first preview waits for what the folder itself says:
 * its files may sit on a mount that doesn't answer. */
const prepare_ms = 250;
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
/** The folders of one provider signed in to one account, read through `cwd`'s executable. */
type Group = {
  provider: Provider;
  id: string;
  variant: string;
  folders: string[];
  cwd: string;
  /** Who signed in to each folder when the rows were grouped. */
  who: Map<string, Identity | null>;
};
/** An account, which several folders may be signed in to. Its usage is read
 * through one of them, the one that worked last; the rest only read their
 * sign-in. */
class Login {
  /** When this worker last read it, in ms. */
  read_at = 0;
  /** Someone asked for its usage: the next read fetches it, whatever its age. */
  forced = false;
  reading: Promise<void> | null = null;
  /** A refresh arrived after the current account read started. */
  stale = false;
  /** The folder whose read worked last. */
  source: string | null = null;
  /** Each folder's own last read, and who was signed in to it then. */
  infos = new Map<string, Info>();
  who = new Map<string, Identity | null>();
  history = limitHistory.none();
  spend = limitHistory.noSpend();
  daily: limitHistory.SpendDay[] = [];
}
/** A fresh usage reading, which other folders of its account can show. */
function usable(info: Info) {
  return info.signed_in === true && info.usage_fetched_at > 0 && !info.usage_error.len;
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
  /** Accounts by provider and who signed in, whichever folders show them. */
  logins = new Map<string, Login>();
  /** Who signed in to each account, by provider and folder, as last read. */
  private identities = new Map<string, Identity | null>();
  private identified = false;
  /** What sets each provider up in a folder beyond a sign-in, as last read. */
  private setups = new Map<string, Preview["configured"]>();
  /** What in each folder changes which credential a provider uses, as last read. */
  private variants = new Map<string, ByProvider<string>>();
  /** Seconds between account reads, which the daemon sets from its viewers. */
  every = idle_every;
  /** The rows taken out of Manage agents, which it doesn't read. */
  removed: row.Removed = { agent_hidden: byProvider(() => false), account_hidden: [], commands: [] };
  private checked = 0;
  private sampling = false;
  private cached_accounts = new Map<string, Preview>();
  /** What each folder runs, kept a few seconds. */
  private installs = new Map<
    string,
    { at: number; installed: Preview["installed"]; outdated: Preview["outdated"]; on_demand: Preview["on_demand"] }
  >();
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
    this.installs.clear();
    const now = Date.now();
    for (const job of this.jobs) {
      job.updated = 0;
      if (now - job.used > shown_ms) continue;
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
  /** Latest account snapshot: no job, discovery, provider read or refresh. A
   * folder not shown lately has its accounts' readings all the same. */
  cached(cwd: string) {
    return this.cached_accounts.get(cwd) ?? this.compose(this.list(new Preview(), cwd), this.skipped(), cwd);
  }
  /** The folders of the workspaces and worktrees there are. */
  private existing = new Set<string>();
  /** Follows the folders that are still some workspace's or worktree's:
   * those stay in the refresh, with the rows they last had, while off screen. */
  keep(folders: Set<string>) {
    this.existing = folders;
  }
  private preparing = new Map<string, Promise<void>>();
  /** Reads what `cwd` itself says before its first preview, so that it
   * shows the reading of its own variant rather than another folder's. */
  prepare(cwd: string): Promise<void> {
    if (this.variants.has(cwd) || this.stopping || Buffer.byteLength(cwd) > 4096) return Promise.resolve();
    let pending = this.preparing.get(cwd);
    if (!pending) {
      pending = (async () => {
        if (!this.identified) await this.identify();
        await this.survey(cwd);
      })().finally(() => this.preparing.delete(cwd));
      this.preparing.set(cwd, pending);
    }
    // Past the wait it shows its accounts' default readings until its own are read.
    return Promise.race([pending, new Promise<void>(resolve => setTimeout(resolve, prepare_ms))]);
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
    if (refresh) this.installs.clear();
    // A new subscriber reads sign-in again; asking for usage fetches it too.
    if (refresh || access)
      for (const [key, login] of this.logins) {
        const [provider, , variant] = key.split("\0") as [Provider, string, string];
        login.read_at = 0;
        login.stale = true;
        // Only this folder's readings: another folder's variant has its own.
        login.forced ||= access && variant === this.variant(provider, cwd);
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
    // Keep settled account availability when a different folder starts reading its models.
    const preview = this.compose(this.list(new Preview(), cwd), this.skipped(), cwd).with({ pending: true });
    job = {
      cwd,
      preview,
      updated: 0,
      used: now,
      queued: true,
      accessing: false,
      request_access: access,
    };
    if (this.jobs.length >= 64) {
      const oldest = this.jobs.reduce((best, j) => (j.used < best.used ? j : best));
      this.forget(j => j === oldest);
    }
    this.jobs.push(job);
    void this.pump();
    return preview;
  }
  /** Account rows come from local state, independently of provider reads;
   * what sets a provider up is as `survey` last read it. */
  private list(previous: Preview, cwd = process.cwd()): Preview {
    const now = performance.now();
    let installs = this.installs.get(cwd);
    if (!installs || now - installs.at >= 5000) {
      const found = installed(cwd);
      installs = {
        at: now,
        installed: found,
        on_demand: byProvider(p => !found[p] && discovery.onDemand(p, cwd)),
        outdated: byProvider(p => (found[p] ? "" : (discovery.outdated(p, cwd) ?? ""))),
      };
      this.installs.set(cwd, installs);
    }
    const { installed: available, outdated, on_demand } = installs,
      setup = this.setups.get(cwd),
      configured = byProvider(p => (available[p] || on_demand[p]) && (setup?.[p] ?? previous.configured[p])),
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
  /** The jobs being run, which a round doesn't forget from under them. */
  private active = new Set<Worker["jobs"][number]>();
  async run(job: Worker["jobs"][number]) {
    this.active.add(job);
    try {
      await this.fill(job);
    } finally {
      this.active.delete(job);
    }
  }
  private async fill(job: Worker["jobs"][number]) {
    job.queued = false;
    job.accessing = job.request_access;
    job.request_access = false;
    await discovery.check(job.cwd);
    if (this.stopping) return;
    this.installs.delete(job.cwd);
    await this.identify();
    await this.survey(job.cwd);
    if (this.stopping) return;
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
      groups = this.groups(rows.map(l => ({ ...l, cwd: job.cwd })));
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
      who = this.who(provider, account),
      last = who ? undefined : this.logins.get(this.loginKey(provider, account, cwd))?.infos.get(account);
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
  /** Rows by who signed in: rows of one login share its reading. Each group
   * is read through the folder of its first row. */
  private groups(rows: (Row & { cwd: string })[]): Group[] {
    const groups: Group[] = [];
    for (const { provider, account, cwd } of rows) {
      const id = this.loginOf(provider, account),
        variant = this.variant(provider, cwd),
        group = groups.find(g => g.provider === provider && g.id === id && g.variant === variant);
      if (!group)
        groups.push({
          provider,
          id,
          variant,
          folders: [account],
          cwd,
          who: new Map([[account, this.who(provider, account)]]),
        });
      else if (!group.folders.includes(account)) {
        group.folders.push(account);
        group.who.set(account, this.who(provider, account));
      }
    }
    return groups;
  }
  /** What `cwd` changes about the credential `provider` uses, as `survey` last read it. */
  private variant(provider: Provider, cwd: string) {
    return this.variants.get(cwd)?.[provider] ?? "";
  }
  /** Who signed in to `account`, as `identify` last read it. */
  private who(provider: Provider, account: string): Identity | null {
    return this.identities.get(provider + "\0" + account) ?? null;
  }
  /** Who signed in to `account`, or the folder itself when that's unknown. */
  private loginOf(provider: Provider, account: string) {
    const id = this.who(provider, account)?.id;
    return id ? `login:${id}` : `folder:${account}`;
  }
  private loginKey(provider: Provider, account: string, cwd: string) {
    return provider + "\0" + this.loginOf(provider, account) + "\0" + this.variant(provider, cwd);
  }
  /** Reads who signed in to each provider's default account and to each
   * account Corgi knows: once a read, whatever the number of folders. */
  private async identify() {
    const rows: Row[] = [
        ...Provider.all.map(provider => ({ provider, account: "" })),
        ...accounts.known().map(a => ({ provider: a.provider, account: a.dir })),
      ],
      read = await Promise.all(rows.map(l => accounts.identity(l.provider, l.account)));
    this.identities = new Map(rows.map((l, i) => [l.provider + "\0" + l.account, read[i]]));
    this.identified = true;
  }
  /** Reads what sets each provider up in `cwd` beyond a sign-in. */
  private async survey(cwd: string) {
    const variants = await Promise.all(
      Provider.all.map(p =>
        adapter(p)
          .accounts.variant(cwd)
          .catch(() => ""),
      ),
    );
    this.variants.set(
      cwd,
      byProvider(p => variants[Provider.all.indexOf(p)]),
    );
    const setup = await Promise.all(Provider.all.map(p => accounts.configured(p, cwd, this.who(p, "") !== null)));
    this.setups.set(
      cwd,
      byProvider(p => setup[Provider.all.indexOf(p)]),
    );
  }
  /** Drops the folders `gone` picks, and what was kept for them. */
  private forget(gone: (job: Worker["jobs"][number]) => boolean) {
    this.jobs = this.jobs.filter(job => {
      if (!gone(job)) return true;
      this.cached_accounts.delete(job.cwd);
      this.installs.delete(job.cwd);
      this.setups.delete(job.cwd);
      this.variants.delete(job.cwd);
      return false;
    });
  }
  /** `listed` with what its rows' accounts read, as its folder shows them. */
  private compose(listed: Preview, skip: (l: row.Launch) => boolean, cwd: string, keys?: Map<string, string>): Preview {
    const shown = (l: row.Launch, option: Option) =>
      listed.on_demand[l.provider] || skip(l)
        ? this.signedIn(l, cwd)
        : this.shown(
            l.provider,
            l.account,
            option,
            cwd,
            keys?.get(l.provider + "\0" + l.account + "\0" + this.variant(l.provider, cwd)),
          );
    return listed.with({
      pending: false,
      options: byProvider(p => shown({ provider: p, account: "" }, listed.options[p])),
      accounts: listed.accounts.map(a => ({ ...a, option: shown(a, a.option) })),
    });
  }
  /** Reads the accounts due a read, then shows what they read in every
   * folder's preview, so subscribers needn't wait for their next refresh.
   * Only the folders viewers showed lately: each folder's own reads are of
   * what it runs and sets up; each login is read once, whatever shows it. */
  private async round() {
    const now = Date.now(),
      latest = this.jobs.reduce<Worker["jobs"][number] | null>((a, b) => (a && a.used >= b.used ? a : b), null),
      // The folder shown last counts as on screen, so the accounts keep being read through it.
      shown = (job: Worker["jobs"][number]) => job === latest || now - job.used < shown_ms;
    this.forget(job => !shown(job) && !job.queued && !this.active.has(job) && !this.existing.has(job.cwd));
    // What was kept for a folder that has no job, as one asked about once, goes too.
    const held = new Set(this.jobs.map(job => job.cwd));
    for (const map of [this.cached_accounts, this.installs, this.setups, this.variants])
      for (const cwd of [...map.keys()]) if (!held.has(cwd) && !this.preparing.has(cwd)) map.delete(cwd);
    const skip = this.skipped(),
      // The folder a viewer asked about last comes first, so a login is read through it.
      ordered = [...this.jobs].sort((a, b) => b.used - a.used),
      folders = this.jobs.length ? [...new Set(ordered.filter(shown).map(job => job.cwd))] : [process.cwd()];
    await this.identify();
    // Only folders on screen are looked at again: what each runs and sets up.
    for (const cwd of folders) {
      await discovery.check(cwd);
      if (this.stopping) return;
      this.installs.delete(cwd);
      await this.survey(cwd);
      if (this.stopping) return;
    }
    this.close(skip);
    const fresh = new Set(folders),
      listed = new Map(folders.map(cwd => [cwd, this.list(new Preview(), cwd)])),
      rows = new Map<string, Row & { cwd: string }>();
    // The rest keep the rows they last had, and their accounts are still read.
    // An account removed since isn't read on their account.
    const known = new Set(accounts.known().map(a => a.provider + "\0" + a.dir)),
      current = (preview: Preview) =>
        preview.with({ accounts: preview.accounts.filter(a => known.has(a.provider + "\0" + a.account)) });
    for (const job of ordered) if (!listed.has(job.cwd)) listed.set(job.cwd, current(job.preview));
    for (const [cwd, preview] of listed)
      for (const l of this.rows(preview, skip)) {
        const key = l.provider + "\0" + l.account + "\0" + this.variant(l.provider, cwd);
        if (!rows.has(key)) rows.set(key, { provider: l.provider, account: l.account, cwd });
      }
    const groups = this.groups([...rows.values()]),
      // Each row's reading by the key it was read under: who signed in may be read again meanwhile.
      keys = new Map(
        groups.flatMap(g =>
          g.folders.map(account => [
            g.provider + "\0" + account + "\0" + g.variant,
            g.provider + "\0" + g.id + "\0" + g.variant,
          ]),
        ),
      );
    await Promise.all(groups.map(group => this.read(group)));
    if (this.stopping) return;
    for (const [cwd, preview] of listed) {
      const jobs = this.jobs.filter(job => job.cwd === cwd);
      // A folder off screen shows its rows as they are now: it may have come
      // back on screen and loaded its models while the accounts were read.
      for (const job of jobs) {
        const rows = fresh.has(cwd) ? this.list(job.preview, cwd) : current(job.preview);
        job.preview = this.compose(rows, skip, cwd, keys).with({ pending: job.preview.pending });
      }
      this.cached_accounts.set(
        cwd,
        fresh.has(cwd) || !jobs.length
          ? this.compose(preview, skip, cwd, keys)
          : jobs[0].preview.with({ pending: false }),
      );
    }
  }
  /** Reads an account once `every` seconds have passed: its folders in turn,
   * the one that worked last first, until one reads its usage. Those after
   * it read only their sign-in, and show the reading they share. */
  private read(group: Group): Promise<void> {
    const { provider, id, variant, folders, cwd } = group,
      key = provider + "\0" + id + "\0" + variant;
    let login = this.logins.get(key);
    if (!login) {
      login = new Login();
      login.forced = this.jobs.some(job => job.accessing && this.variant(provider, job.cwd) === variant);
      this.logins.set(key, login);
    }
    // A fresh reading asked for since the one under way began comes after it.
    if (login.reading && login.stale) return this.again(login.reading, group);
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
          if (launcher) info = await launcher.account(this.quit, max_age, cwd);
        } catch {
          info.usage_error = new Text("account read failed");
        }
        if (this.stopping) return;
        login.infos.set(folder, info);
        login.who.set(folder, group.who.get(folder) ?? null);
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
      for (const folder of folders) this.shown(provider, folder, new Option(), cwd);
    })().finally(() => (login.reading = null));
    login.reading = reading;
    return reading;
  }
  /** Reads `group` again once `reading`, which began before someone asked for a fresh one, ends. */
  private async again(reading: Promise<void>, group: Group): Promise<void> {
    await reading;
    return this.read(group);
  }
  /** `base` with what `account`'s folder read, or when that has no fresh
   * usage, the reading another folder signed in to the same account got. */
  private shown(
    provider: Provider,
    account: string,
    base: Option,
    cwd: string,
    key = this.loginKey(provider, account, cwd),
  ): Option {
    const login = this.logins.get(key),
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
    // Who the reading is of, not who a later look at the folder found.
    out.login = login.who.get(account) ?? null;
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
      out.login,
    );
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
    await this.read(group);
    if (this.stopping) return null;
    // By the group's own key: who signed in may have been read again meanwhile.
    const out = this.shown(p, account, new Option(), cwd, p + "\0" + group.id + "\0" + group.variant);
    const chosen = await launcher.model(cwd, this.quit);
    if (chosen.model) out.setModel(chosen.model, chosen.source, chosen.model_name);
    else out.source = new Text(chosen.source);
    return out;
  }
}
