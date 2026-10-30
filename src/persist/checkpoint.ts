import { isAbsolute } from "node:path";
import { Runtime, Pane, ClosedAgent, Launch, closed_per_workspace } from "../runtime";
import { Workspace, Store } from "../workspace";
import { Model, Tab, max_workspaces } from "../layout";
import { Order, Pins, key as agentKey } from "../agent_order";
import { Stars } from "../agent_stars";
import { Agent, Provider, Text } from "../agents";
import { Attachment, Registry, max_actors } from "../conversations";
import { ResumeHint } from "../resume_hint";
import { Terminal } from "../pane/terminal";
import { Tracker } from "../detection";
import { Cache } from "../trackers/link_labels";
import { Conversation } from "../activity/summary";
import { decodeChecklist } from "../protocol";
import { Entry } from "../launch/command";
import { Meter, Tokens } from "../usage/live";
import * as binary from "../base64";
import * as json from "../json";
import * as worktrees from "../worktrees";
import * as breadcrumbs from "../breadcrumbs";
import { validateCheckpoint } from "./schema";
import { testBuild } from "../build_assets";

export const version = 6;
/** A check the checkpoint failed. It is still named InvalidCheckpoint; `why`
 * says which check, with ids and counts only, since it goes in bug reports. */
export class Invalid extends Error {
  constructor(public why: string) {
    super("InvalidCheckpoint");
  }
}
const invalid = (why: string): never => {
  throw new Invalid(why);
};
/** Fails with `why` when `bad`. */
const check = (bad: unknown, why: () => string) => {
  if (bad) invalid(why());
};

// Restore value objects through their existing constructors, keeping methods and
// bounded strings. Arrays with heterogeneous entries are restored by their owner.
export function hydrate<T>(template: T, value: any): T {
  if (value === undefined) return template;
  if (typeof template === "bigint") return BigInt(value) as T;
  if (typeof template === "number" && typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw Error("Overflow");
    return number as T;
  }
  if (
    template &&
    typeof template === "object" &&
    "value" in template &&
    typeof (template as any).value === "string" &&
    "text" in template &&
    typeof (template as any).text === "function"
  ) {
    if (typeof (template as any).constructor.fromJSON === "function")
      return (template as any).constructor.fromJSON(value);
    if (typeof value !== "string") throw Error("UnexpectedToken");
    const capacity = (template as any).constructor.capacity;
    if (capacity !== undefined && Buffer.byteLength(value) > capacity) throw Error("LengthMismatch");
    return new (template as any).constructor(value);
  }
  if (Array.isArray(template))
    return value.map((v: any, i: number) => hydrate(template[i] ?? template[0] ?? null, v)) as T;
  if (template && typeof template === "object" && value && typeof value === "object") {
    for (const key of Object.keys(template))
      if (Object.hasOwn(value, key)) (template as any)[key] = hydrate((template as any)[key], value[key]);
    return template;
  }
  return value as T;
}

