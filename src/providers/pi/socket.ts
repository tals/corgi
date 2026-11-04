//! Talks to a Pi or OMP session through the socket Corgi's extension opens in
//! it: renames it, or sends it a prompt.
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directory } from "./integration";
type Status = "named" | "exists" | "unavailable";
/** What came back for one request: the extension's reply, or why none did.
 * `refused` means it never reached the extension. */
type Exchange = { reply: Record<string, unknown> } | "refused" | "unanswered";
function exchange(path: string, body: object): Promise<Exchange> {
  return new Promise(resolve => {
    const socket = createConnection(path),
      finish = (result: Exchange) => {
        socket.destroy();
        resolve(result);
      };
    let bytes = "",
      connected = false;
    socket.setEncoding("utf8");
    socket.setTimeout(1500, () => finish("unanswered"));
    socket.on("error", () => finish(connected ? "unanswered" : "refused"));
    socket.on("end", () => finish("unanswered"));
    socket.on("connect", () => {
      connected = true;
      socket.write(JSON.stringify(body) + "\n");
    });
    socket.on("data", data => {
      bytes += data;
      if (bytes.length > 1024) return finish("unanswered");
      if (!bytes.includes("\n")) return;
      try {
        const reply = JSON.parse(bytes);
        finish(reply && typeof reply === "object" ? { reply } : "unanswered");
      } catch {
        finish("unanswered");
      }
    });
  });
}
function status(result: Exchange, only_unnamed: boolean): Status {
  if (typeof result === "string") return "unavailable";
  const { reply } = result;
  return reply.exists === true
    ? "exists"
    : reply.ok === true && (!only_unnamed || reply.automatic === true)
      ? "named"
      : "unavailable";
}
async function request(path: string, session: string, name?: string, only_unnamed = false): Promise<Status> {
  return status(await exchange(path, { session, name, only_unnamed }), only_unnamed);
}
/** Sends `text` as a prompt through the extension at `path`, which said it
 * takes prompts; `prompted` in its reply says it did. */
async function prompt(path: string, session: string, text: string) {
  const result = await exchange(path, { session, prompt: text });
  if (result === "unanswered") throw Error("DeliveryUnknown");
  if (result === "refused" || result.reply.prompted !== true) throw Error("MessageUnavailable");
}
/** Renames and prompts through the socket each session of the `id`
 * extension listens on. */
export function sockets(id: string, directory: (account: string) => string) {
  /** The socket serving `session`, and whether its extension takes prompts:
   * older ones don't, and drop a long request unanswered. */
  async function locate(session: string, account: string, automatic = false) {
    const uid = process.getuid?.() ?? 0;
    const hash = createHash("sha256")
      .update(directory(account) + "\n" + session)
      .digest("hex")
      .slice(0, 24);
    const prefix = `corgi-${id}-${uid}-${hash}-`;
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith(prefix) || !name.endsWith(".sock")) continue;
      const path = join(tmpdir(), name);
      try {
        const s = await lstat(path);
        if (!s.isSocket() || s.uid !== uid) continue;
      } catch {
        continue;
      }
      const result = await exchange(path, { session, only_unnamed: automatic });
      if (status(result, automatic) === "named")
        return { path, prompts: typeof result !== "string" && result.reply.prompts === true };
    }
    return null;
  }
  return {
    async channel(session: string, _connected = false, account = "") {
      const found = await locate(session, account);
      return found
        ? async (name: string) => {
            if ((await request(found.path, session, name)) !== "named") throw Error("PiRenameFailed");
          }
        : null;
    },
    async suggest(session: string, name: string, account = ""): Promise<Status> {
      const found = await locate(session, account, true);
      return found ? request(found.path, session, name, true) : "unavailable";
    },
    async message(session: string, _connected = false, account = "") {
      const found = await locate(session, account);
      return found?.prompts ? (text: string) => prompt(found.path, session, text) : null;
    },
  };
}
export const { channel, suggest, message } = sockets("pi", directory);
