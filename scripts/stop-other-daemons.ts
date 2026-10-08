/** Main-environment development launches retire other same-user Corgi daemons. */
import { createConnection } from "node:net";
import { isatty } from "node:tty";

export type Daemon = { pid: number; command: string };
export function daemons(output: string, uid: number, executables: string): Daemon[] {
  const corgis = new Set(executables.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match && /(?:^|\/)corgi$/.test(match[2]) ? [Number(match[1])] : [];
  }));
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) !== uid || !corgis.has(Number(match[2]))) return [];
    const command = match[3];
    // Viewers, credential helpers, shells mentioning corgi, and other users stay alone.
    if (!/^(?:\/.*\/)?corgi (?:serve|__handoff \d+ \d+)$/.test(command)) return [];
    return [{ pid: Number(match[2]), command }];
  });
}

/** Ask politely, SIGTERM after this long (or at once when nobody heard), SIGKILL later. */
export const TERM_AFTER_MS = 3000;
export const KILL_AFTER_MS = 5000;
export const GIVE_UP_AFTER_MS = 7000;

export type State = "stopping" | "terminating" | "killing" | "stopped" | "terminated" | "killed" | "stuck";
export type Row = { daemon: Daemon; label: string; state: State; ms: number };

type Actions = {
  /** Live daemons, optionally only among `pids`. */
  list(pids?: number[]): Promise<Daemon[]>;
  mainPid(): Promise<number | undefined>;
  /** The daemon's own control socket, if it answers on one. */
  socket(daemon: Daemon): Promise<string | undefined>;
  /** Whether the daemon accepted a shutdown request. */
  shutdown(socket: string): Promise<boolean>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  pause(): Promise<void>;
  now(): number;
  show(rows: Row[], done: boolean): void;
};

const finished: Partial<Record<State, State>> = { stopping: "stopped", terminating: "terminated", killing: "killed" };

export async function stopOthers(actions: Actions): Promise<Row[]> {
  const main = await actions.mainPid();
  const rows: Row[] = (await actions.list())
    .filter((daemon) => daemon.pid !== main)
    .map((daemon) => ({ daemon, label: "", state: "stopping", ms: 0 }));
  if (!rows.length) return rows;
  const start = actions.now();
  const asked = new Map<Row, boolean>();
  for (const row of rows) {
    actions.socket(row.daemon)
      .then(async (socket) => {
        row.label = socket?.replace(/\/control\.sock$/, "") ?? "";
        asked.set(row, socket !== undefined && await actions.shutdown(socket));
      })
      .catch(() => asked.set(row, false));
  }
  actions.show(rows, false);
  for (;;) {
    const pending = rows.filter((row) => row.state in finished);
    if (!pending.length) break;
    const elapsed = actions.now() - start;
    const alive = await actions.list(pending.map((row) => row.daemon.pid));
    // A PID whose command changed was reused; the daemon is gone.
    const due: Row[] = [];
    for (const row of pending) {
      row.ms = elapsed;
      if (!alive.some((d) => d.pid === row.daemon.pid && d.command === row.daemon.command)) row.state = finished[row.state]!;
      else if (elapsed >= GIVE_UP_AFTER_MS) row.state = "stuck";
      else if (row.state === "stopping" && (elapsed >= TERM_AFTER_MS || asked.get(row) === false)) due.push(row);
      else if (row.state === "terminating" && elapsed >= KILL_AFTER_MS) due.push(row);
    }
    // The main daemon can change under a reload; never signal it.
    if (due.length) {
      const current = await actions.mainPid();
      for (const row of due) {
        if (row.daemon.pid === current) { row.state = "stopped"; continue; }
        actions.signal(row.daemon.pid, row.state === "stopping" ? "SIGTERM" : "SIGKILL");
        row.state = row.state === "stopping" ? "terminating" : "killing";
      }
    }
    actions.show(rows, false);
    if (rows.some((row) => row.state in finished)) await actions.pause();
  }
  actions.show(rows, true);
  return rows;
}

async function rpc(socket: string, value: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let data = "";
    const timer = setTimeout(() => finish(new Error("daemon did not respond")), 1000);
    function finish(error?: Error, result?: any) {
      clearTimeout(timer);
      connection.destroy();
      if (error) reject(error); else resolve(result);
    }
    connection.on("connect", () => connection.write(JSON.stringify(value) + "\n"));
    connection.on("error", (error) => finish(error));
    connection.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 65536) return finish(new Error("oversized daemon reply"));
      if (!data.includes("\n")) return;
      try { finish(undefined, JSON.parse(data.slice(0, data.indexOf("\n")))); }
      catch (error) { finish(error as Error); }
    });
  });
}

