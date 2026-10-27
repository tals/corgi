//! How voice mode reaches a runtime. The watch connection holds the presence
//! and hears mute changes; every other request gets a connection of its own
//! and 2 s to finish, so one stuck delivery never holds up the next.
import { createConnection, type Socket } from "node:net";
import * as json from "../json";
import * as protocol from "../protocol";
import * as rpc from "../rpc";

export type WatchRequest = { pane?: number; muted: boolean; available: boolean };
/** Whether the runtime has a viewer, and the title of the pane text would go to.
 * An older daemon sends neither: a viewer is assumed, its pane unnamed. */
export type Seen = { viewer: boolean; focus: string | null };
export function seen(message: any): Seen {
  return { viewer: message?.viewer !== false, focus: typeof message?.focus === "string" ? message.focus : null };
}
export interface VoiceLink {
  watch(req: WatchRequest): Promise<{ voice_id: string; muted: boolean } & Seen>;
  set(state: { muted?: boolean; available?: boolean }): Promise<{ muted: boolean }>;
  type(text: string): Promise<{ pane: number; viewer: number }>;
  on(event: "muted", fn: (muted: boolean) => void): void;
  on(event: "viewer", fn: (seen: Seen) => void): void;
  on(event: "closed", fn: (reason: string) => void): void;
  close(): void;
}
/** `muted`, `viewer` and `closed` listeners, shared by the local and SSH links. */
export class Events {
  private muted: ((muted: boolean) => void)[] = [];
  private viewer: ((seen: Seen) => void)[] = [];
  private closed: ((reason: string) => void)[] = [];
  on(event: "muted" | "viewer" | "closed", fn: (value: any) => void): void {
    (event === "muted" ? this.muted : event === "viewer" ? this.viewer : this.closed).push(fn);
  }
  emitMuted(muted: boolean): void {
    for (const fn of this.muted) fn(muted);
  }
  emitViewer(state: Seen): void {
    for (const fn of this.viewer) fn(state);
  }
  emitClosed(reason: string): void {
    const listeners = this.closed.splice(0);
    for (const fn of listeners) fn(reason);
  }
}
export const deadline_ms = 2000;

/** Rejects with `Timeout` when `promise` takes longer than `ms`. */
export function bounded<T>(promise: Promise<T>, ms: number, onTimeout: () => void = () => {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(Error("Timeout"));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
/** One request on a connection of its own, dropped with it on timeout. */
async function once(path: string, value: object, ms: number): Promise<any> {
  const conn = new rpc.Connection(path);
  try {
    const reply: any = await bounded(conn.rawRequest(value), ms);
    if (reply?.err) throw Error(reply.err);
    return reply;
  } catch (error) {
    throw connectionError(error);
  } finally {
    conn.close();
  }
}
function connectionError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" ? Error("NoRuntime") : (error as Error);
}

export class LocalLink implements VoiceLink {
  private events = new Events();
  private socket: Socket | null = null;
  private heartbeat?: ReturnType<typeof setInterval>;
  private voice_id = "";
  private replies: ((value: any) => void)[] = [];
  private closed = false;
  private constructor(
    readonly path: string,
    private opts: { deadline_ms: number; heartbeat_ms: number },
  ) {}
  /** Connects to the runtime at `path`, which must know the voice ops. */
  static async connect(path: string, opts: Partial<{ deadline_ms: number; heartbeat_ms: number }> = {}) {
    const hello: any = await once(path, protocol.envelope("hello"), opts.deadline_ms ?? deadline_ms);
    if (!hello.capabilities?.includes("voice.watch")) throw Error("DaemonLacksVoice");
    return new LocalLink(path, { deadline_ms, heartbeat_ms: 1000, ...opts });
  }
  watch(req: WatchRequest): Promise<{ voice_id: string; muted: boolean } & Seen> {
    const socket = createConnection(this.path);
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: any;
        try {
          message = json.parse(line);
        } catch {
          continue;
        }
        if (message?.type === "voice.muted") this.events.emitMuted(message.muted === true);
        else if (message?.type === "voice.viewer") this.events.emitViewer(seen(message));
        else this.replies.shift()?.(message);
      }
    });
    socket.on("error", () => this.lost("runtime_gone"));
    socket.on("close", () => this.lost("runtime_gone"));
    const sent = this.send({ ...req, pane: req.pane ?? null }, "voice.watch");
    return bounded(sent, this.opts.deadline_ms)
      .then(reply => {
        if (reply.err) throw Error(reply.err);
        this.voice_id = reply.voice_id;
        this.heartbeat = setInterval(() => this.beat(), this.opts.heartbeat_ms);
        return { voice_id: reply.voice_id as string, muted: reply.muted === true, ...seen(reply) };
      })
      .catch(error => {
        this.close();
        throw connectionError(error);
      });
  }
  private send(fields: object, op: "voice.watch" | "voice.set"): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.closed) return reject(Error("ConnectionClosed"));
      this.replies.push(resolve);
      this.socket.write(json.stringify(protocol.envelope(op, fields as Record<string, unknown>)) + "\n");
    });
  }
  private beat(): void {
    void this.send({ voice_id: this.voice_id }, "voice.set").then(
      reply => {
        if (reply?.err) this.lost(reply.err);
      },
      () => {},
    );
  }
  /** The presence ended without close(); a link that never attached just fails its watch. */
  private lost(reason: string): void {
    if (this.closed) return;
    this.close();
    if (this.voice_id) this.events.emitClosed(reason);
  }
  private request(op: protocol.Op, fields: object): Promise<any> {
    if (this.closed || !this.voice_id) return Promise.reject(Error("NotConnected"));
    return once(this.path, protocol.envelope(op, { voice_id: this.voice_id, ...fields }), this.opts.deadline_ms);
  }
  async set(state: { muted?: boolean; available?: boolean }): Promise<{ muted: boolean }> {
    const reply = await this.request("voice.set", state);
    return { muted: reply.muted === true };
  }
  async type(text: string): Promise<{ pane: number; viewer: number }> {
    const reply = await this.request("voice.type", { text });
    return { pane: reply.pane, viewer: reply.viewer };
  }
  on(event: "muted" | "viewer" | "closed", fn: (value: any) => void): void {
    this.events.on(event, fn);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.socket?.destroy();
    for (const reply of this.replies.splice(0)) reply({ err: "ConnectionClosed" });
  }
}
