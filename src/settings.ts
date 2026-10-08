//! Runtime settings in settings.json beside workspaces.json. People may edit
//! the file by hand; a save keeps the keys it doesn't set.
import { readFileSync } from "node:fs";
import * as os from "./os";
import { Store } from "./workspace";

export function path(socket = os.socketPath()) {
  const state = Store.statePath(socket);
  if (!state.endsWith("workspaces.json")) throw Error("InvalidStatePath");
  return state.slice(0, -"workspaces.json".length) + "settings.json";
}
/** The saved settings, or none when the file is missing, oversized or not an object. */
export function read(file: string): Record<string, unknown> {
  try {
    const data = readFileSync(file);
    if (data.length > 65536) return {};
    const value = JSON.parse(data.toString());
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
export function update(file: string, changes: Record<string, unknown>) {
  os.atomicWrite(file, JSON.stringify({ ...read(file), ...changes }, null, 2), 0o600, false);
}
/** The shell new panes run, as written: an absolute path or a name on PATH. */
/** Whether Corgi probes the ports servers announce, for the sidebar's link
 * button. On unless the file says false. */
export function smartLinks(file = path()): boolean {
  return read(file).smart_links !== false;
}
export function shell(file = path()): string | null {
  const value = read(file).shell;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
