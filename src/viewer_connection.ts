import * as rpc from "./rpc";
import * as rpc_http from "./rpc_http";
import * as errors from "./errors";
import * as protocol from "./protocol";
import type { Transport } from "./mirror";
import * as viewerVersion from "./viewer_version";

/** A request that must run once; it goes again over the link after a reload. */
interface Numbered {
  body: object;
  seq: bigint | null;
  resolve: (reply: any) => void;
  reject: (error: Error) => void;
}
/** How long a reload may take before the viewer gives up on it. */
const resume_ms = 10_000;

/** One control connection and one for pane content and output notifications.
 * Control carries a link: when a reload hands the daemon to a new process,
 * both reconnect, and the link brings the viewer and its commands back. */
export class Connection implements Transport {
  private control: rpc.Connection;
  private data: rpc.Connection | null = null;
  private watching: { viewer: number } | null = null;
  /** The daemon accepted the watch, so pane content can use the data connection. */
  private attached = false;
  /** A sync since then has caught up with changes made before the daemon would wake. */
  private watched = false;
  private closed = false;
  private listeners = new Set<(event: protocol.Event) => void>();
  private resumers = new Set<() => void>();
  private link: string | null = null;
  /** The link, opened before any request. */
  private linked: Promise<void>;
  private resuming: Promise<rpc.Connection> | null = null;
  /** The connection a reconnect is trying. */
  private reconnecting: rpc.Connection | null = null;
  /** Why the viewer can't reach the daemon again. */
  private failure: Error | null = null;
  private numbered: Numbered[] = [];
  private seq = 0n;
  /** The highest numbered request answered, after which the daemon forgets replies. */
  private answered = 0n;
  private replies = new Set<bigint>();
  /** The same daemon over HTTP. */
  readonly daemon: rpc_http.Client;
  constructor(readonly socket: string) {
    this.daemon = new rpc_http.Client(socket);
    this.control = this.adopt(new rpc.Connection(socket));
    this.linked = this.control.call("link.open").then(
      reply => {
        this.link = reply.link;
      },
      () => {},
    );
    this.connectData();
  }
  private emit(event: protocol.Event): void {
    for (const listener of this.listeners) listener(event);
  }
  onEvent(listener: (event: protocol.Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Called after a reload, once the viewer is back: subscriptions start again. */
  onResume(listener: () => void): () => void {
    this.resumers.add(listener);
    return () => {
      this.resumers.delete(listener);
    };
  }
  private adopt(control: rpc.Connection): rpc.Connection {
    control.onEvent(event => this.emit(event));
    control.onClose(() => {
      if (reloading(control.failure)) void this.resume(control).catch(() => {});
    });
    return control;
  }
  private connectData(): rpc.Connection {
    if (this.closed) throw Error("ConnectionClosed");
    if (this.data) return this.data;
    const data = (this.data = new rpc.Connection(this.socket));
    data.onEvent(event => this.emit(event));
    data.socket.once("close", () => this.dropData(data));
    return data;
  }
  private dropData(data: rpc.Connection): void {
    if (this.data !== data) return;
    this.data = null;
    this.attached = false;
    this.watched = false;
    this.watching = null;
    data.close();
  }
  request<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    switch (op) {
      case "viewer.sync":
        return this.sync(args[0] as protocol.RequestInput<"viewer.sync">) as Promise<protocol.Response<K>>;
      case "viewer.surfaces":
      case "viewer.image":
      case "viewer.search":
      case "viewer.pick":
      case "pane.surface":
        return this.content(op, ...args);
    }
    // Input and paste stay ordered with the commands that move or close panes.
    if (protocol.once(op)) return this.once(op, args[0]);
    return this.call(op, ...args);
  }
  /** A request on control. One a reload interrupts goes again: what isn't
   * numbered is safe to run twice. */
  private async call<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    for (let retried = false; ; retried = true) {
      const control = await this.current();
      try {
        return await control.request(op, ...args);
      } catch (error) {
        if (retried || !reloading(error)) throw error;
        await this.resume(control);
      }
    }
  }
  private async current(): Promise<rpc.Connection> {
    await this.linked;
    if (this.resuming) return this.resuming;
    if (this.failure) throw this.failure;
    return this.control;
  }
  /** Reconnects after `lost` closed for a reload, and resumes the link. */
  private resume(lost: rpc.Connection): Promise<rpc.Connection> {
    if (this.control !== lost) return this.current();
    if (!this.resuming)
      this.resuming = this.reconnect().finally(() => {
        this.resuming = null;
      });
    return this.resuming;
  }
  private async reconnect(): Promise<rpc.Connection> {
    const until = Date.now() + resume_ms;
    for (;;) {
      if (this.closed) throw Error("ConnectionClosed");
      // A daemon that takes the connection but never answers must not hold the viewer.
      let resumed = false;
      const control = new rpc.Connection(this.socket, {
        timeout_ms: () => (resumed ? 0 : Math.max(1, until - Date.now())),
      });
      this.reconnecting = control;
      try {
        const hello = await control.call("hello");
        if (hello.protocol !== protocol.version) throw Error("UnsupportedProtocol");
        // A reload that cut off the first link.open leaves none to resume.
        if (this.link) await control.call("link.resume", { link: this.link });
        else this.link = (await control.call("link.open")).link;
        resumed = true;
        this.control = this.adopt(control);
        if (this.data) this.dropData(this.data);
        for (const request of this.numbered) this.send(request, control);
        for (const listener of this.resumers) listener();
        return control;
      } catch (error) {
        control.close();
        // A daemon that lost the link restarted; one on another protocol is another build.
        const final = errors.is(error, "NoLink") || errors.is(error, "UnsupportedProtocol");
        if (final || Date.now() >= until) {
          this.failure = errors.is(error, "NoLink")
            ? Error("ConnectionClosed", { cause: "the daemon had no link to resume" })
            : (error as Error);
          for (const request of this.numbered.splice(0)) request.reject(this.failure);
          throw this.failure;
        }
        await Bun.sleep(50);
      } finally {
        this.reconnecting = null;
      }
    }
  }
  /** Sends a request that must run once, numbered over the link. */
  private async once(op: protocol.Op, payload: unknown): Promise<any> {
    const control = await this.current();
    if (!this.link) return this.call(op, payload as never);
    // A number given to a request that never leaves would stall every later one.
    if (control.backlogged || this.numbered.length >= 64) throw Error("RequestBackpressure");
    return new Promise((resolve, reject) => {
      const request: Numbered = {
        body: protocol.envelope(op, payload as Record<string, unknown>),
        seq: null,
        resolve,
        reject,
      };
      this.numbered.push(request);
      this.send(request, control);
    });
  }
  private send(request: Numbered, control: rpc.Connection): void {
    request.seq ??= ++this.seq;
    const seq = request.seq;
    control.rawRequest({ ...request.body, seq, answered: this.answered }).then(
      reply => {
        const index = this.numbered.indexOf(request);
        if (index < 0) return;
        this.numbered.splice(index, 1);
        this.replies.add(seq);
        while (this.replies.delete(this.answered + 1n)) this.answered++;
        request.resolve(reply);
      },
      error => {
        // A reload sends it again once the link is back.
        if (reloading(error) || reloading(control.failure)) return;
        const index = this.numbered.indexOf(request);
        if (index >= 0) this.numbered.splice(index, 1);
        request.reject(error);
      },
    );
  }
  private async content<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    const data = this.attached ? this.data : null;
    if (data)
      try {
        return await data.request(op, ...args);
      } catch (error) {
        this.dropData(data);
        if (this.closed) throw error;
      }
    return this.call(op, ...args);
  }
  private async sync(q: protocol.RequestInput<"viewer.sync">): Promise<protocol.Response<"viewer.sync">> {
    // Unwatched, one request on control brings the view and its surfaces.
    const attached = this.attached;
    const view = await this.call("viewer.sync", { ...q, surfaces: !attached });
    if ("err" in view) return view;
    viewerVersion.require(view);
    if (this.watching?.viewer !== view.viewer) this.watch(view.viewer);
    if (!attached) return view;
    const frames = await this.content("viewer.surfaces");
    if ("err" in frames) return frames;
    this.watched = this.attached;
    return { ...view, surfaces: frames.surfaces };
  }
  /** Sent beside the sync; until the daemon accepts, the viewer syncs every
   * frame, and a refusal is asked again on the next sync. */
  private watch(viewer: number): void {
    const data = this.connectData(),
      watching = { viewer };
    this.watching = watching;
    this.attached = false;
    this.watched = false;
    void data.request("viewer.watch", { viewer }).then(
      reply => {
        if (this.watching !== watching) return;
        if ("err" in reply) this.watching = null;
        else this.attached = true;
      },
      () => this.dropData(data),
    );
  }
  /** Whether the daemon wakes this viewer; until then it syncs every frame. */
  watches(): boolean {
    return this.watched;
  }
  close(): void {
    this.closed = true;
    // Commands a reload left to send again won't be; their callers hear so.
    for (const request of this.numbered.splice(0)) request.reject(Error("ConnectionClosed"));
    this.reconnecting?.close();
    this.control.close();
    if (this.data) this.dropData(this.data);
  }
}
/** Whether `error` is a reload closing the connection, which the link survives. */
function reloading(error: unknown): boolean {
  return errors.is(error, "ServerReloading");
}
