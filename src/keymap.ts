import * as i18n from "./i18n";
export type Preset = "corgi" | "tmux" | "herdr" | "cmux";
export type Prefix = "ctrl_b" | "ctrl_a";
export const available_presets: Preset[] =
  process.platform === "darwin" ? ["corgi", "tmux", "herdr", "cmux"] : ["corgi", "tmux", "herdr"];
export function supportedPreset(preset: Preset): Preset {
  return preset === "cmux" && process.platform !== "darwin" ? "corgi" : preset;
}
export function prefixByte(prefix: Prefix): number {
  return prefix === "ctrl_a" ? 1 : 2;
}
export function prefixName(prefix: Prefix): string {
  return prefix === "ctrl_a" ? "Ctrl+A" : "Ctrl+B";
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
