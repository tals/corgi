/** Request cumulative snapshots outside a benchmark's CPU window. */
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Recorder } from "../../src/telemetry";

type Snapshot = ReturnType<Recorder["snapshot"]> & {
  pid: number;
  thread: number;
  worker_count: number;
  at: number;
  epoch_ms: number;
  cpu: { user: number; system: number };
  memory: Record<string, number>;
};
function read(path: string): Snapshot | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}
export async function capture(directory: string, pids: number[]) {
  mkdirSync(directory, { recursive: true });
  const before = new Map(readdirSync(directory).map(file => [file, read(join(directory, file))?.at ?? -1]));
  for (const pid of pids) process.kill(pid, "SIGUSR2");
  const deadline = Date.now() + 5000;
  for (;;) {
    const files = readdirSync(directory).filter(file => pids.some(pid => file.startsWith(`${pid}-`)));
    const snapshots = files
      .map(file => ({ file, snapshot: read(join(directory, file)) }))
      .filter(({ file, snapshot }) => snapshot && snapshot.at > (before.get(file) ?? -1))
      .map(({ snapshot }) => snapshot!);
    if (
      pids.every(pid => existsSync(join(directory, `${pid}-0.json`))) &&
      pids.every(pid => {
        const own = snapshots.filter(snapshot => snapshot.pid === pid);
        const main = own.find(snapshot => snapshot.thread === 0);
        return main && own.length >= main.worker_count + 1;
      })
    ) {
      return snapshots;
    }
    if (Date.now() >= deadline) throw Error(`Telemetry flush timed out for ${pids.join(",")}`);
    await Bun.sleep(2);
  }
}
