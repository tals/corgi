//! Provider accounts. An account is a provider's settings directory, which
//! a variable such as CLAUDE_CONFIG_DIR picks; "" is the one the daemon's
//! environment picks. Corgi knows the default, folders it made for accounts
//! the user added, folders the user added or ran an agent in, and the
//! accounts Omarchy keeps. TODO: find other second accounts, such as a
//! `~/.claude-work` an alias points at, without guessing from folder names.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Provider, adapter } from "./providers";
import type { Login } from "./providers/adapter";
import type { Identity } from "./account_identity";
import { atomicWrite } from "./os";
import * as agentName from "./agent_name";
import * as agentOptions from "./agent_options";

/** An account Corgi knows. `managed` when Corgi made its folder. */
export type Known = { provider: Provider; dir: string; name: string; managed: boolean };
/** The accounts besides the defaults, the folders the user removed, and
 * the names given to each provider's default account, whichever folder or
 * login that is. `removed` says whose and what each removed folder was, so
 * it can be added back. */
type Saved = {
  accounts: (Known & { created?: string })[];
  forgotten: string[];
  removed: { provider: Provider; dir: string; name: string }[];
  defaults: Partial<Record<Provider, string>>;
  launch: { provider: Provider; account: string; options: agentOptions.Options }[];
};

/** Where the user's accounts are listed. Like integrations.json it sits under
 * the base state directory, so every environment sees the same accounts. */
function base() {
  const e = process.env;
  return join(e.CORGI_ENV_BASE ?? e.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "corgi");
}
export const path = () => join(base(), "accounts.json");

/** A folder as typed in `cwd`, as an absolute path with links resolved. */
function canonical(dir: string, cwd = process.cwd()) {
  const home = process.env.HOME ?? homedir();
  let full = dir.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home).replace(/^(\$PWD|\$\{PWD\})(?=\/|$)/, cwd);
  if (!isAbsolute(full)) full = resolve(cwd, full);
  try {
    return realpathSync(full);
  } catch {
    return full;
  }
}
const defaults = new Map<Provider, string>();
/** The folder the default account uses. */
function home(provider: Provider) {
  let found = defaults.get(provider);
  if (found === undefined)
    try {
      defaults.set(provider, (found = canonical(adapter(provider).accounts.home())));
    } catch {
      found = "";
    }
  return found;
}
/** `dir`, as typed in `cwd`, as an account: "" when it is the default's folder. */
export function normalize(provider: Provider, dir: string, cwd?: string): string {
  if (!dir) return "";
  const full = canonical(dir, cwd);
  return full === home(provider) ? "" : full;
}
/** The account an environment picks, from the variables it sets in `cwd`.
 * A value spelled with other variables picks the default. */