async function output(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text;
}

const color = isatty(2) && !process.env.NO_COLOR;
const paint = (code: string, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const looks: Record<State, [string, string, string]> = {
  stopping: ["36", "", "shutting down"],
  terminating: ["33", "", "sent SIGTERM"],
  killing: ["31", "", "sent SIGKILL"],
  stopped: ["32", "✓", "stopped"],
  terminated: ["33", "✓", "terminated"],
  killed: ["31", "✓", "killed"],
  stuck: ["31", "✗", "still running"],
};

/** Redraws the rows in place on a terminal; elsewhere prints each daemon once it settles. */
function renderer() {
  let drawn = 0, frame = 0;
  const printed = new Set<Row>();
  return (rows: Row[], done: boolean) => {
    const line = (row: Row) => {
      const [code, mark, text] = looks[row.state];
      const icon = paint(code, mark || spinner[frame % spinner.length]);
      const label = row.label || row.daemon.command.replace(/^.*\//, "");
      return `  ${icon} ${paint("2", String(row.daemon.pid).padStart(7))}  ${label.padEnd(36)} ${paint(code, text.padEnd(14))} ${paint("2", `${(row.ms / 1000).toFixed(1)}s`)}`;
    };
    if (!color) {
      if (!drawn++) console.error(`corgi: stopping ${rows.length} other daemon${rows.length === 1 ? "" : "s"}`);
      for (const row of rows) {
        if (printed.has(row) || !looks[row.state][1]) continue;
        printed.add(row);
        console.error(line(row));
      }
      return;
    }
    frame++;
    const header = `${paint("1", "corgi:")} stopping ${rows.length} other daemon${rows.length === 1 ? "" : "s"}`;
    process.stderr.write((drawn ? `\x1b[${drawn}F` : "") + [header, ...rows.map(line)].map((text) => `\x1b[2K${text}\n`).join(""));
    drawn = rows.length + 1;
    if (done) {
      const slowest = Math.max(...rows.map((row) => row.ms));
      const stuck = rows.filter((row) => row.state === "stuck").length;
      const summary = stuck ? paint("31", `${stuck} of ${rows.length} other daemons still running`) : `stopped ${rows.length} other daemon${rows.length === 1 ? "" : "s"}`;
      process.stderr.write(`\x1b[${drawn}F\x1b[2K${paint("1", "corgi:")} ${summary} in ${(slowest / 1000).toFixed(1)}s\n\x1b[${drawn - 1}E`);
    }
  };
}

export function systemActions(mainSocket: string): Actions {
  const uid = process.getuid!();
  return {
    async list(pids) {
      if (pids?.length === 0) return [];
      const select = pids ? ["-p", pids.join(",")] : ["-ax"];
      const [args, comms] = await Promise.all([
        output(["ps", "-ww", "-o", "uid=,pid=,args=", ...select]),
        output(["ps", "-ww", "-o", "pid=,comm=", ...select]),
      ]);
      return daemons(args, uid, comms);
    },
    async mainPid() {
      try {
        const reply = await rpc(mainSocket, { op: "hello", protocol: 1 });
        if (!Number.isSafeInteger(reply.server_pid) || reply.server_pid <= 0) throw new Error("cannot identify main daemon");
        return reply.server_pid;
      } catch (error) {
        if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code || "")) return undefined;
        throw error;
      }
    },
    async socket(daemon) {
      const listing = await output(["lsof", "-nP", "-a", "-p", String(daemon.pid), "-U", "-Fn"]);
      const sockets = new Set(listing.split("\n").filter((line) => line.startsWith("n/") && !line.includes(" ->")).map((line) => line.slice(1).replace(/ type=\w+$/, "")));
      for (const socket of sockets) {
        if (socket === mainSocket) continue;
        try {
          if ((await rpc(socket, { op: "hello", protocol: 1 })).server_pid === daemon.pid) return socket;
        } catch { /* Try the next socket. */ }
      }
      return undefined;
    },
    async shutdown(socket) {
      try { await rpc(socket, { op: "shutdown" }); return true; }
      catch { return false; }
    },
    signal(pid, signal) {
      try { process.kill(pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    },
    pause: () => Bun.sleep(100),
    now: () => performance.now(),
    show: renderer(),
  };
}

export async function stopOtherDaemons(mainSocket: string): Promise<void> {
  await stopOthers(systemActions(mainSocket));
}
