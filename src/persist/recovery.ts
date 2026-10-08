import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Runtime } from "../runtime";
import { atomicWrite } from "../os";
import * as checkpoint from "./checkpoint";
import * as json from "../json";
export { atomicWrite };
export function path(socket: string): string {
  const root =
    process.env.XDG_STATE_HOME ??
    join(process.env.HOME ?? "/", ".local", "state");
  const standard = `/tmp/corgi-${process.getuid?.() ?? 0}/control.sock`;
  return join(
    root,
    "corgi",
    "recovery",
    socket === standard
      ? "recovery.json"
      : `runtime-${Bun.hash.wyhash(socket, 0n).toString(16)}.json`,
  );
}
export async function save(r: Runtime, socket: string): Promise<void> {
  const dest = path(socket);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  atomicWrite(dest, json.stringify(checkpoint.capture(r, false)));
}
export async function load(
  r: Runtime,
  socket: string,
  executable: string,
): Promise<boolean> {
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
  await checkpoint.restore(r, decoded.value, false, socket, executable);
  if (decoded.migrated) {
    atomicWrite(`${source}.v${decoded.from}`, bytes);
    try {
      atomicWrite(source, json.stringify(decoded.value));
    } catch (error) {
      console.error(
        `recovery snapshot ${source} could not be rewritten after migration:`,
        error,
      );
    }
  }
  return true;
}
