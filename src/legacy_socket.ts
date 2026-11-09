// XXX: Remove for next protocol bump. A daemon an older build's updater
// started keeps that build's listener until the update is done, and answers
// JSON lines and HTTP `POST`s on it, so the older updater can check the new
// daemon and finish; then Bun's server takes the socket. Only a new client
// `POST`s `hello`, and hears the update isn't done yet.
import { n, ptr, ReadyLoop, READ, WRITE } from "./native_bridge";
import * as json from "./json";
import * as protocol from "./protocol";
import * as text from "./text";
import type * as peer from "./peer";
import type * as socket_server from "./socket_server";

/** Accepts on `fd`, a listener the older daemon handed over; `finishing`
 * says whether the update is still waiting on the older updater. */
export class Listener {
  private readonly registration: ReturnType<ReadyLoop["watch"]>;
  private closed = false;
  constructor(
    private readonly fd: number,
    private readonly loop: ReadyLoop,
    private readonly accept: socket_server.Accept,
    private readonly finishing: () => boolean = () => true,
  ) {
    n.probe_nonblock(fd);
    this.registration = loop.watch(fd, () => {
      // Readable with nothing to take: out of descriptors, say. Wait rather than spin.
      if (this.take()) this.registration.arm(READ);
      else setTimeout(() => this.closed || this.registration.arm(READ), 100);
    });
    this.registration.arm(READ);
  }
  /** Takes every waiting connection; how many. */
  private take(): number {
    for (let taken = 0; ; taken++) {
      const fd = n.probe_accept(this.fd);
      if (fd < 0) return taken;
      new Connection(fd, this.loop, this.accept, this.finishing);
    }
  }
  /** Stops accepting; connections already open, or waiting to be, carry on. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.take();
    this.registration.close();
    n.probe_close(this.fd);
  }
}
/** One connection: JSON lines, or an HTTP `POST` answered once. */
class Connection implements peer.Transport {
  private input = Buffer.alloc(0);
  private output = Buffer.alloc(0);
  private client: peer.Client | null = null;
  private http = false;
  private answered = false;
  private done = false;
  private readonly registration: ReturnType<ReadyLoop["watch"]>;
  private readonly scratch = Buffer.alloc(65536);
  constructor(
    private readonly fd: number,
    loop: ReadyLoop,
    private readonly accept: socket_server.Accept,
    private readonly finishing: () => boolean,
  ) {
    n.probe_nonblock(fd);
    this.registration = loop.watch(fd, () => {
      this.read();
      this.flush();
      this.arm();
    });
    this.arm();
  }
  get buffered(): number {
    return this.output.length;
  }
  send(bytes: Buffer): void {
    if (this.done) return;
    this.output = Buffer.concat([this.output, bytes]);
    this.flush();
    this.arm();
  }
  close(): void {
    if (this.done) return;
    this.done = true;
    this.registration.close();
    n.probe_close(this.fd);
    this.client?.closed();
  }
  private arm(): void {
    if (!this.done) this.registration.arm(READ | (this.output.length ? WRITE : 0));
  }
  private flush(): void {
    while (this.output.length && !this.done) {
      const count = n.probe_write(this.fd, ptr(this.output), this.output.length);
      if (count > 0) this.output = this.output.subarray(count);
      else if (count === -4) continue;
      else if (count === -11 || count === -35) return;
      else return this.close();
    }
    if (this.output.length || this.done) return;
    if (this.answered) this.close();
    else this.client?.flushed();
  }
  private read(): void {
    for (let i = 0; i < 8 && !this.done; i++) {
      const count = n.probe_read(this.fd, ptr(this.scratch), this.scratch.length);
      if (count > 0) this.receive(Buffer.from(this.scratch.subarray(0, count)));
      else if (count === -4) continue;
      else if (count === -11 || count === -35) return;
      else return this.close();
    }
  }
  private receive(bytes: Buffer): void {
    if (this.client && !this.http) return this.client.read(bytes);
    this.input = Buffer.concat([this.input, bytes]);
    if (this.input.length > 4 * 1024 * 1024) return this.close();
    if (!this.http) {
      const start = this.input.subarray(0, 5).toString();
      if (start.length < 5 && "POST ".startsWith(start)) return;
      if (start !== "POST ") {
        this.client = this.accept.connection(this);
        if (!this.client) return this.close();
        const input = this.input;
        this.input = Buffer.alloc(0);
        return this.client.read(input);
      }
      this.http = true;
    }
    if (this.client || this.answered) return;
    // One request: its head, then a Content-Length body.
    const head = this.input.indexOf("\r\n\r\n");
    if (head < 0) return;
    const length = /\r\ncontent-length:\s*(\d+)\r\n/i.exec(this.input.subarray(0, head + 2).toString("latin1"));
    if (!length) return this.respond({ err: "LengthRequired" });
    const end = head + 4 + Number(length[1]);
    if (this.input.length < end) return;
    let value: unknown;
    try {
      value = json.parse(this.input.subarray(head + 4, end).toString());
    } catch {
      return this.respond({ err: "InvalidJson" });
    }
    if (this.finishing() && protocol.parse(value) === "hello") return this.respond({ err: "UpdateIncomplete" });
    this.client = this.accept.request(value, reply => this.respond(reply));
    if (!this.client) this.close();
  }
  private respond(reply: unknown): void {
    const body = json.stringify(reply) + "\n",
      failed = !!reply && typeof reply === "object" && "err" in reply;
    this.answered = true;
    this.send(
      Buffer.from(
        `HTTP/1.1 ${failed ? "400 Bad Request" : "200 OK"}\r\nContent-Type: application/json\r\nContent-Length: ${text.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      ),
    );
  }
}
