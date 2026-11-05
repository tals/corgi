import { join, dirname } from "node:path";
import * as preferences from "./preferences";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "./os";
import * as json from "./json";
import * as sidebar from "./sidebar";
import type { Profile } from "./machines";
import { max_workspaces } from "./layout";

interface Snapshot {
  instance: string;
  updated: number;
  workspaces: sidebar.WorkspaceEntry[];
}
const limit = 256 * 1024;
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("InvalidCache");
  return value;
}
function label(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw Error("InvalidCache");
  return value;
}
function bytes(value: unknown): bigint | null {
  if (value === null) return null;
  const result = BigInt(typeof value === "bigint" ? value : count(value));
  if (result < 0n || result > 0xffffffffffffffffn) throw Error("InvalidCache");
  return result;
}
/** Display summaries only. Identity is checked again before any workspace can be used. */
export class Cache {
  private saved = "";
  private next = 0;
  readonly path: string;
  constructor(
    profile: Profile | null,
    local: string,
    directory = join(dirname(preferences.path()), "remote/workspaces"),
  ) {
    const identity = profile
      ? [profile.name, profile.target, profile.executable, profile.socket, profile.home]
      : [local];
    this.path = `${directory}/${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.json`;
  }
  read(): Snapshot | null {
    try {
      if (statSync(this.path).size > limit) return null;
      const data = json.parse(readFileSync(this.path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.workspaces) || data.workspaces.length > max_workspaces) return null;
      const ids = new Set<number>();
      const workspaces = data.workspaces.map((row: Record<string, any>) => {
        const id = count(row.id);
        if (!id || ids.has(id)) throw Error("InvalidCache");
        ids.add(id);
        const ws = sidebar.workspaceEntry({
          id,
          name: label(row.name),
          cwd: label(row.cwd),
          active: row.active === true,
        });
        for (const field of ["agents", "working", "unread", "attention"] as const) ws[field] = count(row[field]);
        for (const field of ["tools", "input", "output"] as const) ws.stats[field] = count(row.stats[field]);
        ws.stats.tokens_known = row.stats.tokens_known === true;
        const r = row.resources;
        if (r.cpu !== null && (typeof r.cpu !== "number" || !Number.isFinite(r.cpu) || r.cpu < 0))
          throw Error("InvalidCache");
        Object.assign(ws.resources, {
          id,
          known: r.known === true,
          cpu: r.cpu,
          memory: bytes(r.memory),
          read: bytes(r.read),
          written: bytes(r.written),
          cpu_pressure: r.cpu_pressure === true,
        });
        return ws;
      });
      return { instance: label(data.instance), updated: count(data.updated), workspaces };
    } catch {
      return null;
    }
  }
  write(snapshot: Snapshot, now = Date.now()): void {
    if (!snapshot.instance || now < this.next) return;
    this.next = now + 1000;
    const workspaces = snapshot.workspaces.map(
      ({ id, name, cwd, active, agents, working, unread, attention, stats, resources }) => ({
        id,
        name,
        cwd,
        active,
        agents,
        working,
        unread,
        attention,
        stats,
        resources: {
          known: resources.known,
          cpu: resources.cpu,
          memory: resources.memory,
          read: resources.read,
          written: resources.written,
          cpu_pressure: resources.cpu_pressure,
        },
      }),
    );
    const summary = json.stringify({ instance: snapshot.instance, workspaces });
    if (summary === this.saved) return;
    const data = json.stringify({ version: 1, updated: snapshot.updated, instance: snapshot.instance, workspaces });
    if (Buffer.byteLength(data) > limit) return;
    try {
      os.atomicWrite(this.path, data);
      this.saved = summary;
    } catch {}
  }
}
