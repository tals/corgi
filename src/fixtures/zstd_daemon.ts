import { createConnection, createServer } from "node:net";
import { Connection } from "../rpc";
import { Channel } from "../wire_compression";
import { listen } from "./tcp";

/** A daemon on a local TCP port that agrees to zstd in `hello`, answers a
 * later request with the messages `answer` gives, compressed, and resets the
 * connection once they are written. `answer` returns null to stay silent. */
export async function resetting(answer: (request: any) => object[] | null) {
  let encoder: Channel | null = null;
  const server = createServer(socket => {
    let input = "",
      compressed = false;
    const read = (bytes: Buffer) => {
      input += bytes.toString();
      for (let end = input.indexOf("\n"); end >= 0; end = input.indexOf("\n")) {
        const request = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        if (request.op === "hello") {
          socket.write(
            JSON.stringify({ type: "hello", content_encoding: "zstd", request_id: request.request_id }) + "\n",
          );
          encoder = new Channel(
            bytes => socket.write(bytes),
            read,
            () => socket.destroy(),
          );
          compressed = true;
          continue;
        }
        const messages = answer(request);
        if (messages)
          encoder!.encode(Buffer.from(messages.map(value => JSON.stringify(value) + "\n").join("")), () =>
            socket.resetAndDestroy(),
          );
      }
    };
    socket.on("data", bytes => (compressed ? encoder!.decode(Buffer.from(bytes)) : read(Buffer.from(bytes))));
    socket.on("error", () => {});
  });
  const port = await listen(server);
  return {
    /** A compressing client of this daemon. */
    connect: () => new Connection(createConnection(port, "127.0.0.1"), { compression: true, timeout_ms: 1000 }),
    async close() {
      (encoder as Channel | null)?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
