import { parse, stringify } from "../../json";
type UnixWebSocket = WebSocket & { terminate(): void };
export class Client {
  next_id = 1;
  deadline = 0;
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(public socket: UnixWebSocket) {
    socket.onmessage = event => {
      try {
        const text = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString();
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error("TooLarge");
        const value = parse(text),
          waiting = this.pending.get(value.id);
        if (!waiting) return;
        this.pending.delete(value.id);
        clearTimeout(waiting.timer);
        if (value.error != null) waiting.reject(Error("RpcError"));
        else waiting.resolve(value);
      } catch (error) {
        this.fail(error as Error);
      }
    };
    socket.onclose = () => this.fail(Error("Disconnected"));
    socket.onerror = () => this.fail(Error("Disconnected"));
  }
  fail(error: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
  static async open(path: string) {
    const socket = new WebSocket(`ws+unix://${path}:/rpc`) as UnixWebSocket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(Error("Timeout"));
      }, 1000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(Error("ConnectFailed"));
      };
    });
    const client = new Client(socket);
    try {
      await client.call("initialize", {
        clientInfo: { name: "corgi-observer", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      socket.send('{"method":"initialized","params":{}}');
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  close() {
    this.socket.terminate();
    this.fail(Error("Disconnected"));
  }
  call(method: string, params: any) {
    const id = this.next_id++,
      bytes = stringify({ id, method, params });
    if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) return Promise.reject(Error("TooLarge"));
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(Error("Disconnected"));
    this.deadline = Date.now() + 1000;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("Timeout"));
      }, 1000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(bytes);
    });
  }
}
