//! Viewer-local opt-in Ghostty shortcuts preserve all custom bindings.
import {
  readFileSync,
  statSync,
  realpathSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import * as keymap from "./keymap";
import * as keys from "./keys";
import * as bindings from "./bindings";
import type { Template as Action } from "./action";
import type { Key } from "./keyboard";
export type State = "unavailable" | "disabled" | "enabled" | "failed";
export type Keys = { preset: keymap.Preset; prefix: keymap.Prefix; bindings?: readonly bindings.Binding[] };
const begin = "# BEGIN CORGI GHOSTTY INTEGRATION\n",
  end = "# END CORGI GHOSTTY INTEGRATION\n";
export function available() {
  return process.platform === "darwin" && !("SSH_CONNECTION" in process.env) && !("SSH_TTY" in process.env);
}
function path() {
  const home = process.env.HOME;
  if (!home) throw Error("NoHomeDirectory");
  const native = join(home, "Library/Application Support/com.mitchellh.ghostty"),
    xdg = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "ghostty") : join(home, ".config/ghostty");
  for (const dir of [native, xdg])
    for (const name of ["config.ghostty", "config"])
      try {
        return realpathSync(join(dir, name));
      } catch (error) {
        if ((error as any).code !== "ENOENT") throw error;
      }
  return join(native, "config");
}
function read(file: string) {
  try {
    const bytes = readFileSync(file);
    if (bytes.length > 1024 * 1024) throw Error("StreamTooLong");
    return bytes.toString();
  } catch (error) {
    if ((error as any).code === "ENOENT") return "";
    throw error;
  }
}
export function block(bytes: string): { start: number; stop: number } | null {
  const start = bytes.indexOf(begin),
    stop = bytes.indexOf(end);
  if (start < 0 && stop < 0) return null;
  if (start < 0 || stop < 0 || stop < start) throw Error("InvalidIntegrationBlock");
  const after = stop + end.length;
  if (
    (start > 0 && bytes[start - 1] !== "\n") ||
    (stop > 0 && bytes[stop - 1] !== "\n") ||
    bytes.indexOf(begin, start + begin.length) >= 0 ||
    bytes.indexOf(end, after) >= 0
  )
    throw Error("InvalidIntegrationBlock");
  return { start, stop: after };
}
export function state(): State {
  if (!available()) return "unavailable";
  try {
    return block(read(path())) ? "enabled" : "disabled";
  } catch {
    return "failed";
  }
}
const host_keys: { host: string; action: Action }[] = [
  { host: "cmd+t", action: { name: "new" } },
  { host: "cmd+w", action: { name: "close-tab" } },
  { host: "cmd+shift+t", action: { name: "undo-close" } },
  { host: "ctrl+tab", action: { name: "next" } },
  { host: "ctrl+shift+tab", action: { name: "prev" } },
  ...["cmd+", "cmd+digit_"].flatMap(mod =>
    Array.from({ length: 9 }, (_, i) => ({
      host: mod + (i + 1),
      action: { name: "tab", value: i + 1 } as const,
    })),
  ),
];
/** The Ghostty keys Corgi binds under `preset`, as triggers ("cmd+t") with
 * the action each sends. */
