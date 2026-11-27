import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const database = (root: string) => join(root, "conversation_summaries.db");
export function workspace(uris: string) {
  try {
    return fileURLToPath(JSON.parse(uris)[0]);
  } catch {
    return "";
  }
}

export function indexStamp(file: string) {
  try {
    const stat = statSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return null;
    const wal = statSync(file + "-wal", { bigint: true, throwIfNoEntry: false });
    return [stat.ino, stat.size, stat.mtimeNs, wal?.ino, wal?.size, wal?.mtimeNs].join(":");
  } catch {
    return null;
  }
}
