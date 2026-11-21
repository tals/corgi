//! Forwards another machine's loopback ports to this computer, so a link to
//! localhost there opens here. The pointer resting on such a link reserves a
//! port here, and Corgi draws the link pointing at it, so the host terminal's
//! own Cmd+click opens it forwarded. A link carrying a loopback callback, as a
//! sign-in's does, reserves the callback's port as it is.
//!
//! A reservation holds nothing on the machine until a request or a click
//! realizes it. Until then it isn't listed, gives its port up to any forward
//! that wants it, and expires a while after the pointer leaves its link.
//! Connections go over the machine's `Link`, which its transport provides.
//! Realized forwards last as long as the viewer; a callback's, until it's
//! been idle a while.
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import * as errors from "./errors";

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
   * "MachineUnreachable" when it can't. */
  prepare(): Promise<void>;
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
  /** The link last opened through it, pointing here. */
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
/** A callback's lasts this long after its last connection, realized or not: a
 * sign-in can take minutes to come back, then it's done. */
export const callback_ms = 10 * 60_000;
/** The way to the machine is checked again before connections this long
 * after it was last readied: an idle SSH master goes after ten minutes. */
const ready_ms = 60_000;
/** A pointer at rest keeps its link's reservation this long after it last moved. */
export const hover_ms = 5 * 60_000;
/** A callback port in use here is tried again after this long. */
const blocked_ms = 2000;

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
/** Loopback URLs a web link carries in its query or fragment, such as a
 * sign-in's `redirect_uri`. The server they name waits for the browser to
 * come back there, so they're forwarded as they are, never rewritten. */
export function callbacks(url: string): string[] {
  const parsed = parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return [];
  const values = [...parsed.searchParams.values()],
    fragment = parsed.hash.slice(1);
  if (fragment.includes("=")) values.push(...new URLSearchParams(fragment).values());
  return [...new Set(values.filter(value => target(value) !== null))];
}
/** The address here a browser coming back to callback `url` connects to,
 * which a callback's forward must listen on as the link names it. */
