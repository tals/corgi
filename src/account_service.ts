//! Account mutations belong to the daemon that owns their files and processes.
import * as accountLock from "./account_lock";
import * as accounts from "./accounts";
import * as profiles from "./agent_profiles";
import * as signin from "./signin";
import * as launcherConfig from "./launcher_config";
import type * as launcherData from "./launcher_data";
import type { Runtime } from "./runtime";
import type { Provider } from "./providers";
import { Row } from "./launch/row";

export function data(r: Runtime): launcherData.Data {
  return {
    accounts: launcherConfig.catalog(r).flatMap(a =>
      a.provider && !Row.profile(a.row)
        ? [
            {
              row: a.row,
              folder: accounts.folder(a.provider, a.account),
              suggest: accounts.suggest(a.provider, accounts.identity(a.provider, a.account), a.account),
              options: a.options,
            },
          ]
        : [],
    ),
    removed: accounts.removed().map(a => ({ provider: a.provider, account: a.dir, name: a.name })),
  };
}
function show(r: Runtime, provider: Provider, account: string): void {
  const row = Row.of(provider, account);
  r.account_hidden = r.account_hidden.filter(a => a !== account);
  for (const ws of r.workspaces.items) ws.launcher_hidden = ws.launcher_hidden.filter(a => a !== row);
  r.changed();
}
export function restore(r: Runtime, provider: Provider, account: string): accounts.Known {
  accountLock.check(provider, account);
  const a = accounts.restore(provider, account);
  show(r, provider, a.dir);
  return a;
}
export async function remove(r: Runtime, provider: Provider, account: string): Promise<boolean> {
  const release = accountLock.take(provider, account);
  try {
    const known = accounts.find(provider, account);
    if (!known) throw Error("AccountNotFound");
    profiles.assertAccountUnused(provider, account);
    if (r.panes.some(p => p.agent().provider === provider && p.account() === account)) throw Error("AccountInUse");
    if (r.sessions.some(s => s.provider === provider && s.account === account)) throw Error("AccountInUse");
    if (accounts.owns(known)) await signin.signOut(known);
    const deleted = await accounts.remove(known);
    show(r, provider, account);
    return deleted;
  } finally {
    release();
  }
}
