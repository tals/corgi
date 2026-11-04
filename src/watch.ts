//! `corgi watch --json`: the agents, as a desktop bar shows them, one JSON
//! line at start and another whenever they change. With no daemon running
//! it prints `{"running":false}` and waits for one.
import * as rpc from "./rpc";
import * as mirror from "./mirror";
import * as sidebar from "./sidebar";
import * as agentRows from "./agent_rows";
import * as agentSections from "./agent_sections";
import * as agentOrder from "./agent_order";
import * as json from "./json";
import * as errors from "./errors";
import * as protocol from "./protocol";
import type { Provider } from "./providers";
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
  /** Its sidebar row's second line; a retry's countdown is left to `retry_at`. */
  detail: string;
  /** The glyph before that line: thinking and compacting spin. */
  glyph: Activity;
  /** The corgi playing on that line instead of the detail, if any. */
  corgi: Mode;
  /** When its compaction began, in ms, or 0; the herd starts from it. */
  compacting_since: number;
  /** When Corgi starts its failed turn again, in ms, while it's retrying; else 0. */
  retry_at: number;
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
 * activity lists them; archived workspaces stay out, as they do there.
 * `since` remembers when each agent entered its section, from one summary
 * to the next. */
export function summary(
  runtime: mirror.Runtime,
  intensity = new preferences.Preferences().corgi_intensity,
  since = new agentSections.Since(),
  now_ms = Date.now(),
): Summary {
  const counts: Counts = { agents: 0, working: 0, needs_input: 0, ready: 0, idle: 0, done: 0, unread: 0 },
    seen = new Set<string>();
  const workspaces = runtime.workspaces.items.flatMap(ws => {
    if (ws.archived) return [];
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
    return [{ id: ws.id, name: ws.name, links, pointer: links.length > 0 ? sidebar.portLabel(entry) : "", agents }];
  });
  since.keep(seen);
  return { running: true, counts, workspaces };
}
/** `ws`'s agents as the sidebar sorted by activity lists them with nothing
 * focused (this watcher has no viewer, so no read agent holds its place): the
 * starred, then working, ready, idle and done, each section in the user's
 * order, the agent that entered it last on top. */
