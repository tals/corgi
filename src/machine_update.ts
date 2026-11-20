import * as buildId from "./build_id";
import * as machines from "./machines";
import * as dev from "./machine_deploy";

type Event = { type: "progress"; message: string } | { type: "ready" };
export function event(value: unknown): Event {
  if (!value || typeof value !== "object" || !("type" in value)) throw Error("InvalidMachineUpdateEvent");
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "progress":
      if ("message" in value && typeof value.message === "string" && value.message.length <= 4096)
        return { type: "progress", message: value.message.replace(/[\x00-\x1f\x7f]/g, " ") };
  }
  throw Error("InvalidMachineUpdateEvent");
}
export class Failure extends Error {
  readonly reply: { err: string; detail: string };
  constructor(readonly detail: string) {
    super("MachineUpdateFailed");
    this.reply = { err: this.message, detail };
  }
}
export async function prepare(
  profile: machines.Profile,
  {
    progress = (message: string) => process.stderr.write(message + "\n"),
    signal,
    reuseLogin = false,
  }: {
    progress?: (message: string) => void;
    signal?: AbortSignal;
    reuseLogin?: boolean;
  } = {},
): Promise<machines.Profile> {
  if (!dev.enabled()) return profile;
  signal?.throwIfAborted();
  const child = Bun.spawn([buildId.self(), "__machine-sync", profile.name, profile.target, profile.socket], {
    env: { ...process.env, CORGI_MACHINE_SYNC: reuseLogin ? "reconnect" : "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  let diagnostic = "";
  const stderr = (async () => {
    for await (const bytes of child.stderr) diagnostic = (diagnostic + Buffer.from(bytes).toString()).slice(-8192);
  })();
  let ready = false,
    pending = "";
  const decoder = new TextDecoder();
  try {
    for await (const bytes of child.stdout) {
      pending += decoder.decode(bytes, { stream: true });
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        if (end > 8192) throw Error("InvalidMachineUpdateEvent");
        const value = event(JSON.parse(pending.slice(0, end)));
        pending = pending.slice(end + 1);
        switch (value.type) {
          case "progress":
            progress(value.message);
            break;
          case "ready":
            ready = true;
            break;
        }
      }
      if (pending.length > 8192) throw Error("InvalidMachineUpdateEvent");
    }
    const code = await child.exited;
    await stderr;
    signal?.throwIfAborted();
    if (code || !ready || pending) throw new Failure(diagnostic.trim() || "Update helper stopped before finishing.");
    const refreshed = machines.find(profile.name);
    if (refreshed.target !== profile.target || refreshed.socket !== profile.socket) throw Error("MachineChanged");
    return refreshed;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await stderr;
  }
}

/** One preparation shared by the control/data paths and all reconnects of this viewer. */
export class Preparation<T> {
  message = "";
  private result: { value: T } | null = null;
  private job: { controller: AbortController; promise: Promise<T>; users: Set<symbol> } | null = null;
  constructor(
    private start: (signal: AbortSignal, progress: (message: string) => void) => Promise<T>,
    private changed: () => void = () => {},
  ) {}
  async run(signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.result) return this.result.value;
    if (this.job?.controller.signal.aborted) {
      await until(
        this.job.promise.catch(() => {}),
        signal,
      );
      return this.run(signal);
    }
    if (!this.job) {
      const controller = new AbortController();
      const job = { controller, users: new Set<symbol>(), promise: null as unknown as Promise<T> };
      this.job = job;
      job.promise = Promise.resolve()
        .then(() =>
          this.start(controller.signal, message => {
            this.message = message;
            this.changed();
          }),
        )
        .then(value => {
          if (!controller.signal.aborted) this.result = { value };
          return value;
        })
        .finally(() => {
          if (this.job === job) {
            this.job = null;
            this.message = "";
            this.changed();
          }
        });
    }
    const job = this.job,
      user = Symbol();
    job.users.add(user);
    try {
      return await until(job.promise, signal);
    } finally {
      job.users.delete(user);
      if (!job.users.size && this.job === job) job.controller.abort();
    }
  }
}
async function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? Error("Aborted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
