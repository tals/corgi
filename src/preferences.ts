//! Viewer preferences that survive restarts: what a person chooses, such as
//! shortcuts and theme, in config.json, and what viewers remember, such as
//! sidebar sizes, in viewer.json. Viewers on one machine share both; the daemon
//! never reads them. The viewer saved-state history moves fields between them.
//! A setting or shortcut this build can't use falls back alone and is
//! reported; saving rewrites only the fields it changes.
import { join, dirname, basename, resolve, isAbsolute, sep } from "node:path";
import { tmpdir, userInfo } from "node:os";
import {
  readFileSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  statSync,
  readlinkSync,
  accessSync,
  fchmodSync,
  constants,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { supportedPreset, type Preset, type Prefix } from "./keymap";
import * as palette from "./palette";
import { Provider } from "./providers";
import * as effort from "./providers/effort";
import type { Scope, Sort } from "./sidebar";
import * as worktreeFolder from "./worktree_folder";
import * as keybindings from "./keybindings";
import * as ghosttyIntegration from "./ghostty_integration";
import type { Binding } from "./bindings";
import { flock } from "./native_bridge";
import * as os from "./os";
import * as locale from "./locale";
import * as i18n from "./i18n";
import * as state_formats from "./persist/state_formats";

/** Resource readings shown in the sidebar. Disabling removes the row and,
 * once every attached viewer is off, stops the daemon's sampling. Settings
 * older builds kept beside `enabled` are ignored. */
export type Resources = { enabled: boolean };
/** Where an agent list was scrolled: workspace `workspace`'s own list, or the "All" list when null. */
export type AgentScroll = { workspace: number | null; offset: number };
/** The model the Corgi prompt last picked, as `model_picker.Choice`. */
export type PromptModel = {
  provider: Provider;
  account: string;
  model: string;
  name: string;
  effort: effort.Effort | null;
};
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
  /** Machine-qualified workspace order in the combined sidebar. */
  workspace_order: string[] = [];
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
  /** The Corgi prompt's last pick; "auto", like unset, follows the strong
   * model of the agent run most. */
  prompt_model: PromptModel | "auto" | undefined = undefined;

  agentSort(): Sort {
    return this.agent_sort ?? "manual";
  }
  bindings(): readonly Binding[] {
    let cached = binding_cache.get(this);
    if (!cached || cached.preset !== this.preset || cached.keys !== this.keys || cached.prefix !== this.prefix) {
      cached = {
        preset: this.preset,
        prefix: this.prefix,
        keys: this.keys,
        table: table(this.preset, this.prefix, this.keys),
      };
      binding_cache.set(this, cached);
    }
    return cached.table;
  }
}
/** The bindings `keys` make under `preset` and `prefix`; throws when they can't be used together. */
function table(preset: Preset, prefix: Prefix, keys: keybindings.Config): Binding[] {
  keybindings.validatePrefix(keys, prefix);
  const resolved = keybindings.resolve(preset, keys);
  if (preset === "cmux") ghosttyIntegration.validate(resolved);
  return resolved;
}
const binding_cache = new WeakMap<
  Preferences,
  { preset: Preset; prefix: Prefix; keys: keybindings.Config; table: Binding[] }
>();
/** The fields config.json holds: what a person chooses. viewer.json holds the
 * rest, what viewers remember. */
const settings: readonly string[] = [
  "preset",
  "prefix",
  "keys",
  "language",
  "theme",
  "corgi_intensity",
  "resources",
  "worktree_folder",
];
/** viewer.json, which viewers write. */
export function path(env = process.env): string {
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, "corgi", "viewer.json");
  if (!env.HOME) throw Error("NoHome");
  return join(env.HOME, ".local", "state", "corgi", "viewer.json");
}
/** config.json, which a person may keep with their dotfiles. A developer
 * environment keeps its own. */
