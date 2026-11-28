import { readdir, readlink, realpath } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { run } from "../../subprocess";
import { directory, validSession } from "./config";

/** agy holds a presence/<conversation>.lock descriptor while that conversation is selected.
 * Null means no unique lock. Undefined means the process couldn't be inspected. */
export async function selected(pid: number, account: string): Promise<string | null | undefined> {
  const dir = await realpath(join(directory(account), "presence")).catch((err: NodeJS.ErrnoException) =>
    err.code === "ENOENT" ? null : undefined,
  );
  if (!dir) return dir;
  let files: string[];
  if (process.platform === "linux") {
    const proc = "/proc/" + pid + "/fd";
    try {
      const fds = await readdir(proc);
      files = await Promise.all(
        fds.map(fd =>
          readlink(join(proc, fd)).catch((err: NodeJS.ErrnoException) => {
            // Descriptors can close between listing and reading them.
            if (err.code === "ENOENT") return "";
            throw err;
          }),
        ),
      );
    } catch {
      return undefined;
    }
  } else if (process.platform === "darwin") {
    const result = await run(["/usr/sbin/lsof", "-nP", "-p", String(pid), "-Fn"], {
      timeout_ms: 1500,
      max_output: 512 * 1024,
    }).catch(() => null);
    if (!result?.ok()) return undefined;
    files = result.stdout
      .toString()
      .split("\n")
      .filter(line => line.startsWith("n"))
      .map(line => line.slice(1));
  } else return undefined;
  const ids = new Set(
    files
      .filter(path => dirname(path) === dir && path.endsWith(".lock"))
      .map(path => basename(path, ".lock"))
      .filter(validSession),
  );
  return ids.size === 1 ? [...ids][0] : null;
}
