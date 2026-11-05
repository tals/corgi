//! `corgi settings`: Corgi setup's settings from the command line. A viewer
//! setting goes into viewer.json, which every viewer on this machine watches
//! and applies as it changes; a runtime setting goes to the daemon the way
//! setup sends it. Shortcuts, Ghostty's command keys and imports stay in setup.
import type { Connection } from "./rpc";
import * as preferences from "./preferences";
import type { Preferences } from "./preferences";
import * as locale from "./locale";
import * as palette from "./palette";
import * as keymap from "./keymap";
import * as worktreeFolder from "./worktree_folder";
import { Provider } from "./providers";
import { status as setupStatus, type Status } from "./corgi_setup";
import { status as shellStatus } from "./shell_picker";
import type { ShellStatus } from "./launch/command";
import type { Use } from "./inference/setup";
import { stringify } from "./json";

export type Name =
  | "language"
  | "theme"
  | "keymap"
  | "prefix"
  | "flourishes"
  | "resources"
  | "worktree-folder"
  | "shell"
  | "smart-links"
  | "clever-corgi"
  | "activity-summaries"
  | "worktree-briefs";
const viewer: Name[] = ["language", "theme", "keymap", "prefix", "flourishes", "resources", "worktree-folder"];
const runtime: Name[] = ["shell", "smart-links", "clever-corgi", "activity-summaries", "worktree-briefs"];
export const names = [...viewer, ...runtime];
export function parseName(name: string): Name | null {
  return names.find(n => n === name) ?? null;
}
const uses: Partial<Record<Name, Use>> = { "activity-summaries": "activity", "worktree-briefs": "worktrees" };
/** Every spelling of a prefix `set` reads; the list shows the first. */
const prefixes: [string, keymap.Prefix][] = [
  ["ctrl+b", "ctrl_b"],
  ["ctrl+a", "ctrl_a"],
  ["ctrl_b", "ctrl_b"],
  ["ctrl_a", "ctrl_a"],
];
const prefixName = (prefix: keymap.Prefix) => prefixes.find(([, p]) => p === prefix)![0];
/** cmux's command keys need Ghostty set up first, which setup walks through. */
const presets = () => keymap.available_presets.filter(p => p !== "cmux");

/** The runtime's settings, as its session snapshot carries them. */
export type Runtime = { inference: Status; shell: ShellStatus; smart_links: boolean };
export interface Row {
  name: Name;
  /** Who it applies to: viewers on this machine, or the runtime. */
  applies: "viewers" | "runtime";
  value: string;
  /** The values `set` takes, when they're a closed set. */
  choices: string[];
  /** How to write any other value. */
  hint: string;
}
const onOff = (on: boolean) => (on ? "on" : "off");
const out = (name: Name, value: string, choices: string[], hint = ""): Row => ({
  name,
  applies: viewer.includes(name) ? "viewers" : "runtime",
  value,
  choices,
  hint,
});
function viewerRow(name: Name, prefs: Preferences): Row | null {
  switch (name) {
    case "language":
      return out(name, prefs.language ?? "auto", ["auto", ...locale.locales]);
    case "theme":
      return out(name, prefs.theme ?? "auto", ["auto", ...palette.available_themes]);
    case "keymap":
      return out(name, prefs.preset, presets());
    case "prefix":
      return out(name, prefixName(prefs.prefix), ["ctrl+b", "ctrl+a"]);
    case "flourishes":
      return out(name, String(prefs.corgi_intensity), [], "0-100, the sidebar corgi's brightness");
    case "resources":
      return out(name, onOff(prefs.resources.enabled), ["on", "off"]);
    case "worktree-folder":
      return out(
        name,
        prefs.worktree_folder,
        ["default"],
        "or a folder with $NAME; also $PROJECT_ROOT $PROJECT_NAME $HOME",
      );
    default:
      return null;
  }
}
function runtimeRow(name: Name, r: Runtime): Row | null {
  switch (name) {
    case "shell":
      return out(
        name,
        r.shell.setting || "default",
        ["default"],
        `or a shell's name or path; panes run ${r.shell.path}`,
      );
    case "smart-links":
      return out(name, onOff(r.smart_links), ["on", "off"]);
    case "clever-corgi":
      return out(name, cleverCorgi(r.inference), ["auto", ...Provider.all], "[--model ID [--account NAME]]");
    case "activity-summaries":
    case "worktree-briefs":
      return out(name, onOff(r.inference.uses[uses[name]!]), ["on", "off"]);
    default:
      return null;
  }
}
/** Clever Corgi's choice as `set` writes it, and whom Auto follows. */
function cleverCorgi(s: Status): string {
  const provider = Provider.parse(s.choice);
  if (!provider) return s.choice === "auto" && s.provider ? `auto (following ${s.provider})` : s.choice;
  const picked = s.selection.provider === provider && s.selection.model ? s.selection : null;
  if (!picked) return provider;
  return `${provider} --model ${picked.model}` + (picked.account ? ` --account ${picked.account}` : "");
}
export function rows(prefs: Preferences, r: Runtime): Row[] {
  return names.map(name => viewerRow(name, prefs) ?? runtimeRow(name, r)!);
}
export function text(shown: Row[]): string {
  const name = Math.max(...shown.map(r => r.name.length)) + 2,
    value = Math.max(...shown.map(r => r.value.length)) + 2,
    line = (r: Row) =>
      (
        "  " +
        r.name.padEnd(name) +
        r.value.padEnd(value) +
        [r.choices.join(", "), r.hint].filter(Boolean).join(" ")
      ).trimEnd();
  const group = (applies: Row["applies"], heading: string) => {
    const lines = shown.filter(r => r.applies === applies).map(line);
    return lines.length ? [heading, ...lines] : [];
  };
  return (
    [...group("viewers", "Viewers on this machine:"), ...group("runtime", "Runtime, for every viewer:")].join("\n") +
    "\n"
  );
}