export function configPath(env = process.env): string {
  if (env.CORGI_ENV_DIR) return join(env.CORGI_ENV_DIR, "config", "corgi", "config.json");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "corgi", "config.json");
  if (!env.HOME) throw Error("NoHome");
  return join(env.HOME, ".config", "corgi", "config.json");
}
export type Paths = { viewer: string; config: string };
export function paths(env = process.env): Paths {
  return { viewer: path(env), config: configPath(env) };
}
/** Something a file sets that this build skipped, or a file it can't read. */
export type Problem = { file: string; text: string };
/** What a read found. */
export type Reading = {
  prefs: Preferences;
  /** Files that can't be read, then each setting or shortcut that fell back to its default. */
  problems: Problem[];
};
type Raw = Record<string, unknown>;
/** Both files as viewer revisions step them; config is null without one. */
type Files = { viewer: Raw; config: Raw | null };
const history = state_formats.viewer,
  /** The revision of a viewer.json that records none, from before it did. */
  unstamped = history.ancestors.at(-1)!;
function stamp(viewer: Raw): string {
  return typeof viewer.format === "string" ? viewer.format : unstamped;
}
/** Whether this build knows viewer.json's revision; one it doesn't came from a newer build. */
function known(viewer: Raw): boolean {
  return history.ancestors.includes(stamp(viewer));
}
/** Steps the files to this build's revision. Files from a newer build stay
 * as they are, read as far as this build can. */
function upgrade(files: Files): Files {
  const from = stamp(files.viewer);
  if (!history.ancestors.includes(from) || from === history.current) return files;
  return history.up(files, from) as Files;
}
/** Exports files at this build's revision for a reader at `target`. Older
 * viewers reject the whole file for one bad setting, so their copy contains
 * only settings they can use. The original config stays available on upgrade. */
export function downgrade(files: Files, target: string): Files {
  const legacy = ["3bc5f3ca7f53", "d495e64414cb", "67a3f5d4cd43"].includes(target);
  let input = files;
  if (legacy && files.config !== null) {
    const prefs = new Preferences(),
      skipped = new Set(readSettings(files.config, prefs).map(problem => problem.field)),
      config: Raw = {};
    for (const [key, value] of Object.entries(prefs))
      if (settings.includes(key) && Object.hasOwn(files.config, key) && !skipped.has(key) && value !== undefined)
        config[key] = value;
    input = { viewer: files.viewer, config };
  }
  const output = history.down(input, target) as Files;
  if (legacy) output.config = structuredClone(files.config);
  if (target === unstamped) delete output.viewer.format;
  else output.viewer.format = target;
  return output;
}
/** Both files as this build reads them, stepped in memory: nothing is written. */
export function inspect(where = paths()): Reading {
  const problems: Problem[] = [];
  let viewer: Raw | null = null,
    config: Raw | null = null,
    broken = false;
  try {
    viewer = readRaw(where.viewer);
  } catch (error) {
    problems.push(unreadable(where.viewer, error));
    broken = true;
  }
  try {
    config = readRaw(where.config);
  } catch (error) {
    problems.push(unreadable(where.config, error));
    // It exists, so settings left in viewer.json don't take its place.
    config = {};
  }
  const files = upgrade({ viewer: viewer ?? {}, config }),
    prefs = new Preferences();
  readState(files.viewer, prefs);
  // Viewers replace viewer.json whole, so only a hand edit leaves one they
  // can't read. Setup ran before it: onboarding and its imports must not run again.
  if (broken) prefs.onboarding_complete = true;
  for (const p of readSettings(files.config ?? {}, prefs))
    problems.push({ file: where.config, text: `${p.field}: ${p.reason}` });
  return { prefs, problems };
}
/** config.json alone, as live reload reads it; prefs is null when it can't be read. */
export function inspectConfig(file = configPath()): { prefs: Preferences | null; problems: Problem[] } {
  let raw: Raw | null;
  try {
    raw = readRaw(file);
  } catch (error) {
    return { prefs: null, problems: [unreadable(file, error)] };
  }
  const prefs = new Preferences();
  return { prefs, problems: readSettings(raw ?? {}, prefs).map(p => ({ file, text: `${p.field}: ${p.reason}` })) };
}
/** viewer.json alone, as live reload reads it, with defaults for settings;
 * null when it can't be read. */
