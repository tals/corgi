//! The whisper-server voice mode starts, owns and stops. It is never
//! adopted when something else holds the port.

import * as subprocess from "../subprocess";

type Child = ReturnType<typeof Bun.spawn>;
const tail_bytes = 4096;

/** Whether something already answers on `port`. */
async function answers(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}
/** A port nothing listens on now. whisper-server takes requests without
 * authentication, so a port that changes each run is harder to find. */
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }),
    port = probe.port;
  probe.stop(true);
  return port;
}
export class Server {
  /** The end of the server's output, for the verbose log. */
  output = "";
  private crashed: ((code: number | null) => void)[] = [];
  private stopping = false;
  private constructor(
    private child: Child,
    readonly port: number,
  ) {
    for (const stream of [child.stdout, child.stderr]) if (stream instanceof ReadableStream) void this.drain(stream);
    void child.exited.then(code => {
      if (this.stopping) return;
      for (const fn of this.crashed) fn(code);
    });
  }
  static async start(opts: {
    binary: string;
    model: string;
    /** A free one when unset. */
    port?: number;
    vadModel?: string;
    /** Whisper's `-l`; unset keeps its default, English. */
    language?: string;
    healthTimeoutMs?: number;
    /** Stops a server still loading, with `Aborted`. */
    signal?: AbortSignal;
  }): Promise<Server> {
    const port = opts.port ?? freePort();
    if (await answers(port)) throw Error("PortInUse");
    const args = [opts.binary, "-m", opts.model, "--host", "127.0.0.1", "--port", String(port)];
    if (opts.language) args.push("-l", opts.language);
    if (opts.vadModel) args.push("--vad", "--vad-model", opts.vadModel);
    let child: Child;
    try {
      child = Bun.spawn(args, { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      throw subprocess.spawnError(error);
    }
    const server = new Server(child, port),
      until = Date.now() + (opts.healthTimeoutMs ?? 60_000);
    let exited = false;
    void child.exited.then(() => (exited = true));
    while (Date.now() < until && !exited && !opts.signal?.aborted) {
      if (await server.healthy(Math.max(1, Math.min(1000, until - Date.now())))) return server;
      await Bun.sleep(250);
    }
    const failed = exited;
    await server.stop();
    throw Error(opts.signal?.aborted ? "Aborted" : failed ? "WhisperStartFailed" : "Timeout");
  }
  private async healthy(ms: number): Promise<boolean> {
    try {
      const reply = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(ms) });
      return reply.ok && (await reply.json())?.status === "ok";
    } catch {
      return false;
    }
  }
  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) this.output = (this.output + decoder.decode(chunk)).slice(-tail_bytes);
    } catch {}
  }
  /** What Whisper heard in `wav`, trimmed. */
  async transcribe(wav: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "utterance.wav");
    for (const [key, value] of Object.entries({
      temperature: "0.0",
      beam_size: "1",
      no_speech_thold: "0.6",
      entropy_thold: "2.4",
      logprob_thold: "-1.0",
      response_format: "json",
    }))
      form.append(key, value);
    let reply: Response;
    try {
      reply = await fetch(`http://127.0.0.1:${this.port}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw Error((error as Error)?.name === "TimeoutError" ? "Timeout" : "ServerDown");
    }
    if (!reply.ok) throw Error("TranscriptionFailed");
    const body: unknown = await reply.json().catch(() => {
      throw Error("TranscriptionFailed");
    });
    const heard = body && typeof body === "object" ? (body as { text?: unknown }).text : undefined;
    if (typeof heard !== "string") throw Error("TranscriptionFailed");
    return heard.trim();
  }
  on(_event: "crashed", fn: (code: number | null) => void): void {
    this.crashed.push(fn);
  }
  /** SIGTERM, then SIGKILL after 3 s. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.child.exited;
    clearTimeout(timer);
  }
}
