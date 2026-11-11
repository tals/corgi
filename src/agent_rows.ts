//! A workspace's agent rows as the daemon's state builds them: the viewer's
//! agent list and `corgi watch --json` start from the same rows.
import * as agentOrder from "./agent_order";
import * as startup from "./startup";
import * as sidebar from "./sidebar";
import * as mirror from "./mirror";
import * as subagentTooltip from "./subagent_tooltip";

export type Entry = sidebar.Entry<agentOrder.Target, number>;
export type Listed = sidebar.Entry<agentOrder.Target | sidebar.Heading<number> | sidebar.Asleep, number>;
export interface Row {
  entry: Entry;
  /** When the daemon says its state began, in ms. */
  start: number;
}

/** The agents' sessions, and the prompt's while a Corgi pane holds them. */
export function sessions(runtime: mirror.Runtime): mirror.Headless[] {
  return [...runtime.sessions, ...runtime.corgi_sessions.filter(s => !s.exited && s.pane !== null)];
}

/** `ws`'s agents, panes by tab and then headless sessions, unsorted and
 * unfocused; the viewer marks its own focus. */
export function rows(runtime: mirror.Runtime, ws: mirror.Workspace, now_ms: number): Row[] {
  const starred = (target: agentOrder.Target) => ws.pinned_agents.some(t => agentOrder.equal(t, target)),
    starting = (target: agentOrder.Target) => ws.starting_agents.some(t => agentOrder.equal(t, target));
  const tabs: mirror.Pane[][] = Array.from({ length: ws.model.count }, () => []);
  for (const p of runtime.panes) {
    if (p.agent.provider === null) continue;
    const tab = ws.model.tabForPane(p.id);
    if (tab !== null) tabs[tab].push(p);
  }
  const rows: Row[] = tabs.flat().map(p => ({
    entry: sidebar.entry<agentOrder.Target, number>({
      conversation: p.agent.conversation,
      target: { pane: p.id },
      starred: starred({ pane: p.id }),
      starting: starting({ pane: p.id }),
      name: p.label.length > 0 ? p.label : p.agent.name,
      provider: p.agent.provider,
      state: p.agent.state,
      attention: p.agent.attention,
      cwd: p.agent.cwd.length > 0 ? p.agent.cwd : p.cwd,
      tool_active: p.agent.tool_active,
      compacting: p.agent.compacting,
      compacting_since: p.agent.compacting_since,
      paused: p.agent.paused,
      retry_at: p.agent.retry_at,
      subagents: { ...p.agent.subagents },
      unread: mirror.unread(p.agent.observation),
      activity: (() => {
        const wait = runtime.startup_waits.find(w => w.pane === p.id);
        return wait ? startup.label(wait) : p.agent.activity;
      })(),
      reopened: p.restoring.length > 0 && !p.dormant,
    }),
    start: stateStart(p.agent),
  }));
  for (const session of sessions(runtime)) {
    if (session.workspace !== ws.id) continue;
    const entry = sidebar.entry<agentOrder.Target, number>({
      target: { headless: session.id },
      starred: starred({ headless: session.id }),
      starting: starting({ headless: session.id }),
      provider: session.provider,
      state: session.state,
      attention: session.attention,
      cwd: session.cwd,
      tool_active: session.tool_active,
      unread: mirror.unread(session.observation),
    });
    if (session.agent) {
      entry.conversation = session.agent.conversation;
      entry.subagents = { ...session.agent.subagents };
      entry.name = session.agent.name;
      entry.activity = session.agent.activity;
    }
    if (session.corgi) entry.name = "Corgi";
    rows.push({ entry, start: session.agent ? stateStart(session.agent) : 0 });
  }
  for (const { entry } of rows) subagentTooltip.presentChildren(entry, runtime.conversations, now_ms * 1000);
  return rows;
}
/** When an agent's state began, in ms, as far as the daemon says: its work
 * clock while it works, else its last change. */
function stateStart(agent: mirror.Agent): number {
  return (agent.working_since > 0 ? agent.working_since : agent.changed_at) / 1000;
}
