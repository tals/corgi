import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";

const protocol = "corgi-stream-v1";
const capacity = 4 * 1024 * 1024;
export interface Options {
  path: string;
  target: string;
  maximum?: number;
  deflate?: boolean;
}
export interface Metrics {
  connections: number;
  toTarget: number;
  toClient: number;
  targetPeak: number;
  clientPeak: number;
  pauses: number;
  drops: number;
}
export interface Adapter {
  close(): Promise<void>;
  metrics: Metrics;
}
function metrics(): Metrics {
  return { connections: 0, toTarget: 0, toClient: 0, targetPeak: 0, clientPeak: 0, pauses: 0, drops: 0 };
}
function socket(path: string): Socket {
  return createConnection({ path, allowHalfOpen: true, highWaterMark: 65536 });
}

/** The control adds the same two Unix-socket hops as the WebSocket adapters. */
export async function listenRaw(options: Options): Promise<Adapter> {
  const stats = metrics(),
    clients = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true, highWaterMark: 65536 }, left => {
    const right = socket(options.target);
    stats.connections++;
    clients.add(left).add(right);
    left
      .on("error", () => right.end())
      .on("close", () => {
        clients.delete(left);
        if (!left.readableEnded) right.end();
      });
    right
      .on("error", () => left.end())
      .on("close", () => {
        clients.delete(right);
        if (!right.readableEnded) left.end();
      });
    left.on("data", bytes => {
      stats.toTarget += bytes.length;
      stats.targetPeak = Math.max(stats.targetPeak, right.writableLength + bytes.length);
    });
    right.on("data", bytes => {
      stats.toClient += bytes.length;
      stats.clientPeak = Math.max(stats.clientPeak, left.writableLength + bytes.length);
    });
    left.pipe(right).pipe(left);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, resolve);
  });
  chmodSync(options.path, 0o600);
  return {
    metrics: stats,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** Binary WebSocket messages carry the existing byte stream, including its hello and zstd history. */
export async function listenWebSocket(options: Options): Promise<Adapter> {
  const stats = metrics(),
    maximum = options.maximum ?? capacity,
    clients = new Set<() => void>();
  interface State {
    target: Socket;
    stop: () => void;
    finish: () => void;
    ending: boolean;
  }
  const server = Bun.serve<State>({
    unix: options.path,
    fetch(request, server) {
      const offered = request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map(value => value.trim());
      if (!offered?.includes(protocol)) return new Response("Subprotocol required", { status: 400 });
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": protocol } })) return;
      return new Response("Upgrade failed", { status: 400 });
    },
    websocket: {
      perMessageDeflate: options.deflate ? { compress: "dedicated", decompress: "dedicated" } : false,
      idleTimeout: 0,
      maxPayloadLength: maximum,
      backpressureLimit: maximum,
      closeOnBackpressureLimit: true,
      open(ws) {
        stats.connections++;
        const target = socket(options.target);
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          clients.delete(stop);
          target.destroy();
          ws.terminate();
        };
        const finish = () => {
          ws.data.ending = true;
          target.pause();
          // Send Close after accepted application bytes have left Bun's queue.
          if (!ws.getBufferedAmount()) ws.close(1000);
        };
        ws.data = { target, stop, finish, ending: false };
        clients.add(stop);
        target.on("data", bytes => {
          if (stopped || ws.data.ending) return;
          const queued = ws.getBufferedAmount() + bytes.length;
          stats.clientPeak = Math.max(stats.clientPeak, queued);
          if (queued > maximum) {
            stats.drops++;
            stop();
            return;
          }
          const sent = ws.send(bytes, options.deflate ?? false);
          if (!sent) {
            stats.drops++;
            stop();
            return;
          }
          stats.toClient += bytes.length;
          if (sent === -1) {
            stats.pauses++;
            target.pause();
          }
        });
        target.on("drain", () => {
          if (!stopped) ws.resume();
        });
        target.on("end", finish).on("error", finish);
        target.on("close", () => {
          if (!stopped) finish();
        });
      },
      message(ws, message) {
        const state = ws.data;
        if (state.ending) return;
        if (typeof message === "string") {
          state.stop();
          return;
        }
        const queued = state.target.writableLength + message.length;
        stats.targetPeak = Math.max(stats.targetPeak, queued);
        if (queued > maximum) {
          stats.drops++;
          state.stop();
          return;
        }
        stats.toTarget += message.length;
        if (!state.target.write(message)) {
          stats.pauses++;
          ws.pause();
        }
      },
      drain(ws) {
        if (ws.data.ending) ws.data.finish();
        else ws.data.target.resume();
      },
      close(ws) {
        ws.data?.stop();
      },
      error(_error, ws) {
        ws.data?.stop();
      },
    },
  });
  chmodSync(options.path, 0o600);
  return {
    metrics: stats,
    async close() {
      for (const stop of clients) stop();
      await server.stop(true);
      rmSync(options.path, { force: true });
    },
  };
}

/** Expose a byte-stream Unix socket backed by Bun's native WebSocket client. */
export async function listenWebSocketClient(options: Options): Promise<Adapter> {
  const stats = metrics(),
    maximum = options.maximum ?? capacity,
    clients = new Set<() => void>();
  const server = createServer({ allowHalfOpen: true, highWaterMark: 65536 }, local => {
    stats.connections++;
    local.pause();
    const ws = new WebSocket(`ws+unix://${options.target}:/rpc`, {
      protocols: [protocol],
      perMessageDeflate: options.deflate ?? false,
    });
    let stopped = false,
      ending = false,
      poll: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(poll);
      clients.delete(stop);
      local.destroy();
      ws.terminate();
    };
    const drain = () => {
      poll = undefined;
      if (stopped || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount) {
        poll = setTimeout(drain, 1);
        return;
      }
      if (ending) ws.close(1000);
      else local.resume();
    };
    clients.add(stop);
    local.on("data", bytes => {
      if (stopped || ending) return;
      const queued = ws.bufferedAmount + bytes.length;
      stats.targetPeak = Math.max(stats.targetPeak, queued);
      if (queued > maximum || ws.readyState !== WebSocket.OPEN) {
        stats.drops++;
        stop();
        return;
      }
      ws.send(bytes);
      stats.toTarget += bytes.length;
      if (ws.bufferedAmount) {
        stats.pauses++;
        local.pause();
        poll ??= setTimeout(drain, 1);
      }
    });
    local.on("drain", () => {
      if (!stopped) ws.resume();
    });
    local.on("end", () => {
      ending = true;
      drain();
    });
    local.on("error", stop).on("close", stop);
    ws.onopen = () => {
      if (
        ws.protocol !== protocol ||
        (options.deflate ? ws.extensions !== "permessage-deflate" : Boolean(ws.extensions))
      ) {
        stop();
        return;
      }
      drain();
    };
    ws.onmessage = event => {
      if (stopped) return;
      if (typeof event.data === "string") {
        stop();
        return;
      }
      const bytes = Buffer.from(event.data),
        queued = local.writableLength + bytes.length;
      stats.clientPeak = Math.max(stats.clientPeak, queued);
      if (queued > maximum) {
        stats.drops++;
        stop();
        return;
      }
      stats.toClient += bytes.length;
      if (!local.write(bytes)) {
        stats.pauses++;
        ws.pause();
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      ending = true;
      clearTimeout(poll);
      local.pause();
      // EOF must follow bytes already delivered by the WebSocket callbacks.
      local.end();
      local.once("finish", stop);
    };
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, resolve);
  });
  chmodSync(options.path, 0o600);
  return {
    metrics: stats,
    async close() {
      for (const stop of clients) stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
