import { mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import * as ssh from "./ssh";
import * as telemetry from "./telemetry";
import type { Profile } from "./machines";

/** SSH authentication and channel setup precede the first daemon reply. */
export const startup_ms = 30_000;

const marker = Buffer.from("\ncorgi-bridge-v1\n");
/** Shell banners end at the native bridge's versioned boundary. */
export class Preamble extends Transform {
  private pending = Buffer.alloc(0);
  private ready = false;
  constructor(private readonly connected: () => void = () => {}) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.ready) {
      this.push(chunk);
    } else {
      this.pending = Buffer.concat([this.pending, chunk]);
      const boundary = this.pending.indexOf(marker);
      if (boundary >= 0) {
        this.ready = true;
        this.connected();
        this.push(this.pending.subarray(boundary + marker.length));
        this.pending = Buffer.alloc(0);
      } else if (this.pending.length > 65536) {
        done(Error("InvalidBridgePreamble"));
        return;
      }
    }
    done();
  }
  override _flush(done: (error?: Error | null) => void): void {
    done(this.ready ? null : Error("MissingBridgePreamble"));
  }
}

/** Presents a local daemon socket to RPC and auxiliary clients. No protocol or UI policy lives here. */
export class Remote {
  readonly directory = mkdtempSync(`/tmp/corgi-ssh-${process.getuid?.() ?? "user"}-`);
  readonly socket = this.directory + "/s";
  private listener: Server | null = null;
  private children = new Set<ChildProcess>();
  private clients = new Set<Socket>();
  private stopped = false;
  private started = false;
  private stderr = "";
  private bridge_ready = false;
  constructor(
    readonly profile: Profile,
    private readonly fresh = false,
    private readonly timeoutMs = startup_ms,
  ) {}
  async open(): Promise<void> {
    if (this.stopped || this.started) throw Error("TransportClosed");
    this.started = true;
    if (!this.profile.bridge) return this.forward();
    const listener = (this.listener = createServer(client => this.attach(client)));
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(this.socket, () => {
        if (this.stopped) {
          listener.close();
          rmSync(this.directory, { recursive: true, force: true });
          reject(Error("TransportClosed"));
          return;
        }
        try {
          chmodSync(this.socket, 0o600);
          resolve();
        } catch (error) {
          this.close();
          reject(error);
        }
      });
    });
  }
  private attach(client: Socket): void {
    if (this.stopped) {
      client.destroy();
      return;
    }
    this.clients.add(client);
    let child: ChildProcess;
    try {
      child = this.spawn([
        ...ssh.args(this.profile.target, false, this.fresh),
        ssh.command(this.profile.bridge!, [this.profile.socket]),
      ]);
    } catch (error) {
      this.stderr = error instanceof Error ? error.message : "SSH startup failed";
      this.clients.delete(client);
      client.destroy();
      return;
    }
    const preamble = new Preamble(() => {
      this.bridge_ready = true;
      telemetry.event("remote.transport", {
        machine: this.profile.name,
        phase: "bridge",
        pid: child.pid ?? 0,
        fresh: Number(this.fresh),
      });
    });
    const close = () => {
      client.destroy();
      preamble.destroy();
      this.stop(child);
      this.clients.delete(client);
    };
    client.on("error", close).once("close", close);
    child.once("error", close);
    child.stdin!.on("error", close);
    child.stdout!.on("error", close);
    preamble.on("error", close);
    // pipe propagates backpressure independently in each direction.
    client.pipe(child.stdin!);
    child.stdout!.pipe(preamble).pipe(client);
    child.once("close", () => {
      if (!client.writableEnded) client.end();
    });
  }
  private spawn(args: string[]): ChildProcess {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.children.add(child);
    telemetry.event("remote.transport", {
      machine: this.profile.name,
      phase: "spawn",
      pid: child.pid ?? 0,
      fresh: Number(this.fresh),
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4096);
    });
    child.once("close", (code, signal) => {
      this.children.delete(child);
      telemetry.event("remote.transport", {
        machine: this.profile.name,
        phase: "exit",
        pid: child.pid ?? 0,
        code: code ?? -1,
        signal: signal ?? "",
      });
    });
    return child;
  }
  private stop(child: ChildProcess): void {
    child.kill();
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  /** Older saved profiles retain forwarding until machine setup discovers a native bridge. */
  private async forward(): Promise<void> {
    const args = ssh.args(this.profile.target, false, true);
    args.unshift(
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StreamLocalBindMask=0177",
      "-L",
      `${this.socket}:${this.profile.socket}`,
    );
    const child = this.spawn(args);
    child.stdin!.end();
    child.stdout!.resume();
    let failure: Error | null = null;
    child.once("error", () => {
      failure = Error("SshUnavailable");
    });
    child.once("exit", () => {
      failure ??= Error("SshDisconnected");
    });
    try {
      const until = performance.now() + this.timeoutMs;
      while (!existsSync(this.socket)) {
        if (failure) throw failure;
        if (this.stopped) throw Error("TransportClosed");
        if (performance.now() >= until) throw Error("RemoteTimedOut");
        await Bun.sleep(25);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  diagnostic(): string {
    return this.stderr.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  }
  progress(): string {
    return this.bridge_ready ? "waiting for daemon" : "opening SSH connection";
  }
  close(): void {
    this.stopped = true;
    this.listener?.close();
    for (const client of this.clients) client.destroy();
    for (const child of this.children) this.stop(child);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
