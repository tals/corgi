import * as viewerNative from "./viewer_native";
import { adapter } from "./providers";
import { milliTimestamp, microTimestamp } from "./clock";
import type { Runtime, Pane } from "./runtime";
import type { Terminal } from "./pane/terminal";
export const max_name = 80;
export function validName(value: string | Uint8Array) {
  let name: string;
  try {
    name = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return false;
  }
  return name.length > 0 && Buffer.byteLength(name) <= max_name && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(name);
}
export async function paste(t: Terminal, text: string) {
  const mode = t.bracketed_paste;
  await t.send((mode ? "\x1b[200~" : "") + text + (mode ? "\x1b[201~" : ""));
}
export async function submit(t: Terminal) {
  await t.send(viewerNative.encodeKey(t.handle, { codepoint: 13, mods: {} }));
}
function renamed(runtime: Runtime, pane: Pane, name: string) {
  pane.agent().setName(name);
  pane.label = "";
  runtime.changed();
}
/** Renames the agent `pane` shows, or with a null `name` only checks that it can. */
export async function renamePane(pane: Pane, name: string | null, runtime: Runtime) {
  const agent = pane.agent();
  if (pane.terminal.exited || !agent.provider) throw new Error("NoConversation");
  if (name !== null && !validName(name)) throw new Error("InvalidName");
  const rename = adapter(agent.provider).rename;
  if (!rename) throw new Error("RenameUnavailable");
  const channel = agent.session.len
    ? await rename.channel(agent.sessionId(), microTimestamp() - agent.protocol_at < 5e6, pane.account())
    : null;
  if (channel) {
    if (name !== null) {
      await channel(name);
      renamed(runtime, pane, name);
    }
    return;
  }
  const typed = rename.typed;
  if (!typed) throw new Error(agent.session.len ? "RenameUnavailable" : "NoConversation");
  if (!typed.empty(pane.terminal)) throw new Error("AgentBusy");
  if (name === null) return;
  const text = typed.command(name);
  if (Buffer.byteLength(text) + 4 > pane.terminal.cols) throw new Error("InvalidName");
  if (runtime.renames.some(r => r.pane === pane.id)) throw new Error("AgentBusy");
  await paste(pane.terminal, text);
  runtime.renames.push({
    pane: pane.id,
    name,
    deadline: milliTimestamp() + 2000,
  });
}
export async function advance(runtime: Runtime, now: number) {
  for (let i = runtime.renames.length - 1; i >= 0; i--) {
    const pending = runtime.renames[i],
      pane = runtime.pane(pending.pane),
      provider = pane?.agent().provider,
      typed = provider ? adapter(provider).rename?.typed : null;
    if (!pane || !typed) {
      runtime.renames.splice(i, 1);
      continue;
    }
    if (typed.holds(pane.terminal, typed.command(pending.name))) {
      await submit(pane.terminal);
      renamed(runtime, pane, pending.name);
    } else if (now < pending.deadline) continue;
    runtime.renames.splice(i, 1);
  }
  for (let i = runtime.wanted_names.length - 1; i >= 0; i--) {
    const wanted = runtime.wanted_names[i],
      pane = runtime.pane(wanted.pane);
    if (!pane) {
      runtime.wanted_names.splice(i, 1);
      continue;
    }
    try {
      await renamePane(pane, wanted.name, runtime);
      runtime.wanted_names.splice(i, 1);
    } catch (e) {
      if (
        now >= wanted.deadline ||
        !["NoConversation", "RenameUnavailable", "AgentBusy"].includes((e as Error).message)
      )
        runtime.wanted_names.splice(i, 1);
    }
  }
}