export class Screen {
  static capture(t: Terminal, live: boolean) {
    return {
      cols: t.cols,
      rows: t.rows,
      data: binary.encode(live ? t.liveSnapshot() : t.snapshot()),
      pid: live ? t.pid : -1,
      title_pid: live ? t.title_pid : 0,
      fd: live ? t.fd : -1,
      exited: t.exited,
      exit_status: t.exit_status,
      runs_command: t.runs_command,
      initial_input: live ? t.initial_input : null,
    };
  }
  static restore(screen: any, live: boolean): Terminal {
    if (
      !Number.isInteger(screen.cols) ||
      !Number.isInteger(screen.rows) ||
      screen.cols < 1 ||
      screen.cols > 500 ||
      screen.rows < 1 ||
      screen.rows > 200
    )
      invalid(`a screen is ${screen.cols}×${screen.rows}, outside 1–500 × 1–200`);
    const bytes = binary.decode(screen.data),
      t = Terminal.create(screen.cols, screen.rows);
    t.restore(bytes, live ? (screen.title_pid ?? 0) : 0);
    if (live) {
      if (screen.initial_input) t.prefill(screen.initial_input);
      Object.assign(t, {
        fd: screen.fd ?? -1,
        pid: screen.pid ?? -1,
        owner: "candidate",
        imported: true,
        exited: screen.exited ?? true,
        exit_status: screen.exit_status ?? 0,
        runs_command: screen.runs_command ?? false,
      });
    }
    return t;
  }
}
export function historicalAgent(value: Agent): Agent {
  const result = value.snapshot();
  result.state = result.state === "done" ? "done" : "unknown";
  result.attention = result.observation.unread() ? "finished" : "none";
  result.last_seq = 0n;
  result.metadata_protocol_at = result.metadata_at = result.working_since = 0;
  result.tool_active = result.compacting = false;
  result.compacting_since = 0;
  result.permission_review = null;
  result.subagents = { running: 0, blocked: 0, waiting: false };
  result.observation.pending_stop = false;
  result.transcript = new (result.transcript.constructor as any)();
  return result;
}
export function captureBinding(binding: Attachment, live: boolean) {
  return {
    actor: binding.actor?.id ?? 0,
    generation: binding.generation,
    selection_hash: live ? binding.selection_hash : 0,
    hook_seq: live ? binding.hook_seq : 0,
    known: [...binding.known],
    provisional: live ? binding.provisional : historicalAgent(binding.provisional),
  };
}
/** How a restore treats what it can repair: `repairs` collects what it
 * dropped, and `strict` fails on it instead, as releases before repairs did. */
