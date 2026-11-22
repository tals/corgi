//! Forwards another machine's loopback ports to this computer, so a link to
//! localhost there opens here. The pointer resting on such a link reserves a
//! port here, and Corgi draws the link pointing at it, so the host terminal's
//! own Cmd+click opens it forwarded.
//!
//! A reservation holds nothing on the machine until a request or a click
//! realizes it. Until then it isn't listed, gives its port up to any forward
//! that wants it, and expires a while after the pointer leaves its link.
//! Connections go over the machine's `Link`, which its transport provides.
//! Realized forwards last as long as the viewer.
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

/** Why a connection couldn't reach the port: nothing took it there, the
 * machine's SSH server doesn't forward, or the machine couldn't be reached. */
export type Failure = "refused" | "prohibited" | "unreachable";
/** One connection's way to the machine's port. `done` settles once it's
 * over, with what stopped it reaching the port, if anything did. */
export interface Channel {
  input: Writable;
  output: Readable;
  done: Promise<Failure | null>;
  close(): void;
}
/** A transport's way to ports on one machine. */
export interface Link {
  /** Readies the way before the first connection, such as one that must
   * log in, so a browser's first handful don't each start it. Throws
   * "MachineUnreachable" when it can't, and gives up once `signal` aborts. */
  prepare(signal: AbortSignal): Promise<void>;
  /** A connection to `host`:`port` as the machine resolves them. */
  dial(host: string, port: number): Channel;
}
/** A port on the machine, as its link dials it there. */
export interface Target {
  host: string;
  port: number;
}
export interface Forward extends Target {
  /** The port on this computer's loopback. */
  local: number;
  /** The link it was made for, or the last one opened through Corgi (a
   * click, or a pane program's BROWSER), pointing here: what the card opens
   * again. A Cmd+click the terminal handles itself isn't seen. */
  url: string;
  /** Connections open now. */
  open: number;
  /** Set when the last connection couldn't reach the port. */
  failure: Failure | null;
  /** A request or a click made it real: it's listed, and kept. */
  realized: boolean;
}
/** A browser opens a handful at a time; past this, something is looping. */
const channel_limit = 64;
/** A port on this computer that takes connections is in use, whoever bound it. */
const probe_ms = 300;
/** An unrealized reservation lasts this long after the pointer leaves its link. */
export const reserved_ms = 60_000;
/** The way to the machine is checked again before connections this long
 * after it was last readied: an idle SSH master goes after ten minutes. */
const ready_ms = 60_000;
/** A pointer at rest keeps its link's reservation this long after it last moved. */
export const hover_ms = 5 * 60_000;

function loopback(parsed: URL): Target | null {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const name = parsed.hostname.toLowerCase();
  const local =
    name === "localhost" ||
    name.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(name) ||
    ["[::1]", "0.0.0.0", "[::]"].includes(name);
  if (!local) return null;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  // localhost reaches a server on either loopback, whichever the link named.
  return { host: /^127\./.test(name) && name !== "127.0.0.1" ? name : "localhost", port };
}
function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
/** The machine's port a link points at, when it's on the machine's own
 * loopback: localhost and its subdomains, 127.0.0.0/8, ::1, or a wildcard
 * address servers print, such as 0.0.0.0. */
export function target(url: string): Target | null {
  const parsed = parse(url);
  return parsed && loopback(parsed);
}
/** `url` pointing at `port` on this computer's loopback. Only its host and
 * port change, spliced into the text: the rest stays as the machine wrote it,
 * not as a URL parser would write it again. */
