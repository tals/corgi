import { Duplex } from "node:stream";
import * as websocket from "../wire_websocket";

/** Fake RPC daemons use Bun's WS server, independently of the production descriptor parser. */
export class Socket extends Duplex {
  constructor(private readonly ws: Bun.ServerWebSocket<Socket | null>) {
    super();
  }
  override _read(): void {}
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.ws.send(bytes);
    done();
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.ws.terminate();
    done(error);
  }
}
export class Server {
  private server: Bun.Server<Socket | null> | null = null;
  constructor(private readonly connected: (socket: Socket) => void) {}
  listen(path: string, ready: () => void): void {
    const connected = this.connected;
    this.server = Bun.serve<Socket | null>({
      unix: path,
      fetch(req, server) {
        if (server.upgrade(req, { headers: { "Sec-WebSocket-Protocol": websocket.protocol }, data: null })) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        perMessageDeflate: false,
        idleTimeout: 0,
        open(ws) {
          ws.data = new Socket(ws);
          connected(ws.data);
        },
        message(ws, bytes) {
          ws.data!.push(bytes);
        },
        close(ws) {
          ws.data?.destroy();
        },
      },
    });
    ready();
  }
  close(done: () => void = () => {}): void {
    void this.server?.stop(true).then(done);
  }
}
export function createServer(connected: (socket: Socket) => void): Server {
  return new Server(connected);
}
