//! The daemon's Unix socket, served by Bun: one-shot HTTP `POST`s and
//! WebSocket connections that carry JSON lines. It binds beside its path and
//! renames itself into place, so a reload replaces the old daemon's socket
//! with no moment where nothing listens, and finds out it can't bind before
//! it commits.
import * as fs from "node:fs";
import * as path from "node:path";
import * as json from "./json";
import * as os from "./os";
import * as wire_websocket from "./wire_websocket";
import type * as peer from "./peer";

export interface Accept {
  /** A WebSocket opened; null refuses it. */
  connection(transport: peer.Transport): peer.Client | null;
  /** An HTTP request's envelope, answered once; null refuses it. */
  request(value: unknown, respond: (reply: unknown) => void): peer.Client | null;
}
export type Server = Bun.Server<peer.Client | null>;
/** Requests and lines a client can send at once. */
const limit = 4 * 1024 * 1024;

/** A server bound beside the socket, not yet answering on it. */
export interface Bound {
  /** Moves it over the socket: from now on it answers there. */
  publish(): Server;
  /** Stops it, and removes its name. */
  abandon(): void;
}
/** Binds `socket` at once. */
export function listen(socket: string, accept: Accept): Server {
  return bind(socket, accept).publish();
}
/** Binds a temporary name in `socket`'s folder, short so any socket path
 * that fits does too; `publish` moves it over `socket`. */
export function bind(socket: string, accept: Accept): Bound {
  os.privateDirectory(path.dirname(socket));
  os.unixAddress(socket);
  const next = os.unixAddress(path.join(path.dirname(socket), `.${process.pid}`));
  fs.rmSync(next, { force: true });
  const server = Bun.serve<peer.Client | null>({
    unix: next,
    maxRequestBodySize: limit,
    async fetch(request, server) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const offered = request.headers.get("sec-websocket-protocol")?.split(",") ?? [];
        if (!offered.some(name => name.trim() === wire_websocket.protocol)) return new Response(null, { status: 400 });
        const headers = { "Sec-WebSocket-Protocol": wire_websocket.protocol };
        return server.upgrade(request, { headers, data: null }) ? undefined : new Response(null, { status: 400 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      let value: unknown;
      try {
        value = json.parse(await request.text());
      } catch {
        return answer({ err: "InvalidJson" });
      }
      const reply = Promise.withResolvers<unknown>(),
        client = accept.request(value, reply.resolve);
      if (!client) return new Response(null, { status: 503 });
      // A sender that hangs up is gone, as a closed connection is.
      request.signal.addEventListener("abort", () => client.closed());
      return answer(await reply.promise);
    },
    websocket: {
      perMessageDeflate: false,
      // Viewers and subscriptions stay open while idle.
      idleTimeout: 0,
      maxPayloadLength: limit,
      open(ws) {
        ws.data = accept.connection({
          send: bytes => void ws.send(bytes),
          get buffered() {
            return ws.getBufferedAmount();
          },
          close: (code, reason) => ws.close(code, reason),
        });
        if (!ws.data) ws.close(wire_websocket.try_again);
      },
      message(ws, message) {
        if (typeof message === "string") ws.close(wire_websocket.unsupported);
        else ws.data?.read(Buffer.from(message));
      },
      drain(ws) {
        ws.data?.flushed();
      },
      close(ws) {
        ws.data?.closed();
      },
    },
  });
  try {
    fs.chmodSync(next, 0o600);
  } catch (error) {
    void server.stop(true);
    throw error;
  }
  return {
    publish() {
      fs.renameSync(next, socket);
      return server;
    },
    abandon() {
      void server.stop(true);
      fs.rmSync(next, { force: true });
    },
  };
}
function answer(reply: unknown): Response {
  const failed = !!reply && typeof reply === "object" && "err" in reply;
  return new Response(json.stringify(reply) + "\n", {
    status: failed ? 400 : 200,
    headers: { "Content-Type": "application/json" },
  });
}