/** A `set` command line. */
export type Change = { name: Name; value: string; model: string | null; account: string | null };
export type Command = { json: boolean; change: Change | null };
/** `corgi settings ARGS`, the words after `settings`. */
export function parse(args: string[]): Command {
  const words: string[] = [];
  let json = false,
    model: string | null = null,
    account: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--model" && model === null && i + 1 < args.length) model = args[++i];
    else if (a === "--account" && account === null && i + 1 < args.length) account = args[++i];
    else if (a === "--") {
      words.push(...args.slice(i + 1));
      break;
    } else if (a.startsWith("--")) throw Error("Usage");
    else words.push(a);
  }
  if (!words.length && model === null && account === null) return { json, change: null };
  if (words.length !== 3 || words[0] !== "set") throw Error("Usage");
  const name = parseName(words[1]);
  if (!name) throw Error("UnknownSetting");
  if ((model !== null || account !== null) && (name !== "clever-corgi" || words[2] === "auto")) throw Error("Usage");
  return { json, change: { name, value: words[2], model, account } };
}
function bad(): never {
  throw Error("BadValue");
}
function on(value: string): boolean {
  return value === "on" ? true : value === "off" ? false : bad();
}
/** What viewer.json saves for `change`, or null for a runtime setting. */
export function viewerChange(change: Change): Partial<Preferences> | null {
  const v = change.value;
  switch (change.name) {
    case "language":
      return { language: v === "auto" ? undefined : (locale.locales.find(l => l === v) ?? bad()) };
    case "theme":
      return { theme: v === "auto" ? undefined : (palette.parseTheme(v) ?? bad()) };
    case "keymap":
      return { preset: presets().find(p => p === v) ?? bad() };
    case "prefix":
      return { prefix: prefixes.find(([name]) => name === v)?.[1] ?? bad() };
    case "flourishes":
      if (!/^\d{1,3}$/.test(v) || Number(v) > 100) bad();
      return { corgi_intensity: Number(v) };
    case "resources":
      return { resources: { enabled: on(v) } };
    case "worktree-folder": {
      const template = v === "default" ? worktreeFolder.default_template : v;
      if (worktreeFolder.problem(template) !== null) bad();
      return { worktree_folder: template };
    }
    default:
      return null;
  }
}
/** Sends a runtime setting the way setup does; whether the daemon saved it
 * for its next start. */
async function configure(conn: Connection, change: Change): Promise<boolean> {
  const v = change.value;
  switch (change.name) {
    case "shell":
      await conn.call("shell.configure", { shell: v === "default" ? "" : v });
      return true;
    case "smart-links":
      await conn.call("smart_links.configure", { enabled: on(v) });
      return true;
    case "clever-corgi": {
      const choice = v === "auto" ? "auto" : (Provider.parse(v) ?? bad());
      return (await conn.call("inference.configure", { choice, model: change.model, account: change.account })).saved;
    }
    case "activity-summaries":
    case "worktree-briefs":
      return (await conn.call("inference.configure", { [uses[change.name]!]: on(v) })).saved;
    default:
      throw Error("Unreachable");
  }
}
async function runtimeState(conn: Connection): Promise<Runtime> {
  const { result } = await conn.call("session.list");
  return {
    inference: setupStatus(result.inference),
    shell: shellStatus(result.shell),
    smart_links: result.smart_links !== false,
  };
}
/** Runs `corgi settings ARGS`, with viewer settings in `file`; what it
 * prints. Only runtime settings and the list connect to the runtime. */
export async function run(connect: () => Connection, args: string[], file = preferences.path()): Promise<string> {
  const { json, change } = parse(args);
  const saving = change && viewerChange(change);
  if (saving) {
    preferences.updateFile(file, saving);
    const shown = viewerRow(change.name, preferences.read(file))!;
    return json ? stringify({ ok: true, setting: shown, saved: true }) + "\n" : `${shown.name} ${shown.value}\n`;
  }
  const conn = connect();
  try {
    if (!change) {
      const state = await runtimeState(conn),
        shown = rows(preferences.read(file), state);
      if (!json) return text(shown);
      const models = state.inference.available.map(({ provider, model, account, name }) => ({
        provider,
        model,
        account,
        name,
      }));
      return stringify({ ok: true, settings: shown, models }) + "\n";
    }
    const saved = await configure(conn, change),
      shown = runtimeRow(change.name, await runtimeState(conn))!;
    if (json) return stringify({ ok: true, setting: shown, saved }) + "\n";
    return `${shown.name} ${shown.value}${saved ? "" : " (not saved for next start)"}\n`;
  } finally {
    conn.close();
  }
}
