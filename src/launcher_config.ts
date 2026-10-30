//! Shared launcher configuration, addressed by stable rows rather than display labels.
import type { Runtime } from "./runtime";
import { Provider, adapter } from "./providers";
import { Row } from "./launch/row";
import * as accounts from "./accounts";
import * as profiles from "./agent_profiles";
import * as options from "./agent_options";
import * as effort from "./providers/effort";
import * as order from "./launch/order";

export type Agent = {
  agent: string;
  names: string[];
  row: Row;
  label: string;
  launcher: boolean;
  name: string;
  provider: Provider | null;
  account: string;
  options: options.Options;
  yolo: boolean;
};
export function catalog(r: Runtime): Agent[] {
  const native = Provider.all
    .flatMap(provider => [
      { provider, account: "", name: accounts.defaultName(provider) },
      ...accounts
        .known()
        .filter(a => a.provider === provider)
        .map(a => ({ provider, account: a.dir, name: a.name })),
    ])
    .map(({ provider, account, name }): Agent => ({
      agent: account ? `${provider}/${name}` : provider,
      names: [name, ...(!account ? [`${provider}/default`] : [])].filter(Boolean),
      row: Row.of(provider, account),
      label: name || adapter(provider).label,
      launcher: account ? !r.account_hidden.includes(account) : !r.agent_hidden[provider],
      name,
      provider,
      account,
      options: accounts.launchOptions(provider, account),
      yolo: r.yolo(provider, account),
    }));
  return [
    ...native,
    ...profiles.list().map((p): Agent => ({
      agent: `profile/${p.id}`,
      names: [p.name],
      row: Row.ofProfile(p.id),
      label: p.name,
      launcher: true,
      name: p.name,
      provider: p.provider,
      account: p.account,
      options: p.options,
      yolo: p.yolo,
    })),
    ...r.agent_commands.flatMap((e, i): Agent[] =>
      e.command
        ? [
            {
              agent: `command/${i + 1}`,
              names: e.name ? [e.name] : [],
              row: Row.ofCommand(i),
              label: e.label(),
              launcher: !e.hidden,
              name: e.name,
              provider: null,
              account: "",
              options: options.empty(),
              yolo: false,
            },
          ]
        : [],
    ),
  ];
}
export function get(r: Runtime, row: string): Agent {
  const agent = catalog(r).find(a => a.row === row);
  if (!agent) throw Error("UnknownAgent");
  return agent;
}
export type Edit = {
  row: string;
  clone: boolean;
  name: string | null;
  model: string | null;
  effort: string | null;
  flags: string | null;
  env: string | null;
  yolo: boolean | null;
};
export function configure(r: Runtime, q: Edit): Row {
  const agent = get(r, q.row);
  if (!agent.provider) throw Error("CustomCommandOptions");
  const settings = { ...agent.options };
  if (q.model !== null) {
    delete settings.model;
    if (q.model !== "auto") settings.model = q.model;
  }
  if (q.effort !== null) {
    delete settings.effort;
    if (q.effort !== "default") {
      const level = effort.parse(q.effort);
      if (!level) throw Error("InvalidAgentOptions");
      settings.effort = level;
    }
  }
  if (q.flags !== null) settings.flags = q.flags;
  if (q.env !== null) {
    const env: unknown = JSON.parse(q.env);
    if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some(v => typeof v !== "string"))
      throw Error("InvalidAgentOptions");
    settings.env = Object.entries(env) as [string, string][];
  }
  const clean = options.read(settings);
  if (!clean) throw Error("InvalidAgentOptions");
  const name = q.name ?? (q.clone ? `${agent.label} copy` : agent.name),
    yolo = q.yolo ?? agent.yolo,
    id = Row.profile(agent.row);
  if (q.clone || id) {
    const saved = profiles.save({
      ...(q.clone ? {} : { id: id! }),
      provider: agent.provider,
      account: agent.account,
      name,
      options: clean,
      yolo,
    });
    return Row.ofProfile(saved.id);
  }
  accounts.configure(agent.provider, agent.account, name, clean);
  if (agent.account)
    r.account_yolo = [...r.account_yolo.filter(a => a !== agent.account), ...(yolo ? [agent.account] : [])];
  else r.agent_yolo[agent.provider] = adapter(agent.provider).bypass !== false && yolo;
  return agent.row;
}
export function copy(r: Runtime, from: number, to: number): void {
  const source = r.getWorkspace(from),
    destination = r.getWorkspace(to);
  destination.launcher_order = [...source.launcher_order];
  destination.launcher_hidden = [...source.launcher_hidden];
}
export function arrange(r: Runtime, workspace: number): Row[] {
  return order.arrange(
    catalog(r).map(a => a.row),
    r.getWorkspace(workspace).launcher_order as Row[],
  );
}
