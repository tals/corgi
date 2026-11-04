//! A workspace's agent rows as the daemon's state builds them: the viewer's
//! agent list and `corgi watch --json` start from the same rows.
import * as sidebar from "./sidebar";
import * as mirror from "./mirror";

export interface Row {
  entry: sidebar.Entry;
  /** When the daemon says its state began, in ms. */
  start: number;
}

/** `ws`'s agents, panes by tab and then headless sessions, unsorted and
 * unfocused; the viewer marks its own focus. */
export function rows(runtime: mirror.Runtime, ws: mirror.Workspace): Row[] {
  const starred = (target: sidebar.Target) => ws.pinned_agents.some(t => sidebar.sameTarget(t, target)),
    starting = (target: sidebar.Target) => ws.starting_agents.some(t => sidebar.sameTarget(t, target));
  const tabs: mirror.Pane[][] = Array.from({ length: ws.model.count }, () => []);
  for (const p of runtime.panes) {
    if (p.agent.provider === null) continue;
    const tab = ws.model.tabForPane(p.id);
    if (tab !== null) tabs[tab].push(p);
  }
  const rows: Row[] = tabs.flat().map(p => ({
    entry: sidebar.entry({
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
      activity: p.agent.activity,
      reopened: p.restoring.length > 0 && !p.dormant,
    }),
    start: stateStart(p.agent),
  }));
  for (const session of runtime.sessions) {
    if (session.workspace !== ws.id) continue;
    const entry = sidebar.entry({
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
    rows.push({ entry, start: session.agent ? stateStart(session.agent) : 0 });
  }
  return rows;
}
/** When an agent's state began, in ms, as far as the daemon says: its work
 * clock while it works, else its last change. */
function stateStart(agent: mirror.Agent): number {
  return (agent.working_since > 0 ? agent.working_since : agent.changed_at) / 1000;
}
