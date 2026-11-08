// XXX: Remove for next protocol bump. Upgrade clients must reach pre-HTTP
// daemons, and older HTTP daemons drop the reload reply during handoff.
import * as net from "node:net";
import * as json from "./json";
import * as errors from "./errors";
import type * as protocol from "./protocol";

export function probeAfter(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (
    code === "HPE_INVALID_CONSTANT" || code === "ECONNRESET" || code === "EPIPE" || errors.is(error, "RequestTimedOut")
  );
}
export function needsStream(op: unknown, hello: protocol.Response<"hello">, transport: "http" | "stream") {
  return transport === "stream" || (op === "server.reload" && ("err" in hello || hello.transports?.http !== 1));
}
/** One request, no correlation or subscription state. Never retries a mutation. */
export function request(path: string, value: unknown, timeout_ms: number): Promise<unknown> {
  const bytes = Buffer.from(json.stringify(json.object(value)) + "\n");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let buffer = Buffer.alloc(0),
      done = false;
    const finish = (error?: Error, reply?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(reply);
    };
    const timer = setTimeout(() => finish(Error("RequestTimedOut")), timeout_ms);
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(Error("ConnectionClosed")));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 64 * 1024 * 1024) return finish(Error("MessageTooLarge"));
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        finish(undefined, json.parse(buffer.toString("utf8", 0, end)));
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.write(bytes);
  });
}
