//! Viewer preferences that survive restarts. Viewers on one machine share the
//! file; the daemon never reads it. Unreadable files fall back to defaults.
//! Mirrors preferences.zig, synchronously like it.
import { join, dirname } from "node:path";
import {
  readFileSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  statSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { supportedPreset, type Preset, type Prefix } from "./keymap";
import * as palette from "./palette";
import type { Scope, Sort } from "./sidebar";
import * as worktreeFolder from "./worktree_folder";
import * as keybindings from "./keybindings";
import * as ghosttyIntegration from "./ghostty_integration";
import type { Binding } from "./bindings";
import { flock } from "./native_bridge";
import * as locale from "./locale";

/** Resource readings shown in the sidebar. Disabling removes the row and,
 * once every attached viewer is off, stops the daemon's sampling. Settings
 * older builds kept beside `enabled` are ignored. */
export type Resources = { enabled: boolean };
/** Where an agent list was scrolled: workspace `workspace`'s own list, or the "All" list when null. */
export type AgentScroll = { workspace: number | null; offset: number };
export class Preferences {
  /** The agent scope persists across viewer restarts. */
  agents: Scope = "workspace";
  /** An explicit agent order; unset follows the default without saving it. */
  agent_sort: Sort | undefined = undefined;
  /** The last dragged sidebar width seeds new viewers; open ones keep their own. */
  sidebar_width = 28;
  /** The last dragged agents header row, seeding new viewers like the width;
   * null splits the sidebar in half. */
  sidebar_split: number | null = null;
  /** The last viewer's agent list scroll seeds new viewers that show the same list. */
  agent_scroll: AgentScroll | null = null;
  preset: Preset = "corgi";
  prefix: Prefix = "ctrl_b";
  /** Action overrides; omitted actions inherit the selected preset. */
  keys: keybindings.Config = {};
  onboarding_complete = false;
  /** Unset follows this viewer's locale; CORGI_LANG overrides an explicit choice. */
  language: locale.Locale | undefined = undefined;
  resources: Resources = { enabled: true };
  /** Decorative sidebar corgi brightness, from off (0) to full (100). */
  corgi_intensity = 50;
  /** The theme picked in setup or onboarding; unset, the terminal picks
   * (`palette.chosen`), and the file leaves it out. */
  theme: palette.Theme | undefined = undefined;
  /** Where the launcher puts a new worktree, as `worktree_folder.ts` reads it. */
  worktree_folder = worktreeFolder.default_template;
  /** The review panel's width, as last dragged. */
  review_width = 80;
  /** Rows the review panel's file list takes at most, as last dragged. */
  review_tree_rows = 9;

  agentSort(): Sort {
    return this.agent_sort ?? "manual";
  }
  bindings(): readonly Binding[] {
    let cached = binding_cache.get(this);
    if (!cached || cached.preset !== this.preset || cached.keys !== this.keys || cached.prefix !== this.prefix) {
      keybindings.validatePrefix(this.keys, this.prefix);
      cached = {
        preset: this.preset,
        prefix: this.prefix,
        keys: this.keys,
        table: keybindings.resolve(this.preset, this.keys),
      };
      if (this.preset === "cmux") ghosttyIntegration.validate(cached.table);
      binding_cache.set(this, cached);
    }
    return cached.table;
  }
}
const binding_cache = new WeakMap<
  Preferences,
  { preset: Preset; prefix: Prefix; keys: keybindings.Config; table: Binding[] }
>();
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
  if (saved === null && existsSync(file)) return new Preferences();
  // Older builds kept preferences beside an overridden socket. Carry a
  // completed setup forward once; the shared file then takes precedence.
  if (process.env.CORGI_SOCKET) {
    const old = readExisting(`${process.env.CORGI_SOCKET}.viewer.json`);
    if (old?.onboarding_complete) {
      try {
        // Keep the legacy setup in memory even if another viewer is saving it.
        saved = migrate(saved, old);
        locked(file, () => {
          const current = readExisting(file);
          saved = current;
          if (current?.onboarding_complete) {
            return;
          }
          if (!current && existsSync(file)) return;
          saved = migrate(current, old);
          atomicWrite(file, saved);
        });
      } catch {
        const current = readExisting(file);
        if (current?.onboarding_complete) saved = current;
      }
    }
  }
  return saved ?? new Preferences();
}
function migrate(current: Preferences | null, old: Preferences): Preferences {
  const migrated = Object.assign(new Preferences(), current ?? old);
  migrated.preset = old.preset;
  migrated.prefix = old.prefix;
  migrated.onboarding_complete = true;
  migrated.bindings();
  return migrated;
}
/** Saves the given fields and keeps the rest as another viewer may have left them. */
export function update(changes: Partial<Preferences>): void {
  updateFile(path(), changes);
}
/** An editor must not overwrite shortcuts changed by another viewer. */
export function updateKeys(expected: Preferences, keys: keybindings.Config, file = path()): void {
  locked(file, () => {
    const saved = readExisting(file);
    if (!saved && existsSync(file)) throw Error("Invalid viewer.json; repair the file before saving shortcuts.");
    const current = saved ?? new Preferences();
    if (
      current.preset !== expected.preset ||
      current.prefix !== expected.prefix ||
      JSON.stringify(current.keys) !== JSON.stringify(expected.keys)
    )
      throw Error("Shortcuts changed on disk. Reopen the editor before saving.");
    current.keys = keybindings.parse(keys);
    current.bindings();
    atomicWrite(file, current);
  });
}
export function updateFile(file: string, changes: Partial<Preferences>): void {
  locked(file, () => {
    const saved = readExisting(file);
    if (!saved && existsSync(file)) throw Error("InvalidPreferences");
    const next = Object.assign(saved ?? new Preferences(), changes);
    next.bindings();
    atomicWrite(file, next);
  });
}
export function read(file: string): Preferences {
  return readExisting(file) ?? new Preferences();
}
const enums = {
  agents: ["workspace", "all"],
  agent_sort: ["activity", "manual"],
  preset: ["corgi", "tmux", "herdr", "cmux"],
  prefix: ["ctrl_b", "ctrl_a"],
} as const;
export function readExisting(file: string): Preferences | null {
  try {
    if (statSync(file).size > 64 * 1024) return null;
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    const v = new Preferences();
    if ("language" in d) {
      if (typeof d.language !== "string") return null;
      v.language = locale.locales.includes(d.language as locale.Locale) ? (d.language as locale.Locale) : undefined;
    }
    // std.json: a known field of the wrong type fails the whole parse.
    for (const [key, values] of Object.entries(enums)) {
      if (!(key in d)) continue;
      if (!(values as readonly string[]).includes(d[key])) return null;
      (v as any)[key] = d[key];
    }
    for (const key of ["onboarding_complete"] as const) {
      if (!(key in d)) continue;
      if (typeof d[key] !== "boolean") return null;
      v[key] = d[key];
    }
    // The old sleeping-corgi switch becomes intensity; an explicit new 0 wins.
    v.corgi_intensity =
      Number.isInteger(d.corgi_intensity) && d.corgi_intensity >= 0 && d.corgi_intensity <= 100
        ? d.corgi_intensity
        : d.sleeping_corgis === false
          ? 0
          : 50;
    if ("theme" in d) {
      if (typeof d.theme !== "string") return null;
      // A theme from a newer build falls back rather than resetting the rest.
      v.theme = palette.parseTheme(d.theme) ?? undefined;
    }
    if ("worktree_folder" in d) {
      if (typeof d.worktree_folder !== "string") return null;
      // A hand-edited template that can't place worktrees falls back alone.
      if (worktreeFolder.problem(d.worktree_folder) === null) v.worktree_folder = d.worktree_folder;
    }
    if ("sidebar_width" in d) {
      if (!Number.isInteger(d.sidebar_width) || d.sidebar_width < 0 || d.sidebar_width > 65535) return null;
      v.sidebar_width = d.sidebar_width;
    }
    if ("review_width" in d) {
      if (!Number.isInteger(d.review_width) || d.review_width < 0 || d.review_width > 65535) return null;
      v.review_width = d.review_width;
    }
    if ("review_tree_rows" in d) {
      if (!Number.isInteger(d.review_tree_rows) || d.review_tree_rows < 1 || d.review_tree_rows > 65535) return null;
      v.review_tree_rows = d.review_tree_rows;
    }
    if ("sidebar_split" in d && d.sidebar_split !== null) {
      if (!Number.isInteger(d.sidebar_split) || d.sidebar_split < 0 || d.sidebar_split > 65535) return null;
      v.sidebar_split = d.sidebar_split;
    }
    if ("resources" in d) {
      const resources = d.resources;
      if (!resources || typeof resources !== "object" || Array.isArray(resources)) return null;
      if ("enabled" in resources && typeof resources.enabled !== "boolean") return null;
      v.resources = { enabled: resources.enabled ?? true };
    }
    if ("agent_scroll" in d && d.agent_scroll !== null) {
      const scroll = d.agent_scroll;
      if (!scroll || typeof scroll !== "object" || Array.isArray(scroll)) return null;
      if (scroll.workspace !== null && !(Number.isInteger(scroll.workspace) && scroll.workspace > 0)) return null;
      if (!Number.isInteger(scroll.offset) || scroll.offset < 0) return null;
      v.agent_scroll = { workspace: scroll.workspace, offset: scroll.offset };
    }
    v.sidebar_width = Math.max(v.sidebar_width, 20);
    v.preset = supportedPreset(v.preset);
    v.keys = keybindings.parse(d.keys);
    v.bindings();
    return v;
  } catch {
    return null;
  }
}
export function write(file: string, value: Preferences): void {
  locked(file, () => atomicWrite(file, value));
}
/** Lock a stable sibling: atomic replacement changes viewer.json's inode. */
function locked(file: string, save: () => void): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(`${file}.lock`, "a", 0o600);
  try {
    if (!flock(fd)) throw Error("Preferences are being saved by another viewer. Try again.");
    save();
  } finally {
    closeSync(fd);
  }
}
function atomicWrite(file: string, value: Preferences): void {
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
