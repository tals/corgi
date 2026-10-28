//! How voice mode reaches a runtime. The watch connection holds the presence
//! and hears mute changes; every other request gets a connection of its own
//! and 2 s to finish, so one stuck delivery never holds up the next.
import { createConnection, type Socket } from "node:net";
import * as json from "../json";
import * as errors from "../errors";
import * as protocol from "../protocol";
import * as rpc from "../rpc";

export type WatchRequest = { pane?: number; muted: boolean; available: boolean };
/** Whether the runtime has a viewer, and the title of the pane text would go to. */
export type Seen = { viewer: boolean; focus: string | null };
export type Watched = { voice_id: string; muted: boolean } & Seen;
export type Typed = { pane: number; viewer: number };
/** A JSON object off the wire, its fields not yet read. */
export type Message = Record<string, unknown>;
/** `value` when it is a JSON object; anything else is not a message. */
export function message(value: unknown): Message | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Message) : null;
}
/** `Seen` from a message off the wire; anything malformed reads as no viewer. */
export function seen(message: Message): Seen {
  return { viewer: message.viewer === true, focus: typeof message.focus === "string" ? message.focus : null };
}
/** The answer to `voice.watch`. */
export function watched(reply: Message): Watched {
  return {
    voice_id: typeof reply.voice_id === "string" ? reply.voice_id : "",
    muted: reply.muted === true,
    ...seen(reply),
  };
}
/** The answer to `voice.type`. */
export function typed(reply: Message): Typed {
  return {
    pane: typeof reply.pane === "number" ? reply.pane : 0,
    viewer: typeof reply.viewer === "number" ? reply.viewer : 0,
  };
}
/** What a runtime or bridge says unasked; anything else answers a request. */
export type Event =
  | { type: "voice.muted"; muted: boolean }
  | { type: "voice.viewer"; seen: Seen }
  | { type: "pong" }
  | { type: "closed"; reason: string };
export function event(message: Message): Event | null {
  switch (message.type) {
    case "voice.muted":
      return { type: "voice.muted", muted: message.muted === true };
    case "voice.viewer":
      return { type: "voice.viewer", seen: seen(message) };
    case "pong":
      return { type: "pong" };
    case "closed":
      return {
        type: "closed",
        reason:
          typeof message.reason === "string" && /^[a-z_]{1,32}$/.test(message.reason) ? message.reason : "runtime_gone",
      };
    default:
      return null;
  }
}
export type LinkEvents = {
  muted: (muted: boolean) => void;
  viewer: (seen: Seen) => void;
  closed: (reason: string) => void;
};
export interface VoiceLink {
  watch(req: WatchRequest): Promise<Watched>;
  set(state: { muted?: boolean; available?: boolean }): Promise<{ muted: boolean }>;
  type(text: string): Promise<Typed>;
  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): void;
  close(): void;
}
/** `muted`, `viewer` and `closed` listeners, shared by the local and SSH links. */
export class Events {
  private listeners: { [K in keyof LinkEvents]: LinkEvents[K][] } = { muted: [], viewer: [], closed: [] };
  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): void {
    this.listeners[event].push(fn);
  }
  emitMuted(muted: boolean): void {
    for (const fn of this.listeners.muted) fn(muted);
  }
  emitViewer(state: Seen): void {
    for (const fn of this.listeners.viewer) fn(state);
  }
  emitClosed(reason: string): void {
    const listeners = this.listeners.closed.splice(0);
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
async function once(path: string, value: object, ms: number): Promise<Message> {
  const conn = new rpc.Connection(path);
  try {
    const reply = message(await bounded(conn.rawRequest(value), ms));
    if (!reply) throw Error("UnexpectedToken");
    if (reply.err) throw Error(String(reply.err));
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
  private replies: ((reply: Message) => void)[] = [];
  private closed = false;
  private constructor(
    readonly path: string,
    private opts: { deadline_ms: number; heartbeat_ms: number },
  ) {}
  /** Connects to the runtime at `path`, which must know the voice ops. */
  static async connect(path: string, opts: Partial<{ deadline_ms: number; heartbeat_ms: number }> = {}) {
    const hello = await once(path, protocol.envelope("hello"), opts.deadline_ms ?? deadline_ms);
    if (!Array.isArray(hello.capabilities) || !hello.capabilities.includes("voice.watch"))
      throw Error("DaemonLacksVoice");
    return new LocalLink(path, { deadline_ms, heartbeat_ms: 1000, ...opts });
  }
  watch(req: WatchRequest): Promise<Watched> {
    const socket = createConnection(this.path);
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let read: Message | null;
        try {
          read = message(json.parse(line));
        } catch {
          continue;
        }
        if (!read) continue;
        const e = event(read);
        switch (e?.type) {
          case "voice.muted":
            this.events.emitMuted(e.muted);
            break;
          case "voice.viewer":
            this.events.emitViewer(e.seen);
            break;
          default:
            this.replies.shift()?.(read);
        }
      }
    });
    socket.on("error", () => this.lost("runtime_gone"));
    socket.on("close", () => this.lost("runtime_gone"));
    const sent = this.send({ ...req, pane: req.pane ?? null }, "voice.watch");
    return bounded(sent, this.opts.deadline_ms)
      .then(reply => {
        if (reply.err) throw Error(String(reply.err));
        const answer = watched(reply);
        this.voice_id = answer.voice_id;
        this.heartbeat = setInterval(() => this.beat(), this.opts.heartbeat_ms);
        return answer;
      })
      .catch(error => {
        this.close();
        throw connectionError(error);
      });
  }
  private send(fields: object, op: "voice.watch" | "voice.set"): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.closed) return reject(Error("ConnectionClosed"));
      this.replies.push(resolve);
      this.socket.write(json.stringify(protocol.envelope(op, fields as Record<string, unknown>)) + "\n");
    });
  }
  /** Renews the presence; a runtime that keeps the socket but stops answering is lost. */
  private beat(): void {
    void bounded(this.send({ voice_id: this.voice_id }, "voice.set"), this.opts.deadline_ms).then(
      reply => {
        if (reply.err) this.lost(String(reply.err));
      },
      error => {
        if (errors.is(error, "Timeout")) this.lost("heartbeat_timeout");
      },
    );
  }
  /** The presence ended without close(); a link that never attached just fails its watch. */
  private lost(reason: string): void {
    if (this.closed) return;
    this.close();
    if (this.voice_id) this.events.emitClosed(reason);
  }
  private request(op: protocol.Op, fields: object): Promise<Message> {
    if (this.closed || !this.voice_id) return Promise.reject(Error("NotConnected"));
    return once(this.path, protocol.envelope(op, { voice_id: this.voice_id, ...fields }), this.opts.deadline_ms);
  }
  async set(state: { muted?: boolean; available?: boolean }): Promise<{ muted: boolean }> {
    const reply = await this.request("voice.set", state);
    return { muted: reply.muted === true };
  }
  async type(text: string): Promise<Typed> {
    return typed(await this.request("voice.type", { text }));
  }
  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): void {
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
