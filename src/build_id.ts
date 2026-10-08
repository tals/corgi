import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function of(executable: string): string {
  const hash = createHash("sha256").update(readFileSync(executable));
  if (!import.meta.filename.startsWith("/$bunfs/")) {
    for (const file of readdirSync(import.meta.dir, { recursive: true })
      .filter((p): p is string => typeof p === "string" && p.endsWith(".ts") && !p.endsWith(".test.ts"))
      .sort())
      hash.update(file).update(readFileSync(resolve(import.meta.dir, file)));
  }
  return hash.digest("hex");
}

export function executablePath(modulePath: string, processPath: string, sourcePath: string, override?: string): string {
  return modulePath.startsWith("/$bunfs/") ? processPath : (override ?? sourcePath);
}
