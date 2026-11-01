//! `corgi account`: lists the provider accounts Corgi knows, adds one,
//! signs in to one, renames one, and removes one.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isatty } from "node:tty";
import { Provider, adapter } from "./providers";
import * as agentName from "./agent_name";
import * as accounts from "./accounts";
import * as agentProfiles from "./agent_profiles";
import * as integration from "./integration";
import * as signin from "./signin";
import * as errors from "./errors";
import * as cli from "./cli";

const managed = Provider.all.filter(p => adapter(p).accounts.signin !== null);
export const help = `Usage: corgi account COMMAND

  list                          the accounts Corgi knows and who signed in
  add [PROVIDER] [NAME]         make a new account and sign in to it; it's
                                named from the login unless you name it
  add PROVIDER NAME --dir DIR   use an account folder you already have
  login NAME                    sign in to an account again
  rename NAME NEW               call an account something else; NAME can be
                                default, or claude/default, for the default
  remove NAME                   remove an account: one Corgi made is signed
                                out and deleted, another forgotten

PROVIDER is ${managed.join(" or ")}. Name an account claude/work when two
providers both have one called work. Signing in runs the agent's own sign-in
in the account's folder; agents then start there from the launcher, or with
${managed.map(p => adapter(p).accounts.env).join(" or ")} set.
`;
/** `path` from `~` when it is under HOME, as typed or with links resolved. */
const tilde = (path: string) => {
  const home = process.env.HOME ?? homedir();
  let real = home;
  try {
    real = realpathSync(home);
  } catch {}
  for (const root of [home, real])
    if (path === root || path.startsWith(root + "/")) return "~" + path.slice(root.length);
  return path;
};
/** Says who signed in to a folder the user added, and whether Corgi's hooks
 * there wait on the user, as Codex's do until they're trusted. */
async function signedIn(account: accounts.Known) {
  const who = accounts.identity(account.provider, account.dir)?.email,
    name = `${adapter(account.provider).label} · ${account.name}`;
  process.stdout.write(
    who
      ? `${name} signed in as ${who}. Start it from the launcher.\n`
      : `${name} isn't signed in; \`corgi account login ${account.name}\` signs in.\n`,
  );
  if ((await adapter(account.provider).integration.status(account.dir)).some(step => step.todo))
    process.stdout.write(`Its hooks need you once: \`corgi integration status --account ${account.name}\` says how.\n`);
  return who !== undefined;
}
function list() {
  const rows = Provider.all.flatMap(provider => [
    {
      label: adapter(provider).label,
      name: accounts.defaultName(provider) || "default",
      who: accounts.identity(provider, "")?.email ?? null,
      dir: tilde(accounts.directory(provider, "")),
      managed: false,
      named: accounts.defaultName(provider).length > 0,
    },
    ...accounts
      .known()
      .filter(a => a.provider === provider)
      .map(a => ({
        label: adapter(provider).label,
        name: a.name,
        who: accounts.identity(provider, a.dir)?.email ?? null,
        dir: tilde(a.dir),
        managed: a.managed,
        named: false,
      })),
  ]);
  const width = (pick: (r: (typeof rows)[number]) => string) => Math.max(...rows.map(r => pick(r).length)),
    labels = width(r => r.label),
    names = width(r => r.name),
    whos = width(r => r.who ?? "not signed in");
  for (const r of rows)
    process.stdout.write(
      `${r.label.padEnd(labels)}  ${r.name.padEnd(names)}  ${(r.who ?? "not signed in").padEnd(whos)}  ${r.dir}${r.managed ? "  (made by Corgi)" : r.named ? "  (default)" : ""}\n`,
    );
}
/** The provider whose default account `spelled` names: `default`,
 * `claude/default`, or the name it was given. */