export function of(provider: Provider, env: readonly (readonly [string, string])[], cwd?: string): string {
  const name = adapter(provider).accounts.env,
    value = env.findLast(([key]) => key === name)?.[1];
  return value === undefined || /[$`]/.test(value.replace(/^(\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?=\/|$)/, ""))
    ? ""
    : normalize(provider, value, cwd);
}
/** The folder `account` keeps its settings in. */
export function directory(provider: Provider, account: string) {
  return account || adapter(provider).accounts.home();
}
const descriptions = new Map<string, { at: number; value: Identity }>();
/** The resolved profile, including the folder behind the daemon's default. */
export function describe(provider: Provider, account: string): Identity | null {
  if (adapter(provider).accounts.native) return null;
  const dir = account || home(provider),
    id = JSON.stringify([provider, dir]),
    found = descriptions.get(id),
    now = Date.now();
  if (!dir) return null;
  if (found && now - found.at < 5000) return found.value;
  const value = {
    id,
    name: (account ? label(provider, account) : defaultName(provider) || basename(dir))
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
      .slice(0, 160),
    directory: dir,
  };
  if (descriptions.size >= 256) descriptions.delete(descriptions.keys().next().value!);
  descriptions.set(id, { at: now, value });
  return value;
}
let homes: [string, string] = ["", ""];
/** The folder `account` keeps its settings in, under `~` when it's in the
 * user's home, as they would write it. */
export function folder(provider: Provider, account: string) {
  const dir = account || home(provider) || directory(provider, ""),
    spelled = process.env.HOME ?? homedir();
  if (homes[0] !== spelled) homes = [spelled, canonical(spelled)];
  const user = homes[1];
  return dir === user || dir.startsWith(user + "/") ? "~" + dir.slice(user.length) : dir;
}
/** The variables that pick `account`; none for the default. */
export function env(provider: Provider, account: string): [string, string][] {
  return account ? [[adapter(provider).accounts.env, account]] : [];
}
/** The environment a provider's process for `account` runs with. */
export function environment(provider: Provider, account: string, from: NodeJS.ProcessEnv = process.env) {
  return account ? { ...from, [adapter(provider).accounts.env]: account } : from;
}

let saved: { stamp: string; value: Saved } | null = null;
function load(): Saved {
  let stamp = "";
  try {
    const s = statSync(path());
    stamp = `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {}
  if (saved?.stamp === stamp) return saved.value;
  const value: Saved = { accounts: [], forgotten: [], removed: [], defaults: {}, launch: [] };
  if (stamp)
    try {
      const raw = JSON.parse(readFileSync(path(), "utf8"));
      for (const a of Array.isArray(raw?.accounts) ? raw.accounts : []) {
        const provider = Provider.parse(a?.provider);
        if (!provider || typeof a.dir !== "string" || !isAbsolute(a.dir) || !valid(a.name)) continue;
        value.accounts.push({
          provider,
          dir: a.dir,
          name: a.name,
          managed: a.managed === true,
          ...(typeof a.created === "string" ? { created: a.created } : {}),
        });
      }
      for (const entry of Array.isArray(raw?.launch) ? raw.launch : []) {
        const provider = Provider.parse(entry?.provider),
          options = agentOptions.read(entry?.options);
        if (provider && typeof entry.account === "string" && (!entry.account || isAbsolute(entry.account)) && options)
          value.launch.push({ provider, account: entry.account, options });
      }
      for (const dir of Array.isArray(raw?.forgotten) ? raw.forgotten : [])
        if (typeof dir === "string") value.forgotten.push(dir);
      for (const a of Array.isArray(raw?.removed) ? raw.removed : []) {
        const provider = Provider.parse(a?.provider);
        if (provider && typeof a.dir === "string" && isAbsolute(a.dir) && valid(a.name))
          value.removed.push({ provider, dir: a.dir, name: a.name });
      }
      for (const provider of Provider.all)
        if (valid(raw?.defaults?.[provider])) value.defaults[provider] = raw.defaults[provider];
    } catch {}
  saved = { stamp, value };
  return value;
}
function store(value: Saved) {
  atomicWrite(path(), JSON.stringify(value, null, 2) + "\n", 0o600, false);
  saved = null;
  found = null;
  gone = null;
}

/** Names the CLI and the launcher can spell. */
export function valid(name: unknown): name is string {
  return agentName.valid(name) && name !== "default";
}
/** What `dir` is called when nobody named it: `.claude-work` is "work". */
function nameOf(provider: Provider, dir: string) {
  const file = basename(dir),
    prefix = adapter(provider).accounts.prefix,
    name = file.startsWith(prefix) ? file.slice(prefix.length) : file.replace(/^\.+/, "");
  return valid(name) ? name : "account";
}
/** The accounts `omarchy agent account add` made, which Corgi reads and
 * never writes: each one's folder and label. Its primary is the default. */
function omarchy(provider: Provider): { dir: string; name: string }[] {
  const e = process.env,
    state = e.XDG_STATE_HOME ?? join(e.HOME ?? homedir(), ".local", "state");
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(join(state, "omarchy", "agents", "accounts", `${provider}.json`), "utf8"));
  } catch {
    return [];
  }
  const out: { dir: string; name: string }[] = [];
  for (const a of Array.isArray(raw?.accounts) ? raw.accounts : [])
    if (a?.primary !== true && typeof a?.home === "string" && isAbsolute(a.home) && existsSync(a.home))
      out.push({ dir: a.home, name: [a.label, a.id].find(valid) ?? "account" });
  return out;
}
let found: { at: number; stamp: unknown; accounts: Known[] } | null = null;
/** Every account Corgi knows besides the defaults, for each provider in turn. */
export function known(): Known[] {
  const value = load(),
    now = Date.now();
  if (found && found.stamp === value && now - found.at < 5000) return found.accounts;
  const accounts: Known[] = [];
  for (const provider of Provider.all) {
    if (!adapter(provider).accounts.signin) continue;
    const taken = new Set<string>(defaultName(provider) ? [defaultName(provider)] : []),
      add = (dir: string, name: string, managed: boolean) => {
        const account = normalize(provider, dir);
        if (!account || accounts.some(a => a.provider === provider && a.dir === account)) return;
        let unique = name;
        for (let i = 2; taken.has(unique); i++) unique = `${name}-${i}`;
        taken.add(unique);
        accounts.push({ provider, dir: account, name: unique, managed: managed && owns({ provider, dir }, value) });
      };
    for (const a of value.accounts) if (a.provider === provider) add(a.dir, a.name, a.managed);
    for (const a of omarchy(provider)) if (!value.forgotten.includes(canonical(a.dir))) add(a.dir, a.name, false);
  }
  found = { at: now, stamp: value, accounts };
  return accounts;
}
export function find(provider: Provider, account: string): Known | null {
  return account ? (known().find(a => a.provider === provider && a.dir === account) ?? null) : null;
}
/** Match a literal display name or its provider-qualified spelling. */
export function matchesName(spelled: string, provider: Provider, name: string): boolean {
  return spelled === name || spelled === `${provider}/${name}`;
}
/** The account the CLI names, rejecting collisions between names and qualifiers. */
export function named(spelled: string, provider: Provider | null = null): Known | null {
  const matches = known().filter(
    a => (!provider || a.provider === provider) && matchesName(spelled, a.provider, a.name),
  );
  if (matches.length > 1) throw Error("AmbiguousAccount");
  return matches[0] ?? null;
}
/** The account's name, "" for the default. */
export function label(provider: Provider, account: string): string {
  return account ? (find(provider, account)?.name ?? nameOf(provider, account)) : "";
}
/** Who signed in to `account`, as its provider caches that. */
export function identity(provider: Provider, account: string): Login | null {
  try {
    return adapter(provider).accounts.identity(directory(provider, account));
  } catch {
    return null;
  }
}
/** Another account of `provider` that `login` signed in to already: the
 * default or one Corgi knows. */
