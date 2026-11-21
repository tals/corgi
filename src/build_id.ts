import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { resolve } from "node:path";

export function of(executable: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(executable, "r");
  try {
    const chunk = Buffer.allocUnsafe(512 * 1024);
    for (;;) {
      const bytes = fs.readSync(fd, chunk);
      if (bytes === 0) break;
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!import.meta.filename.startsWith("/$bunfs/")) {
    for (const file of fs
      .readdirSync(import.meta.dir, { recursive: true })
      .filter((p): p is string => typeof p === "string" && p.endsWith(".ts") && !p.endsWith(".test.ts"))
      .sort())
      hash.update(file).update(fs.readFileSync(resolve(import.meta.dir, file)));
  }
  return hash.digest("hex");
}

export function executablePath(modulePath: string, processPath: string, sourcePath: string, override?: string): string {
  return modulePath.startsWith("/$bunfs/") ? processPath : (override ?? sourcePath);
}
/** The Corgi executable this process runs: the binary, or the checkout's `corgi` script. */
export function self(): string {
  return executablePath(
    import.meta.filename,
    process.execPath,
    resolve(import.meta.dir, "../corgi"),
    process.env.CORGI_APP_EXE,
  );
}