function defaultOf(spelled: string): Provider | null {
  const matches = Provider.all.filter(
    p =>
      accounts.matchesName(spelled, p, "default") ||
      (accounts.defaultName(p) && accounts.matchesName(spelled, p, accounts.defaultName(p))),
  );
  if (matches.length > 1) throw Error("AmbiguousAccount");
  return matches[0] ?? null;
}
function found(spelled: string | undefined) {
  if (!spelled) throw Error("Usage");
  const account = accounts.named(spelled);
  if (!account) throw Error("UnknownAccount");
  return account;
}
/** The guided sign-in needs a terminal to draw in. */
function terminal() {
  if (!isatty(0) || !isatty(1)) throw Error("NotATerminal");
}
async function run(args: string[]): Promise<number> {
  const [op, ...rest] = args,
    at = rest.indexOf("--dir"),
    dir = at >= 0 ? rest.splice(at, 2)[1] : null;
  if (at >= 0 && !dir) throw Error("Usage");
  switch (op) {
    case undefined:
    case "list":
      if (rest.length) throw Error("Usage");
      list();
      return 0;
    case "add": {
      if (rest.length > 2) throw Error("Usage");
      const provider = rest[0] === undefined ? null : Provider.parse(rest[0]);
      if (rest[0] !== undefined && !provider) throw Error("Usage");
      if (provider && !adapter(provider).accounts.signin) throw Error("AccountManagementUnsupported");
      if (dir === null) {
        if (provider && rest[1] !== undefined) accounts.unused(provider, rest[1]);
        terminal();
        return signin.add(provider, rest[1] ?? null);
      }
      if (!provider || rest.length < 2) throw Error("Usage");
      const account = accounts.add(provider, rest[1], dir);
      await integration.prepare(provider, account.dir);
      return (await signedIn(account)) ? 0 : 1;
    }
    case "login": {
      if (rest.length !== 1) throw Error("Usage");
      const account = found(rest[0]);
      terminal();
      await integration.prepare(account.provider, account.dir);
      return signin.login(account);
    }
    case "rename": {
      if (rest.length !== 2) throw Error("Usage");
      const provider = defaultOf(rest[0]),
        account = accounts.named(rest[0]);
      if (provider && account) throw Error("AmbiguousAccount");
      if (provider) {
        accounts.renameDefault(provider, rest[1]);
        process.stdout.write(
          rest[1]
            ? `${adapter(provider).label}'s default account is ${rest[1]} now.\n`
            : `${adapter(provider).label}'s default account goes by its name again.\n`,
        );
        return 0;
      }
      if (!account) throw Error("UnknownAccount");
      accounts.rename(account, rest[1]);
      process.stdout.write(`Renamed ${account.name} to ${rest[1]}.\n`);
      return 0;
    }
    case "remove": {
      if (rest.length !== 1) throw Error("Usage");
      const account = found(rest[0]);
      agentProfiles.assertAccountUnused(account.provider, account.dir);
      if (accounts.owns(account)) await signin.signOut(account);
      const removed = await accounts.remove(account);
      process.stdout.write(
        removed
          ? `Signed out of ${account.name} and deleted its folder.\n`
          : `Forgot ${account.name}; its folder stays at ${tilde(account.dir)}.\n`,
      );
      return 0;
    }
    default:
      throw Error("Usage");
  }
}
const messages: Record<string, string> = {
  AccountHasProfiles: "delete this account’s cloned configurations first",
  get InvalidAccountName() {
    return agentName.accountMessage();
  },
  get InvalidAgentName() {
    return agentName.message();
  },
  AccountExists: "there's an account by that name already",
  UnknownAccount: "no account by that name; `corgi account list` shows them",
  AmbiguousAccount: "two providers have an account by that name; say claude/NAME or codex/NAME",
  DefaultAccount: "that folder is the default account's",
  FileNotFound: "no such folder",
  NotATerminal: "signing in needs a terminal; run it in one, or add a folder you have with --dir",
  AccountManagementUnsupported: "this agent uses its existing login; manage accounts in the agent itself",
};
/** `corgi account …`: the exit status. */
export async function command(args: string[]): Promise<number> {
  if (args[0] === "help" || cli.asksHelp(["account", ...args])) {
    process.stdout.write(help);
    return 0;
  }
  try {
    return await run(args);
  } catch (error) {
    const name = errors.name(error) ?? String(error);
    process.stderr.write(name === "Usage" ? help : `corgi: ${messages[name] ?? name}\n`);
    return name === "Usage" ? 2 : 1;
  }
}
