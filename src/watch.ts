//! `corgi watch --json`: the agents, as a desktop bar shows them, one JSON
//! line at start and another whenever they change. The daemon pushes each
//! change; with none running it prints `{"running":false}` and waits for one.
import * as rpc from "./rpc";
import * as mirror from "./mirror";
import * as sidebar from "./sidebar";
import * as agentSections from "./agent_sections";
import * as agentOrder from "./agent_order";
import * as json from "./json";
import * as errors from "./errors";
import * as protocol from "./protocol";
import { adapter, type Provider } from "./providers";
import * as preferences from "./preferences";
import { directoryLabel } from "./text";
import type { Section } from "./agent_order";
import type { Activity, Mode } from "./corgi_animation";

export interface Agent {
  pane: number | null;
  headless: number | null;
  title: string;
  provider: Provider | null;
  /** Starred in its workspace: listed above the sections, in the order starred. */
  starred: boolean;
  section: Exclude<Section, "starred">;
  /** It waits on the user, as the sidebar's warm dot says; its section stays working. */
  needs_input: boolean;
  unread: boolean;
  /** What its sidebar glyph says. */
  status: sidebar.Status;
  /** Its sidebar row's second line. */
  detail: string;
  /** The glyph before that line: thinking and compacting spin. */
  glyph: Activity;
  /** The corgi playing on that line instead of the detail, if any. */
  corgi: Mode;
  /** When its compaction began, in ms, or 0; the herd starts from it. */
  compacting_since: number;
}
export interface Workspace {
  id: number;
  name: string;
  links: { url: string; label: string }[];
  /** The sidebar's link button for them, such as "API docs ↗" or "Open Link ↗ 2"; "" with none. */
  pointer: string;
  agents: Agent[];
}
/** `needs_input` and `unread` overlap the section counts, which add up to `agents`. */
export interface Counts {
  agents: number;
  working: number;
  needs_input: number;
  ready: number;
  idle: number;
  done: number;
  unread: number;
}
export type Summary = { running: false } | { running: true; counts: Counts; workspaces: Workspace[] };

/** Every workspace's links and agents, in the order the sidebar sorted by
 * activity lists them. `since` remembers when each agent entered its
 * section, from one summary to the next. */
export function summary(
  runtime: mirror.Runtime,
  intensity = new preferences.Preferences().corgi_intensity,
  since = new agentSections.Since(),
  now_ms = Date.now(),
): Summary {
  const counts: Counts = { agents: 0, working: 0, needs_input: 0, ready: 0, idle: 0, done: 0, unread: 0 },
    seen = new Set<string>();
  const workspaces = runtime.workspaces.items.map(ws => {
    const agents = arranged(runtime, ws, since, now_ms, seen).map(e => agent(e, intensity));
    for (const a of agents) {
      counts.agents += 1;
      counts[a.section] += 1;
      if (a.needs_input) counts.needs_input += 1;
      if (a.unread) counts.unread += 1;
    }
    const entry = sidebar.workspaceEntry({
      id: ws.id,
      name: ws.name,
      cwd: ws.cwd,
      active: false,
      ports: runtime.ports,
    });
    const links: Workspace["links"] = [];
    for (let index = 0; ; index++) {
      const url = sidebar.workspaceUrl(entry, index);
      if (url === null) break;
      links.push({ url, label: sidebar.workspaceUrlName(entry, index) });
    }
    return { id: ws.id, name: ws.name, links, pointer: links.length > 0 ? sidebar.portLabel(entry) : "", agents };
  });
  since.keep(seen);
  return { running: true, counts, workspaces };
}
/** `ws`'s agents as the sidebar sorted by activity lists them: the starred,
 * then working, ready, idle and done, each section in the user's order, the
 * agent that entered it last on top. */
function arranged(
  runtime: mirror.Runtime,
  ws: mirror.Workspace,
  since: agentSections.Since,
  now_ms: number,
  seen: Set<string>,
): sidebar.Entry[] {
  const items = rows(runtime, ws).map(({ entry, start }): agentSections.Item => {
    const target = entry.target as agentOrder.Target,
      key = agentOrder.key(target),
      section = agentSections.section(entry),
      pin = ws.pinned_agents.findIndex(t => sidebar.sameTarget(t, target)),
      rank = ws.activity_order.findIndex(t => sidebar.sameTarget(t, target));
    seen.add(key);
    return {
      key,
      entry,
      workspace: ws.id,
      checkout: null,
      section,
      since: since.observe(key, section, start, now_ms),
      pin: pin < 0 ? null : pin,
      rank: rank < 0 ? ws.activity_order.length : rank,
    };
  });
  since.place(items, new Set());
  return agentSections
    .arrange(items, { all: false, folded: new Set(), workspaces: [ws.id], label: () => "" })
    .filter(e => sidebar.isAgent(e.target));
}
/** When the daemon says an agent's state began, in ms. */
const stateStart = (agent: mirror.Agent) => (agent.working_since > 0 ? agent.working_since : agent.changed_at) / 1000;
/** `ws`'s agent rows as its hand-sorted list builds them: panes by tab, then
 * headless sessions, in the workspace's agent order; each with when its state began. */
