import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directory } from "./integration";
type Status = "named" | "exists" | "unavailable";
function request(path: string, session: string, name?: string, only_unnamed = false): Promise<Status> {
  return new Promise(resolve => {
    const socket = createConnection(path),
      finish = (status: Status) => {
        socket.destroy();
        resolve(status);
      };
    let bytes = "";
    socket.setTimeout(1500, () => finish("unavailable"));
    socket.on("error", () => finish("unavailable"));
    socket.on("end", () => finish("unavailable"));
    socket.on("connect", () => socket.write(JSON.stringify({ session, name, only_unnamed }) + "\n"));
    socket.on("data", data => {
      bytes += data;
      if (bytes.length > 1024) return finish("unavailable");
      if (bytes.includes("\n")) {
        try {
          const response = JSON.parse(bytes);
          finish(
            response.exists === true
              ? "exists"
              : response.ok === true && (!only_unnamed || response.automatic === true)
                ? "named"
                : "unavailable",
          );
        } catch {
          finish("unavailable");
        }
      }
    });
  });
}
/** Renames through the socket each session of the `id` extension listens on. */
export function sockets(id: string, directory: (account: string) => string) {
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
      if ((await request(path, session, undefined, automatic)) === "named") return path;
    }
    return null;
  }
  return {
    async channel(session: string, _connected = false, account = "") {
      const path = await locate(session, account);
      return path
        ? async (name: string) => {
            if ((await request(path, session, name)) !== "named") throw Error("PiRenameFailed");
          }
        : null;
    },
    async suggest(session: string, name: string, account = ""): Promise<Status> {
      const path = await locate(session, account, true);
      return path ? request(path, session, name, true) : "unavailable";
    },
  };
}
export const { channel, suggest } = sockets("pi", directory);