export function inspectViewer(file = path()): Preferences | null {
  const prefs = new Preferences();
  try {
    readState(upgrade({ viewer: readRaw(file) ?? {}, config: {} }).viewer, prefs);
  } catch {
    return null;
  }
  return prefs;
}
function unreadable(file: string, error: unknown): Problem {
  const reason = (error as Error).message;
  return { file, text: i18n.t`can't be read (${reason}); using defaults until it's repaired` };
}
export function read(where = paths()): Preferences {
  return inspect(where).prefs;
}
/** Loads startup preferences, optionally persisting the import and migration together. */
export function load(migrating = false): Preferences {
  let where: Paths;
  try {
    where = paths();
  } catch {
    return new Preferences();
  }
  const saved = read(where);
  const finish = () => {
    if (migrating) {
      try {
        return save(where, () => {});
      } catch {}
    }
    return saved;
  };
  if (saved.onboarding_complete || !process.env.CORGI_SOCKET) return finish();
  // Older builds kept preferences beside an overridden socket. Carry a
  // completed setup forward once; the shared files then take precedence.
  let old: Raw | null;
  try {
    old = readRaw(`${process.env.CORGI_SOCKET}.viewer.json`);
  } catch {
    return finish();
  }
  if (old === null) return finish();
  const legacy = new Preferences();
  readState(old, legacy);
  readSettings(old, legacy);
  if (!legacy.onboarding_complete) return finish();
  // Its keymap carries forward only into a config.json it makes: one already
  // there, such as one restored from dotfiles, keeps its own choices. Without
  // a shared viewer.json, the old one stands in for it.
  const carry = (files: Files, { disk }: Context) => {
    if (files.viewer.onboarding_complete === true) return;
    files.viewer.onboarding_complete = true;
    if (disk.config !== null) return;
    const defaults = new Preferences(),
      chosen: Raw = {};
    if (legacy.preset !== defaults.preset) chosen.preset = legacy.preset;
    if (legacy.prefix !== defaults.prefix) chosen.prefix = legacy.prefix;
    if (Object.keys(chosen).length) files.config = { ...files.config, ...chosen };
  };
  try {
    return save(where, carry, { base: old, strict: false });
  } catch {
    // Keep the legacy setup in memory even if another viewer is saving it.
    try {
      return plan(where, carry, { base: old, strict: false }).prefs;
    } catch {
      return saved;
    }
  }
}
/** Brings both files to this build's revision, as every save does.
 * Throws when another viewer holds the lock. */
