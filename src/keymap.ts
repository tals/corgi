import * as i18n from "./i18n";
import * as keys from "./keys";
import * as bindings from "./bindings";
import type { Key } from "./keyboard";
export type Preset = "corgi" | "tmux" | "herdr" | "cmux";
/** A key chord in the same grammar as custom shortcuts. */
export type Prefix = string;
export const defaultPrefix: Prefix = "ctrl+b";
const prefixes = new Map<string, Key>();
export function parsePrefix(value: unknown): Prefix | null {
  if (typeof value !== "string") return null;
  const key = keys.parseChord(value);
  if (!key || key.codepoint === 27) return null;
  if (prefixes.size >= 32) prefixes.clear();
  prefixes.set(value, key);
  return value;
}
export function prefixKey(prefix: Prefix): Key {
  if (!prefixes.has(prefix) && parsePrefix(prefix) === null) throw Error("InvalidPrefix");
  return prefixes.get(prefix)!;
}
export const available_presets: Preset[] =
  process.platform === "darwin" ? ["corgi", "tmux", "herdr", "cmux"] : ["corgi", "tmux", "herdr"];
export function supportedPreset(preset: Preset): Preset {
  return preset === "cmux" && process.platform !== "darwin" ? "corgi" : preset;
}
export function prefixName(prefix: Prefix): string {
  const key = prefixKey(prefix);
  return bindings.format({ key: key.codepoint, mods: key.mods, prefixed: false, action: { name: "help" } });
}
export function name(preset: Preset): string {
  return { corgi: "Corgi", tmux: "tmux", herdr: "Herdr", cmux: "cmux" }[preset];
}
export function description(preset: Preset): string {
  return {
    corgi: i18n.t`Made for Corgi`,
    tmux: i18n.t`Prefix + classic splits`,
    herdr: i18n.t`Prefix + home row`,
    cmux: i18n.t`Command shortcuts`,
  }[preset];
}
/** The description where a preset gets a narrow column. */
export function shortDescription(preset: Preset): string {
  return {
    corgi: i18n.t`Made for Corgi`,
    tmux: i18n.t`Classic splits`,
    herdr: i18n.t`Home row`,
    cmux: i18n.t`Command keys`,
  }[preset];
}
