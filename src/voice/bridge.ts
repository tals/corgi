//! Voice mode on another host's runtime: `corgi __voice-bridge` runs there
//! through `ssh -T` and relays JSON lines to its runtime; `SshLink` is this
//! side of it. Only text, commands and state cross; audio never does.
import * as json from "../json";
import * as errors from "../errors";
import * as config from "../build_config";
import * as protocol from "../protocol";
import {
  Events,
  LocalLink,
  bounded,
  deadline_ms,
  event,
  message,
  typed,
  watched,
  type LinkEvents,
  type Message,
  type Typed,
  type VoiceLink,
  type Watched,
  type WatchRequest,
} from "./link";

const bridge_version = 1;
const ping_ms = 1000,
  lost_ms = 3000,
  /** How long ssh may take to connect and start the bridge; prompts can take a while. */
  greeting_ms = 60_000,
  max_line = 64 * 1024;

/** The bridge, on the runtime's host: relays requests until stdin closes or
 * pings stop. Writes nothing to stdout but protocol lines. */
export async function serve(socket: string, args: string[] = []): Promise<number> {
  const write = (value: object) => void process.stdout.write(json.stringify(value) + "\n");
  if (args.length && args[0] !== String(bridge_version)) {
    write({ type: "refused", reason: "bridge_version", bridge: bridge_version });
    return 0;
  }
  let link: LocalLink;
  try {
    link = await LocalLink.connect(socket);
  } catch (error) {
    const name = errors.name(error);
    write({
      type: "refused",
      reason: name === "DaemonLacksVoice" ? "daemon_lacks_voice" : "no_runtime",
      detail: name ?? String(error),
    });
    return 0;
  }
  write({ type: "ready", corgi: config.releaseVersion, bridge: bridge_version });
  let pinged = Date.now(),
    finish!: () => void;
  const done = new Promise<void>(resolve => (finish = resolve));
  link.on("muted", muted => write({ type: "voice.muted", muted }));
  link.on("viewer", state => write({ type: "voice.viewer", ...state }));
  link.on("closed", reason => {
    write({ type: "closed", reason });
    finish();
  });
  const relay = async (op: protocol.Op | null, request: Message) => {
    const id = typeof request.id === "number" ? request.id : null;
    try {
      let reply: object;
      switch (op) {
        case "voice.watch":
          reply = await link.watch(watchRequest(request));
          break;
        case "voice.set":
          reply = await link.set(setRequest(request));
          break;
        case "voice.type":
          reply = await link.type(typeof request.text === "string" ? request.text : "");
          break;
        default:
          return write({ id, ok: false, err: "UnknownOperation" });
      }
      write({ id, ok: true, ...reply });
    } catch (error) {
      write({ id, ok: false, err: errors.name(error) ?? String(error) });
    }
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let request: Message | null;
      try {
        request = message(json.parse(line));
      } catch {
        continue;
      }
      if (!request) continue;
      const op = protocol.parse(request);
      if (op === "ping") {
        pinged = Date.now();
        write({ type: "pong" });
      } else void relay(op, request);
    }
  });
  process.stdin.on("end", finish);
  process.stdin.on("close", finish);
  const watchdog = setInterval(() => {
    if (Date.now() - pinged > lost_ms) finish();
  }, 250);
  await done;
  clearInterval(watchdog);
  link.close();
  // A quiet but open stdin would keep the process up.
  process.stdin.destroy();
  return 0;
}

/** What `SshLink.watch` sends; the voice on another host is never a pane there. */
function watchRequest(request: Message): WatchRequest {
  return { muted: request.muted === true, available: request.available !== false };
}
/** What `SshLink.set` sends: only the fields that changed. */
function setRequest(request: Message): { muted?: boolean; available?: boolean } {
  return {
    ...(typeof request.muted === "boolean" ? { muted: request.muted } : {}),
    ...(typeof request.available === "boolean" ? { available: request.available } : {}),
  };
}

/** The remote command: Corgi from the login PATH, or where the installer puts
 * it, told which bridge this side speaks. */
export const remote = `sh -c 'exec "$(command -v corgi || echo $HOME/.local/bin/corgi)" __voice-bridge ${bridge_version}'`;
/** Which side is behind when the bridges differ: the host's `bridge` against ours. */
function versionError(bridge: unknown): Error {
  return Error(typeof bridge === "number" && bridge > bridge_version ? "LocalTooOld" : "RemoteTooOld");
}

/** Why the bridge never said ready, from how ssh ended. */
export function exitError(code: number | null, stderr: string): Error {
  if (code === 2 && /unknown command/i.test(stderr)) return Error("RemoteTooOld");
  if (code === 127 || /not found/i.test(stderr)) return Error("RemoteMissing");
  const last = stderr.trim().split("\n").at(-1) ?? "";
  return Object.assign(Error("SshFailed"), { detail: last.replace(/[\x00-\x1f\x7f-\x9f]/g, " ") });
}
/** An error name from the other side; anything else is not one. */
function errorName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z]{1,64}$/.test(value) ? value : "Failed";
}
/** The last 4 KiB of `stream`, for the message when ssh fails. */
async function tail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let kept = "";
  try {
    for await (const chunk of stream) kept = (kept + decoder.decode(chunk, { stream: true })).slice(-4096);
  } catch {}
  return kept;
}