export function migrate(where = paths()): void {
  save(where, () => {});
}
/** Saves the given fields, each in its file, and keeps the rest as another viewer may have left them. */
export function update(changes: Partial<Preferences>, where = paths()): void {
  save(where, (files, { current, skipped }) => {
    for (const [key, value] of Object.entries(changes)) {
      if (!settings.includes(key)) {
        assign(files.viewer, key, value);
        continue;
      }
      // A choice that changes nothing leaves config.json as it is, so one
      // linked read-only still works; one replacing a value this build skips
      // still clears it.
      if (same((current as unknown as Raw)[key], value) && !skipped.includes(key)) continue;
      files.config ??= {};
      // A newer build's fields in the same object stay.
      const saved = files.config[key];
      assign(files.config, key, object(saved) && object(value) ? { ...saved, ...value } : value);
    }
  });
}
function object(value: unknown): value is Raw {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Sets `key`, or removes it for undefined, which JSON leaves out anyway. */
function assign(raw: Raw, key: string, value: unknown): void {
  if (value === undefined) delete raw[key];
  else raw[key] = value;
}
/** An editor must not overwrite shortcuts changed by another viewer. Shortcuts
 * this build skipped stay in config.json, after the editor's, for the person to
 * fix; what the file then holds comes back, as one of them may now apply. */
export function updateKeys(expected: Preferences, keys: keybindings.Config, where = paths()): Preferences {
  return save(where, (files, { current, skipped }) => {
    if (current.preset !== expected.preset || current.prefix !== expected.prefix || !same(current.keys, expected.keys))
      throw Error("Shortcuts changed on disk. Reopen the editor before saving.");
    const next: Raw = { ...keybindings.parse(keys) };
    const written = files.config?.keys;
    if (object(written))
      for (const [name, value] of Object.entries(written)) {
        if (skipped.includes(`keys.${name}`) && !Object.hasOwn(next, name)) next[name] = value;
      }
    files.config = { ...files.config, keys: next };
  });
}
/** Writes `value` whole: its settings to config.json and the rest to viewer.json. */
export function write(value: Preferences, where = paths()): void {
  save(
    where,
    files => {
      files.config = {};
      files.viewer = { format: history.current };
      for (const [key, field] of Object.entries(value))
        assign(settings.includes(key) ? files.config : files.viewer, key, field);
    },
    { strict: false },
  );
}
type Options = {
  /** Unless false, an edit that would make another setting or shortcut fall back throws. */
  strict?: boolean;
  /** What stands in for a missing viewer.json. */
  base?: Raw;
};
/** What an edit sees besides the files: the settings they hold before it,
 * those this build skipped, and the files as read. */
type Context = { current: Preferences; skipped: string[]; disk: { viewer: Raw | null; config: Raw | null } };
type Edit = (files: Files, context: Context) => void;
type Plan = {
  disk: Context["disk"];
  files: Files;
  prefs: Preferences;
  /** Files this build can't read, which it never writes. */
  unreadable: { viewer: boolean; config: boolean };
};
/** Steps both files, then applies the edit. An unreadable file is never written
 * and blocks migration, since viewer.json may still hold settings. */
function plan(where: Paths, edit: Edit, options: Options = {}): Plan {
  const attempt = (file: string): { raw: Raw | null; error: Error | null } => {
    try {
      return { raw: readRaw(file), error: null };
    } catch (error) {
      return { raw: null, error: error as Error };
    }
  };
  const viewer = attempt(where.viewer),
    config = attempt(where.config),
    disk = { viewer: viewer.raw, config: config.raw };
  // An unreadable config.json still exists: settings left in viewer.json don't take its place.
  const start = {
    viewer: viewer.raw ?? (viewer.error ? {} : (options.base ?? {})),
    config: config.error ? {} : config.raw,
  };
  const steps = !viewer.error && !config.error && known(start.viewer),
    files: Files = structuredClone(steps ? upgrade(start) : start);
  if (steps) files.viewer.format = history.current;
  const stepped = structuredClone(files),
    current = new Preferences();
  readState(files.viewer, current);
  const skipped = readSettings(files.config ?? {}, current).map(p => p.field);
  edit(files, { current, skipped, disk });
  // Until settings have moved, an unreadable viewer.json may hold them, so none save.
  const blocked = {
    viewer: viewer.error && { file: where.viewer, error: viewer.error },
    config: config.error
      ? { file: where.config, error: config.error }
      : viewer.error && config.raw === null && { file: where.viewer, error: viewer.error },
  };
  for (const part of ["viewer", "config"] as const) {
    const block = blocked[part];
    if (block && !same(files[part], stepped[part])) throw cantRead(block.file, block.error);
  }
  const prefs = new Preferences();
  readState(files.viewer, prefs);
  const added = readSettings(files.config ?? {}, prefs).find(p => !skipped.includes(p.field));
  if (options.strict !== false && added !== undefined) throw Error(`${added.field}: ${added.reason}`);
  return { disk, files, prefs, unreadable: { viewer: viewer.error !== null, config: config.error !== null } };
}
/** Saves `edit` under the locks: config.json first, so a viewer that stops
 * between the two writes leaves viewer.json at its old revision, and the
 * same steps run again. Each file is written only when it changed, and
 * neither when either would be too large to read back. */
function save(where: Paths, edit: Edit, options: Options = {}): Preferences {
  return locked(where, () => {
    const { disk, files, prefs, unreadable } = plan(where, edit, options);
    const writes: [string, string][] = [];
    if (!unreadable.config && files.config !== null && !same(files.config, disk.config))
      writes.push([where.config, serialize(where.config, files.config)]);
    if (!unreadable.viewer && !same(files.viewer, disk.viewer))
      writes.push([where.viewer, serialize(where.viewer, files.viewer)]);
    for (const [file, text] of writes) atomicWrite(file, text);
    return prefs;
  });
}
/** The previous release, like this one, reads neither file past 64 KiB, so
 * a long workspace order drops the indentation before it doesn't fit. */
function serialize(file: string, value: Raw): string {
  for (const text of [JSON.stringify(value, null, 2), JSON.stringify(value)])
    if (Buffer.byteLength(text) <= limit) return text;
  const name = basename(file),
    reason = i18n.t`larger than 64 KiB`;
  throw Error(i18n.t`Can't save ${name} (${reason})`);
}
const limit = 64 * 1024;
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function cantRead(file: string, error: Error): Error {
  const name = basename(file),
    reason = error.message;
  return Error(i18n.t`Can't read ${name} (${reason}); repair it before saving preferences.`);
}
/** The file's JSON object, or null when there is no file. */
function readRaw(file: string): Raw | null {
  let text: string;
  try {
    if (statSync(file).size > limit) throw Error(i18n.t`larger than 64 KiB`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const d = JSON.parse(text);
  if (!d || typeof d !== "object" || Array.isArray(d)) throw Error(i18n.t`not a JSON object`);
  return d;
}
/** A setting, such as `prefix` or `keys.new`, that fell back to its default. */
type Skipped = { field: string; reason: string };
/** viewer.json's fields. Viewers write them, so one that isn't valid, from a
 * hand edit or a newer build, falls back quietly. */
function readState(d: Record<string, any>, v: Preferences): void {
  const whole = (value: unknown, min: number): value is number =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= 65535;
  if (d.agents === "workspace" || d.agents === "all") v.agents = d.agents;
  if (d.agent_sort === "activity" || d.agent_sort === "manual") v.agent_sort = d.agent_sort;
  // Only an explicit false runs onboarding: a garbled value comes from a hand edit after setup.
  if ("onboarding_complete" in d) v.onboarding_complete = d.onboarding_complete !== false;
  if (whole(d.sidebar_width, 0)) v.sidebar_width = Math.max(d.sidebar_width, 20);
  if (whole(d.sidebar_split, 0)) v.sidebar_split = d.sidebar_split;
  if (whole(d.review_width, 0)) v.review_width = d.review_width;
  if (whole(d.review_tree_rows, 1)) v.review_tree_rows = d.review_tree_rows;
  // A pick this build can't read, such as a provider it doesn't know, falls back.
  if ("prompt_model" in d) v.prompt_model = promptModel(d.prompt_model) ?? undefined;
  const scroll = d.agent_scroll;
  if (
    scroll &&
    typeof scroll === "object" &&
    !Array.isArray(scroll) &&
    (scroll.workspace === null || (Number.isInteger(scroll.workspace) && scroll.workspace > 0)) &&
    Number.isInteger(scroll.offset) &&
    scroll.offset >= 0
  )
    v.agent_scroll = { workspace: scroll.workspace, offset: scroll.offset };
  const order = d.workspace_order;
  if (Array.isArray(order) && order.length <= 10000 && order.every((key: unknown) => typeof key === "string"))
    v.workspace_order = [...new Set<string>(order)];
}
const enums = {
  preset: ["corgi", "tmux", "herdr", "cmux"],
  prefix: ["ctrl_b", "ctrl_a"],
} as const;
/** config.json's fields, each read alone: one this build can't use keeps its
 * default and names itself, without costing the others. */
function readSettings(d: Record<string, any>, v: Preferences): Skipped[] {
  const problems: Skipped[] = [];
  const skip = (field: string, reason: string) => problems.push({ field, reason });
  const unexpected = (field: string) => skip(field, i18n.t`unexpected value; using the default`);
  if ("language" in d) {
    // A language from a newer build falls back quietly.
    if (typeof d.language !== "string") unexpected("language");
    else v.language = locale.locales.includes(d.language as locale.Locale) ? (d.language as locale.Locale) : undefined;
  }
  for (const [key, values] of Object.entries(enums)) {
    if (!(key in d)) continue;
    if ((values as readonly string[]).includes(d[key])) (v as any)[key] = d[key];
    else {
      const list = values.join(", ");
      skip(key, i18n.t`use one of ${list}`);
    }
  }
  if ("corgi_intensity" in d) {
    const intensity = d.corgi_intensity,
      min = 0,
      max = 100;
    if (Number.isInteger(intensity) && intensity >= min && intensity <= max) v.corgi_intensity = intensity;
    else skip("corgi_intensity", i18n.t`use a whole number from ${min} to ${max}`);
  }
  if ("theme" in d) {
    // A theme from a newer build falls back quietly.
    if (typeof d.theme !== "string") unexpected("theme");
    else v.theme = palette.parseTheme(d.theme) ?? undefined;
  }
  if ("worktree_folder" in d) {
    const problem = typeof d.worktree_folder === "string" ? worktreeFolder.problem(d.worktree_folder) : null;
    if (typeof d.worktree_folder !== "string") unexpected("worktree_folder");
    else if (problem !== null) skip("worktree_folder", problem);
    else v.worktree_folder = d.worktree_folder;
  }
  if ("resources" in d) {
    const resources = d.resources;
    if (
      !resources ||
      typeof resources !== "object" ||
      Array.isArray(resources) ||
      ("enabled" in resources && typeof resources.enabled !== "boolean")
    )
      unexpected("resources");
    else v.resources = { enabled: resources.enabled ?? true };
  }
  v.preset = supportedPreset(v.preset);
  if ("keys" in d) {
    const written = d.keys;
    if (!written || typeof written !== "object" || Array.isArray(written)) unexpected("keys");
    else v.keys = shortcuts(v.preset, v.prefix, written, skip);
  }
  return problems;
}
/** The shortcuts that can be used together. One that can't be used costs
 * only its own action: where two clash, the later in the file gives way, so
 * the first that works wins, and overrides that only work together, such as
 * two key sets trading keys, stay together. */
function shortcuts(
  preset: Preset,
  prefix: Prefix,
  written: Record<string, unknown>,
  skip: (field: string, reason: string) => void,
): keybindings.Config {
  const memo = `${preset}\n${prefix}\n${JSON.stringify(written)}`,
    hit = resolved.get(memo);
  if (hit) {
    for (const [field, reason] of hit.skipped) skip(field, reason);
    return { ...hit.keys };
  }
  const skipped: [string, string][] = [],
    note = (field: string, reason: string) => skipped.push([field, reason]);
  const keys: keybindings.Config = {},
    names: Record<string, string> = {};
  for (const [name, value] of Object.entries(written)) {
    try {
      for (const [id, shortcut] of Object.entries(keybindings.parse({ [name]: value }))) {
        // Two spellings of one action, such as `worktrees` and `worktrees:0`: the first stays.
        if (Object.hasOwn(keys, id)) {
          const earlier = names[id];
          note(`keys.${name}`, i18n.t`${earlier} already sets this action`);
          continue;
        }
        keys[id] = shortcut;
        names[id] = name;
      }
    } catch (error) {
      note(`keys.${name}`, (error as Error).message);
    }
  }
  const order = Object.keys(keys),
    candidates = { ...keys },
    rejected = new Map<string, string>();
  for (;;) {
    try {
      table(preset, prefix, keys);
      break;
    } catch (error) {
      const at = culprits(error).filter(id => Object.hasOwn(keys, id));
      // An error that names none still drops one, the last, so this ends.
      const id = (at.length ? at : Object.keys(keys)).reduce((a, b) => (order.indexOf(a) > order.indexOf(b) ? a : b));
      rejected.set(id, (error as Error).message);
      delete keys[id];
    }
  }
  // A clash may have hidden a usable shortcut behind one that was itself rejected.
  let restored: boolean;
  do {
    restored = false;
    for (const id of order) {
      if (!rejected.has(id)) continue;
      const retry = { ...keys, [id]: candidates[id] };
      try {
        table(preset, prefix, retry);
        keys[id] = candidates[id];
        rejected.delete(id);
        restored = true;
      } catch (error) {
        rejected.set(id, (error as Error).message);
      }
    }
  } while (restored);
  for (const [id, reason] of rejected) note(`keys.${names[id]}`, reason);
  // Problems in file order, as the person reads them.
  const position = (field: string) => Object.keys(written).indexOf(field.slice("keys.".length));
  skipped.sort((a, b) => position(a[0]) - position(b[0]));
  if (resolved.size >= 8) resolved.delete(resolved.keys().next().value!);
  resolved.set(memo, { keys: { ...keys }, skipped });
  for (const [field, reason] of skipped) skip(field, reason);
  return keys;
}
/** Shortcuts already resolved, by what was written: every read of an
 * unchanged config.json would otherwise rebuild a table per clash. */
const resolved = new Map<string, { keys: keybindings.Config; skipped: [string, string][] }>();
/** The overrides an error from `table` blames, by action id. */
function culprits(error: unknown): readonly string[] {
  if (error instanceof keybindings.InvalidKeys) return error.ids;
  if (error instanceof ghosttyIntegration.Clash) return error.actions.map(keybindings.id);
  return [];
}
function promptModel(value: any): PromptModel | "auto" | null {
  if (value === "auto") return "auto";
  if (!value || typeof value !== "object") return null;
  const provider = Provider.parse(value.provider),
    { account, model, name } = value;
  if (!provider || typeof account !== "string" || typeof model !== "string" || typeof name !== "string") return null;
  return { provider, account, model, name, effort: effort.parse(value.effort) };
}
/** Holds the older viewers' lock, then the shared preferences lock. Atomic
 * replacement changes the files' own inodes, so neither can hold a lock. */
function locked<T>(where: Paths, body: () => T): T {
  mkdirSync(dirname(where.viewer), { recursive: true });
  const busy = () => Error("Preferences are being saved by another viewer. Try again.");
  // XXX: Remove for next protocol bump. Older viewers only take this lock.
  const state = openSync(`${where.viewer}.lock`, "a", 0o600);
  let shared: number | null = null;
  try {
    if (!flock(state)) throw busy();
    shared = openSync(sharedLock(), "a", 0o600);
    if (!flock(shared)) throw busy();
    return body();
  } finally {
    if (shared !== null) closeSync(shared);
    closeSync(state);
  }
}
/** One named lock in the user's runtime directory serializes preference saves,
 * including separate configs and paths through linked folders. It stays outside
 * ~/.config, which may be read-only or on NFS. */
export function sharedLock(): string {
  const runtime = process.env.XDG_RUNTIME_DIR,
    folder = runtime
      ? join(runtime, "corgi", "locks")
      : join(tmpdir(), `corgi-${process.getuid?.() ?? userInfo().uid}`, "locks");
  os.privateDirectory(folder);
  return join(folder, "preferences.lock");
}
/** Where writing `file` belongs: a config.json linked from dotfiles stays a
 * link, through a chain of them, even when the last target doesn't exist yet. */
function target(file: string): string {
  let path = resolve(sep),
    hops = 0;
  const pending = (isAbsolute(file) ? file : `${process.cwd()}${sep}${file}`).split(sep);
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      path = dirname(path);
      continue;
    }
    const next = join(path, part);
    try {
      const link = readlinkSync(next);
      if (++hops > 40) throw Error("Too many symbolic links");
      if (isAbsolute(link)) path = resolve(sep);
      pending.unshift(...link.split(sep));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOENT") throw error;
      path = next;
    }
  }
  return path;
}
function atomicWrite(file: string, text: string): void {
  const path = target(file);
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
    accessSync(path, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // One its owner made read-only, as dotfile managers do, stays as it is.
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      const name = basename(file);
      throw Error(i18n.t`${name} is read-only; Corgi leaves it as it is`);
    }
    if (code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  // Every viewer uses these files, so each writer needs its own temporary file.
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
