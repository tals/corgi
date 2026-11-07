//! `corgi usage --json`: cached usage readings and history for scripts and
//! status bars. Consumers choose the display range, scale and formatting.
import * as rpc from "./rpc";
import * as errors from "./errors";
import * as json from "./json";
import * as launcherOrder from "./launch/order";
import { expired } from "./usage/account";
import { type Option, type Preview, preview as normalize } from "./agent_launcher";
import { Row } from "./launch/row";
import { Provider, adapter } from "./providers";
import type { Login } from "./providers/adapter";

/** Another provider's or folder's account folded into one, being the same login. */
export type Shared = { provider: Provider; name: string };
export type Account = {
  provider: Provider;
  /** What the account is called; "" for the provider's default. */
  name: string;
  email: string;
  plan: string;
  shared: Shared[];
  limits: Option["limits"];
  /** Stored samples in provider-window order, including gaps and decreases. */
  history: Option["history"];
  spend: Option["spend"];
  spend_history: Option["spend_daily"];
  usage_fetched_at: number;
  usage_error: string;
};
export type Report = { running: boolean; accounts: Account[] };

/** A reading with limits or spend to draw. A signed-out account's are old. */
function usage(value: Option): boolean {
  return value.signed_in !== false && (typeof value.limits === "object" || value.spend !== null);
}
/** One folder of one provider, as the preview lists it. */
type Member = {
  provider: Provider;
  account: string;
  name: string;
  option: Option;
  login: Login | null;
  order: number;
};
/** The accounts that are one login. */
type Group = { members: Member[] };
const sameLogin = (a: Login, b: Login) => a.service === b.service && a.email.toLowerCase() === b.email.toLowerCase();
const workspace = (login: Login) => login.workspace ?? "";
/** Exact subscriptions first; unnamed workspaces join only an unambiguous one. */
function grouped(members: Member[]): Group[] {
  const groups: Group[] = [];
  const add = (member: Member, found: Group | undefined) => {
    if (found) found.members.push(member);
    else groups.push({ members: [member] });
  };
  for (const member of members) {
    const own = member.login;
    if (own?.service !== undefined && !workspace(own)) continue;
    add(
      member,
      own === null
        ? undefined
        : groups.find(group =>
            group.members.some(
              m =>
                m.login !== null &&
                (own.service !== undefined
                  ? m.login.service !== undefined && sameLogin(m.login, own) && workspace(m.login) === workspace(own)
                  : m.provider === member.provider && m.login.id === own.id),
            ),
          ),
    );
  }
  for (const member of members) {
    const own = member.login;
    if (own?.service === undefined || workspace(own)) continue;
    const matches = groups.filter(group =>
      group.members.some(m => m.login?.service !== undefined && sameLogin(m.login, own) && workspace(m.login)),
    );
    add(
      member,
      matches.length === 1
        ? matches[0]
        : groups.find(group =>
            group.members.some(m => m.login?.service !== undefined && sameLogin(m.login, own) && !workspace(m.login)),
          ),
    );
  }
  return groups.sort((a, b) => Math.min(...a.members.map(m => m.order)) - Math.min(...b.members.map(m => m.order)));
}
/** The member a group shows as: the subscription's own agent, else the first. */
const lead = (group: Group) =>
  group.members.find(m => m.login?.service !== undefined && adapter(m.provider).accounts.service === m.login.service) ??
  group.members[0];
/** The lead's reading, unless another member's is fresher and the lead's is gone. */
function reading(group: Group, now: number): Option {
  const first = lead(group).option;
  if (usage(first) && !expired(first.usage_fetched_at, now)) return first;
  const readings = group.members.map(m => m.option).filter(usage);
  return (
    readings.reduce<Option | null>(
      (best, o) => (best === null || o.usage_fetched_at > best.usage_fetched_at ? o : best),
      null,
    ) ?? first
  );
}
/** The accounts with limits or spend, one per subscription, in the
 * order Manage agents lists them: `order`, the workspace's launcher order. */
export function build(value: Preview, order: readonly Row[], now: number): Account[] {
  const members: Member[] = [];
  const add = (member: Member) => {
    if (member.option.signed_in !== false) members.push(member);
  };
  const member = (provider: Provider, account: string, name: string, option: Option): Member => ({
    provider,
    account,
    name,
    option,
    login: option.login,
    order: members.length,
  });
  const rows = launcherOrder.arrange(
    Provider.all.flatMap((p): Row[] => [
      p,
      ...value.accounts.filter(a => a.provider === p).map(a => Row.of(p, a.account)),
    ]),
    order,
  );
  for (const row of rows) {
    const launch = Row.launch(row);
    if (launch === null) continue;
    const { provider, account } = launch;
    if (!account) {
      if (value.installed[provider]) add(member(provider, "", value.names[provider], value.options[provider]));
      continue;
    }
    const listed = value.accounts.find(a => a.provider === provider && a.account === account);
    if (listed) add(member(provider, account, listed.name, listed.option));
  }
  return grouped(members).flatMap((group): Account[] => {
    const first = lead(group),
      option = reading(group, now);
    if (!usage(option)) return [];
    return [
      {
        provider: first.provider,
        name: first.name,
        email: first.option.account || option.account,
        plan: first.option.plan || option.plan,
        shared: group.members.filter(m => m !== first).map(m => ({ provider: m.provider, name: m.name })),
        limits: option.limits,
        history: option.history,
        spend: option.spend,
        spend_history: option.spend_daily,
        usage_fetched_at: option.usage_fetched_at,
        usage_error: option.usage_error,
      },
    ];
  });
}
/** Asks only for readings the daemon already holds. */
export async function run(path: string): Promise<Report> {
  const connection = new rpc.Connection(path);
  try {
    const list = await connection.call("session.list"),
      // Use the last-used viewer's workspace for its launcher order.
      last = list.viewers.reduce<(typeof list.viewers)[number] | null>(
        (best, v) => (best === null || v.active > best.active ? v : best),
        null,
      ),
      id = last?.workspace ?? list.result.workspaces[0]?.id,
      workspace = list.result.workspaces.find(w => w.id === id);
    if (workspace === undefined) return { running: true, accounts: [] };
    const value = normalize((await connection.call("agent.preview.cached", { workspace: workspace.id })).preview);
    const order = (workspace.launcher_order ?? []).flatMap((row: unknown) => {
      const parsed = typeof row === "string" ? Row.parse(row) : null;
      return parsed === null ? [] : [parsed];
    });
    return { running: true, accounts: build(value, order, Math.floor(Date.now() / 1000)) };
  } catch (error) {
    if (errors.unreachable(error)) return { running: false, accounts: [] };
    throw error;
  } finally {
    connection.close();
  }
}
/** The command: one report on stdout. */
export async function command(path: string): Promise<void> {
  process.stdout.on("error", () => process.exit(0));
  process.stdout.write(json.stringify(await run(path)) + "\n");
}
