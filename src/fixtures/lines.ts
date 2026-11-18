import type { Duplex } from "node:stream";

/** Calls `each` with every line `socket` reads, such as the requests a client
 * writes to a fake daemon, until the socket is destroyed. */
export function lines(socket: Duplex, each: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0 && !socket.destroyed; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      each(line);
    }
  });
}