export function rewrite(url: string, port: number, ipv6: boolean): string {
  const authority = /^(https?:\/\/(?:[^/?#@]*@)?)(\[[^\]]*\]|[^:/?#]*)(?::\d*)?/i.exec(url);
  if (!authority) return url;
  const name = authority[2].toLowerCase(),
    host =
      name === "0.0.0.0" || name === "[::]"
        ? "localhost"
        : /^127\./.test(name) || (name === "[::1]" && !ipv6)
          ? "127.0.0.1"
          : authority[2];
  return `${authority[1]}${host}:${port}${url.slice(authority[0].length)}`;
}
/** Ports browsers refuse to connect to, as Chromium lists them. */
const restricted = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
function answers(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = (taken: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(taken);
    };
    const timer = setTimeout(() => done(false), probe_ms);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
/** Takes a listener's connections, from the moment it listens. */
type Accept = (socket: Socket) => void;
function listen(host: string, port: number, accept: Accept): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Each side ends on its own: a request sent, its reply still on the way.
    const server = createServer({ allowHalfOpen: true }, accept);
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
async function optional(host: string, port: number, accept: Accept): Promise<Server[]> {
  try {
    return [await listen(host, port, accept)];
  } catch {
    return [];
  }
}
/** Listeners on both loopbacks on `port`, unless something here answers
 * there or a realized forward holds it. A port an unrealized reservation
 * holds is up for grabs. IPv6 is best effort. */
async function claim(port: number, accept: Accept): Promise<Server[] | null> {
  const holder = held.get(port);
  if (holder?.entry.forward.realized) return null;
  if (holder) holder.forwards.drop(holder.entry);
  for (const address of ["127.0.0.1", "::1"]) if (await answers(address, port)) return null;
  try {
    return [await listen("127.0.0.1", port, accept), ...(await optional("::1", port, accept))];
  } catch {
    return null;
  }
}
/** Listeners for the machine's port here when it's free, else the next one
 * up, else one the system picks. */
async function bind(wanted: number, accept: Accept): Promise<Server[]> {
  for (const port of [wanted, wanted + 1]) {
    if (port > 65535 || (port !== wanted && restricted.has(port))) continue;
    const servers = await claim(port, accept);
    if (servers) return servers;
  }
  const v4 = await listen("127.0.0.1", 0, accept);
  return [v4, ...(await optional("::1", (v4.address() as AddressInfo).port, accept))];
}

interface Entry {
  forward: Forward;
  servers: Server[];
  ipv6: boolean;
  /** When it expires, unrealized. */
  until: number;
  sockets: Set<Socket>;
  channels: Set<Channel>;
}
const key = (entry: Entry) => `${entry.forward.host}:${entry.forward.port}`;
/** The local ports this viewer's forwards hold, whichever machine's. */
const held = new Map<number, { forwards: Forwards; entry: Entry }>();

/** One machine's forwards and reservations. */
export class Forwards {
  private entries: Entry[] = [];
  private pending = new Map<string, Promise<Entry>>();
  private prepared: { done: Promise<void>; at: number } | null = null;
  private stopping = new AbortController();
  /** The link under the pointer, and its port's reservation, which doesn't
   * expire while the pointer moved lately: one that left the window from the
   * link stops holding it. */
  private hovered: string | null = null;
  private hovering: string | null = null;
  private moved_at = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Told when a forward or reservation comes, goes, or its connections change. */
  onChange: () => void = () => {};
  /** Told when a forward is realized, by a click or a request. */
  onRealized: (forward: Forward) => void = () => {};
  constructor(
    private readonly link: Link,
    private readonly clock: () => number = Date.now,
  ) {}
  /** Realized forwards, in the order they were made. */
  get list(): Forward[] {
    return this.entries.filter(entry => entry.forward.realized).map(entry => entry.forward);
  }
  /** `url` pointing at its port's reservation here, once there is one. */
  local(url: string): string | null {
    const wanted = target(url),
      entry = wanted && this.find(wanted);
    return entry ? rewrite(url, entry.forward.local, entry.ipv6) : null;
  }
  /** Where the host terminal's Cmd+click on `url` goes: itself, or for a
   * link to the machine's loopback, its reservation here once there is one. */
  opens(url: string): string | null {
    return target(url) ? this.local(url) : url;
  }
  /** The pointer is on `url`, or on no link: a reservation lasts while it
   * stays, and for a while after. */
  hover(url: string | null, moved = true): void {
    if (url === this.hovered) {
      if (!moved) {
        // Another forward may have taken its port: reserved again while the pointer's hold lasts.
        if (url !== null && this.clock() - this.moved_at < hover_ms && target(url) && !this.local(url))
          this.reserve(url);
        return;
      }
      this.moved_at = this.clock();
      // A move within the link brings back a reservation that ran out while the pointer rested.
      if (url !== null) this.reserve(url);
      return;
    }
    this.moved_at = this.clock();
    const left = this.hovering,
      now = this.clock(),
      at = url === null ? null : target(url);
    this.hovered = url;
    this.hovering = at && `${at.host}:${at.port}`;
    for (const entry of this.entries)
      if (key(entry) === left && left !== this.hovering) entry.until = Math.max(entry.until, now + reserved_ms);
    if (url !== null) this.reserve(url);
    this.arm();
  }
  /** Reserves the port of a link the pointer rests on. */
  reserve(url: string): void {
    const wanted = target(url);
    if (wanted) void this.ensure(wanted, url).catch(() => {});
  }
  /** A click on `url`: its port forwarded and realized, and `url` pointing
   * here. Null for a link with nothing to forward. */
  async open(url: string): Promise<string | null> {
    const wanted = target(url);
    if (!wanted) return null;
    const entry = await this.ensure(wanted, url);
    entry.forward.url = rewrite(url, entry.forward.local, entry.ipv6);
    this.realize(entry);
    this.onChange();
    return entry.forward.url;
  }
  private find(wanted: Target): Entry | null {
    return this.entries.find(e => e.forward.host === wanted.host && e.forward.port === wanted.port) ?? null;
  }
  private async ensure(wanted: Target, url: string): Promise<Entry> {
    const key = `${wanted.host}:${wanted.port}`;
    // Another forward can take the port while this one waits for it: once.
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw Error("ForwardsClosed");
      let entry = this.find(wanted);
      if (!entry) {
        let pending = this.pending.get(key);
        if (!pending) {
          pending = this.create(wanted, url);
          this.pending.set(key, pending);
          void pending.catch(() => {}).finally(() => this.pending.delete(key));
        }
        entry = await pending;
      }
      if (!this.entries.includes(entry)) {
        if (attempt) throw Error("PortTaken");
        continue;
      }
      entry.until = Math.max(entry.until, this.clock() + reserved_ms);
      this.arm();
      return entry;
    }
  }
  private async create(wanted: Target, url: string): Promise<Entry> {
    // A connection before the entry is made, such as another forward's probe, has nowhere to go.
    let made: Entry | null = null;
    const servers = await bind(wanted.port, socket => (made ? this.carry(made, socket) : socket.destroy())),
      local = (servers[0].address() as AddressInfo).port,
      ipv6 = servers.length > 1;
    if (this.closed) {
      for (const server of servers) server.close();
      throw Error("ForwardsClosed");
    }
    const entry: Entry = {
      forward: { ...wanted, local, url: rewrite(url, local, ipv6), open: 0, failure: null, realized: false },
      servers,
      ipv6,
      until: 0,
      sockets: new Set(),
      channels: new Set(),
    };
    made = entry;
    this.entries.push(entry);
    held.set(local, { forwards: this, entry });
    this.onChange();
    return entry;
  }
  private realize(entry: Entry): void {
    if (entry.forward.realized) return;
    entry.forward.realized = true;
    this.onRealized(entry.forward);
    this.onChange();
  }
  /** The way to the machine, readied before a burst of connections; one
   * readied a while ago is checked again, since it may have gone since. */
  private ready(): Promise<void> {
    const now = this.clock();
    if (this.prepared && now - this.prepared.at < ready_ms) return this.prepared.done;
    const prepared = {
      at: now,
      done: this.link.prepare(this.stopping.signal).catch(error => {
        if (this.prepared === prepared) this.prepared = null;
        throw error;
      }),
    };
    this.prepared = prepared;
    return prepared.done;
  }
  private carry(entry: Entry, socket: Socket): void {
    if (!this.entries.includes(entry) || entry.sockets.size >= channel_limit) {
      socket.destroy();
      return;
    }
    entry.sockets.add(socket);
    let channel: Channel | null = null,
      spoke = false,
      ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      socket.destroy();
      channel?.close();
      entry.sockets.delete(socket);
      if (channel) entry.channels.delete(channel);
      entry.forward.open = entry.channels.size;
      this.arm();
      this.onChange();
    };
    socket.on("error", end).once("close", end);
    // A client that closes without a word, such as a preconnect given up, is
    // let go; a request's half-close goes on to the machine.
    socket.once("end", () => {
      if (!spoke) end();
    });
    // Nothing reaches the machine before the client speaks: a port probe or
    // a browser's preconnect realizes nothing.
    socket.once("data", (first: Buffer) => {
      spoke = true;
      socket.pause();
      this.realize(entry);
      this.ready().then(
        () => {
          if (ended) return;
          try {
            channel = this.link.dial(entry.forward.host, entry.forward.port);
          } catch {
            entry.forward.failure = "unreachable";
            return end();
          }
          const ch = channel;
          entry.channels.add(ch);
          entry.forward.open = entry.channels.size;
          this.onChange();
          ch.input.on("error", end);
          ch.output.on("error", end);
          // A reply means the port answered.
          ch.output.once("data", () => {
            if (entry.forward.failure === null) return;
            entry.forward.failure = null;
            this.onChange();
          });
          // pipe propagates backpressure independently in each direction, and
          // the reply's end ends the socket once it's written.
          ch.input.write(first);
          socket.pipe(ch.input);
          ch.output.pipe(socket);
          void ch.done.then(failure => {
            if (failure) {
              entry.forward.failure = failure;
              socket.destroy();
              this.onChange();
            }
            // A client that never closes its side is let go.
            setTimeout(end, 5000).unref();
          });
        },
        () => {
          entry.forward.failure = "unreachable";
          end();
        },
      );
    });
  }
  /** Whether `entry` can expire: unrealized, with no connection open. */
  private expires(entry: Entry): boolean {
    return !entry.forward.realized && !entry.sockets.size;
  }
  /** When `entry` expires: its own time, or later while the pointer rests on its link. */
  private deadline(entry: Entry): number {
    return key(entry) === this.hovering ? Math.max(entry.until, this.moved_at + hover_ms) : entry.until;
  }
  /** Drops reservations past their time. */
  expire(now = this.clock()): void {
    for (const entry of [...this.entries]) if (this.expires(entry) && this.deadline(entry) <= now) this.drop(entry);
    this.arm();
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...this.entries.filter(e => this.expires(e)).map(e => this.deadline(e)));
    if (!Number.isFinite(next) || this.closed) return;
    this.timer = setTimeout(() => this.expire(), Math.max(0, next - this.clock()) + 10);
    this.timer.unref?.();
  }
  /** Stops listening on the port and closes its connections, realized or not. */
  drop(entry: Entry): void {
    if (!this.entries.includes(entry)) return;
    this.entries = this.entries.filter(e => e !== entry);
    if (held.get(entry.forward.local)?.entry === entry) held.delete(entry.forward.local);
    for (const server of entry.servers) server.close();
    for (const socket of entry.sockets) socket.destroy();
    for (const channel of entry.channels) channel.close();
    this.onChange();
  }
  /** Stops a forward the card lists. */
  stop(forward: Forward): void {
    const entry = this.entries.find(e => e.forward === forward);
    if (entry) this.drop(entry);
  }
  close(): void {
    this.closed = true;
    // A way to the machine still being readied gives up, so the viewer can exit.
    this.stopping.abort();
    for (const entry of [...this.entries]) this.drop(entry);
    if (this.timer) clearTimeout(this.timer);
  }
}
