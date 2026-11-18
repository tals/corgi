//! A fake Codex app server: JSON-RPC over a WebSocket on a Unix socket.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Request = { method: string; params: any };
/** A request's answer, or null to hang up. */
export type Reply = { result: unknown } | { error: { code: number; message: string } } | null;

/** Listens on `path`, answering each request; notifications go unanswered. */
export function serve(path: string, answer: (request: Request) => Reply) {
  mkdirSync(dirname(path), { recursive: true });
  return Bun.serve({
    unix: path,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("bad", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const value = JSON.parse(String(message));
        if (!value.id) return;
        const reply = answer({ method: value.method, params: value.params });
        if (reply) ws.send(JSON.stringify({ id: value.id, ...reply }));
        else ws.close();
      },
    },
  });
}
