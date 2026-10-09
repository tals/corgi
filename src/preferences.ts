//! Viewer preferences that survive restarts. Viewers on one machine share the
//! file; the daemon never reads it. Unreadable files fall back to defaults.
//! Mirrors preferences.zig, synchronously like it.
import { join, dirname } from "node:path";
import { readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { supportedPreset, type Preset, type Prefix } from "./keymap";
import * as palette from "./palette";
import type { Scope } from "./sidebar";

/** Resource readings shown in the sidebar. Disabling removes the row and,
 * once every attached viewer is off, stops the daemon's sampling. Settings
 * older builds kept beside `enabled` are ignored. */
export type Resources = { enabled: boolean };
export class Preferences {
  /** The agent scope persists across viewer restarts. */
  agents: Scope = "workspace";
  /** The last dragged sidebar width seeds new viewers; open ones keep their own. */
  sidebar_width = 28;
  preset: Preset = "corgi";
  prefix: Prefix = "ctrl_b";
  onboarding_complete = false;
  resources: Resources = { enabled: true };
  /** Idle agents nap as corgis in the sidebar; off marks them with a faint Z. */
  sleeping_corgis = true;
  theme: palette.Theme = "corgi";
}
export function path(): string {
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "corgi", "viewer.json");
  if (!process.env.HOME) throw Error("NoHome");
  return join(process.env.HOME, ".local", "state", "corgi", "viewer.json");
}
export function load(): Preferences {
  let file: string;
  try {
    file = path();
  } catch {
    return new Preferences();
  }
  let saved = readExisting(file);
  if (saved?.onboarding_complete) return saved;
  // Older builds kept preferences beside an overridden socket. Carry a
  // completed setup forward once; the shared file then takes precedence.
  if (process.env.CORGI_SOCKET) {
    const old = readExisting(`${process.env.CORGI_SOCKET}.viewer.json`);
    if (old?.onboarding_complete) {
      const migrated = saved ?? old;
      migrated.preset = old.preset;
      migrated.prefix = old.prefix;
      migrated.onboarding_complete = true;
      try {
        write(file, migrated);
      } catch {}
      saved = migrated;
    }
  }
  return saved ?? new Preferences();
}
/** Saves the given fields and keeps the rest as another viewer may have left them. */
export function update(changes: Partial<Preferences>): void {
  updateFile(path(), changes);
}
export function updateFile(file: string, changes: Partial<Preferences>): void {
  write(file, Object.assign(read(file), changes));
}
export function read(file: string): Preferences {
  return readExisting(file) ?? new Preferences();
}
const enums = {
  agents: ["workspace", "all"],
  preset: ["corgi", "tmux", "herdr", "cmux"],
  prefix: ["ctrl_b", "ctrl_a"],
} as const;
export function readExisting(file: string): Preferences | null {
  try {
    if (statSync(file).size > 64 * 1024) return null;
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    const v = new Preferences();
    // std.json: a known field of the wrong type fails the whole parse.
    for (const [key, values] of Object.entries(enums)) {
      if (!(key in d)) continue;
      if (!(values as readonly string[]).includes(d[key])) return null;
      (v as any)[key] = d[key];
    }
    for (const key of ["onboarding_complete", "sleeping_corgis"] as const) {
      if (!(key in d)) continue;
      if (typeof d[key] !== "boolean") return null;
      v[key] = d[key];
    }
    if ("theme" in d) {
      if (typeof d.theme !== "string") return null;
      // A theme from a newer build falls back rather than resetting the rest.
      v.theme = palette.parseTheme(d.theme) ?? "corgi";
    }
    if ("sidebar_width" in d) {
      if (!Number.isInteger(d.sidebar_width) || d.sidebar_width < 0 || d.sidebar_width > 65535) return null;
      v.sidebar_width = d.sidebar_width;
    }
    if ("resources" in d) {
      const resources = d.resources;
      if (!resources || typeof resources !== "object" || Array.isArray(resources)) return null;
      if ("enabled" in resources && typeof resources.enabled !== "boolean") return null;
      v.resources = { enabled: resources.enabled ?? true };
    }
    v.sidebar_width = Math.max(v.sidebar_width, 20);
    v.preset = supportedPreset(v.preset);
    return v;
  } catch {
    return null;
  }
}
export function write(file: string, value: Preferences): void {
  mkdirSync(dirname(file), { recursive: true });
  // Every viewer uses this file, so each writer needs its own temporary file.
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}
