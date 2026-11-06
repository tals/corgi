//! What Claude Code's hooks tell beyond its lifecycle: the background shells
//! and subagents a Stop lists, subagents and teammates it launches, and the
//! pause while a Monitor or a wakeup can wake it.
import path from "node:path";
import { field, str, Text } from "../common";
import { Children, Inventory, Shells, capacity } from "../../activity/background_tasks";
import type { Actor, Registry } from "../../conversations";
import { running } from "./process";
import { subagentTranscript } from "./index";
/** A Stop's background task that still runs, as a shell, a subagent or a teammate. */
function task(item: any) {
  if (["completed", "failed", "killed"].includes(str(item, "status"))) return null;
  const t = str(item, "type");
  return ["shell", "subagent", "teammate"].includes(t) ? t : null;
}
export function inventory(value: any, now: number) {
  if (!Array.isArray(value)) return null;
  const t = new Inventory();
  t.observed_at = now;
  for (const item of value)
    if (task(item) === "shell") t.append(str(item, "id"), str(item, "description"), str(item, "command"));
  return t;
}
export function children(value: any) {
  if (!Array.isArray(value)) return null;
  const out = new Children();
  for (const item of value) {
    if (task(item) !== "subagent") continue;
    const id = str(item, "id");
    if (!id || Buffer.byteLength(id) > 96 || out.listed(id)) continue;
    out.running = Math.min(0xffffffff, out.running + 1);
    if (out.len === capacity) continue;
    out.items.push({
      id: new Text(id),
      description: new Text(str(item, "description").slice(0, 160)),
      agent_type: new Text(str(item, "agent_type").slice(0, 80)),
    });
  }
  return out;
}
/** How many teammates a Stop lists. It names each by a task id of its own,
 * not the agent id its hooks carry, and lists it as running while it idles. */
export function teammates(value: any) {
  return Array.isArray(value) ? value.filter(item => task(item) === "teammate").length : 0;
}
/** The background shells a Stop lists as running that `monitors` started.
 * Each event a Monitor prints wakes the conversation; a plain background
 * command is often a server that never ends. Empty when the Stop lists none. */
export function shells(value: any, monitors: ReadonlySet<string>) {
  const out = new Shells();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (task(item) !== "shell") continue;
    const id = str(item, "id");
    if (!id || Buffer.byteLength(id) > 32 || !monitors.has(id) || out.listed(id) || out.len === capacity) continue;
    out.items.push(new Text(id));
  }
  return out;
}
/** A one-shot wakeup among a Stop's scheduled jobs. */
export function wakeup(crons: any) {
  return Array.isArray(crons) && crons.some(c => field(c, "recurring") === false);
}
/** Adds what Claude's tool results tell to a decoded hook: the teammate the
 * Agent tool spawned, and the task a Monitor started. */
export function decoded<
  T extends { kind: string; tool: string; subagent: string; subagent_type: string; wake_task: string },
>(hook: T | null, v: unknown): T | null {
  if (hook?.kind !== "tool_finish") return hook;
  const response = field(v, "tool_response");
  if (str(response, "status") === "teammate_spawned") {
    hook.subagent = str(response, "agentId");
    hook.subagent_type = str(response, "name");
    Object.assign(hook, { teammate: true });
  }
  if (hook.tool === "Monitor") hook.wake_task = str(response, "taskId");
  return hook;
}
/** The Monitors each conversation started that may still run, by task id.
 * A reload forgets them, so a Monitor started before it doesn't pause the
 * conversation again. */
const monitors = new WeakMap<Actor, Set<string>>();
/** The children a conversation launched or a Stop listed as plain subagents,
 * not teammates. A reload forgets them, so a child restored from before it
 * may be either. */
