//! The shell picker Corgi setup opens: the default, each installed shell
//! /etc/shells lists, and Other… for a typed path. Viewer-owned; a choice
//! sends `shell.configure`, and the daemon saves it in settings.json.
import { basename } from "node:path";
import type { ShellSource, ShellStatus } from "./launch/command";

export type Entry = "default" | "other" | { path: string };
const sources: readonly ShellSource[] = ["setting", "env", "account", "fallback"];
/** The daemon's `shell` snapshot field, with defaults for an older daemon. */
export function status(value: any = {}): ShellStatus {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const fallback = sources.includes(value?.default_source) && value.default_source !== "setting";
  return {
    setting: str(value?.setting),
    path: str(value?.path),
    source: sources.includes(value?.source) ? value.source : "fallback",
    default: str(value?.default),
    default_source: fallback ? value.default_source : "fallback",
  };
}
function origin(source: ShellSource): string {
  switch (source) {
    case "setting":
      return "chosen";
    case "env":
      return "$SHELL";
    case "account":
      return "your account";
    case "fallback":
      return "fallback";
  }
}
/** A setting the daemon could not find, so panes run the default. */
export function missing(s: ShellStatus): boolean {
  return s.setting !== "" && s.source !== "setting";
}
/** The shell new panes run, as Corgi setup shows it: "zsh · your account". */
export function summary(s: ShellStatus): string {
  if (!s.path) return "";
  if (s.source === "setting") return basename(s.path);
  if (missing(s)) return `${s.setting} not found · ${basename(s.path)}`;
  return `${basename(s.path)} · ${origin(s.source)}`;
}
export class Picker {
  entries: Entry[] = [];
  /** The entry new panes use now. */
  in_use = 0;
  selected = 0;
  constructor(readonly shell: ShellStatus) {}
  static open(s: ShellStatus, shells: string[]): Picker {
    const picker = new Picker(s);
    picker.entries = ["default", ...shells.map(path => ({ path }))];
    if (s.setting) {
      const chosen = s.source === "setting" ? s.path : null;
      let index = picker.entries.findIndex(e => typeof e === "object" && (e.path === chosen || e.path === s.setting));
      // A typed shell /etc/shells doesn't list, or one that is gone, keeps a row.
      if (index < 0) index = picker.entries.push({ path: chosen ?? s.setting }) - 1;
      picker.in_use = index;
    }
    picker.entries.push("other");
    picker.selected = picker.in_use;
    return picker;
  }
  move(next: boolean): void {
    this.selected = Math.max(0, Math.min(this.entries.length - 1, this.selected + (next ? 1 : -1)));
  }
  label(e: Entry): string {
    return e === "default" ? "Default" : e === "other" ? "Other…" : basename(e.path);
  }
  detail(e: Entry): string {
    if (e === "default") return `${basename(this.shell.default)} · ${origin(this.shell.default_source)}`;
    if (e === "other") return "type a path";
    return this.entries.indexOf(e) === this.in_use && missing(this.shell) ? `${e.path} · not found` : e.path;
  }
  /** The keycap label for Enter on the selected entry. */
  action(): string {
    const e = this.entries[this.selected];
    return e === "other" ? "Type a path" : this.selected === this.in_use ? "Keep" : "Use";
  }
}