function rows(runtime: mirror.Runtime, ws: mirror.Workspace): { entry: sidebar.Entry; start: number }[] {
  const starting = (target: sidebar.Target) => ws.starting_agents.some(t => sidebar.sameTarget(t, target)),
    starred = (target: sidebar.Target) => ws.pinned_agents.some(t => sidebar.sameTarget(t, target));
  const tabs: mirror.Pane[][] = Array.from({ length: ws.model.count }, () => []);
  for (const p of runtime.panes) {
    if (p.agent.provider === null) continue;
    const tab = ws.model.tabForPane(p.id);
    if (tab !== null) tabs[tab].push(p);
  }
  const entries = tabs.flat().map(p => ({
    start: stateStart(p.agent),
    entry: sidebar.entry({
      target: { pane: p.id },
      starting: starting({ pane: p.id }),
      starred: starred({ pane: p.id }),
      name: p.label.length > 0 ? p.label : p.agent.name,
      provider: p.agent.provider,
      state: p.agent.state,
      attention: p.agent.attention,
      tool_active: p.agent.tool_active,
      compacting: p.agent.compacting,
      compacting_since: p.agent.compacting_since,
      paused: p.agent.paused,
      subagents: { ...p.agent.subagents },
      unread: mirror.unread(p.agent.observation),
      activity: p.agent.activity,
    }),
  }));
  for (const session of runtime.sessions)
    if (session.workspace === ws.id)
      entries.push({
        start: session.agent ? stateStart(session.agent) : 0,
        entry: sidebar.entry({
          target: { headless: session.id },
          starting: starting({ headless: session.id }),
          starred: starred({ headless: session.id }),
          name: session.agent?.name ?? "",
          provider: session.provider,
          state: session.state,
          attention: session.attention,
          tool_active: session.tool_active,
          ...(session.agent ? { subagents: { ...session.agent.subagents }, activity: session.agent.activity } : {}),
          unread: mirror.unread(session.observation),
        }),
      });
  return entries.sort((l, r) =>
    sidebar.lessThan(ws.agent_order, l.entry, r.entry)
      ? -1
      : sidebar.lessThan(ws.agent_order, r.entry, l.entry)
        ? 1
        : 0,
  );
}
function agent(e: sidebar.Entry, intensity: number): Agent {
  const detail = sidebar.rowDetail(e);
  return {
    pane: "pane" in e.target ? e.target.pane : null,
    headless: "headless" in e.target ? e.target.headless : null,
    // As its row names it.
    title: e.name.length > 0 ? directoryLabel(e.name, null, 160) : e.provider ? adapter(e.provider).name : "",
    provider: e.provider,
    starred: e.starred,
    section: agentSections.section(e),
    needs_input: e.state !== "done" && (e.state === "blocked" || e.attention === "needs_input"),
    unread: e.unread,
    status: sidebar.status(e),
    detail: detail.length === 0 ? "" : directoryLabel(detail, null, 512),
    glyph: sidebar.activityKind(e, intensity),
    corgi: sidebar.corgiMode(e, intensity),
    compacting_since: e.state === "working" && e.compacting ? Math.floor(e.compacting_since / 1000) : 0,
  };
}

/** Writes each summary that differs from the last one written. */
export class Printer {
  private last: string | null = null;
  constructor(private readonly write: (line: string) => void) {}
  print(s: Summary): void {
    const line = json.stringify(s);
    if (line === this.last) return;
    this.last = line;
    this.write(line + "\n");
  }
}

export interface Timing {
  /** How long a dropped daemon has to come back before it counts as gone. */
  grace_ms: number;
  /** How often to look for a daemon while there is none. */
  poll_ms: number;
}
const timing: Timing = { grace_ms: 1000, poll_ms: 1000 };

/** Follows the daemon at `path` for good, through restarts and handoffs. A
 * daemon that answers with an error ends it. */
export async function run(path: string, write: (line: string) => void, t: Timing = timing): Promise<never> {
  const printer = new Printer(write),
    // How bright the sidebar's corgis are, where 0 turns them off.
    intensity = preferences.load().corgi_intensity;
  for (let until = 0; ;) {
    if (await follow(path, printer, intensity)) until = Date.now() + t.grace_ms;
    if (Date.now() < until) {
      await Bun.sleep(Math.min(100, t.grace_ms));
      continue;
    }
    printer.print({ running: false });
    await Bun.sleep(t.poll_ms);
  }
}
/** No daemon is there to answer, or it went away. */
function unreachable(error: unknown): boolean {
  return errors.is(error, "ConnectionClosed") || (error instanceof Error && "code" in error);
}
/** Prints the daemon's summaries until its connection closes; false when no
 * daemon answered. */
async function follow(path: string, printer: Printer, intensity: number): Promise<boolean> {
  const connection = new rpc.Connection(path),
    closed = new Promise<void>(resolve => connection.socket.once("close", () => resolve())),
    runtime = new mirror.Runtime(),
    since = new agentSections.Since(),
    // Its terminals stay unrendered, so they never ask.
    transport: mirror.Transport = { request: (op, ...args) => connection.request(op, ...args) };
  let failure: unknown = null;
  const show = (snapshot: protocol.Reply<"session.subscribe">) => {
    if (failure !== null) return;
    try {
      // A daemon on another protocol after a handoff: a matching client takes over.
      if (snapshot.protocol !== protocol.version) throw Error("UnsupportedProtocol");
      runtime.receive(transport, snapshot);
      printer.print(summary(runtime, intensity, since));
    } catch (error) {
      failure = error;
      connection.close();
    }
  };
  connection.onEvent(event => {
    if (event.type === "session") show(event);
  });
  let subscribed = false;
  try {
    show(await connection.call("session.subscribe", { output: false }));
    subscribed = true;
  } catch (error) {
    if (!unreachable(error)) failure = error;
    connection.close();
  }
  await closed;
  runtime.destroy();
  if (failure !== null) throw failure;
  return subscribed;
}

/** The command: summaries on stdout until it closes. */
export async function command(path: string): Promise<void> {
  // The widget stops reading when it reloads.
  process.stdout.on("error", () => process.exit(0));
  await run(path, line => void process.stdout.write(line));
}
