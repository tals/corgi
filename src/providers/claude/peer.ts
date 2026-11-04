//! Talks to a running Claude Code session through the messaging socket its
//! session record names: renames it, or queues a prompt for it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import * as errors from "../../errors";
export interface Peer {
  socket: string;
  token: string;
}
/** The live peer `folder`'s session records name for `session`. */
export async function peerIn(folder: string, session: string): Promise<Peer | null> {
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
      const digest = createHash("sha256").update(record.messagingSocketPath).digest("hex"),
        key = JSON.parse(await readFile(join(folder, `${record.pid}.${digest}.key`), "utf8"));
      if (key.peerToken) return { socket: record.messagingSocketPath, token: key.peerToken };
    } catch {}
  }
  return null;
}
/** Writes `frame` to `peer`'s inbox after its auth line. Throws ConnectFailed
 * when the inbox refused or never accepted the connection, and Timeout when
 * the session didn't take the frame within `timeout` ms, as when it is
 * stopped: the daemon waits on this. */
function write(peer: Peer, frame: object, timeout = 2000) {
  const text = JSON.stringify({ type: "auth", token: peer.token }) + "\n" + JSON.stringify(frame) + "\n";
  return new Promise<void>((resolve, reject) => {
    const connection = createConnection(peer.socket),
      timer = setTimeout(() => settle(Error(connected ? "Timeout" : "ConnectFailed")), timeout);
    let connected = false,
      settled = false;
    const settle = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
      connection.destroy();
    };
    connection.once("error", error => settle(connected ? error : Error("ConnectFailed")));
    connection.once("connect", () => {
      connected = true;
      connection.end(text, settle);
    });
  });
}
export function rename(peer: Peer, session: string, name: string) {
  return write(peer, {
    type: "control",
    action: "rename",
    name,
    session_id: session,
    from: "uds:" + peer.socket,
    msg_id: randomUUID(),
  });
}
/** Queues `text` as a prompt: it starts a turn when the session is idle, or
 * runs after the current one. Throws MessageUnavailable when the inbox
 * refused the connection, and DeliveryUnknown when it failed after taking
 * some of the frame. */
export async function message(peer: Peer, session: string, text: string, timeout?: number) {
  const frame = {
    type: "user",
    message: { role: "user", content: text },
    priority: "next",
    session_id: session,
    msg_id: randomUUID(),
  };
  try {
    await write(peer, frame, timeout);
  } catch (error) {
    throw Error(errors.is(error, "ConnectFailed") ? "MessageUnavailable" : "DeliveryUnknown");
  }
}