export function signedInElsewhere(provider: Provider, account: string, login: Login): Known | "default" | null {
  if (account && identity(provider, "")?.id === login.id) return "default";
  return (
    known().find(a => a.provider === provider && a.dir !== account && identity(provider, a.dir)?.id === login.id) ??
    null
  );
}

/** Whether the user removed `account`, which Corgi then leaves alone. */
export function forgotten(account: string): boolean {
  return account.length > 0 && load().forgotten.includes(account);
}
/** Lists a folder an agent ran in, once someone signed in there, so its
 * hooks and history stay with Corgi after the agent is gone; not one the user
 * removed. True when it was new. */
export function remember(provider: Provider, account: string): boolean {
  if (!account || forgotten(account) || find(provider, account) || identity(provider, account) === null) return false;
  const value = load();
  try {
    store({
      ...value,
      accounts: [...value.accounts, { provider, dir: account, name: nameOf(provider, account), managed: false }],
    });
  } catch {
    return false;
  }
  return true;
}
/** Throws unless `name` can be a new name for one of `provider`'s accounts:
 * besides the one whose folder is `except`, "" for the default. */
export function unused(provider: Provider, name: string, except: string | null = null) {
  if (!valid(name)) throw Error("InvalidAccountName");
  if (
    known().some(a => a.provider === provider && a.name === name && a.dir !== except) ||
    (except !== "" && defaultName(provider) === name)
  )
    throw Error("AccountExists");
}
/** What `provider`'s default account is called; "" while it goes by its
 * agent's name. */
export function defaultName(provider: Provider): string {
  return load().defaults[provider] ?? "";
}
/** Calls `provider`'s default account `name`, or nothing for "". The name
 * stays with the default, whoever signs in to it. */
