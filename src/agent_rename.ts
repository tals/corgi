import { visibleWidth } from "@earendil-works/pi-tui";
import { encode } from "./keyboard";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { Provider } from "./providers";
import { milliTimestamp, microTimestamp } from "./clock";
import type { Runtime, Pane } from "./runtime";
export const max_name = 80;
export function validName(value: string | Uint8Array) {
  let name: string;
  try {
    name =
      typeof value === "string"
        ? value
        : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return false;
  }
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= max_name &&
    !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(name)
  );
}
export interface Peer {
  socket: string;
  token: string;
}
export async function peerIn(
  folder: string,
  session: string,
): Promise<Peer | null> {
  let files: string[];
  try {
    files = await readdir(folder);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(folder, file), "utf8"));
      if (
        String(record.sessionId).toLowerCase() !== session.toLowerCase() ||
        record.peerProtocol !== 1 ||
        !record.messagingSocketPath ||
        record.pid <= 1
      )
        continue;
      try {
        process.kill(record.pid, 0);
      } catch {
        continue;
      }
      const digest = createHash("sha256")
          .update(record.messagingSocketPath)
          .digest("hex"),
        key = JSON.parse(
          await readFile(join(folder, `${record.pid}.${digest}.key`), "utf8"),
        );
      if (key.peerToken)
        return { socket: record.messagingSocketPath, token: key.peerToken };
    } catch {}
  }
  return null;
}
export async function claudePeer(session: string) {
  return peerIn(join(Provider.info("claude").configDir(), "sessions"), session);
}
async function send(socket: string, text: string) {
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(socket);
    connection.once("error", reject);
    connection.once("connect", () =>
      connection.end(text, () => {
        resolve();
        connection.destroy();
      }),
    );
  });
}
export async function renameClaude(peer: Peer, session: string, name: string) {
  await send(
    peer.socket,
    JSON.stringify({ type: "auth", token: peer.token }) +
      "\n" +
      JSON.stringify({
        type: "control",
        action: "rename",
        name,
        session_id: session,
        from: "uds:" + peer.socket,
        msg_id: randomUUID(),
      }) +
      "\n",
  );
}
export async function renameCodex(id: string, name: string) {
  const socket = join(
    Provider.info("codex").configDir(),
    "app-server-control/app-server-control.sock",
  );
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(socket),
      request = 1;
    let buffer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("TimedOut"));
    }, 3000);
    connection.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    connection.once("connect", () =>
      connection.write(
        JSON.stringify({
          id: request,
          method: "thread/name/set",
          params: { threadId: id, name },
        }) + "\n",
      ),
    );
    connection.on("data", (data) => {
      buffer += data;
      for (const line of buffer.split("\n").slice(0, -1)) {
        try {
          const reply = JSON.parse(line);
          if (reply.id !== request) continue;
          clearTimeout(timer);
          connection.destroy();
          reply.error ? reject(new Error("RenameUnavailable")) : resolve();
        } catch {}
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
  });
}
export function command(name: string) {
  return "/rename " + name;
}
function input(t: any) {
  if ((t.title ?? t.vt?.getTitle?.() ?? "").includes("[ ! ] Action Required"))
    return null;
  const frame = t.capture?.(0) ?? t.surface?.(0);
  if (!frame) return null;
  const surface = frame.surface ?? frame,
    cursor = surface.cursor;
  if (!cursor || cursor.visible === false) return null;
  const raw = surface.lines[cursor.y] ?? "";
  const characters: {
    text: string;
    bold: boolean;
    faint: boolean;
    inverse: boolean;
  }[] = [];
  let bold = false,
    faint = false,
    inverse = false;
  for (const match of raw.matchAll(/\x1b\[([0-9;]*)m|([^\x1b]+)/gu)) {
    if (match[1] !== undefined) {
      const codes = match[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) {
          bold = false;
          faint = false;
          inverse = false;
        } else if (code === 1) bold = true;
        else if (code === 2) faint = true;
        else if (code === 7) inverse = true;
        else if (code === 22) {
          bold = false;
          faint = false;
        } else if (code === 27) inverse = false;
        else if (code === 38 || code === 48 || code === 58)
          i += codes[i + 1] === 2 ? 4 : 2;
      }
    } else
      for (const text of match[2])
        characters.push({ text, bold, faint, inverse });
  }
  const marker = characters[0];
  if (
    marker?.text !== "›" ||
    characters[1]?.text !== " " ||
    !marker.bold ||
    marker.faint ||
    marker.inverse
  )
    return null;
  const text = characters
    .slice(2)
    .map((c) => c.text)
    .join("")
    .trimEnd();
  const visible = characters.slice(2).filter((c) => c.text.trim().length > 0);
  return {
    text,
    placeholder: visible.length > 0 && visible.every((c) => c.faint),
    text_end: 2 + visibleWidth(text),
    cursor: cursor.x,
    below: surface.lines
      .slice(cursor.y + 1, cursor.y + 4)
      .join("\n")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
  };
}
export function codexEmpty(t: any) {
  const row = input(t);
  return (
    !!row &&
    row.cursor === 2 &&
    row.placeholder &&
    row.below.includes("? for shortcuts")
  );
}
export function codexHolds(t: any, text: string) {
  const row = input(t);
  return (
    !!row &&
    !row.placeholder &&
    row.text === text &&
    row.cursor === row.text_end
  );
}
export async function paste(t: any, text: string) {
  const mode = t.bracketed_paste ?? t.modes?.bracketed_paste ?? false;
  await t.send((mode ? "\x1b[200~" : "") + text + (mode ? "\x1b[201~" : ""));
}
export async function submit(t: any) {
  const modes = t.surface?.(0)?.modes ?? {};
  await t.send(
    encode(
      { codepoint: 13, mods: {} },
      { kitty: !!(modes.kitty & 1), alt_escape: modes.alt_escape },
    ),
  );
}
function renamed(runtime: Runtime, pane: Pane, name: string) {
  pane.agent().setName(name);
  pane.label = "";
  runtime.changed();
}
export async function renamePane(
  pane: Pane,
  name: string | null,
  runtime: Runtime,
) {
  const agent = pane.agent();
  if (pane.terminal.exited || !agent.provider)
    throw new Error("NoConversation");
  if (name !== null && !validName(name)) throw new Error("InvalidName");
  if (agent.provider === "claude") {
    if (!agent.session.len) throw new Error("NoConversation");
    const peer = await claudePeer(agent.sessionId());
    if (!peer) throw new Error("RenameUnavailable");
    if (name !== null) {
      await renameClaude(peer, agent.sessionId(), name);
      renamed(runtime, pane, name);
    }
    return;
  }
  if (agent.session.len === 36 && microTimestamp() - agent.protocol_at < 5e6) {
    if (name !== null) {
      await renameCodex(agent.sessionId(), name);
      renamed(runtime, pane, name);
    }
    return;
  }
  if (!codexEmpty(pane.terminal)) throw new Error("AgentBusy");
  if (name === null) return;
  const text = command(name);
  if (Buffer.byteLength(text) + 4 > pane.terminal.cols)
    throw new Error("InvalidName");
  if (runtime.renames.some((r) => r.pane === pane.id))
    throw new Error("AgentBusy");
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
      pane = runtime.pane(pending.pane);
    if (!pane) {
      runtime.renames.splice(i, 1);
      continue;
    }
    if (codexHolds(pane.terminal, command(pending.name))) {
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
        !["NoConversation", "RenameUnavailable", "AgentBusy"].includes(
          (e as Error).message,
        )
      )
        runtime.wanted_names.splice(i, 1);
    }
  }
}
