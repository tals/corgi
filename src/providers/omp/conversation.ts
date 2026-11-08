import type { Actor, Registry } from "../../conversations";
import { processArgs } from "../../os";
import { identify } from "../../detection";
import { owns, type Hook } from "../common";
import { info } from "./info";
export { child } from "../pi/conversation";

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

/** Native process inspection avoids spawning a command on pause checks. */
export function holds(pid: number) {
  if (pid <= 1) return false;
  const process = processArgs(pid, 1024 * 1024, { env: false });
  return !!process?.complete && (owns(info.programs, process.exe) || identify(process.argv) === "omp");
}
