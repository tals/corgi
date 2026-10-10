import { spawn, type ChildProcess } from "node:child_process";
import { n, ptr, ReadyLoop, READ } from "./native_bridge";
export type Term = { exited: number } | { signal: string };
export type Options = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | Uint8Array;
  timeout_ms: number;
  max_output?: number;
  stderr?: boolean;
  quit?: Quit;
};
export class Quit {
  private controller = new AbortController();
  static init() {
    return new Quit();
  }
  signal() {
    this.controller.abort();
  }
  get aborted() {
    return this.controller.signal.aborted;
  }
  get abortSignal() {
    return this.controller.signal;
  }
}
export class Output {
  constructor(
    public term: Term,
    public stdout: Buffer,
    public stderr: Buffer,
  ) {}
  ok() {
    return "exited" in this.term && this.term.exited === 0;
  }
}
function spawnError(error: any): Error {
  const name = (
    {
      ENOENT: "FileNotFound",
      ENOTDIR: "NotDir",
      EACCES: "AccessDenied",
      EPERM: "AccessDenied",
      ENOEXEC: "InvalidExe",
      E2BIG: "SystemResources",
      EMFILE: "ProcessFdQuotaExceeded",
      ENFILE: "SystemFdQuotaExceeded",
    } as Record<string, string>
  )[error?.code];
  return name ? Error(name) : error;
}
export async function run(argv: string[], options: Options): Promise<Output> {
  if (options.quit?.aborted) throw Error("Cancelled");
  const cap = options.max_output ?? 65536,
    loop = new ReadyLoop(),
    pipes: number[] = [],
    watches: ReturnType<ReadyLoop["watch"]>[] = [];
  let child: ChildProcess | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    failure: Error | undefined,
    finished = false;
  const close = (fd: number) => {
    n.probe_close(fd);
    const i = pipes.indexOf(fd);
    if (i >= 0) pipes.splice(i, 1);
  };
  const pipe = () => {
    const pair = new Int32Array(2);
    if (n.probe_pipe(ptr(pair))) throw Error("SystemResources");
    pipes.push(...pair);
    return [...pair];
  };
  const stop = (name: string) => {
    failure ??= Error(name);
    if (child?.pid)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
  };
  const abort = () => stop("Cancelled");
  const drain = (fd: number, error: boolean) => {
    const buffer = Buffer.alloc(16384);
    for (let i = 0; i < 16; i++) {
      const size = n.probe_read(fd, ptr(buffer), buffer.length);
      if (size === -4) continue;
      if (size <= 0) break;
      if (error) stderr = Buffer.concat([stderr, buffer.subarray(0, size)]).subarray(-cap);
      else {
        if (stdout.length + size > cap) {
          stop("OutputTooLarge");
          return;
        }
        stdout = Buffer.concat([stdout, buffer.subarray(0, size)]);
      }
    }
  };
  try {
    const [outRead, outWrite] = pipe(),
      [errRead, errWrite] = options.stderr ? pipe() : [-1, -1];
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", outWrite, options.stderr ? errWrite : "ignore"],
    });
    close(outWrite);
    if (errWrite >= 0) close(errWrite);
    const exited = new Promise<Term>((resolve, reject) => {
      child!.once("error", error => reject(spawnError(error)));
      child!.once("exit", (code, signal) =>
        resolve(signal ? { signal: signal.replace(/^SIG/, "") } : { exited: code ?? 0 }),
      );
    });
    timer = setTimeout(() => stop("TimedOut"), options.timeout_ms);
    options.quit?.abortSignal.addEventListener("abort", abort, { once: true });
    if (options.quit?.aborted) abort();
    for (const [fd, error] of [
      [outRead, false],
      [errRead, true],
    ] as const)
      if (fd >= 0) {
        let registration: ReturnType<ReadyLoop["watch"]>;
        registration = loop.watch(fd, () => {
          drain(fd, error);
          if (!finished) registration.arm(READ);
        });
        watches.push(registration);
        registration.arm(READ);
      }
    child.stdin?.on("error", () => {});
    if (options.input !== undefined) child.stdin?.end(options.input);
    const term = await exited;
    drain(outRead, false);
    if (errRead >= 0) drain(errRead, true);
    if (failure) throw failure;
    return new Output(term, stdout, stderr);
  } catch (error) {
    throw spawnError(error);
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    options.quit?.abortSignal.removeEventListener("abort", abort);
    for (const watch of watches) watch.close();
    loop.close();
    for (const fd of pipes) n.probe_close(fd);
    child?.stdin?.destroy();
  }
}
