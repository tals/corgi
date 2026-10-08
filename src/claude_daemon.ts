import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Text } from "./providers/common";
import { Claude } from "./providers/claude";
import { running } from "./os";
export { Text as JobId };
export function jobName(id: string) {
  return /^[a-z0-9_]{1,32}$/.test(id);
}
export function jobIn(root: string, session: string): Text | null {
  let files;
  try {
    files = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    try {
      const name = path.join(root, file.name);
      if (statSync(name).size > 65536) continue;
      const r = JSON.parse(readFileSync(name, "utf8"));
      if (r.kind !== "bg" || typeof r.sessionId !== "string" || r.sessionId.toLowerCase() !== session.toLowerCase())
        continue;
      if (!Number.isInteger(r.pid) || r.pid <= 1 || !running(r.pid) || typeof r.jobId !== "string" || !jobName(r.jobId))
        continue;
      return new Text(r.jobId);
    } catch {}
  }
  return null;
}
export function job(session: string) {
  try {
    return jobIn(path.join(Claude.info.configDir(), "sessions"), session);
  } catch {
    return null;
  }
}
export function attachCommand(id: Text) {
  return `${Claude.info.executables[0]} attach ${id.text()}`;
}