const plain = new WeakSet<Actor>();
/** Keeps an actor's background shells and tasks as a hook reports them. */
export function hooked(actor: Actor, event: any, now: number) {
  actor.state.subagents.waiting = false;
  const tasks = inventory(event.background_tasks, now);
  if (tasks) actor.background_tasks = tasks;
  if (event.wake_task && Buffer.byteLength(event.wake_task) <= 32) {
    const started = monitors.get(actor) ?? new Set<string>();
    if (started.size < capacity) started.add(event.wake_task);
    monitors.set(actor, started);
  }
  // A Stop lists only the tasks of the process that runs the session
  // now, so a shell of an earlier one drops out.
  if (event.kind === "stop") {
    actor.shells = shells(event.background_tasks, monitors.get(actor) ?? new Set());
    monitors.set(actor, new Set(actor.shells.items.map(id => id.text())));
  }
  if (event.kind === "session_end") {
    actor.background_tasks = new Inventory();
    actor.shells = new Shells();
    monitors.delete(actor);
  }
}
/** Takes a subagent or teammate the parent launched or listed as its child. */
function adopt(
  registry: Registry,
  parent: Actor,
  meta: { id: Text; description: Text; agent_type: Text },
  teammate: boolean,
  now: number,
) {
  let child: Actor;
  try {
    child = registry.get(parent.provider(), meta.id.text());
  } catch {
    return false;
  }
  if (!registry.linkChild(parent, child)) return false;
  if (teammate) plain.delete(child);
  else plain.add(child);
  if (!child.state.transcript.len && path.isAbsolute(parent.state.transcriptPath()))
    child.state.transcript = new Text(
      subagentTranscript(parent.state.transcriptPath(), parent.state.sessionId(), meta.id.text()),
    );
  child.role = meta.agent_type;
  child.state.setName(meta.agent_type.text());
  child.state.setActivity(meta.description.text());
  child.state.state = "working";
  child.observed_at = now;
  return true;
}
/** Makes `found` the parent's subagents, and idles the ones a complete list
 * leaves out. While the list has `teammates`, as many working children that
 * aren't plain subagents may be them; their own start and stop say when they work. */
function follow(registry: Registry, parent: Actor, found: Children, teammates: number, now: number) {
  parent.children_observed_at = now;
  for (const meta of found.slice()) adopt(registry, parent, meta, false, now);
  let busy = 0;
  for (const child of registry.items) {
    if (child.parent !== parent.id || child.state.state === "idle" || found.listed(child.state.sessionId())) continue;
    if (busy < teammates && !plain.has(child)) busy++;
    else if (found.complete()) {
      child.state.state = "idle";
      child.observed_at = now;
    }
  }
  parent.state.subagents.running = Math.min(0xffffffff, found.running + busy);
}
/** Follows a hook the parent applied: subagents it launched or a Stop lists,
 * and a pause while a Monitor or a wakeup can wake it. */
export function applied(registry: Registry, actor: Actor, event: any, seq: bigint, now: number) {
  if (event.subagent && Buffer.byteLength(event.subagent) <= 96) {
    const known = registry.find(actor.provider(), event.subagent);
    if (
      known?.state.state !== "working" &&
      adopt(
        registry,
        actor,
        {
          id: new Text(event.subagent),
          description: new Text(event.description),
          agent_type: new Text(event.subagent_type),
        },
        event.teammate === true,
        now,
      )
    ) {
      actor.state.subagents.running = Math.min(0xffffffff, actor.state.subagents.running + 1);
      actor.children_observed_at = now;
    }
  }
  const listed = children(event.background_tasks);
  if (listed === null && event.kind !== "session_end") return;
  follow(registry, actor, listed ?? new Children(), teammates(event.background_tasks), now);
  if (event.kind !== "stop") return;
  if (actor.state.subagents.running > 0) actor.state.awaitSubagents(now);
  else {
    const wakes = wakeup(event.session_crons);
    if (actor.pid <= 0 || (!actor.shells.len && !wakes)) return;
    actor.state.paused = true;
    actor.paused_at = seq;
    actor.paused_for_wakeup = wakes;
  }
}
/** A subagent's start or stop, which leaves its parent's own state alone. */
export function child(registry: Registry, parent: Actor, event: any, now: number) {
  const known = registry.find(parent.provider(), event.subagent);
  if (event.kind === "subagent_stop") {
    // A teammate idles until a message starts it again.
    if (known?.parent === parent.id && known.state.state !== "idle") {
      known.state.state = "idle";
      known.observed_at = now;
    }
    // The list still has the stopping subagent running.
    const listed = children(event.background_tasks);
    if (listed) follow(registry, parent, listed.without(event.subagent), teammates(event.background_tasks), now);
    return;
  }
  // A launch adopts a new subagent; a start only revives one a message resumed.
  if (!known || known.parent !== parent.id || known.state.state === "working") return;
  known.state.state = "working";
  known.observed_at = now;
  parent.state.subagents.running = Math.min(0xffffffff, parent.state.subagents.running + 1);
  parent.children_observed_at = now;
}
/** Whether the process that holds a pause still runs Claude Code. */
export function holds(pid: number) {
  return running(pid);
}