function arranged(
  runtime: mirror.Runtime,
  ws: mirror.Workspace,
  since: agentSections.Since,
  now_ms: number,
  seen: Set<string>,
): sidebar.Entry[] {
  const items = agentRows.rows(runtime, ws, now_ms).map(({ entry, start }): agentSections.Item => {
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
function agent(e: sidebar.Entry, intensity: number): Agent {
  const detail = sidebar.rowDetail(e, null),
    status = sidebar.status(e);
  return {
    pane: "pane" in e.target ? e.target.pane : null,
    headless: "headless" in e.target ? e.target.headless : null,
    title: sidebar.rowTitle(e),
    provider: e.provider,
    starred: e.starred,
    section: agentSections.section(e),
    needs_input: status === "needs_input",
    unread: e.unread,
    status,
    detail: detail.length === 0 ? "" : directoryLabel(detail, null, 512),
    glyph: sidebar.activityKind(e, intensity),
    corgi: sidebar.corgiMode(e, intensity),
    compacting_since: e.state === "working" && e.compacting ? Math.floor(e.compacting_since / 1000) : 0,
    retry_at: status === "retrying" ? e.retry_at : 0,
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

export interface Options {
  /** How bright the sidebar's corgis are, where 0 turns them off; asked for
   * with each summary, so a change shows without a restart. */
  intensity: () => number;
  /** How long a dropped daemon has to come back before it counts as gone. */
  grace_ms: number;
  /** How often to look for a daemon while there is none. */
  poll_ms: number;
  signal?: AbortSignal;
}

/** Follows the daemon at `path` through restarts and handoffs until
 * `signal` aborts. A daemon that answers with an error ends it. */
export async function run(path: string, write: (line: string) => void, o: Options): Promise<void> {
  const printer = new Printer(write);
  for (let until = 0; !o.signal?.aborted;) {
    const seen = await follow(path, printer, o.intensity, o.signal);
    // A daemon that hangs up before it answers gets one grace period, not
    // a new one for each try.
    if (seen === "followed" || (seen === "dropped" && until === 0)) until = Date.now() + o.grace_ms;
    if (o.signal?.aborted) return;
    if (Date.now() < until) {
      await Bun.sleep(Math.min(100, o.grace_ms));
      continue;
    }
    printer.print({ running: false });
    until = 0;
    await Bun.sleep(o.poll_ms);
  }
}
/** What a failed connection says about the daemon: none is listening, it hung
 * up on us (a restart or handoff), or something else is wrong. */
function lost(error: unknown): "absent" | "dropped" | null {
  if (errors.is(error, "ConnectionClosed")) return "dropped";
  const code = error instanceof Error && "code" in error ? error.code : null;
  if (code === "ENOENT" || code === "ECONNREFUSED") return "absent";
  return code === "ECONNRESET" || code === "EPIPE" ? "dropped" : null;
}
/** Prints the daemon's summaries until its connection closes. Says whether
 * it followed one that went away, one hung up before answering, or none was there. */
async function follow(
  path: string,
  printer: Printer,
  intensity: () => number,
  signal?: AbortSignal,
): Promise<"followed" | "dropped" | "absent"> {
  const connection = new rpc.Connection(path),
    stop = () => connection.close(),
    closed = new Promise<void>(resolve => connection.socket.once("close", () => resolve())),
    runtime = new mirror.Runtime(),
    since = new agentSections.Since(),
    // Its terminals stay unrendered, so they never ask.
    transport: mirror.Transport = { request: (op, ...args) => connection.request(op, ...args) };
  let failure: unknown = null;
  const show = (snapshot?: protocol.Reply<"session.subscribe">) => {
    if (failure !== null) return;
    try {
      if (snapshot) {
        // A daemon on another protocol after a handoff: a matching client takes over.
        if (snapshot.protocol !== protocol.version) throw Error("UnsupportedProtocol");
        runtime.receive(transport, snapshot);
      }
      printer.print(summary(runtime, intensity(), since));
    } catch (error) {
      failure = error;
      connection.close();
    }
  };
  // A push read along with the reply reaches us before the reply does, but
  // it's the newer; it waits for the reply.
  let subscribed = false,
    held: protocol.Reply<"session.subscribe"> | null = null;
  connection.onEvent(event => {
    if (event.type !== "session") return;
    if (subscribed) show(event);
    else held = event;
  });
  signal?.addEventListener("abort", stop);
  let dropped = false;
  try {
    show(await connection.call("session.subscribe", { output: false }));
    subscribed = true;
    if (held !== null) show(held);
  } catch (error) {
    const why = lost(error);
    dropped = why === "dropped";
    if (why === null) failure = error;
    connection.close();
  }
  // Freshness and preferences keep the viewer's quiet 500 ms cadence.
  const refresh = subscribed && failure === null ? setInterval(() => show(), 500) : null;
  await closed;
  if (refresh !== null) clearInterval(refresh);
  signal?.removeEventListener("abort", stop);
  runtime.destroy();
  if (failure !== null) throw failure;
  return subscribed ? "followed" : dropped ? "dropped" : "absent";
}

/** The command: summaries on stdout until it closes. */
export async function command(path: string): Promise<void> {
  // The widget stops reading when it reloads: a write fails, or, with nothing
  // to write, we're left to its parent's exit.
  process.stdout.on("error", () => process.exit(0));
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 1000).unref();
  await run(path, line => void process.stdout.write(line), {
    intensity: () => preferences.load().corgi_intensity,
    grace_ms: 1000,
    poll_ms: 1000,
  });
}
