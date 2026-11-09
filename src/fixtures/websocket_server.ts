import * as stream from "node:stream";
import * as websocket from "../wire_websocket";

/** A fake daemon's WebSocket as a stream. */
export class Socket extends stream.Duplex {
  constructor(private readonly ws: Bun.ServerWebSocket<Socket | null>) {
    super();
  }
  override _read(): void {}
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.ws.send(bytes);
    done();
  }
  /** Closes with `code`, as the daemon closes for a reload. */
  close(code: number, reason = ""): void {
    this.ws.close(code, reason);
  }
  override _final(done: (error?: Error | null) => void): void {
    this.ws.close();
    done();
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.ws.terminate();
    done(error);
  }
}
export class Server {
  private server: Bun.Server<Socket | null> | null = null;
  constructor(
    private readonly connected: (socket: Socket) => void,
    private readonly http?: (request: Request) => Promise<Response>,
  ) {}
  listen(path: string, ready: () => void): void {
    const connected = this.connected,
      http = this.http;
    this.server = Bun.serve<Socket | null>({
      unix: path,
      fetch(req, server) {
        if (server.upgrade(req, { headers: { "Sec-WebSocket-Protocol": websocket.protocol }, data: null })) return;
        return http ? http(req) : new Response(null, { status: 400 });
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
export function createServer(
  connected: (socket: Socket) => void,
  http?: (request: Request) => Promise<Response>,
): Server {
  return new Server(connected, http);
}
