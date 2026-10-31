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
import * as bindings from "./bindings";
import type { Action } from "./action";
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
): { host: string; action: Action }[] {
  if (preset === "cmux")
    return bindings
      .table(source)
      .filter(b => !b.prefixed)
      .flatMap(b => {
        const host = trigger(b);
        return host === null ? [] : [{ host, action: b.action }];
      });
  return host_keys.filter(host => {
    return bindings.first(source, host.action, true) !== null || bindings.first(source, host.action, false) !== null;
  });
}
/** A trigger as a Mac menu writes it: "cmd+shift+t" is ⌘⇧T. */
export function macLabel(host: string): string {
  const symbols: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" },
    named: Record<string, string> = {
      tab: "Tab",
      enter: "↩",
      comma: ",",
      left_bracket: "[",
      right_bracket: "]",
      left: "←",
      right: "→",
      up: "↑",
      down: "↓",
    },
    parts = host.split("+"),
    key = parts.pop()!;
  return (
    parts.map(mod => symbols[mod] ?? mod).join("") +
    (named[key] ?? (key.startsWith("digit_") ? key.slice(6) : key.toUpperCase()))
  );
}
function trigger(binding: bindings.Binding) {
  const m = binding.mods;
  const special: Record<number, string> = {
    9: "tab",
    13: "enter",
    32: "space",
    39: "quote",
    44: "comma",
    45: "minus",
    46: "period",
    47: "slash",
    59: "semicolon",
    61: "equal",
    91: "left_bracket",
    92: "backslash",
    93: "right_bracket",
    96: "backquote",
    127: "backspace",
    57348: "insert",
    57349: "delete",
    57350: "left",
    57351: "right",
    57352: "up",
    57353: "down",
    57354: "page_up",
    57355: "page_down",
    57356: "home",
    57357: "end",
  };
  // These characters delimit Ghostty's keybind syntax.
  const shifted: Record<number, string> = { 43: "equal", 58: "semicolon", 62: "period" };
  const name =
    special[binding.key] ??
    shifted[binding.key] ??
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
export function transform(bytes: string, keys: Keys | null): string {
  const existing = block(bytes);
  let out = existing ? bytes.slice(0, existing.start) + bytes.slice(existing.stop) : bytes;
  if (!keys) return out;
  if (out && !out.endsWith("\n")) out += "\n";
  out += begin;
  const source = keys.bindings ?? keys.preset;
  if (keys.preset === "cmux") {
    out += "# cmux preset; applies throughout Ghostty. Reload with Cmd+Shift+comma.\n";
    for (const b of bindings.table(source))
      if (!b.prefixed) {
        const host = trigger(b);
        if (host === null) continue;
        const m = b.mods,
          mods = Number(!!m.shift) + 2 * Number(!!m.alt) + 4 * Number(!!m.ctrl) + 8 * Number(!!m.super);
        out += `keybind = ${host}=text:\\x1b[${b.key};${mods + 1}u\n`;
      }
  } else {
    out += "# Applies throughout Ghostty. Reload with Cmd+Shift+comma.\n";
    for (const host of commandKeys(keys.preset, source)) {
      const b = bindings.first(source, host.action, true) ?? bindings.first(source, host.action, false)!;
      const mods =
        Number(!!b.mods.shift) + 2 * Number(!!b.mods.alt) + 4 * Number(!!b.mods.ctrl) + 8 * Number(!!b.mods.super);
      const key =
        mods || b.key >= 128
          ? `\\x1b[${b.key};${mods + 1}u`
          : b.key > 32 && b.key < 127 && b.key !== 92
            ? String.fromCodePoint(b.key)
            : "\\x" + b.key.toString(16).padStart(2, "0");
      const prefix = b.prefixed ? `\\x${keymap.prefixByte(keys.prefix).toString(16).padStart(2, "0")}` : "";
      out += `keybind = ${host.host}=text:${prefix}${key}\n`;
    }
  }
  return out + end;
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