export function commandKeys(
  preset: keymap.Preset,
  source: bindings.Source = preset,
  prefix?: keymap.Prefix,
): { host: string; action: Action }[] {
  const prefix_key = prefix === undefined ? null : keymap.prefixKey(prefix),
    prefix_host = prefix_key ? trigger({ key: prefix_key.codepoint, mods: prefix_key.mods }) : null;
  if (prefix_key)
    source = bindings.table(source).filter(b => !keys.same(prefix_key, { codepoint: b.key, mods: b.mods }));
  if (preset === "cmux")
    return bindings
      .table(source)
      .filter(b => !b.prefixed)
      .flatMap(b => {
        const host = trigger(b);
        return host === null || host === prefix_host ? [] : [{ host, action: b.action }];
      });
  return host_keys.filter(host => {
    if (prefix_key && keys.same(prefix_key, keys.parseChord(host.host.replace("digit_", ""))!)) return false;
    return bindings.first(source, host.action, true) !== null || bindings.first(source, host.action, false) !== null;
  });
}
const key_names: Record<number, readonly [string, string]> = {
  9: ["tab", "Tab"],
  13: ["enter", "↩"],
  32: ["space", "Space"],
  39: ["quote", "'"],
  44: ["comma", ","],
  45: ["minus", "-"],
  46: ["period", "."],
  47: ["slash", "/"],
  59: ["semicolon", ";"],
  61: ["equal", "="],
  91: ["left_bracket", "["],
  92: ["backslash", "\\"],
  93: ["right_bracket", "]"],
  96: ["backquote", "`"],
  127: ["backspace", "⌫"],
  57348: ["insert", "Insert"],
  57349: ["delete", "⌦"],
  57350: ["left", "←"],
  57351: ["right", "→"],
  57352: ["up", "↑"],
  57353: ["down", "↓"],
  57354: ["page_up", "⇞"],
  57355: ["page_down", "⇟"],
  57356: ["home", "↖"],
  57357: ["end", "↘"],
};
/** A trigger as a Mac menu writes it: "cmd+shift+t" is ⌘⇧T. */
export function macLabel(host: string): string {
  const symbols: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" },
    parts = host.split("+"),
    key = parts.pop()!,
    label = Object.values(key_names).find(([name]) => name === key)?.[1];
  return (
    parts.map(mod => symbols[mod] ?? mod).join("") +
    (label ?? (key.startsWith("digit_") ? key.slice(6) : key.toUpperCase()))
  );
}
function trigger(binding: Pick<bindings.Binding, "key" | "mods">) {
  const m = binding.mods;
  // These characters delimit Ghostty's keybind syntax.
  const shifted: Record<number, number> = { 43: 61, 58: 59, 62: 46 };
  const name =
    key_names[shifted[binding.key] ?? binding.key]?.[0] ??
    (binding.key >= 57364 && binding.key <= 57388
      ? `f${binding.key - 57363}`
      : binding.key >= 33 && !(binding.key >= 57344 && binding.key <= 63743)
        ? String.fromCodePoint(binding.key)
        : null);
  if (name === null) return null;
  return (
    (m.super ? "cmd+" : "") +
    (m.ctrl ? "ctrl+" : "") +
    (m.alt ? "alt+" : "") +
    (m.shift || shifted[binding.key] ? "shift+" : "") +
    name
  );
}
/** Ghostty aliases must not turn distinct Corgi chords into the same trigger. */
/** Two shortcuts Ghostty would take for one key. */
export class Clash extends Error {
  name = "GhosttyClash";
  constructor(
    message: string,
    readonly actions: readonly [Action, Action],
  ) {
    super(message);
  }
}
export function validate(source: bindings.Source): void {
  const seen = new Map<string, bindings.Binding>();
  for (const binding of bindings.table(source)) {
    if (binding.prefixed) continue;
    const host = trigger(binding);
    if (host === null) continue;
    const previous = seen.get(host);
    if (previous)
      throw new Clash(
        `${bindings.format(previous)} and ${bindings.format(binding)} both use ${macLabel(host)} in Ghostty; choose another shortcut.`,
        [previous.action, binding.action],
      );
    seen.set(host, binding);
  }
}
export function transform(bytes: string, chosen: Keys | null): string {
  const existing = block(bytes);
  let out = existing ? bytes.slice(0, existing.start) + bytes.slice(existing.stop) : bytes;
  if (!chosen) return out;
  if (out && !out.endsWith("\n")) out += "\n";
  out += begin;
  const source = chosen.bindings ?? chosen.preset,
    prefix_key = keymap.prefixKey(chosen.prefix),
    prefix_host = trigger({ key: prefix_key.codepoint, mods: prefix_key.mods }),
    prefix_hosts = new Set(
      host_keys
        .filter(host => keys.same(prefix_key, keys.parseChord(host.host.replace("digit_", ""))!))
        .map(host => host.host),
    );
  if (prefix_key.mods.super && prefix_host !== null) prefix_hosts.add(prefix_host);
  if (chosen.preset === "cmux") {
    validate(source);
    out += "# cmux preset; applies throughout Ghostty. Reload with Cmd+Shift+comma.\n";
    for (const b of bindings.table(source))
      if (!b.prefixed) {
        const host = trigger(b);
        if (host === null) continue;
        if (host === prefix_host) prefix_hosts.add(host);
        if (prefix_hosts.has(host)) continue;
        const m = b.mods,
          mods = Number(!!m.shift) + 2 * Number(!!m.alt) + 4 * Number(!!m.ctrl) + 8 * Number(!!m.super);
        out += `keybind = ${host}=text:\\x1b[${b.key};${mods + 1}u\n`;
      }
  } else {
    out += "# Applies throughout Ghostty. Reload with Cmd+Shift+comma.\n";
    const reachable = bindings.table(source).filter(b => !keys.same(prefix_key, { codepoint: b.key, mods: b.mods }));
    for (const host of commandKeys(chosen.preset, source, chosen.prefix)) {
      const b = bindings.first(reachable, host.action, true) ?? bindings.first(reachable, host.action, false);
      if (!b) continue;
      const key = keyText({ codepoint: b.key, mods: b.mods });
      const prefix = b.prefixed ? keyText(keymap.prefixKey(chosen.prefix)) : "";
      out += `keybind = ${host.host}=text:${prefix}${key}\n`;
    }
  }
  for (const host of prefix_hosts) out += `keybind = ${host}=text:${keyText(prefix_key)}\n`;
  return out + end;
}
function keyText({ codepoint, mods: m }: Key): string {
  const mods = Number(!!m.shift) + 2 * Number(!!m.alt) + 4 * Number(!!m.ctrl) + 8 * Number(!!m.super);
  if (mods || codepoint >= 128) return `\\x1b[${codepoint};${mods + 1}u`;
  if (codepoint > 32 && codepoint < 127 && codepoint !== 92) return String.fromCodePoint(codepoint);
  return "\\x" + codepoint.toString(16).padStart(2, "0");
}
function apply(keys: Keys | null, existing_only: boolean): boolean {
  if (!available()) throw Error("LocalMacOSOnly");
  const file = path(),
    bytes = read(file);
  if (existing_only && !block(bytes)) return false;
  const updated = transform(bytes, keys);
  if (updated === bytes) return false;
  mkdirSync(dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch (error) {
    if ((error as any).code !== "ENOENT") throw error;
  }
  const temp = file + "." + randomBytes(8).toString("hex") + ".tmp",
    fd = openSync(temp, "wx", mode);
  try {
    writeSync(fd, updated);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, file);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
  return true;
}
export function sync(keys: Keys | null): void {
  apply(keys, false);
}
export function refresh(keys: Keys): boolean {
  return apply(keys, true);
}
