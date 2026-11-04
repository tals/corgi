//! Talks to a running Claude Code session through the messaging socket its
//! session record names: renames it, or queues a prompt for it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
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
/** Writes `frame` to `peer`'s inbox after its auth line. */
function write(peer: Peer, frame: object) {
  const text = JSON.stringify({ type: "auth", token: peer.token }) + "\n" + JSON.stringify(frame) + "\n";
  return new Promise<void>((resolve, reject) => {
    const connection = createConnection(peer.socket);
    connection.once("error", reject);
    connection.once("connect", () =>
      connection.end(text, () => {
        resolve();
        connection.destroy();
      }),
    );
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
 * runs after the current one. */
export function message(peer: Peer, session: string, text: string) {
  return write(peer, {
    type: "user",
    message: { role: "user", content: text },
    priority: "next",
    session_id: session,
    msg_id: randomUUID(),
  });
}
