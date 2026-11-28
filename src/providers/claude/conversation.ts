//! What Claude Code's hooks tell beyond its lifecycle: the background shells
//! and subagents a Stop lists, subagents it launches, and the pause while
//! background work can wake it.
import path from "node:path";
import { field, str, Text } from "../common";
import { Children, Inventory, Shells, capacity } from "../../activity/background_tasks";
import type { Actor, Registry } from "../../conversations";
import { running } from "./process";
import { subagentTranscript } from "./index";
/** A Stop's background task that still runs, as a shell or a subagent. */
function task(item: any) {
  if (["completed", "failed", "killed"].includes(str(item, "status"))) return null;
  const t = str(item, "type");
  return ["shell", "subagent"].includes(t) ? t : null;
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
/** The background shells a Stop lists as running: commands and Monitors
 * alike. Each one's end, and each event a Monitor prints, wakes the
 * conversation. Empty when the Stop lists no work at all. */
export function shells(value: any) {
  const out = new Shells();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (task(item) !== "shell") continue;
    const id = str(item, "id");
    if (!id || Buffer.byteLength(id) > 32 || out.listed(id) || out.len === capacity) continue;
    out.items.push(new Text(id));
  }
  return out;
}
/** A one-shot wakeup among a Stop's scheduled jobs. */
export function wakeup(crons: any) {
  return Array.isArray(crons) && crons.some(c => field(c, "recurring") === false);
}
/** The tool calls, by subagent, whose permission prompts a conversation
 * shows, and whether it waited on its subagents when the first one asked. The
 * prompt's notification names no agent, so it blocks the conversation itself.
 * A reload forgets them, and the next hook of the conversation's own ends the
 * block. */
const prompts = new WeakMap<Actor, { agents: Map<string, Set<bigint>>; waiting: boolean }>();
/** Keeps an actor's background shells and tasks as a hook reports them. */
export function hooked(actor: Actor, event: any, now: number) {
  if (!event.permission_notification) prompts.delete(actor);
  actor.state.subagents.waiting = false;
  const tasks = inventory(event.background_tasks, now);
  if (tasks) actor.background_tasks = tasks;
  if (event.kind === "session_end") actor.background_tasks = new Inventory();
  // A Stop lists only the tasks of the process that runs the session
  // now, so a shell of an earlier one drops out.
  if (event.kind === "stop") actor.shells = shells(event.background_tasks);
  if (event.kind === "session_end") actor.shells = new Shells();
}
/** Takes a subagent the parent launched or listed as its child. */
function adopt(
  registry: Registry,
  parent: Actor,
  meta: { id: Text; description: Text; agent_type: Text },
  now: number,
) {
  let child: Actor;
  try {
    child = registry.get(parent.provider(), meta.id.text());
  } catch {
    return false;
  }
  if (!registry.linkChild(parent, child)) return false;
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
/** Makes `found` the parent's subagents, and idles the ones a complete list leaves out. */
function follow(registry: Registry, parent: Actor, found: Children, now: number) {
  parent.state.subagents.running = found.running;
  parent.children_observed_at = now;
  for (const meta of found.slice()) adopt(registry, parent, meta, now);
  if (found.complete())
    for (const child of registry.items)
      if (child.parent === parent.id && child.state.state !== "idle" && !found.listed(child.state.sessionId())) {
        child.state.state = "idle";
        child.observed_at = now;
      }
}
/** Follows a hook the parent applied: subagents it launched or a Stop lists,
 * and a pause while its background work can wake it. */
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
        now,
      )
    ) {
      actor.state.subagents.running = Math.min(0xffffffff, actor.state.subagents.running + 1);
      actor.children_observed_at = now;
    }
  }
  const listed = children(event.background_tasks);
  if (listed === null && event.kind !== "session_end") return;
  const found = listed ?? new Children();
  follow(registry, actor, found, now);
  if (event.kind !== "stop") return;
  if (found.running > 0) actor.state.awaitSubagents(now);
  else {
    const wakes = wakeup(event.session_crons);
    if (actor.pid <= 0 || (!actor.shells.len && !wakes)) return;
    actor.state.paused = true;
    actor.paused_at = seq;
    actor.paused_for_wakeup = wakes;
  }
}
/** Ends the block subagents' prompts raised once each prompted call ends, or
 * its subagent stops (`call` null). A denied call sends no hook of its own. */
function answered(parent: Actor, subagent: string, call: bigint | null, now: number) {
  const asked = prompts.get(parent),
    calls = asked?.agents.get(subagent);
  if (!asked || !calls || (call !== null && !calls.delete(call))) return;
  if (call === null || !calls.size) asked.agents.delete(subagent);
  if (asked.agents.size) return;
  prompts.delete(parent);
  const own = parent.state;
  if (own.state !== "blocked") return;
  own.state = "working";
  own.subagents.waiting = asked.waiting && own.subagents.running > 0;
  own.tool_active = false;
  own.attention = own.observation.unread() ? "finished" : "none";
  own.changed_at = now;
}
/** A subagent's start, stop, permission prompt or tool. Only going on from
 * its prompt changes its parent's own state. */
export function child(registry: Registry, parent: Actor, event: any, now: number) {
  if (event.kind === "subagent_permission") {
    const asked = prompts.get(parent) ?? { agents: new Map(), waiting: parent.state.subagents.waiting };
    const calls = asked.agents.get(event.subagent) ?? new Set<bigint>();
    if (calls.size < capacity) calls.add(event.tool_call);
    if (asked.agents.size < capacity && Buffer.byteLength(event.subagent) <= 96)
      asked.agents.set(event.subagent, calls);
    prompts.set(parent, asked);
    return;
  }
  if (event.kind === "subagent_tool") return answered(parent, event.subagent, event.tool_call, now);
  if (event.kind === "subagent_stop") {
    // The list still has the stopping subagent running.
    const listed = children(event.background_tasks);
    if (listed) follow(registry, parent, listed.without(event.subagent), now);
    return answered(parent, event.subagent, null, now);
  }
  // A launch adopts a new subagent; a start only revives one a message resumed.
  const known = registry.find(parent.provider(), event.subagent);
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