export function returnAddress(url: string): string {
  const name = parse(url)?.hostname.toLowerCase() ?? "";
  if (name === "[::1]") return "::1";
  return /^127\.\d+\.\d+\.\d+$/.test(name) ? name : "127.0.0.1";
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
function listen(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Each side ends on its own: a request sent, its reply still on the way.
    const server = createServer({ allowHalfOpen: true });
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
async function optional(host: string, port: number): Promise<Server[]> {
  try {
    return [await listen(host, port)];
  } catch {
    return [];
  }
}
/** Listeners on both loopbacks on `port`, unless something here answers
 * there or a realized forward holds it. A port an unrealized reservation
 * holds is up for grabs. IPv6 is best effort. */
interface Bound {
  servers: Server[];
  port: number;
  /** The addresses it listens on, IPv6's without brackets. */
  addresses: Set<string>;
}
/** Listeners on both loopbacks on `port`, and on `also` as well, unless
 * something here answers there or a realized forward holds it. A port an
 * unrealized reservation holds is up for grabs. IPv6 is best effort. */
async function claim(port: number, also: string | null): Promise<Bound | null> {
  const holder = held.get(port);
  if (holder?.entry.forward.realized) return null;
  if (holder) holder.forwards.drop(holder.entry);
  const extra = also && also !== "127.0.0.1" && also !== "::1" ? also : null;
  for (const address of ["127.0.0.1", "::1", ...(extra ? [extra] : [])]) if (await answers(address, port)) return null;
  const servers: Server[] = [];
  try {
    servers.push(await listen("127.0.0.1", port));
    servers.push(...(await optional("::1", port)));
    if (extra) servers.push(await listen(extra, port));
  } catch {
    for (const server of servers) server.close();
    return null;
  }
  const addresses = new Set(servers.map(server => (server.address() as AddressInfo).address));
  return { servers, port, addresses };
}
/** The machine's port here when it's free, else the next one up, else,
 * unless `exact`, one the system picks. `also` is an address it must listen on too. */
async function bind(wanted: number, exact: boolean, also: string | null): Promise<Bound> {
  for (const port of exact ? [wanted] : [wanted, wanted + 1]) {
    if (port > 65535 || (port !== wanted && restricted.has(port))) continue;
    const bound = await claim(port, also);
    if (bound) return bound;
  }
  if (exact) throw Error("PortInUse");
  const v4 = await listen("127.0.0.1", 0),
    port = (v4.address() as AddressInfo).port,
    servers = [v4, ...(await optional("::1", port))];
  return { servers, port, addresses: new Set(servers.map(server => (server.address() as AddressInfo).address)) };
}

interface Entry {
  forward: Forward;
  servers: Server[];
  /** The addresses it listens on, as `Bound` has them. */
  addresses: Set<string>;
  ipv6: boolean;
  /** Its local port is the machine's, as a callback's must be. */
  exact: boolean;
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
  /** The link under the pointer, and its ports', which don't expire while
   * the pointer moved lately: one that left the window from the link stops
   * holding them. */
  private hovered: string | null = null;
  private hovering = new Set<string>();
  private moved_at = 0;
  /** Callback ports found in use here, and when: tried again after a moment. */
  private blocked = new Map<number, number>();
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
  /** Ports of `url`'s callbacks that are in use here, so it can't come back. */
  unavailable(url: string): number[] {
    return callbacks(url)
      .map(callback => target(callback)!.port)
      .filter(port => this.blocked.has(port));
  }
  /** The pointer is on `url`, or on no link: a reservation lasts while it
   * stays, and for a while after. */
  hover(url: string | null, moved = true): void {
    if (url === this.hovered) {
      if (moved) this.moved_at = this.clock();
      return;
    }
    this.moved_at = this.clock();
    const left = this.hovering,
      now = this.clock();
    this.hovered = url;
    this.hovering = new Set(
      (url === null ? [] : [url, ...callbacks(url)]).flatMap(link => {
        const at = target(link);
        return at ? [`${at.host}:${at.port}`] : [];
      }),
    );
    for (const entry of this.entries)
      if (left.has(key(entry)) && !this.hovering.has(key(entry)))
        entry.until = Math.max(entry.until, now + (entry.exact ? callback_ms : reserved_ms));
    if (url !== null) this.reserve(url);
    this.arm();
  }
  /** Reserves ports for a link the pointer rests on: its own, and its callbacks'. */
  reserve(url: string): void {
    const wanted = target(url);
    if (wanted) void this.ensure(wanted, url, false).catch(() => {});
    for (const callback of callbacks(url)) {
      const at = target(callback)!;
      if (this.clock() - (this.blocked.get(at.port) ?? -Infinity) < blocked_ms) continue;
      void this.ensure(at, callback, true).then(
        () => this.blocked.delete(at.port) && this.onChange(),
        error => {
          if (!errors.is(error, "PortInUse")) return;
          this.blocked.set(at.port, this.clock());
          this.onChange();
        },
      );
    }
  }
  /** A click on `url`: its port forwarded and realized, with `url` pointing
   * here; a link carrying callbacks opens as it is, their ports forwarded
   * unchanged, and says which were in use here. Null for a link with nothing
   * to forward. */
  async open(url: string): Promise<{ url: string; unavailable: number[] } | null> {
    const wanted = target(url),
      nested = callbacks(url);
    if (!wanted && !nested.length) return null;
    const unavailable: number[] = [];
    for (const callback of nested) {
      const at = target(callback)!;
      try {
        this.realize(await this.ensure(at, callback, true));
        this.blocked.delete(at.port);
      } catch (error) {
        if (!errors.is(error, "PortInUse")) throw error;
        this.blocked.set(at.port, this.clock());
        unavailable.push(at.port);
      }
    }
    if (!wanted) return { url, unavailable };
    const entry = await this.ensure(wanted, url, false);
    entry.forward.url = rewrite(url, entry.forward.local, entry.ipv6);
    this.realize(entry);
    this.onChange();
    return { url: entry.forward.url, unavailable };
  }
  private find(wanted: Target): Entry | null {
    return this.entries.find(e => e.forward.host === wanted.host && e.forward.port === wanted.port) ?? null;
  }
  private async ensure(wanted: Target, url: string, exact: boolean): Promise<Entry> {
    const key = `${wanted.host}:${wanted.port}`;
    // Another forward can take the port while this one waits for it: once.
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw Error("ForwardsClosed");
      let entry = this.find(wanted);
      if (!entry) {
        let pending = this.pending.get(key);
        if (!pending) {
          pending = this.create(wanted, url, exact);
          this.pending.set(key, pending);
          void pending.catch(() => {}).finally(() => this.pending.delete(key));
        }
        entry = await pending;
      }
      if (!this.entries.includes(entry)) {
        if (attempt) throw Error("PortTaken");
        continue;
      }
      // A callback comes back to its own port and address, which a link to it may have moved.
      if (exact && (entry.forward.local !== wanted.port || !entry.addresses.has(returnAddress(url))))
        throw Error("PortInUse");
      // A forward in use stays one: a link carrying it as a callback doesn't make it expire.
      if (!entry.forward.realized) entry.exact ||= exact;
      entry.until = Math.max(entry.until, this.clock() + (exact ? callback_ms : reserved_ms));
      this.arm();
      return entry;
    }
  }
  private async create(wanted: Target, url: string, exact: boolean): Promise<Entry> {
    const { servers, port: local, addresses } = await bind(wanted.port, exact, exact ? returnAddress(url) : null),
      ipv6 = addresses.has("::1");
    if (this.closed) {
      for (const server of servers) server.close();
      throw Error("ForwardsClosed");
    }
    const entry: Entry = {
      forward: { ...wanted, local, url: rewrite(url, local, ipv6), open: 0, failure: null, realized: false },
      servers,
      addresses,
      ipv6,
      exact,
      until: 0,
      sockets: new Set(),
      channels: new Set(),
    };
    for (const server of servers) server.on("connection", socket => this.carry(entry, socket));
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
      done: this.link.prepare().catch(error => {
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
      ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      socket.destroy();
      channel?.close();
      entry.sockets.delete(socket);
      if (channel) entry.channels.delete(channel);
      entry.forward.open = entry.channels.size;
      // A callback waits again from its last connection.
      if (entry.exact) entry.until = Math.max(entry.until, this.clock() + callback_ms);
      this.arm();
      this.onChange();
    };
    socket.on("error", end).once("close", end);
    // Nothing reaches the machine before the client speaks: a port probe or
    // a browser's preconnect realizes nothing.
    socket.once("data", (first: Buffer) => {
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
  /** Whether `entry` can expire: unrealized, or a callback's, with no
   * connection open and the pointer off its link. */
  private expires(entry: Entry): boolean {
    return (!entry.forward.realized || entry.exact) && !entry.sockets.size;
  }
  /** When `entry` expires: its own time, or later while the pointer rests on its link. */
  private deadline(entry: Entry): number {
    return this.hovering.has(key(entry)) ? Math.max(entry.until, this.moved_at + hover_ms) : entry.until;
  }
  /** Drops reservations and callbacks past their time. */
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
    for (const entry of [...this.entries]) this.drop(entry);
    if (this.timer) clearTimeout(this.timer);
  }
}