export function renameDefault(provider: Provider, name: string) {
  if (name) unused(provider, name, "");
  const value = load();
  store({ ...value, defaults: { ...value.defaults, [provider]: name || undefined } });
}
/** Extra launch settings for an account, shared by every workspace and environment. */
export function launchOptions(provider: Provider, account: string): agentOptions.Options {
  const options = load().launch.find(a => a.provider === provider && a.account === account)?.options;
  return options ? { ...options, env: options.env.map(([key, value]) => [key, value]) } : agentOptions.empty();
}
/** Save the edit form as one private, atomic accounts.json update. */
export function configure(provider: Provider, account: string, name: string, options: agentOptions.Options): void {
  const clean = agentOptions.read(options);
  if (!clean) throw Error("InvalidAgentOptions");
  if (clean.env.some(([key]) => key === adapter(provider).accounts.env)) throw Error("AccountEnvironmentOverride");
  if (account || name) unused(provider, name, account);
  const known = account ? find(provider, account) : null;
  if (account && !known) throw Error("AccountNotFound");
  const value = load(),
    listed = value.accounts.find(a => a.provider === provider && canonical(a.dir) === account);
  store({
    ...value,
    accounts: known
      ? listed
        ? value.accounts.map(a => (a === listed ? { ...a, name } : a))
        : [...value.accounts, { ...known, name }]
      : value.accounts,
    defaults: account ? value.defaults : { ...value.defaults, [provider]: name || undefined },
    launch: [
      ...value.launch.filter(a => a.provider !== provider || a.account !== account),
      ...(clean.flags || clean.env.length || clean.model || clean.effort
        ? [{ provider, account, options: clean }]
        : []),
    ],
  });
}
/** Mail hosts whose addresses are people's own, which name an account by
 * the mailbox rather than the company. */
const personal = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "live.com",
  "live.co.uk",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.ca",
  "yahoo.com.au",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "aim.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "tuta.com",
  "tuta.io",
  "tutanota.com",
  "tutanota.de",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "daum.net",
  "comcast.net",
  "att.net",
  "sbcglobal.net",
  "verizon.net",
  "cox.net",
  "btinternet.com",
  "orange.fr",
  "wanadoo.fr",
  "laposte.net",
  "free.fr",
]);
/** A name for the account `login` signed in to: the company of a work
 * address, the mailbox of a personal one, made unique among `provider`'s
 * accounts besides the one whose folder is `except`, "" for the default. */
export function suggest(provider: Provider, login: Login | null, except: string | null = null): string {
  const [mailbox = "", host = ""] = (login?.email ?? "").trim().toLowerCase().split("@"),
    word = personal.has(host) || !host.includes(".") ? mailbox : host.slice(0, host.indexOf(".")),
    cleaned = word.replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, ""),
    base = valid(cleaned.slice(0, 28)) ? cleaned.slice(0, 28) : "account",
    taken = new Set(known().flatMap(a => (a.provider === provider && a.dir !== except ? [a.name] : [])));
  if (except !== "" && defaultName(provider)) taken.add(defaultName(provider));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}
/** Calls `account` `name` from now on; its folder stays where it is. */
export function rename(account: Known, name: string): Known {
  unused(account.provider, name, account.dir);
  const value = load(),
    listed = value.accounts.find(a => a.provider === account.provider && canonical(a.dir) === account.dir),
    renamed = { ...(listed ?? account), name };
  // An account Omarchy keeps gets its name in Corgi's list, which comes first.
  store({
    ...value,
    accounts: listed ? value.accounts.map(a => (a === listed ? renamed : a)) : [...value.accounts, renamed],
  });
  return { ...account, name };
}
function list(account: Known, created?: string) {
  const value = load();
  store({
    ...value,
    accounts: [
      ...value.accounts.filter(a => !(a.provider === account.provider && a.dir === account.dir)),
      { ...account, ...(created === undefined ? {} : { created }) },
    ],
    forgotten: value.forgotten.filter(d => d !== account.dir),
    removed: value.removed.filter(r => !(r.provider === account.provider && r.dir === account.dir)),
  });
  return account;
}
/** Lists `dir`, a folder the user has, as an account called `name`. */
export function add(provider: Provider, name: string, dir: string): Known {
  if (!adapter(provider).accounts.signin) throw Error("AccountManagementUnsupported");
  unused(provider, name);
  const folder = canonical(dir);
  if (!existsSync(folder)) throw Error("FileNotFound");
  const account = normalize(provider, folder);
  if (!account) throw Error("DefaultAccount");
  return list({ provider, dir: account, name, managed: false });
}
/** A new account's folder while someone signs in to it. It is made in a
 * private temporary folder, and its own path only links there until the
 * sign-in works out and the folder moves in. The provider sees only that
 * path, which names Claude's login in the macOS Keychain, so the folder is
 * numbered rather than named: a name can change, and it comes from the
 * login, after the folder is made. `name` is one asked for up front. */