export type Repairs = { what?: string; repairs?: string[]; strict?: boolean };
export function restoreBinding(registry: Registry, value: any, live: boolean, how: Repairs = {}): Attachment {
  const binding = new Attachment(),
    agent = hydrate(new Agent(), value.provisional ?? {});
  check(agent.observation.read > agent.observation.completed, () => "a binding read more turns than finished");
  check((value.known?.length ?? 0) > 256, () => `a binding knows ${value.known.length} conversations, over 256`);
  binding.provisional = agent;
  binding.generation = BigInt.asUintN(64, BigInt(value.generation ?? 1) + BigInt(!live));
  binding.selection_hash = live ? BigInt(value.selection_hash ?? 0) : 0n;
  binding.hook_seq = live ? BigInt(value.hook_seq ?? 0) : 0n;
  // A conversation forgotten while a pane still pointed at it costs the pane its
  // binding, not the whole checkpoint.
  const missing = new Set<number>(),
    find = (id: number) => registry.byId(id) ?? (missing.add(id), null);
  if (value.actor) binding.actor = find(value.actor);
  binding.known = (value.known ?? []).flatMap((id: number) => find(id)?.id ?? []);
  if (missing.size) {
    const what = how.what ?? "a binding",
      repair = `${what} pointed at conversation ${[...missing].join(", ")}, which isn't saved`;
    if (how.strict) invalid(repair);
    console.warn(`checkpoint: ${repair}; dropped`);
    how.repairs?.push(`${repair}; dropped`);
  }
  return binding;
}
export function capture(r: Runtime, live: boolean) {
  const state = {
    version,
    live,
    saved_at: Math.trunc(Date.now() / 1000),
    next_workspace: r.workspaces.next_id,
    next_pane: r.workspaces.next_pane_id,
    next_session: r.next_session,
    revision: r.revision,
    next_conversation: r.conversations.next_id,
    worktree_placements: r.worktree_tracker.capture(),
    link_labels: live ? r.link_labels : new Cache(),
    last_agent: r.last_agent,
    agent_yolo: r.agent_yolo,
    agent_hidden: r.agent_hidden,
    account_yolo: r.account_yolo,
    account_hidden: r.account_hidden,
    agent_commands: r.agent_commands,
    workspaces: r.workspaces.items.map(w => ({
      away: w.away,
      id: w.id,
      name: w.customName(),
      cwd: w.cwd,
      worktrees: live ? w.worktrees : null,
      model: w.model,
      agent_order: w.agent_order.slice(),
      pinned_agents: w.pinned_agents.slice(),
      starred_sessions: w.starred_sessions.slice(),
      star_bindings: live
        ? r.agentTargets(w).flatMap(target => {
            const conversation = w.star_bindings.get(agentKey(target));
            return conversation ? [{ target, ...conversation }] : [];
          })
        : [],
      activity_order: w.activity_order.slice(),
      last_agent: w.last_agent,
      launcher_hidden: w.launcher_hidden,
      focus: w.focus,
    })),
    panes: r.panes.map(p => {
      p.refreshCwd();
      if (!p.detection.claim) p.resume_hint.observe(p.agent());
      const binding = captureBinding(p.attachment, live);
      if (p.detection.claim && !live) {
        const observation = binding.provisional.observation;
        binding.provisional = new Agent({ observation, attention: observation.unread() ? "finished" : "none" });
      }
      return {
        id: p.id,
        label: p.label,
        cwd: p.cwd,
        screen: Screen.capture(p.terminal, live),
        binding,
        detection: live ? p.detection : new Tracker(),
        resume_hint: p.resume_hint,
        launch: p.launch,
        dormant: p.dormant,
      };
    }),
    closed: r.closed.map(p => ({
      label: p.label,
      cwd: p.cwd,
      screen: Screen.capture(p.terminal, false),
      tab: p.tab,
      workspace_id: p.workspace_id,
      resume_hint: p.resume_hint,
      launch: p.launch,
      pane: p.pane,
      tab_index: p.tab_index,
    })),
    conversations: r.conversations.items.map(actor => ({
      id: actor.id,
      agent: live ? actor.state : historicalAgent(actor.state),
      worktree_location: worktrees.observed(actor.state),
      worktree_placement: worktrees.placement(actor.state),
      status_inference: live ? actor.status_inference : new Conversation(),
      screen_compacting: live && actor.screen_compacting,
      parent: actor.parent,
      workspace: actor.workspace,
      observed_at: live ? actor.observed_at : 0,
      children_observed_at: live ? actor.children_observed_at : 0,
      checklist: actor.checklist,
      tracked_since: live ? actor.tracked_since : 0,
      headless_meter:
        live && actor.headless_usage
          ? { meter: actor.headless_meter.meter, previous: actor.headless_meter.previous }
          : null,
    })),
    sessions: r.sessions.map(s => s.capture(live)),
    breadcrumbs: breadcrumbs.capture(),
  };
  return copyValue(state);
}
function copyValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyValue) as T;
  if (value && typeof value === "object") {
    const result = Object.create(Object.getPrototypeOf(value));
    for (const key of Object.keys(value)) result[key] = copyValue((value as any)[key]);
    return result;
  }
  return value;
}