export class SshLink implements VoiceLink {
  private events = new Events();
  private pending = new Map<number, (reply: Message) => void>();
  private next_id = 1;
  private ponged = Date.now();
  private pinger?: ReturnType<typeof setInterval>;
  private closed = false;
  private attached = false;
  private constructor(
    private child: ReturnType<typeof Bun.spawn>,
    private opts: { deadline_ms: number },
  ) {}
  /** Starts the bridge on `host`. Reconnects pass `batch`, so ssh never
   * prompts over the full-screen UI. */
  static async connect(
    host: string,
    opts: { batch?: boolean; deadline_ms?: number; signal?: AbortSignal } = {},
  ): Promise<SshLink> {
    const ssh = process.env.CORGI_VOICE_SSH || "ssh",
      argv = [ssh, "-T", "-o", "ServerAliveInterval=2", "-o", "ServerAliveCountMax=2", "-o", "ConnectTimeout=10"];
    if (opts.batch) argv.push("-o", "BatchMode=yes");
    // A host is never an option.
    argv.push("--", host, remote);
    const child = Bun.spawn(argv, { env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const link = new SshLink(child, { deadline_ms: opts.deadline_ms ?? deadline_ms }),
      stderr = tail(child.stderr as ReadableStream<Uint8Array>);
    let first!: (line: Message | null) => void;
    const greeted = new Promise<Message | null>(resolve => (first = resolve));
    const reading = link.read(child.stdout as ReadableStream<Uint8Array>, line => first(line));
    // A refusal is the last line before the bridge exits: read it first.
    void Promise.all([child.exited, reading]).then(() => first(null));
    // Quitting mid-connect ends the attempt now, not when ssh gives up.
    const abort = () => {
      child.kill();
      first(null);
    };
    if (opts.signal?.aborted) abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    const hello = await bounded(greeted, greeting_ms, () => child.kill()).catch(() => null);
    opts.signal?.removeEventListener("abort", abort);
    if (!hello) {
      await child.exited;
      throw exitError(child.exitCode, await stderr);
    }
    if (hello.type === "refused" || hello.bridge !== bridge_version) {
      link.close();
      if (hello.type !== "refused" || hello.reason === "bridge_version") throw versionError(hello.bridge);
      throw Error(hello.reason === "daemon_lacks_voice" ? "DaemonLacksVoice" : "NoRuntime");
    }
    void child.exited.then(() => link.lost("ssh_closed"));
    // The greeting may have taken a while; pongs count from now.
    link.ponged = Date.now();
    link.pinger = setInterval(() => {
      if (Date.now() - link.ponged > lost_ms) return link.lost("ping_timeout");
      link.send({ id: 0, op: "ping" });
    }, ping_ms);
    return link;
  }
  private async read(stream: ReadableStream<Uint8Array>, greet: (line: Message) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "",
      greeted = false;
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > max_line && !buffer.includes("\n")) return this.lost("protocol_error");
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
          if (!greeted) {
            greeted = true;
            greet(read);
          } else this.receive(read);
        }
      }
    } catch {}
  }
  private receive(read: Message): void {
    const e = event(read);
    switch (e?.type) {
      case "pong":
        this.ponged = Date.now();
        break;
      case "voice.muted":
        this.events.emitMuted(e.muted);
        break;
      case "voice.viewer":
        this.events.emitViewer(e.seen);
        break;
      case "closed":
        this.lost(e.reason);
        break;
      default:
        if (typeof read.id === "number") {
          this.pending.get(read.id)?.(read);
          this.pending.delete(read.id);
        }
    }
  }
  private send(value: object): void {
    if (this.closed) return;
    try {
      const stdin = this.child.stdin as import("bun").FileSink;
      stdin.write(json.stringify(value) + "\n");
      stdin.flush();
    } catch {}
  }
  private lost(reason: string): void {
    if (this.closed) return;
    const attached = this.attached;
    this.close();
    if (attached) this.events.emitClosed(reason);
  }
  private async request(op: protocol.Op, fields: object = {}): Promise<Message> {
    if (this.closed) throw Error("NotConnected");
    const id = this.next_id++,
      reply = new Promise<Message>(resolve => this.pending.set(id, resolve));
    this.send({ id, op, ...fields });
    const message = await bounded(reply, this.opts.deadline_ms, () => this.pending.delete(id));
    if (!message.ok) throw Error(errorName(message.err));
    return message;
  }
  async watch(req: WatchRequest): Promise<Watched> {
    // The voice runs on another host, so it is never one of the runtime's panes.
    const reply = await this.request("voice.watch", { muted: req.muted, available: req.available });
    // The same read may have held the reply and a close: nothing to attach to.
    if (this.closed) throw Error("ConnectionClosed");
    this.attached = true;
    return watched(reply);
  }
  async set(state: { muted?: boolean; available?: boolean }): Promise<{ muted: boolean }> {
    return { muted: (await this.request("voice.set", state)).muted === true };
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
    clearInterval(this.pinger);
    for (const resolve of this.pending.values()) resolve({ ok: false, err: "NotConnected" });
    this.pending.clear();
    try {
      (this.child.stdin as import("bun").FileSink).end();
    } catch {}
    this.child.kill();
  }
}
