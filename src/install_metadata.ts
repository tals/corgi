import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as json from "./json";
import * as subprocess from "./subprocess";

/** A mise shim is a dispatcher, including when its tool is not installed. */
export function shim(path: string): boolean {
  const env = process.env,
    data = env.MISE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(env.HOME ?? "", ".local/share"), "mise"),
    shims = resolve(env.MISE_SHIMS_DIR ?? join(data, "shims"));
  if (dirname(resolve(path)) === shims) return true;
  let fd: number | undefined;
  try {
    if (basename(realpathSync(path)) === "mise") return true;
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096),
      head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString();
    return head.startsWith("#!") && /(?:^|[\s/"'])mise["']?\s+(?:exec|x)\b/m.test(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read a matching package above the resolved executable. */
export function packageVersion(path: string, packages: string[]): { version: string; file: string } | null {
  let dir: string;
  try {
    dir = dirname(realpathSync(path));
  } catch {
    return null;
  }
  for (;;) {
    const file = join(dir, "package.json");
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8")),
        name = json.str(value, "name"),
        version = json.str(value, "version");
      if (packages.includes(name) && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) return { version, file };
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `which --version` reads mise's installation record; it does not run the agent. */
export async function mise(
  executable: string,
  command: string,
  cwd: string,
): Promise<{ path: string; version: string | null } | null> {
  const options = {
    cwd,
    timeout_ms: 1000,
    max_output: 4096,
    env: { ...process.env, MISE_AUTO_INSTALL: "0", MISE_NOT_FOUND_AUTO_INSTALL: "0" },
  };
  try {
    const found = await subprocess.run([executable, "which", command], options);
    if (!found.ok()) return null;
    const path = found.stdout.toString().trim();
    if (!path.startsWith("/") || path.includes("\n")) return null;
    let version: string | null = null;
    try {
      const result = await subprocess.run([executable, "which", command, "--version"], options),
        value = result.stdout
          .toString()
          .trim()
          .replace(/^v(?=\d)/, "");
      if (result.ok() && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value)) version = value;
    } catch {}
    return { path, version };
  } catch {
    return null;
  }
}
