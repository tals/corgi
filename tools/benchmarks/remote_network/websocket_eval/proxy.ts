import { createServer, createConnection, type Socket } from "node:net";

export interface Shape {
  rtt_ms?: number;
  bytes_per_second?: number;
  freeze_after_ms?: number;
  freeze_ms?: number;
}
class Inspect {
  handshake: boolean;
  pending = Buffer.alloc(0);
  header_bytes = 0;
  payload_bytes = 0;
  frames = 0;
  compressed_frames = 0;
  masked_frames = 0;
  handshake_bytes = 0;
  socket_bytes = 0;
  handshake_text = "";
  constructor(private ws: boolean) {
    this.handshake = ws;
  }
  read(bytes: Buffer) {
    this.socket_bytes += bytes.length;
    if (!this.ws) {
      this.payload_bytes += bytes.length;
      return;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    if (this.handshake) {
      const end = this.pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      this.handshake_bytes += end + 4;
      this.handshake_text = this.pending.subarray(0, end + 4).toString();
      this.pending = this.pending.subarray(end + 4);
      this.handshake = false;
    }
    while (this.pending.length >= 2) {
      const b = this.pending;
      const short = b[1] & 127,
        masked = Boolean(b[1] & 128);
      const header = 2 + (short === 126 ? 2 : short === 127 ? 8 : 0) + (masked ? 4 : 0);
      if (b.length < header) break;
      const length = short === 126 ? b.readUInt16BE(2) : short === 127 ? Number(b.readBigUInt64BE(2)) : short;
      if (b.length < header + length) break;
      this.header_bytes += header;
      this.payload_bytes += length;
      this.frames++;
      if (b[0] & 64) this.compressed_frames++;
      if (masked) this.masked_frames++;
      this.pending = this.pending.subarray(header + length);
    }
  }
  result() {
    return {
      socket_bytes: this.socket_bytes,
      handshake_bytes: this.handshake_bytes,
      application_phase_bytes: this.socket_bytes - this.handshake_bytes,
      websocket_header_bytes: this.header_bytes,
      websocket_payload_bytes: this.payload_bytes,
      frames: this.frames,
      compressed_frames: this.compressed_frames,
      masked_frames: this.masked_frames,
      incomplete_bytes: this.pending.length,
      handshake: this.handshake_text,
    };
  }
}
export async function proxy(upstream: number, ws: boolean, shape: Shape) {
  const sockets = new Set<Socket>();
  const sessions: { up: Inspect; down: Inspect }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let maxQueue = 0,
    queued = 0,
    bytesHeld = 0,
    started = 0;
  const server = createServer(client => {
    const remote = createConnection(upstream, "127.0.0.1");
    sockets.add(client);
    sockets.add(remote);
    client.setNoDelay(true);
    remote.setNoDelay(true);
    const pair = { up: new Inspect(ws), down: new Inspect(ws) };
    sessions.push(pair);
    const ready: Buffer[] = [];
    let connected = false;
    remote.on("connect", () => {
      connected = true;
      for (const data of ready) remote.write(data);
    });
    function route(from: Socket, to: Socket, inspect: Inspect, down: boolean) {
      let departure = 0;
      const queue: { when: number; bytes: Buffer }[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const drain = () => {
        if (timer) timers.delete(timer);
        timer = null;
        const now = performance.now();
        while (queue.length && queue[0].when <= now) {
          const { bytes } = queue.shift()!;
          queued -= bytes.length;
          if (to.destroyed) continue;
          if (to === remote && !connected) ready.push(bytes);
          else to.write(bytes);
        }
        if (queue.length) {
          timer = setTimeout(drain, Math.max(1, queue[0].when - performance.now()));
          timers.add(timer);
        }
      };
      from.on("data", data => {
        inspect.read(data);
        const now = performance.now();
        if (!started && (!ws || inspect.frames > 0)) started = now;
        const capped = shape.bytes_per_second ?? Infinity;
        const delay = (shape.rtt_ms ?? 0) / 2;
        for (let at = 0; at < data.length; at += Number.isFinite(capped) ? 256 : data.length) {
          const bytes = Buffer.from(data.subarray(at, at + (Number.isFinite(capped) ? 256 : data.length)));
          departure = Math.max(departure, now) + (bytes.length / capped) * 1000;
          let when = departure + delay;
          const freeze = started + (shape.freeze_after_ms ?? Infinity);
          if (down && when >= freeze && when < freeze + (shape.freeze_ms ?? 0)) {
            bytesHeld += bytes.length;
            when = freeze + (shape.freeze_ms ?? 0);
          }
          queued += bytes.length;
          maxQueue = Math.max(maxQueue, queued + to.writableLength);
          queue.push({ when, bytes });
        }
        if (!timer) drain();
      });
    }
    route(client, remote, pair.up, false);
    route(remote, client, pair.down, true);
    for (const [socket, opposite] of [
      [client, remote],
      [remote, client],
    ]) {
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        opposite.destroy();
      });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NoAddress");
  return {
    port: address.port,
    result: () => ({
      sessions: sessions.map(value => ({ up: value.up.result(), down: value.down.result() })),
      max_queue_bytes: maxQueue,
      freeze_bytes: bytesHeld,
    }),
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