export async function restore(
  r: Runtime,
  state: any,
  live: boolean,
  socket: string,
  executable: string,
  recover = true,
  repairs: string[] = [],
): Promise<string[]> {
  state = json.parse(json.stringify(state));
  // A check can play a release that failed on what this one repairs; only test builds do.
  const strict = !recover && testBuild && !!process.env.CORGI_TEST_STRICT_REFERENCES;
  validateCheckpoint(state);
  check(state.version !== version, () => `version ${state.version}, expected ${version}`);
  check(state.live !== live, () => `saved ${state.live ? "live" : "cold"}, loaded ${live ? "live" : "cold"}`);
  check(
    !Array.isArray(state.workspaces) || !Array.isArray(state.panes) || !Array.isArray(state.closed),
    () => "workspaces, panes or closed isn't a list",
  );
  check(!Array.isArray(state.sessions), () => "sessions isn't a list");
  check(
    !state.workspaces.length || state.workspaces.length > max_workspaces,
    () => `${state.workspaces.length} workspaces, outside 1–${max_workspaces}`,
  );
  check(
    state.closed.length > closed_per_workspace * max_workspaces,
    () => `${state.closed.length} closed tabs, over ${closed_per_workspace * max_workspaces}`,
  );
  check(state.sessions.length > 16, () => `${state.sessions.length} native sessions, over 16`);
  check(
    (state.conversations?.length ?? 0) > max_actors,
    () => `${state.conversations.length} conversations, over ${max_actors}`,
  );
  r.link_labels = new Cache();
  r.worktree_tracker.restore(state.worktree_placements);
  if (live && state.link_labels) {
    r.link_labels.generation = BigInt(state.link_labels.generation ?? 0);
    r.link_labels.entries = state.link_labels.entries.map((e: any) =>
      e
        ? {
            ...e,
            key: { ...e.key, address: BigInt(e.key.address) },
            generation: BigInt(e.generation),
            name: new Text(e.name),
          }
        : null,
    );
    r.link_labels = Cache.restore(r.link_labels);
  }
  for (const w of state.workspaces) {
    check(
      !w.id || w.id >= state.next_workspace,
      () => `workspace ${w.id} isn't between 1 and next_workspace ${state.next_workspace}`,
    );
    check(r.workspaces.get(w.id), () => `workspace ${w.id} is saved twice`);
    check(!isAbsolute(w.cwd), () => `workspace ${w.id}'s folder isn't an absolute path`);
    const item = new Workspace(w.id, w.cwd);
    if (live && w.worktrees != null) {
      item.worktrees = worktrees.snapshot(w.worktrees);
      if (
        !item.worktrees ||
        !isAbsolute(item.worktrees.common_dir) ||
        item.worktrees.entries.some(e => !isAbsolute(e.path))
      )
        invalid(`workspace ${w.id}'s worktrees aren't absolute paths`);
    }
    item.rename(w.name);
    item.model = Model.fromData(w.model);
    item.agent_order = Order.restore(w.agent_order ?? []);
    item.pinned_agents = Pins.restore(w.pinned_agents ?? []);
    item.starred_sessions = Stars.restore(w.starred_sessions ?? []);
    for (const binding of live ? (w.star_bindings ?? []) : []) {
      const conversation = Stars.restore([binding]).slice()[0],
        target = Order.restore([binding.target]).items[0];
      if (conversation) item.star_bindings.set(agentKey(target), conversation);
    }
    // A checkpoint from before the sections starts them in the dragged order.
    item.activity_order = Order.restore(w.activity_order ?? w.agent_order ?? []);
    item.last_agent = w.last_agent ?? null;
    item.launcher_hidden = w.launcher_hidden ?? [];
    item.focus = w.focus ?? 0;
    item.away = hydrate(item.away, w.away);
    for (const tab of item.model.tabs)
      check(
        tab.id >= state.next_pane,
        () => `workspace ${w.id}'s tab ${tab.id} isn't below next_pane ${state.next_pane}`,
      );
    item.model.next_id = state.next_pane;
    r.workspaces.items.push(item);
  }
  r.workspaces.next_id = state.next_workspace;
  r.workspaces.next_pane_id = state.next_pane;
  r.next_session = state.next_session;
  r.revision = BigInt.asUintN(64, BigInt(state.revision) + 1n);
  r.last_agent = state.last_agent ?? Provider.first;
  r.agent_yolo = hydrate(r.agent_yolo, state.agent_yolo);
  r.agent_hidden = hydrate(r.agent_hidden, state.agent_hidden);
  r.account_yolo = hydrate(r.account_yolo, state.account_yolo);
  r.account_hidden = hydrate(r.account_hidden, state.account_hidden);
  r.agent_commands = (state.agent_commands ?? r.agent_commands).map((entry: any) => hydrate(new Entry(), entry));
  for (const entry of r.agent_commands) entry.semantics.nameModel();
  for (const saved of state.conversations ?? []) {
    const agent = hydrate(new Agent(), saved.agent);
    check(
      !saved.id || saved.id >= (state.next_conversation ?? 1),
      () => `conversation ${saved.id} isn't between 1 and next_conversation ${state.next_conversation ?? 1}`,
    );
    check(r.conversations.byId(saved.id), () => `conversation ${saved.id} is saved twice`);
    check(
      agent.observation.read > agent.observation.completed,
      () => `conversation ${saved.id} read more turns than finished`,
    );
    check(!agent.provider, () => `conversation ${saved.id} has no provider`);
    check(!agent.session.len, () => `conversation ${saved.id} has no session`);
    check(
      r.conversations.find(agent.provider!, agent.sessionId()),
      () =>
        `conversation ${saved.id} has the same session as conversation ${r.conversations.find(agent.provider!, agent.sessionId())!.id}`,
    );
    if (
      !Number.isInteger(saved.status_inference?.len ?? 0) ||
      (saved.status_inference?.len ?? 0) > (saved.status_inference?.recent?.length ?? 4) ||
      !Number.isInteger(saved.status_inference?.phases_len ?? 0) ||
      (saved.status_inference?.phases_len ?? 0) > (saved.status_inference?.phases?.length ?? 4)
    )
      invalid(`conversation ${saved.id}'s status inference is out of range`);
    const actor = r.conversations.get(agent.provider!, agent.sessionId());
    actor.id = saved.id;
    actor.state = live ? agent : historicalAgent(agent);
    worktrees.restoreLocation(actor.state, saved.worktree_location);
    worktrees.restorePlacement(actor.state, saved.worktree_placement);
    if (live) actor.status_inference = hydrate(new Conversation(), saved.status_inference);
    actor.parent = saved.parent ?? null;
    actor.workspace = r.workspaces.get(saved.workspace) ? saved.workspace : 0;
    actor.observed_at = live ? (saved.observed_at ?? 0) : 0;
    actor.children_observed_at = live ? (saved.children_observed_at ?? 0) : 0;
    actor.checklist = decodeChecklist(saved.checklist);
    if (live && saved.tracked_since) actor.tracked_since = saved.tracked_since;
    if (live && saved.headless_meter) {
      actor.headless_usage = true;
      actor.headless_meter.meter = hydrate(new Meter(), saved.headless_meter.meter);
      if (saved.headless_meter.previous)
        actor.headless_meter.previous = hydrate(new Tokens(), saved.headless_meter.previous);
    }
    if (live) actor.restoreCompaction(saved.screen_compacting ?? null, Date.now() * 1000);
  }
  r.conversations.next_id = state.next_conversation ?? 1;
  for (const actor of r.conversations.items) {
    check(actor.parent === actor.id, () => `conversation ${actor.id} is its own parent`);
    check(
      actor.parent && !r.conversations.byId(actor.parent),
      () => `conversation ${actor.id}'s parent, conversation ${actor.parent}, isn't saved`,
    );
  }
  for (const p of state.panes) {
    check(!p.id || p.id >= state.next_pane, () => `pane ${p.id} isn't between 1 and next_pane ${state.next_pane}`);
    check(r.pane(p.id), () => `pane ${p.id} is saved twice`);
    check(!r.workspaces.owner(p.id), () => `pane ${p.id} isn't in any workspace's layout`);
    check(!isAbsolute(p.cwd), () => `pane ${p.id}'s folder isn't an absolute path`);
    const pane = new Pane(p.id, Screen.restore(p.screen, live), p.cwd);
    pane.label = p.label ?? "";
    pane.attachment = restoreBinding(r.conversations, p.binding, live, { what: `pane ${p.id}`, repairs, strict });
    pane.detection = live ? hydrate(new Tracker(), p.detection) : new Tracker();
    pane.resume_hint = hydrate(new ResumeHint(), p.resume_hint);
    pane.launch = p.launch ? Launch.from(p.launch) : null;
    pane.dormant = live && p.dormant === true;
    r.panes.push(pane);
  }
  for (const w of r.workspaces.items)
    for (const node of w.model.nodes)
      check(
        node && "pane" in node && !r.pane(node.pane),
        () => `workspace ${w.id}'s layout shows pane ${(node as { pane: number }).pane}, which isn't saved`,
      );
  for (const p of state.closed) {
    const hint = hydrate(new ResumeHint(), p.resume_hint);
    if (!hint.args() || !r.workspaces.get(p.workspace_id)) continue;
    const closed = new ClosedAgent(
      Screen.restore(p.screen, false),
      p.cwd,
      hydrate(new Tab(0, 0), p.tab),
      p.workspace_id,
      hint,
    );
    closed.label = p.label ?? "";
    closed.launch = p.launch ? Launch.from(p.launch) : null;
    closed.pane = p.pane ?? 0;
    closed.tab_index = p.tab_index ?? null;
    r.closed.push(closed);
  }
  if (state.sessions.length) {
    const { Session } = await import("../headless");
    for (const saved of state.sessions) {
      const tracker = saved.usage_tracker;
      check(
        !r.workspaces.get(saved.workspace_id),
        () => `native session ${saved.id}'s workspace ${saved.workspace_id} isn't saved`,
      );
      check(
        (tracker?.next_sample ?? 0) >= (tracker?.samples?.length ?? 128) ||
          (tracker?.next_tool ?? 0) >= (tracker?.tools?.length ?? 256),
        () => `native session ${saved.id}'s usage tracker is out of range`,
      );
      r.sessions.push(await Session.restore(saved, r.conversations, live, { repairs, strict }));
    }
  }
  // `recover` false only checks the checkpoint: no shells start.
  if (!live && recover) {
    for (const p of r.panes) await recoverPane(p, socket, executable);
    for (const n of state.sessions) {
      if (n.exited) continue;
      const cwd = await safeDirectory(n.cwd);
      const id = await r.create({
        workspace: n.workspace_id,
        cwd,
        title: "Recovered headless session",
        cols: 100,
        rows: 30,
        theme: {},
        socket,
        executable,
      });
      const p = r.pane(id)!;
      p.resume_hint = hydrate(new ResumeHint(), n.resume_hint);
      p.attachment = restoreBinding(r.conversations, n.binding, false, { what: `pane ${id}`, repairs });
      for (const { event } of n.events) {
        const { kind, ...rest } = event;
        p.terminal.feed(`${kind} ${json.stringify(rest)}`.replace(/[\x00-\x1f\x7f]/g, " ") + "\r\n");
      }
      p.terminal.feed(p.resume_hint.banner(Math.trunc(Date.now() / 1000)));
      p.terminal.prefill(p.resume_hint.command());
    }
  }
  breadcrumbs.restore(state.breadcrumbs);
  breadcrumbs.record(live ? "restored_live" : "restored_cold");
  // Daemons that never pruned saved every conversation they had seen.
  r.pruneConversations();
  return repairs;
}
async function safeDirectory(cwd: string): Promise<string> {
  try {
    return await Store.directory(cwd);
  } catch {
    return await Store.directory(process.env.HOME ?? "/");
  }
}
async function recoverPane(p: Pane, socket: string, executable: string): Promise<void> {
  p.cwd = await safeDirectory(p.cwd);
  if (p.resume_hint.args() !== null) return p.sleep();
  p.terminal.feed("\x1b[0m\r\n\r\n# Recovered saved output; new shell.\r\n");
  await p.terminal.spawn(p.cwd, socket, p.id, executable, null, false);
}
