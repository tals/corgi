//! Messages an agent through its provider's own channel when one reaches it,
//! or else types the message into its pane and submits it.
import * as viewerNative from "./viewer_native";
import { adapter } from "./providers";
import { logicalKey } from "./keys";
import { microTimestamp } from "./clock";
import type { Runtime, Pane } from "./runtime";
import type { State } from "./agents";
import type { Target } from "./agent_order";
/** How a message reached its agent: its provider's channel, or the pane's keyboard. */
export type Delivery = "message" | "typed";
/** How a message reached its agent, and whether the agent was mid-turn, so
 * the message waits for, or steers, the turn under way. */
export type Sent = { delivery: Delivery; queued: boolean };
/** Types `text` into `pane`, as a paste when its program asked for bracketed
 * paste, then Enter if `enter`. */
export async function type(pane: Pane, text: string, enter: boolean) {
  const bracketed = pane.terminal.bracketed_paste ?? false;
  await pane.terminal.send(
    (bracketed ? "\x1b[200~" : "") +
      text +
      (bracketed ? "\x1b[201~" : "") +
      (enter ? viewerNative.encodeKey(pane.terminal.handle, logicalKey("enter")) : ""),
  );
}
/** Sends `text` to the agent `target` names as a prompt. */
export async function send(r: Runtime, target: Target, text: string): Promise<Sent> {
  if (!text) throw Error("InvalidMessage");
  if ("headless" in target) {
    const session = r.sessions.find(s => s.id === target.headless);
    if (!session) throw Error("NoHeadlessSession");
    const queued = busy(session.status());
    session.send({ kind: "prompt", text, ...(session.session ? { session: session.session } : {}) });
    return { delivery: "message", queued };
  }
  const pane = r.pane(target.pane);
  if (!pane) throw Error("NoPane");
  const agent = pane.agent(),
    queued = busy(agent.state),
    message = agent.provider && agent.session.len && !pane.terminal.exited ? adapter(agent.provider).message : null,
    channel = message
      ? await message(agent.sessionId(), microTimestamp() - agent.protocol_at < 5e6, pane.account())
      : null;
  if (channel) {
    await channel(text);
    return { delivery: "message", queued };
  }
  await type(pane, text, true);
  return { delivery: "typed", queued };
}
function busy(state: State) {
  return state === "working" || state === "blocked";
}
