import { mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import * as ssh from "./ssh";
import * as telemetry from "./telemetry";
import * as lab from "./remote_lab";
import type { Profile } from "./machines";
import type * as portForwards from "./port_forwards";

/** SSH authentication and channel setup precede the first daemon reply. */
export const startup_ms = 30_000;

/** Runs `ssh` for one of `profile`'s lanes, handing on what it says. */
function spawnSsh(profile: Profile, args: string[], lane: ssh.Lane, fresh: boolean, stderr: (chunk: string) => void) {
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  telemetry.event("remote.transport", {
    machine: profile.name,
    phase: "spawn",
    lane,
    pid: child.pid ?? 0,
    fresh: Number(fresh),
  });
  child.stderr!.on("data", (chunk: Buffer) => stderr(chunk.toString()));
  child.once("close", (code, signal) => {
    telemetry.event("remote.transport", {
      machine: profile.name,
      phase: "exit",
      pid: child.pid ?? 0,
      code: code ?? -1,
      signal: signal ?? "",
    });
  });
  return child;
}
function stop(child: ChildProcess): void {
  child.kill();
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export function bridgePreamble(connected?: () => void): Transform {
  const preamble = new ssh.Preamble(ssh.bridgeMarker, connected);
  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        done(null, preamble.read(chunk));
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      done(preamble.endError());
    },
  });
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
  /** With `start`, a daemon that isn't running is started; only a viewer
   * reaching the machine asks that. */
  constructor(
    readonly profile: Profile,
    private readonly fresh = false,
    private readonly timeoutMs = startup_ms,
    private readonly lane: "control" | "data" = "control",
    private readonly start = false,
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
        ...ssh.args(this.profile.target, false, this.fresh, this.lane),
        ssh.bridge(this.profile.executable, this.profile.bridge!, this.profile.socket, this.start),
      ]);
    } catch (error) {
      this.stderr = error instanceof Error ? error.message : "SSH startup failed";
      this.clients.delete(client);
      client.destroy();
      return;
    }
    const preamble = bridgePreamble(() => {
      this.bridge_ready = true;
      telemetry.event("remote.transport", {
        machine: this.profile.name,
        phase: "bridge",
        pid: child.pid ?? 0,
        fresh: Number(this.fresh),
        lane: this.lane,
      });
    });
    const close = () => {
      client.destroy();
      preamble.destroy();
      if ("up" in faults) {
        faults.up.destroy();
        faults.down.destroy();
      }
      faults.done();
      stop(child);
      this.clients.delete(client);
    };
    const faults = lab.local.connect(this.profile.name, close);
    client.on("error", close).once("close", close);
    child.once("error", close);
    child.stdin!.on("error", close);
    child.stdout!.on("error", close);
    preamble.on("error", close);
    // pipe propagates backpressure independently in each direction.
    if ("up" in faults) {
      faults.up.on("error", close);
      faults.down.on("error", close);
      client.pipe(faults.up).pipe(child.stdin!);
      child.stdout!.pipe(faults.down).pipe(preamble).pipe(client);
    } else {
      client.pipe(child.stdin!);
      child.stdout!.pipe(preamble).pipe(client);
    }
    child.once("close", () => {
      // Replies a fault still holds reach the client before it ends.
      if ("up" in faults) {
        if (!faults.down.writableEnded) faults.down.end();
      } else if (!client.writableEnded) client.end();
    });
  }
  private spawn(args: string[]): ChildProcess {
    const child = spawnSsh(
      this.profile,
      args,
      this.lane,
      this.fresh,
      chunk => (this.stderr = (this.stderr + chunk).slice(-4096)),
    );
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    return child;
  }
  /** Older saved profiles retain forwarding until machine setup discovers a native bridge. */
  private async forward(): Promise<void> {
    lab.local.forwards(this.profile.name);
    // Its own connection, carrying what Corgi already compresses.
    const args = ssh.args(this.profile.target, false, true, "data");
    // Clearing forwardings would clear this one too.
    args[args.indexOf("ClearAllForwardings=yes")] = "ClearAllForwardings=no";
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
    for (const child of this.children) stop(child);
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** What a failed `ssh -W` said. Through a shared master, a channel the
 * machine refused reads only "Stdio forwarding failed". */
export function portFailure(stderr: string): portForwards.Failure {
  if (/administratively prohibited/i.test(stderr)) return "prohibited";
  if (/open failed|forwarding.*failed|refused by peer/i.test(stderr)) return "refused";
  return "unreachable";
}
/** SSH's own connect timeout, and a little more. */
const ports_prepare_ms = 35_000;
/** Ports on the machine's loopback: each connection is an `ssh -W` on the
 * forward lane, a master of its own, so a page loading can't hold up typing
 * or pane data. */
export class Ports implements portForwards.Link {
  constructor(readonly profile: Profile) {}
  private args(...extra: string[]): string[] {
    const list = ssh.args(this.profile.target, false, false, "forward");
    list.splice(list.indexOf("--"), 0, ...extra);
    return list;
  }
  private check(): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn("ssh", this.args("-O", "check"), { stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("exit", code => resolve(code === 0));
    });
  }
  async prepare(signal: AbortSignal): Promise<void> {
    if (await this.check()) return;
    if (signal.aborted) throw Error("ForwardsClosed");
    // With ControlPersist, -N backgrounds the new master once it's in. One
    // that lost the race to another viewer's master would stay in front
    // instead, so the check decides.
    const child = spawnSsh(this.profile, this.args("-N"), "forward", false, () => {});
    child.stdin!.end();
    let exited: number | null | undefined;
    child.once("error", () => (exited = -1));
    child.once("exit", code => (exited = code));
    const until = performance.now() + ports_prepare_ms,
      cancel = () => stop(child);
    signal.addEventListener("abort", cancel);
    try {
      while (performance.now() < until && !signal.aborted) {
        if (exited !== undefined && exited !== 0) break;
        if (await this.check()) return;
        await Bun.sleep(200);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      if (exited === undefined) stop(child);
    }
    throw Error(signal.aborted ? "ForwardsClosed" : "MachineUnreachable");
  }
  dial(host: string, port: number): portForwards.Channel {
    let said = "";
    const child = spawnSsh(
      this.profile,
      this.args("-W", `${host}:${port}`),
      "forward",
      false,
      chunk => (said = (said + chunk).slice(-4096)),
    );
    return {
      input: child.stdin!,
      output: child.stdout!,
      done: new Promise(resolve => {
        child.once("error", () => resolve("unreachable"));
        child.once("close", code => resolve(code ? portFailure(said) : null));
      }),
      close: () => stop(child),
    };
  }
}
