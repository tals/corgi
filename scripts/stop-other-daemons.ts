#!/usr/bin/env bun
/** Main-environment development launches retire other same-user Corgi daemons. */
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";

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

type Actions = {
  list(): Daemon[];
  mainPid(): Promise<number | undefined>;
  shutdown(daemon: Daemon): Promise<void>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  pause(): Promise<void>;
  log(message: string): void;
};

export async function stopOthers(actions: Actions): Promise<void> {
  for (const daemon of actions.list()) {
    const stillSame = () => actions.list().some((d) => d.pid === daemon.pid && d.command === daemon.command);
    const protectedNow = async () => daemon.pid === await actions.mainPid();
    if (await protectedNow() || !stillSame()) continue;
    actions.log(`corgi: stopping other daemon ${daemon.pid}`);
    await actions.shutdown(daemon);
    for (let i = 0; i < 50 && stillSame(); i++) await actions.pause();
    if (!stillSame() || await protectedNow()) continue;
    actions.signal(daemon.pid, "SIGTERM");
    for (let i = 0; i < 10 && stillSame(); i++) await actions.pause();
    if (stillSame() && !await protectedNow()) actions.signal(daemon.pid, "SIGKILL");
  }
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

if (import.meta.main) {
  const uid = process.getuid!();
  const mainSocket = `/tmp/corgi-${uid}/control.sock`;
  if ((process.env.CORGI_SOCKET || mainSocket) !== mainSocket) {
    throw new Error("daemon cleanup is only for the main environment");
  }
  const list = () => daemons(
    execFileSync("ps", ["-ww", "-axo", "uid=,pid=,args="], { encoding: "utf8" }), uid,
    execFileSync("ps", ["-ww", "-axo", "pid=,comm="], { encoding: "utf8" }),
  );
  await stopOthers({
    list,
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
    async shutdown(daemon) {
      let sockets: string[] = [];
      try {
        sockets = [...new Set(execFileSync("lsof", ["-nP", "-a", "-p", String(daemon.pid), "-U", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          .split("\n").filter((line) => line.startsWith("n/") && !line.includes(" ->")).map((line) => line.slice(1)))];
      } catch { /* An unreachable daemon is terminated below. */ }
      for (const socket of sockets) {
        if (socket === mainSocket) continue;
        try {
          const hello = await rpc(socket, { op: "hello", protocol: 1 });
          if (hello.server_pid !== daemon.pid) continue;
          await rpc(socket, { op: "shutdown" });
          return;
        } catch { /* Try the next socket, then terminate this exact process. */ }
      }
    },
    signal(pid, signal) {
      try { process.kill(pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    },
    pause: () => Bun.sleep(100),
    log: console.error,
  });
}
