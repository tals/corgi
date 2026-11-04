//! Launcher rows: what the picker lists, and what a workspace hides by name.
import { Provider, type ByProvider } from "../providers";

export const customs = ["custom0", "custom1", "custom2", "custom3", "custom4", "custom5"] as const;

/** One of a provider's accounts' rows: the provider, then the account's folder. */
type AccountRow = `${Provider}:${string}`;
/** Launcher rows: each provider's and its accounts', saved commands and a
 * plain terminal. */
export type Row = Provider | AccountRow | `profile:${string}` | (typeof customs)[number] | "terminal";
/** What a row starts: a provider's agent in one of its accounts, "" the default. */
export type Launch = { provider: Provider; account: string };
/** The rows Manage agents took out: providers' own, and accounts by folder. */
export type Hidden = { agent_hidden: ByProvider<boolean>; account_hidden: readonly string[] };
/** The rows taken out of Manage agents, and the rows saved commands start
 * in. Unless a saved agent in `used` or a saved command runs in one, nothing
 * reads a row taken out; Add agent offers it back. */
export type Removed = Hidden & { commands: readonly Launch[] };
export function hidden(r: Hidden, l: Launch): boolean {
  return l.account ? r.account_hidden.includes(l.account) : r.agent_hidden[l.provider];
}
const same = (a: Launch, b: Launch) => a.provider === b.provider && a.account === b.account;
export function removed(r: Removed, l: Launch, used: readonly Launch[] = []): boolean {
  return hidden(r, l) && !used.some(u => same(u, l)) && !r.commands.some(c => same(c, l));
}
/** `r`'s removed rows alone, which later changes to `r` leave as they were. */
export function removedOf(r: Removed): Removed {
  return {
    agent_hidden: { ...r.agent_hidden },
    account_hidden: [...r.account_hidden],
    commands: r.commands.map(l => ({ ...l })),
  };
}
export function sameRemoved(a: Removed, b: Removed): boolean {
  return (
    Provider.all.every(p => a.agent_hidden[p] === b.agent_hidden[p]) &&
    a.account_hidden.length === b.account_hidden.length &&
    a.account_hidden.every((account, i) => account === b.account_hidden[i]) &&
    a.commands.length === b.commands.length &&
    a.commands.every((l, i) => same(l, b.commands[i]))
  );
}
export const Row = {
  profile(row: string): string | null {
    return /^profile:[a-z0-9-]{1,64}$/.test(row) ? row.slice(8) : null;
  },
  ofProfile(id: string): Row {
    return `profile:${id}`;
  },
  /** `provider`'s row, or the row of its `account`. */
  of(provider: Provider, account = ""): Row {
    return account.length > 0 ? `${provider}:${account}` : provider;
  },
  custom(row: Row): number | null {
    const i = customs.indexOf(row as (typeof customs)[number]);
    return i >= 0 ? i : null;
  },
  /** A saved command's row. */
  ofCommand(index: number): Row {
    return customs[index];
  },
  /** A provider's, an account's or a saved command's row, or null. */
  parse(text: string): Row | null {
    if (Row.profile(text) !== null) return text as Row;
    const row = text as Row,
      l = Row.launch(row);
    if (l) return l.account.length === 0 || l.account.startsWith("/") ? row : null;
    return Row.custom(row) !== null ? row : null;
  },
  /** The provider of its own row; null for its accounts' rows. */
  agent(row: Row): Provider | null {
    return Provider.parse(row);
  },
  /** What a provider's or an account's row starts. */
  launch(row: Row): Launch | null {
    const colon = row.indexOf(":");
    const provider = Provider.parse(colon < 0 ? row : row.slice(0, colon));
    return provider === null ? null : { provider, account: colon < 0 ? "" : row.slice(colon + 1) };
  },
  /** Rows with a digit and the agent columns: a provider's, an account's or a saved command's. */
  starts(row: Row): boolean {
    return Row.launch(row) !== null || Row.profile(row) !== null || Row.custom(row) !== null;
  },
};