export type Staged = { provider: Provider; name: string | null; dir: string; temp: string };
const temporary = "corgi-account-";
/** A folder `stage` made, by what it is called and where. */
function staging(temp: string) {
  return dirname(temp) === realpathSync(tmpdir()) && basename(temp).startsWith(temporary);
}
/** Whether `dir` is a staged account's link to its folder. */
function placeholder(dir: string, temp?: string) {
  try {
    if (!lstatSync(dir).isSymbolicLink()) return false;
    const to = readlinkSync(dir);
    return temp === undefined ? staging(to) : to === temp;
  } catch {
    return false;
  }
}
/** Where Corgi makes `provider`'s accounts' folders. */
const made = (provider: Provider) => join(base(), "accounts", provider);
/** Creation is recorded by adopt, never inferred from the folder's location.
 * A replaced folder or link no longer carries that ownership. Older records
 * without a directory identity only allow forgetting the account. */
export function owns(account: Pick<Known, "provider" | "dir">, value = load()): boolean {
  const created = folderIdentity(account.dir);
  return (
    created !== null &&
    value.accounts.some(
      a => a.provider === account.provider && a.dir === account.dir && a.managed && a.created === created,
    ) &&
    dirname(account.dir) === canonical(made(account.provider)) &&
    canonical(account.dir) === account.dir
  );
}
function folderIdentity(dir: string): string | null {
  try {
    const s = lstatSync(dir, { bigint: true });
    return s.isDirectory() ? `${s.dev}:${s.ino}:${s.birthtimeNs}` : null;
  } catch {
    return null;
  }
}
/** Starts a new account: a folder that shares the default account's setup,
 * which the caller then signs in to. Its number is the first free one; a
 * cancelled sign-in's leftover link, whose folder is gone, frees its own. */
export function stage(provider: Provider, name: string | null = null): Staged {
  if (!adapter(provider).accounts.signin) throw Error("AccountManagementUnsupported");
  if (name !== null) unused(provider, name);
  const parent = made(provider);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  let dir = "";
  for (let n = 1; ; n++) {
    dir = join(realpathSync(parent), String(n));
    if (placeholder(dir) && !existsSync(dir)) unlinkSync(dir);
    if (!lstatOrNull(dir)) break;
  }
  const temp = mkdtempSync(join(realpathSync(tmpdir()), temporary));
  make(provider, temp);
  symlinkSync(temp, dir);
  return { provider, name, dir, temp };
}
/** Moves a staged account's folder in, once its sign-in worked out, and
 * lists it as `name`: the one asked for, or one its login suggests. */
export function adopt(s: Staged, name = s.name ?? suggest(s.provider, identity(s.provider, s.dir))): Known {
  if (!placeholder(s.dir, s.temp) || !staging(s.temp)) throw Error("NotStaged");
  unused(s.provider, name);
  unlinkSync(s.dir);
  try {
    renameSync(s.temp, s.dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      symlinkSync(s.temp, s.dir);
      throw error;
    }
    copy(s.temp, s.dir);
    erase(s.temp);
  }
  retarget(s.dir, s.temp);
  const created = folderIdentity(s.dir);
  if (created === null) throw Error("NotStaged");
  return list({ provider: s.provider, dir: s.dir, name, managed: true }, created);
}
/** Points links under `root` that lead into `from`, where its files were
 * before they moved, at the same place under `root`. Codex links its
 * server's current release by the folder's resolved path, the staging one. */
function retarget(root: string, from: string, dir = root) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry),
      s = lstatSync(path);
    if (s.isDirectory()) retarget(root, from, path);
    else if (s.isSymbolicLink()) {
      const to = readlinkSync(path);
      if (to !== from && !to.startsWith(from + "/")) continue;
      unlinkSync(path);
      symlinkSync(root + to.slice(from.length), path);
    }
  }
}
/** Deletes a staged account that didn't work out: its link, and the
 * temporary folder, whose own links go without what they point at. */
