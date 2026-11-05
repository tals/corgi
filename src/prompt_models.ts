//! The model catalog and suggestions shared by prompt cards and panes.
import * as accounts from "./accounts";
import * as profiles from "./agent_profiles";
import * as visibility from "./launch/visibility";
import * as agentLauncher from "./agent_launcher";
import type * as agentModels from "./agent_models";
import type * as mirror from "./mirror";
import * as modelPicker from "./model_picker";
import type * as modelSuggest from "./model_suggest";
import { Provider, adapter } from "./providers";
import { expired } from "./usage/account";
export type Place = { provider: Provider; account: string; name: string; option: agentLauncher.Option };
export function places(
  runtime: mirror.Runtime,
  preview: agentLauncher.Preview,
  pick: modelPicker.Choice | null,
): Place[] {
  // A saved command says only when it runs its provider's default account.
  const saved = new Set(
      runtime.agent_commands.flatMap(({ command, hidden, semantics: s }) =>
        command && !hidden && s.default_account && s.provider ? [s.provider] : [],
      ),
    ),
    runs = (provider: Provider, account: string) =>
      (!account && saved.has(provider)) ||
      runtime.panes.some(p => p.agent.provider === provider && p.account === account) ||
      (!account && runtime.sessions.some(s => s.provider === provider)),
    defaults = visibility.defaults(preview, runtime.launcher_added, profiles.list()),
    out: Place[] = [],
    signed: Place[] = [];
  for (const provider of Provider.all) {
    if (!preview.installed[provider] || !adapter(provider).headless) continue;
    const places = [
      { account: "", name: preview.names[provider], option: preview.options[provider] },
      ...runtime.accounts
        .filter(a => a.provider === provider)
        .map(a => ({
          account: a.account,
          name: a.name,
          option:
            preview.accounts.find(o => o.provider === provider && o.account === a.account)?.option ??
            agentLauncher.option(),
        })),
    ];
    for (const place of places) {
      if (place.option.signed_in === false) continue;
      const picked = pick?.provider === provider && pick.account === place.account,
        hidden = place.account ? runtime.account_hidden.includes(place.account) : runtime.agent_hidden[provider];
      const listed = !!place.account || defaults[provider];
      if (listed) signed.push({ provider, ...place });
      if (picked || (!hidden && listed) || runs(provider, place.account)) out.push({ provider, ...place });
    }
  }
  return out.length ? out : signed;
}
export function catalog(
  cache: agentModels.Cache,
  offered: Place[],
  at: number,
  cwd = "",
): { entries: modelPicker.Entry[]; briefs: modelPicker.Brief[]; pending: boolean } {
  const entries: modelPicker.Entry[] = [],
    briefs: modelPicker.Brief[] = [];
  let pending = false;
  for (const { provider, account, name, option } of offered) {
    const stale = typeof option.limits === "object" && expired(option.usage_fetched_at, at);
    briefs.push(modelPicker.accountHeader(provider, account, { ...option, limits: stale ? "none" : option.limits }));
    const catalog = cache.get(provider, account, cwd);
    pending ||= catalog.pending;
    for (const m of catalog.values)
      entries.push({
        provider,
        account,
        account_name: name,
        model: m.id,
        name: m.name,
        efforts: m.efforts ?? [],
        default_effort: m.default_effort ?? null,
      });
  }
  return { entries, briefs, pending };
}
export function usage(runtime: mirror.Runtime, last: modelPicker.Choice | null): modelSuggest.Usage {
  const s = runtime.inference,
    agents: modelSuggest.Usage["agents"] = [];
  const ran = (provider: Provider, account: string, conversation: number) => {
    const configured = accounts.launchOptions(provider, account);
    agents.push({
      provider,
      account,
      model: runtime.conversations.find(c => c.id === conversation)?.model || configured.model || "",
      effort: configured.effort ?? null,
    });
  };
  for (const p of runtime.panes) if (p.agent.provider) ran(p.agent.provider, p.account, p.agent.conversation);
  for (const session of runtime.sessions) if (session.agent) ran(session.provider, "", session.agent.conversation);
  return {
    launches: s.launches,
    agents,
    last,
    clever: s.provider ? { provider: s.provider, model: s.model } : null,
  };
}
