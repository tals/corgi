import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Runtime } from "../runtime";
import { atomicWrite } from "../os";
import * as checkpoint from "./checkpoint";
import * as json from "../json";
export { atomicWrite };
export function path(socket: string): string {
  const root = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/", ".local", "state");
  const standard = `/tmp/corgi-${process.getuid?.() ?? 0}/control.sock`;
  return join(
    root,
    "corgi",
    "recovery",
    socket === standard ? "recovery.json" : `runtime-${Bun.hash.wyhash(socket, 0n).toString(16)}.json`,
  );
}
export async function save(r: Runtime, socket: string): Promise<void> {
  const dest = path(socket);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  atomicWrite(dest, json.stringify(checkpoint.capture(r, false)));
}
/** Where the daemon records a load that repaired the saved session, for the next viewer to report. */
const repairedPath = (socket: string) => `${path(socket)}.repaired.json`;
/** Records that loading `state` took `repairs`; the latest one wins. */
export async function recordRepairs(socket: string, state: unknown, repairs: string[], executable: string) {
  if (!repairs.length) return;
  try {
    const { describe } = await import("./check"),
      { release } = await import("../updates");
    atomicWrite(
      repairedPath(socket),
      json.stringify({ release: release(executable).version, report: { state: { ...describe(state), repairs } } }),
    );
  } catch (error) {
    console.warn("recording a repaired session:", error);
  }
}
/** The repaired session the daemon recorded, once: taking it removes it. */
export function takeRepairs(socket: string): { release: string; report: unknown } | null {
  const file = repairedPath(socket);
  let value: any;
  try {
    value = json.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(file);
    } catch {}
  }
  return typeof value?.release === "string" ? { release: value.release, report: value.report } : null;
}
export async function load(r: Runtime, socket: string, executable: string): Promise<boolean> {
  const source = path(socket);
  let bytes: string;
  try {
    bytes = readFileSync(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (Buffer.byteLength(bytes) > 256 * 1024 * 1024) throw Error("FileTooBig");
  const { decode } = await import("./migrations");
  const decoded = decode("checkpoint", bytes);
  const repairs = await checkpoint.restore(r, decoded.value, false, socket, executable);
  await recordRepairs(socket, decoded.value, repairs, executable);
  if (decoded.migrated) {
    atomicWrite(`${source}.v${decoded.from}`, bytes);
    try {
      atomicWrite(source, json.stringify(decoded.value));
    } catch (error) {
      console.error(`recovery snapshot ${source} could not be rewritten after migration:`, error);
    }
  }
  return true;
}
