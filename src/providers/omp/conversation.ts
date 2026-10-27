import path from "node:path";
import type { Actor, Registry } from "../../conversations";
import { Path, Text } from "../../agents";
import { processArgs } from "../../os";
import { identify } from "../../detection";
import { Model } from "../model";
import { owns, type Hook } from "../common";
import { info } from "./info";

export function hooked(actor: Actor, event: Hook, now: number) {
  if (event?.owner_pid) actor.pid = event.owner_pid;
  if (event?.kind === "activity" || (event?.kind === "tool_start" && event.description && !event.asking))
    actor.checkpointActivity(event.activity_amend, now);
}

/** Only a completed turn waiting for async work holds an idle pause. */
export function applied(_registry: Registry, actor: Actor, event: Hook, seq: bigint) {
  if (event?.kind !== "stop" || !event.awaiting_async_work || event.outcome !== "completed") return;
  actor.state.paused = true;
  actor.paused_at = seq;
  actor.paused_for_wakeup = true;
}

function recount(registry: Registry, parent: Actor, now: number) {
  let running = 0;
  let blocked = 0;
  for (const child of registry.items) {
    if (child.parent !== parent.id) continue;
    if (child.state.state === "working" || child.state.state === "blocked") running++;
    if (child.state.state === "blocked") blocked++;
  }
  parent.state.subagents.running = running;
  parent.state.subagents.blocked = blocked;
  parent.children_observed_at = Math.max(parent.children_observed_at, now);
}

/** Child lifecycle never acts as parent activity or changes its binding. */
export function child(registry: Registry, parent: Actor, event: Hook, now: number) {
  if (!event?.subagent || !["subagent_start", "subagent_stop"].includes(event.kind)) return;
  let actor: Actor;
  try {
    actor = registry.get(parent.provider(), event.subagent);
  } catch {
    return;
  }
  if (!registry.linkChild(parent, actor)) return;
  if (event.subagent_type) actor.role = new Text(event.subagent_type);
  if (event.subagent_name || !actor.state.name.len) actor.state.setName(event.subagent_name || event.subagent_type);
  if (event.description) {
    actor.state.setActivity(event.description);
    actor.state.activity_inferred = false;
    actor.state.activity_at = now;
    actor.checkpointActivity(false, now);
  }
  if (path.isAbsolute(event.child_transcript)) actor.state.transcript = new Path(event.child_transcript);
  if (event.model) {
    actor.state.model = new Text(event.model);
    actor.model = Model.resolve(event.model);
    actor.model_from_hook = true;
  }
  actor.state.state = event.kind === "subagent_stop" ? "idle" : "working";
  actor.state.trackWorking(now);
  actor.observed_at = now;
  recount(registry, parent, now);
}

/** Native process inspection avoids spawning a command on pause checks. */
export function holds(pid: number) {
  if (pid <= 1) return false;
  const process = processArgs(pid, 1024 * 1024, { env: false });
  return !!process?.complete && (owns(info.programs, process.exe) || identify(process.argv) === "omp");
}
