//! Messages an agent through its provider's own channel when one reaches it,
//! or else types the message into its pane and submits it.
import * as viewerNative from "./viewer_native";
import * as errors from "./errors";
import { adapter } from "./providers";
import { microTimestamp } from "./clock";
import type { Runtime, Pane } from "./runtime";
import type { Terminal } from "./pane/terminal";
import type { State } from "./agents";
import type { Delivery } from "./protocol";
import type { Target } from "./agent_order";
/** How a message reached its agent, and whether the agent was mid-turn, so
 * the message waits for, or steers, the turn under way. */
export type Sent = { delivery: Delivery; queued: boolean };
const paste_end = "\x1b[201~";
/** Types `text` into `t`, as a paste when its program asked for bracketed
 * paste. A paste can't end early: `text` loses any end-of-paste sequence. */
export async function paste(t: Terminal, text: string) {
  if (!t.bracketed_paste) return await t.send(text);
  while (text.includes(paste_end)) text = text.replaceAll(paste_end, "");
  await t.send("\x1b[200~" + text + paste_end);
}
/** Presses Enter in `t`, in its program's keyboard protocol. */
export async function submit(t: Terminal) {
  await t.send(viewerNative.encodeKey(t.handle, { codepoint: 13, mods: {} }));
}
/** Sends `text` to the agent `target` names as a prompt. Typing refuses an
 * agent that is answering a prompt, or whose composer holds a draft. */
export async function send(r: Runtime, target: Target, text: string): Promise<Sent> {
  if (!text) throw Error("InvalidMessage");
  if ("headless" in target) {
    const session = r.sessions.find(s => s.id === target.headless);
    if (!session) throw Error("NoHeadlessSession");
    if (session.exited) throw Error("HeadlessExited");
    const queued = busy(session.status());
    session.send({ kind: "prompt", text, ...(session.session ? { session: session.session } : {}) });
    return { delivery: "message", queued };
  }
  const pane = r.pane(target.pane);
  if (!pane) throw Error("NoPane");
  if (pane.dormant) throw Error("PaneAsleep");
  if (pane.terminal.exited) throw Error("PaneExited");
  const agent = pane.agent(),
    queued = busy(agent.state),
    message = agent.provider ? adapter(agent.provider).message : undefined,
    channel =
      message && agent.session.len
        ? await message.channel(agent.sessionId(), microTimestamp() - agent.protocol_at < 5e6, pane.account())
        : null;
  if (channel)
    try {
      await channel(text);
      return { delivery: "message", queued };
    } catch (error) {
      if (!errors.is(error, "MessageUnavailable")) throw error;
    }
  if (agent.state === "blocked") throw Error("AgentBlocked");
  if (message?.empty && !message.empty(pane.terminal)) throw Error("AgentBusy");
  await paste(pane.terminal, text);
  await submit(pane.terminal);
  return { delivery: "typed", queued };
}
function busy(state: State) {
  return state === "working" || state === "blocked";
}
