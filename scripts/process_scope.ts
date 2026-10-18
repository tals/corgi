/** Disposable subprocesses belong to a scope, even after detaching or reloading. */
import { randomUUID } from "node:crypto";

const variable = "CORGI_PROCESS_SCOPE";
type Process = { pid: number; born: string };
export type Report = { reaped: number[]; remaining: number[] };

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Process scope watchdog timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** A separate watchdog keeps working when the owning test is killed. */
export class Scope {
  private result: Promise<Report> | null = null;
  private constructor(
    readonly env: Record<string, string | undefined>,
    private child: Bun.Subprocess<"pipe", "pipe", "inherit">,
    private reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}
  static async start(base: Record<string, string | undefined> = process.env) {
    const id = randomUUID();
    const env = { ...base, [variable]: [base[variable] ?? process.env[variable], id].filter(Boolean).join(",") };
    const guardEnv = { ...process.env };
    // Ancestor scopes reap the work, not the watchdogs protecting it.
    delete guardEnv[variable];
    const child = Bun.spawn([process.execPath, import.meta.path, id], {
      env: guardEnv,
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = child.stdout.getReader();
    try {
      const ready = await bounded(reader.read(), 5000);
      if (ready.done || new TextDecoder().decode(ready.value) !== "ready\n")
        throw new Error("Process scope watchdog did not start");
      child.unref();
      return new Scope(env, child, reader);
    } catch (error) {
      child.kill("SIGKILL");
      await child.exited;
      throw error;
    }
  }
  close(): Promise<Report> {
    return (this.result ??= this.finish());
  }
  private async finish(): Promise<Report> {
    this.child.ref();
    this.child.stdin.write("finish\n");
    this.child.stdin.end();
    const read = async () => {
      let output = "";
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      if ((await this.child.exited) !== 0) throw new Error("Process scope watchdog failed");
      const report = JSON.parse(output) as Report;
      if (!Array.isArray(report.reaped) || !Array.isArray(report.remaining))
        throw new Error("Invalid process scope report");
      return report;
    };
    return bounded(read(), 15_000);
  }
  async assertClean() {
    const report = await this.close();
    if (report.remaining.length) throw new Error(`Processes survived cleanup: ${report.remaining.join(", ")}`);
    if (report.reaped.length) throw new Error(`Leaked processes were reaped: ${report.reaped.join(", ")}`);
  }
}

async function members(id: string, pids?: number[]): Promise<Process[]> {
  const selection = pids === undefined ? ["-A"] : ["-p", pids.join(",")];
  const ps = Bun.spawn(["ps", "eww", ...selection, "-o", "pid=,stat=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(ps.stdout).text(),
    new Response(ps.stderr).text(),
    ps.exited,
  ]);
  if (code === 1 && pids !== undefined && !output.trim() && !error.trim()) return [];
  if (code) throw new Error(`Cannot inspect scoped processes: ${error}`);
  const result: Process[] = [];
  for (const line of output.split("\n")) {
    const scope = /(?:^|\s)CORGI_PROCESS_SCOPE=([^\s]*)/.exec(line)?.[1];
    if (!scope?.split(",").includes(id)) continue;
    const match = /^\s*(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s/.exec(line);
    if (match && !match[2].includes("Z")) result.push({ pid: Number(match[1]), born: match[3] });
  }
  return result;
}

async function reap(id: string, graceful: boolean): Promise<Report> {
  const reaped = new Set<number>();
  const signaled = new Map<number, string>();
  const start = Date.now();
  const grace = graceful ? 1000 : 0;
  for (;;) {
    const current = await members(id);
    if (!current.length) return { reaped: [...reaped], remaining: [] };
    const elapsed = Date.now() - start;
    // A scan slowed by load can use up the budget; what it found still gets SIGKILL first.
    if (elapsed >= grace) {
      const signal = elapsed >= grace + 2000 ? "SIGKILL" : "SIGTERM";
      const pids = current.map(p => p.pid);
      const live = await members(id, pids);
      for (const member of current) {
        const identity = `${member.born}:${signal}`;
        if (signaled.get(member.pid) === identity) continue;
        if (!live.some(p => p.pid === member.pid && p.born === member.born)) continue;
        try {
          process.kill(member.pid, signal);
          signaled.set(member.pid, identity);
          reaped.add(member.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    if (elapsed >= grace + 7000) return { reaped: [...reaped], remaining: current.map(p => p.pid) };
    await Bun.sleep(100);
  }
}

if (import.meta.main) {
  const id = process.argv[2];
  if (!/^[\da-f-]{36}$/.test(id ?? "")) throw new Error("Invalid process scope");
  process.stdout.on("error", () => {});
  process.stdout.write("ready\n");
  let graceful = false;
  for await (const chunk of Bun.stdin.stream()) if (chunk.length) graceful = true;
  const report = await reap(id, graceful);
  process.stdout.write(JSON.stringify(report));
  process.exitCode = report.remaining.length ? 1 : 0;
}
