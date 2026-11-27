import { readdir, readlink, realpath } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { run } from "../../subprocess";
import { directory, validSession } from "./config";

/** A second CLI opening a conversation already in use does not acquire its lock. */
export function requested(args: string[]) {
  for (let i = 1; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (flag === "--") break;
    if (["--conversation", "--resume", "-r"].includes(flag)) {
      const id = inline ?? args[++i];
      return validSession(id) ? id : null;
    }
  }
  return null;
}

/** agy holds a presence/<conversation>.lock descriptor while that conversation is selected. */
export async function selected(pid: number, account: string): Promise<string | null> {
  const dir = await realpath(join(directory(account), "presence")).catch(() => null);
  if (!dir) return null;
  let files: string[];
  if (process.platform === "linux") {
    const proc = "/proc/" + pid + "/fd";
    const fds = await readdir(proc).catch(() => []);
    files = await Promise.all(fds.map(fd => readlink(join(proc, fd)).catch(() => "")));
  } else if (process.platform === "darwin") {
    const result = await run(["/usr/sbin/lsof", "-nP", "-p", String(pid), "-Fn"], {
      timeout_ms: 1500,
      max_output: 512 * 1024,
    }).catch(() => null);
    files =
      result?.stdout
        .toString()
        .split("\n")
        .filter(line => line.startsWith("n"))
        .map(line => line.slice(1)) ?? [];
  } else return null;
  const ids = new Set(
    files
      .filter(path => dirname(path) === dir && path.endsWith(".lock"))
      .map(path => basename(path, ".lock"))
      .filter(validSession),
  );
  return ids.size === 1 ? [...ids][0] : null;
}
