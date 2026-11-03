import type { Runtime } from "./runtime";
import type { Agent } from "./agents";
import * as agentOrder from "./agent_order";
import * as archiveSummary from "./archive_summary";
import * as processName from "./process_name";
import { processArgs } from "./native_bridge";
import type { Preview } from "./workspace_archive";
import { Provider, adapter } from "./providers";
import * as native from "./trackers/resource_os";
import * as resources from "./trackers/resources";
import * as ports from "./trackers/ports";

/** A fresh inventory, independent of resource sampling preferences and display limits. */
function inventory(runtime: Runtime, workspace: number): { result: Preview; roots: resources.Root[] } {
  const ws = runtime.getWorkspace(workspace);
  const panes = runtime.panes.filter(p => runtime.workspaces.owner(p.id)?.id === workspace);
  const sessions = runtime.sessions.filter(s => s.workspace_id === workspace && !s.exited);
  const agents: (Preview["agents"][number] & { since: number })[] = [];
  const add = (
    agent: Agent,
    name: string,
    awake: boolean,
    provider: Provider | null,
    target: agentOrder.Target,
    state = agent.state,
    attention = agent.attention,
    unread = agent.observation.unread(),
  ) => {
    if (!provider) return;
    const running =
      awake &&
      (ws.starting.has(agentOrder.key(target)) || agentOrder.section(state, attention, agent.paused) === "working");
    agents.push({
      target,
      name: name || agent.name.text() || adapter(provider).name,
      provider,
      activity: agent.activity.text() || agent.recent.text(),
      running,
      state,
      attention,
      paused: agent.paused,
      unread,
      since: running && agent.working_since > 0 ? agent.working_since : agent.changed_at || agent.updated_at * 1e6,
    });
  };
  const roots: resources.Root[] = [];
  for (const p of panes) {
    const agent = p.agent();
    const title = ws.model.tabs[ws.model.tabForPane(p.id) ?? -1]?.title ?? "";
    add(
      agent,
      p.label || agent.name.text() || title,
      !p.dormant && !p.terminal.exited,
      agent.provider ?? p.launch?.agent?.provider ?? p.resume_hint.provider,
      { pane: p.id },
    );
    if (!p.dormant && !p.terminal.exited && p.terminal.pid > 0)
      roots.push({
        key: p.id * 2,
        pid: p.terminal.pid,
        start: null,
        workspace,
        agent_pid: p.detection.pid,
        provider: p.agent().provider,
        pane: p.id,
        session: null,
      });
  }
  for (const s of sessions) {
    add(s.agent(), "", true, s.provider, { headless: s.id }, s.status(), s.attention(), s.observation().unread());
    for (const pid of s.client.processes?.() ?? [])
      roots.push({
        key: s.id * 2 + 1,
        pid,
        start: null,
        workspace,
        agent_pid: pid,
        provider: s.provider,
        pane: null,
        session: s.id,
      });
  }
  const result: Preview = {
    workspace,
    name: ws.name(),
    agents: agents.sort(compareAgents).map(({ since, ...a }) => a),
    processes: [],
    processes_available: false,
    processes_partial: false,
    links: [],
    links_available: false,
  };
  try {
    const inventory = native.inventory(roots.map(r => r.pid));
    const index = new Map(inventory.items.map((p, i) => [p.pid, i]));
    for (const root of roots) root.start = inventory.items[index.get(root.pid) ?? -1]?.start ?? null;
    result.processes = processes(inventory.items, roots);
    result.processes_available = true;
    result.processes_partial = inventory.truncated;
  } catch {
    /* The review still shows agents and known links. */
  }
  return { result, roots };
}

export function summary(runtime: Runtime, workspace: number): archiveSummary.Summary {
  const { result } = inventory(runtime, workspace);
  return archiveSummary.capture(result.agents, result.processes);
}

export async function preview(runtime: Runtime, workspace: number, remote: boolean): Promise<Preview> {
  const { result, roots } = inventory(runtime, workspace);
  if (!roots.length) {
    result.links_available = runtime.ports.enabled;
    return result;
  }
  const tracker = new ports.Tracker();
  tracker.enabled = runtime.ports.enabled;
  tracker.current = runtime.ports.current;
  tracker.roots = roots.map(r => ({ pid: r.pid, pane: r.pane ?? 0, workspace, agent_pid: r.agent_pid }));
  try {
    await tracker.scan(pane => runtime.pane(pane)?.terminal.history() ?? "");
    result.links_available = tracker.enabled && tracker.pending.ports_available;
    result.links = [
      ...new Set(
        tracker.pending.workspace(workspace).endpoints.flatMap(e => {
          const url = ports.url(e, remote);
          return url ? [url] : [];
        }),
      ),
    ];
  } catch {
    result.links = [
      ...new Set(
        runtime.ports.current.workspace(workspace).endpoints.flatMap(e => {
          const url = ports.url(e, remote);
          return url ? [url] : [];
        }),
      ),
    ];
  } finally {
    tracker.close();
  }
  return result;
}

/** Working, unread, then the rest; newest in each bucket, as in the sidebar. */
export function compareAgents(
  left: { running: boolean; unread: boolean; since: number },
  right: { running: boolean; unread: boolean; since: number },
): number {
  const bucket = (agent: typeof left) => (agent.running ? 0 : agent.unread ? 1 : 2);
  return bucket(left) - bucket(right) || right.since - left.since;
}

/** Shells and agents are not useful process rows; their non-agent children are. */
export function processes(
  items: native.Identity[],
  roots: resources.Root[],
  args = (pid: number) => processArgs(pid).argv,
): Preview["processes"] {
  const index = new Map(items.map((p, i) => [p.pid, i]));
  return items
    .filter(p => {
      const root = resources.owner(p.pid, items, index, roots);
      return (
        root &&
        p.pid !== root.agent_pid &&
        !(root.provider && p.pid === root.pid) &&
        processName.program([p.name]).name !== "" &&
        !Provider.owning(p.name)
      );
    })
    .sort((a, b) => (a.start > b.start ? -1 : a.start < b.start ? 1 : b.pid - a.pid))
    .flatMap(p => {
      const argv = args(p.pid),
        command = argv.length ? argv : [p.name];
      if (processName.program([command[0]]).name === "") return [];
      const program = processName.program(command);
      return program.name && !Provider.owning(program.name) ? [{ pid: p.pid, ...program }] : [];
    });
}
