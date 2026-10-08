import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Quit } from "../subprocess";
import type { Stopping } from "../inference";
export type ControlStopping = Stopping | { stopping: boolean };
export type Options = {
  stopping?: ControlStopping;
  quit?: Quit;
  deadline?: number;
};
export function cancelled(stopping?: ControlStopping): boolean {
  if (typeof stopping === "boolean") return stopping;
  if (!stopping) return false;
  if ("aborted" in stopping) return stopping.aborted;
  if ("stopping" in stopping) return stopping.stopping;
  return stopping.load?.() ?? stopping.value ?? false;
}
const message_limit = 4 * 1024 * 1024;
/** Provider-owned read-only control channel; never sends prompts. */
export class Control {
  child: ChildProcessWithoutNullStreams | null = null;
  next = 0;
  buffer = "";
  pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      cleanup: () => void;
    }
  >();
  initialized: Promise<any> | null = null;
  constructor(
    public provider: "codex" | "claude",
    public executable: string = provider,
  ) {}
  start() {
    if (this.child) return;
    this.buffer = "";
    const args =
      this.provider === "codex"
        ? ["app-server"]
        : [
            "--print",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--settings",
            '{"disableAllHooks":true,"remoteControlAtStartup":false}',
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--tools",
            "",
          ];
    this.child = spawn(this.executable, args, {
      cwd: "/tmp",
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
      },
      stdio: "pipe",
      detached: true,
    });
    this.child.stdout.on("data", b => {
      this.buffer += b.toString();
      if (Buffer.byteLength(this.buffer) > message_limit && !this.buffer.includes("\n")) {
        this.close(Error("NativeMessageTooLarge"));
        return;
      }
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (Buffer.byteLength(line) > message_limit) {
          this.close(Error("NativeMessageTooLarge"));
          return;
        }
        try {
          const v = JSON.parse(line);
          if (this.provider === "claude" && v.type === "control_request" && v.request_id !== undefined) {
            this.close(Error("UnexpectedRequest"));
            return;
          }
          const id = this.provider === "codex" ? String(v.id) : v.response?.request_id,
            p = this.pending.get(id);
          if (!p) continue;
          p.cleanup();
          this.pending.delete(id);
          if (v.error || (this.provider === "claude" && v.response?.subtype !== "success"))
            p.reject(Error("UnsupportedUsage"));
          else p.resolve(this.provider === "codex" ? v.result : v.response?.response);
        } catch {}
      }
      if (Buffer.byteLength(this.buffer) > message_limit) this.close(Error("NativeMessageTooLarge"));
    });
    this.child.stderr.resume();
    const child = this.child;
    const fail = () => {
      if (this.child === child) this.close(Error("HarnessExited"));
    };
    this.child.stdin.on("error", fail);
    this.child.on("error", fail);
    this.child.on("exit", fail);
  }
  async ready(options: Options = {}) {
    this.start();
    if (!this.initialized)
      this.initialized = this.requestRaw(
        "initialize",
        this.provider === "codex"
          ? {
              clientInfo: { name: "corgi", version: "bun" },
              capabilities: { experimentalApi: true },
            }
          : { skip_behaviors: true },
        options,
      ).then(v => {
        if (this.provider === "codex") this.child?.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        return v;
      });
    return this.initialized;
  }
  async request(method: string, params: any = {}, options: Options = {}) {
    const timed = {
      ...options,
      deadline: options.deadline ?? Date.now() + 5000,
    };
    if (cancelled(timed.stopping) || timed.quit?.aborted) throw Error("Cancelled");
    await this.ready(timed);
    return this.requestRaw(method, params, timed);
  }
  requestRaw(method: string, params: any, options: Options = {}) {
    if (cancelled(options.stopping) || options.quit?.aborted) return Promise.reject(Error("Cancelled"));
    this.start();
    const id = String(++this.next);
    return new Promise<any>((resolve, reject) => {
      const deadline = options.deadline ?? Date.now() + 5000;
      let poll: ReturnType<typeof setInterval> | undefined;
      const abort = () => this.close(Error("Cancelled"));
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          cleanup();
          reject(Error("Timeout"));
          this.close();
        },
        Math.max(0, deadline - Date.now()),
      );
      const signal = options.quit?.abortSignal;
      const stoppingSignal =
        options.stopping && typeof options.stopping === "object" && "addEventListener" in options.stopping
          ? (options.stopping as AbortSignal)
          : null;
      const cleanup = () => {
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        signal?.removeEventListener("abort", abort);
        stoppingSignal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      stoppingSignal?.addEventListener("abort", abort, { once: true });
      if (options.stopping && !stoppingSignal)
        poll = setInterval(() => {
          if (cancelled(options.stopping)) abort();
        }, 20);
      const value =
        this.provider === "codex"
          ? { id: Number(id), method, params }
          : {
              type: "control_request",
              request_id: id,
              request: { subtype: method, skip_behaviors: true, ...params },
            };
      this.child!.stdin.write(JSON.stringify(value) + "\n", error => {
        if (error) this.close(Error("HarnessExited"));
      });
    });
  }
  close(error = Error("Cancelled")) {
    const c = this.child;
    this.child = null;
    this.initialized = null;
    if (c?.pid)
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        c.kill("SIGKILL");
      }
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    this.pending.clear();
  }
}