export function unstage(s: Staged) {
  if (placeholder(s.dir, s.temp)) unlinkSync(s.dir);
  if (staging(s.temp) && lstatOrNull(s.temp)?.isDirectory()) erase(s.temp);
}
const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};
/** Deletes `path`, never following a link. */
function erase(path: string) {
  if (!lstatSync(path).isDirectory()) return unlinkSync(path);
  for (const entry of readdirSync(path)) erase(join(path, entry));
  rmdirSync(path);
}
/** Copies `from` to `to` as it is, links as links. */
function copy(from: string, to: string) {
  const s = lstatSync(from);
  if (s.isSymbolicLink()) return symlinkSync(readlinkSync(from), to);
  if (!s.isDirectory()) return copyFileSync(from, to);
  mkdirSync(to, { mode: s.mode & 0o777 });
  for (const entry of readdirSync(from)) copy(join(from, entry), join(to, entry));
}
/** Removes an account. One whose folder Corgi made goes with its folder,
 * once its agent has signed out; another is forgotten, its folder left
 * alone, and Corgi doesn't list it again until it's added back. */
export async function remove(account: Known): Promise<boolean> {
  const dir = canonical(account.dir),
    owned = owns(account);
  if (owned) await rm(account.dir, { recursive: true });
  // Other accounts may have changed while the folder was being deleted.
  const value = load();
  store({
    ...value,
    accounts: value.accounts.filter(
      a => !(a.provider === account.provider && (a.dir === account.dir || canonical(a.dir) === dir)),
    ),
    forgotten: owned || value.forgotten.includes(dir) ? value.forgotten : [...value.forgotten, dir],
    removed: [
      ...value.removed.filter(r => !(r.provider === account.provider && r.dir === dir)),
      ...(owned ? [] : [{ provider: account.provider, dir, name: account.name }]),
    ],
    launch: value.launch.filter(a => a.provider !== account.provider || a.account !== account.dir),
  });
  return owned;
}
/** The accounts the user removed whose folders are still there, which
 * Manage agents offers to add back: those Corgi recorded, then those Omarchy
 * keeps. */
let gone: { at: number; stamp: unknown; accounts: Known[] } | null = null;
export function removed(): Known[] {
  const value = load(),
    now = Date.now();
  if (gone && gone.stamp === value && now - gone.at < 5000) return gone.accounts;
  const out: Known[] = [];
  for (const provider of Provider.all) {
    if (!adapter(provider).accounts.signin) continue;
    const add = (dir: string, name: string) => {
      const account = canonical(dir);
      if (
        value.forgotten.includes(account) &&
        account !== home(provider) &&
        existsSync(account) &&
        !out.some(a => a.provider === provider && a.dir === account) &&
        !find(provider, account)
      )
        out.push({ provider, dir: account, name, managed: false });
    };
    for (const r of value.removed) if (r.provider === provider) add(r.dir, r.name);
    for (const a of omarchy(provider)) add(a.dir, a.name);
  }
  gone = { at: now, stamp: value, accounts: out };
  return out;
}
/** Lists a removed account again, by the name it had when there's no other
 * account by that name. */
export function restore(provider: Provider, dir: string): Known {
  const gone = removed().find(a => a.provider === provider && a.dir === dir);
  if (!gone) throw Error("AccountNotFound");
  const taken = new Set([...known().flatMap(a => (a.provider === provider ? [a.name] : [])), defaultName(provider)]);
  let name = gone.name;
  for (let i = 2; taken.has(name); i++) name = numbered(gone.name, i);
  return list({ ...gone, name });
}
/** `name` numbered `n`, cut short so the whole stays a valid name. */
function numbered(name: string, n: number): string {
  const suffix = `-${n}`,
    chars = [...name];
  while (chars.length > 1 && Buffer.byteLength(chars.join("") + suffix) > agentName.limit) chars.pop();
  return chars.join("").trimEnd() + suffix;
}
/** Fills an account's folder with links to the setup the default account
 * shares; its login and conversations stay its own. A folder the default
 * lacks is made there first, so the account's writes land in the default's. */
function make(provider: Provider, dir: string) {
  const from = adapter(provider).accounts.home(),
    { dirs, files } = adapter(provider).accounts.shared;
  for (const entry of dirs) {
    mkdirSync(join(from, entry), { recursive: true, mode: 0o700 });
    if (!lstatOrNull(join(dir, entry))) symlinkSync(join(from, entry), join(dir, entry));
  }
  for (const entry of files)
    if (existsSync(join(from, entry)) && !lstatOrNull(join(dir, entry)))
      symlinkSync(join(from, entry), join(dir, entry));
}
/** Forgets what `known` and `home` read, after the environment changes. */
export function reset() {
  defaults.clear();
  descriptions.clear();
  saved = null;
  found = null;
  gone = null;
}
