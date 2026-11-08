import { createServer, createConnection, type Socket } from "node:net";
import { Channel } from "../../../../src/wire_compression";
import { type Config, corpus, lines, cpu, ns, milliseconds, distribution } from "./common";

const [role, serialized, portText] = process.argv.slice(2);
const config: Config = JSON.parse(serialized);
const messages = corpus(config.corpus, config.limit);
const wsMode = config.mode.startsWith("websocket");
const compressed = config.mode.endsWith("zstd");
const nativeDeflate = config.mode === "websocket-deflate";
const emit = (value: object) => console.log(JSON.stringify(value));
const fatal = (error: unknown) => {
  console.error(error);
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
interface Transport {
  send: (bytes: Buffer) => void;
  close: () => void;
  queued: () => number;
}
function channel(transport: Transport, receive: (line: Buffer) => void) {
  const parse = lines(receive);
  const codec = compressed ? new Channel(transport.send, parse, fatal) : null;
  let maxQueue = 0;
  return {
    send(bytes: Buffer, done?: () => void) {
      if (codec) codec.encode(bytes, done);
      else {
        transport.send(bytes);
        done?.();
      }
      maxQueue = Math.max(maxQueue, (codec?.pending ?? 0) + transport.queued());
    },
    read(bytes: Buffer) {
      if (codec) codec.decode(bytes);
      else parse(bytes);
    },
    close: () => codec?.close(),
    queue: () => maxQueue,
    pending: () => codec?.pending ?? 0,
  };
}
const rawTransport = (socket: Socket): Transport => ({
  send: bytes => {
    socket.write(bytes);
  },
  close: () => socket.destroy(),
  queued: () => socket.writableLength,
});

if (role === "server") {
  let cpuStart = 0,
    started = 0n,
    done = false;
  let connections = 0,
    totalSent = 0,
    maxQueue = 0;
  const roundtrips: number[] = [],
    deliveries: number[] = [];
  const offsets: number[] = [];
  function session(transport: Transport) {
    connections++;
    let sent = 0,
      acked = 0,
      active = true;
    const times = new Map<number, bigint>();
    const io = channel(transport, line => {
      if (!active) return;
      const value = JSON.parse(line.toString());
      if (value.ready) {
        if (!started) {
          started = ns();
          cpuStart = cpu();
        }
        sent = acked = value.offset;
        offsets.push(sent);
        pump();
      } else {
        const index = value.ack;
        if (index !== acked) throw Error(`InvalidReceipt:${index}:${acked}`);
        const at = times.get(index)!;
        roundtrips.push(milliseconds(at, ns()));
        deliveries.push(milliseconds(at, BigInt(value.received_ns)));
        times.delete(index);
        acked++;
        if (acked === messages.length && !done) {
          done = true;
          maxQueue = Math.max(maxQueue, io.queue());
          emit({
            type: "done",
            role,
            cpu_us: cpu() - cpuStart,
            duration_ms: milliseconds(started, ns()),
            messages: messages.length,
            raw_bytes: messages.reduce((n, value) => n + value.length, 0),
            roundtrip_ms: distribution(roundtrips),
            delivery_ms: distribution(deliveries),
            roundtrip_samples_ms: roundtrips,
            delivery_samples_ms: deliveries,
            connections,
            offsets,
            total_sent: totalSent,
            max_queue_bytes: maxQueue,
          });
        } else pump();
      }
    });
    function pump() {
      while (active && sent < messages.length && sent - acked < config.window) {
        times.set(sent, ns());
        io.send(messages[sent]);
        sent++;
        totalSent++;
      }
    }
    return {
      read: io.read,
      close() {
        active = false;
        maxQueue = Math.max(maxQueue, io.queue());
        io.close();
      },
    };
  }
  if (wsMode) {
    const server = Bun.serve<{ io: ReturnType<typeof session> }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: {} as never })) return;
        return new Response("WebSocket required", { status: 400 });
      },
      websocket: {
        perMessageDeflate: nativeDeflate ? { compress: "dedicated", decompress: "dedicated" } : false,
        backpressureLimit: 4 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        idleTimeout: 120,
        open(socket) {
          socket.data.io = session({
            send: bytes => {
              socket.send(bytes, nativeDeflate);
            },
            close: () => socket.close(),
            queued: () => socket.getBufferedAmount(),
          });
        },
        message(socket, bytes) {
          socket.data.io.read(Buffer.from(bytes));
        },
        close(socket) {
          socket.data.io.close();
        },
      },
    });
    emit({ type: "ready", port: server.port });
  } else {
    const server = createServer(socket => {
      socket.setNoDelay(true);
      const io = session(rawTransport(socket));
      socket.on("data", io.read);
      socket.on("error", () => {});
      socket.on("close", () => io.close());
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("NoAddress");
      emit({ type: "ready", port: address.port });
    });
  }
} else {
  let received = 0,
    connections = 0,
    io: ReturnType<typeof channel>;
  let transport: Transport,
    cpuStart = 0,
    started = 0n,
    reconnectAt = 0n;
  let firstAt = 0n,
    reconnectFirst: number | null = null,
    done = false,
    maxQueue = 0;
  const connectMs: number[] = [],
    firstMs: number[] = [];
  function connect() {
    connections++;
    const dialed = ns();
    let sessionIO: ReturnType<typeof channel>;
    let first = true,
      active = true;
    const opened = (value: Transport) => {
      transport = value;
      connectMs.push(milliseconds(dialed, ns()));
      io = sessionIO = channel(transport, line => {
        if (done || !active) return;
        if (!line.equals(messages[received])) throw Error(`PayloadMismatch:${received}`);
        const at = ns();
        if (first) {
          first = false;
          firstMs.push(milliseconds(dialed, at));
          if (!firstAt) firstAt = at;
          if (reconnectAt) reconnectFirst = milliseconds(reconnectAt, at);
        }
        const index = received++;
        if (config.reconnect && received === config.reconnect && connections === 1) {
          maxQueue = Math.max(maxQueue, io.queue());
          active = false;
          io.close();
          transport.close();
          reconnectAt = ns();
          setTimeout(connect, 0);
          return;
        }
        io.send(Buffer.from(JSON.stringify({ ack: index, received_ns: at.toString() }) + "\n"), () => {
          if (index !== messages.length - 1 || done) return;
          if (io.pending()) throw Error("IncompleteAckEncoding");
          done = true;
          emit({
            type: "done",
            role,
            cpu_us: cpu() - cpuStart,
            duration_ms: milliseconds(started, ns()),
            messages: received,
            verified_bytes: messages.reduce((n, value) => n + value.length, 0),
            connect_ms: connectMs,
            first_message_ms: firstMs,
            reconnect_first_ms: reconnectFirst,
            connections,
            max_queue_bytes: Math.max(maxQueue, io.queue()),
          });
        });
      });
      if (!started) {
        started = ns();
        cpuStart = cpu();
      }
      io.send(Buffer.from(JSON.stringify({ ready: true, offset: received }) + "\n"));
    };
    if (wsMode) {
      const socket = new WebSocket(`ws://127.0.0.1:${portText}/benchmark`, { perMessageDeflate: nativeDeflate });
      socket.binaryType = "arraybuffer";
      socket.onopen = () =>
        opened({
          send: bytes => socket.send(bytes),
          close: () => socket.terminate(),
          queued: () => socket.bufferedAmount,
        });
      socket.onmessage = event => sessionIO.read(Buffer.from(event.data));
      socket.onerror = () => {
        if (!reconnectAt && !done) fatal(Error("WebSocketError"));
      };
    } else {
      const socket = createConnection(Number(portText), "127.0.0.1");
      socket.setNoDelay(true);
      socket.on("connect", () => opened(rawTransport(socket)));
      socket.on("data", bytes => sessionIO.read(bytes));
      socket.on("error", error => {
        if (!reconnectAt && !done) fatal(error);
      });
    }
  }
  connect();
}
