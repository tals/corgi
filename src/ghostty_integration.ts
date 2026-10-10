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
export type Keys = { preset: keymap.Preset; prefix: keymap.Prefix };
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
export function commandKeys(preset: keymap.Preset): { host: string; action: Action }[] {
  if (preset === "cmux")
    return bindings
      .table("cmux")
      .filter(b => !b.prefixed)
      .map(b => ({ host: trigger(b), action: b.action }));
  return host_keys.filter(host => {
    const b = bindings.first(preset, host.action, true);
    return b && !Object.values(b.mods).some(Boolean) && b.key < 128;
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
    13: "enter",
    44: "comma",
    91: "left_bracket",
    93: "right_bracket",
    57350: "left",
    57351: "right",
    57352: "up",
    57353: "down",
  };
  return (
    (m.super ? "cmd+" : "") +
    (m.ctrl ? "ctrl+" : "") +
    (m.alt ? "alt+" : "") +
    (m.shift ? "shift+" : "") +
    (special[binding.key] ?? String.fromCodePoint(binding.key))
  );
}
export function transform(bytes: string, keys: Keys | null): string {
  const existing = block(bytes);
  let out = existing ? bytes.slice(0, existing.start) + bytes.slice(existing.stop) : bytes;
  if (!keys) return out;
  if (out && !out.endsWith("\n")) out += "\n";
  out += begin;
  if (keys.preset === "cmux") {
    out += "# cmux preset; applies throughout Ghostty. Reload with Cmd+Shift+comma.\n";
    for (const b of bindings.table("cmux"))
      if (!b.prefixed) {
        const m = b.mods,
          mods = Number(!!m.shift) + 2 * Number(!!m.alt) + 4 * Number(!!m.ctrl) + 8 * Number(!!m.super);
        out += `keybind = ${trigger(b)}=text:\\x1b[${b.key};${mods + 1}u\n`;
      }
  } else {
    out += "# Applies throughout Ghostty. Reload with Cmd+Shift+comma.\n";
    for (const host of commandKeys(keys.preset)) {
      const b = bindings.first(keys.preset, host.action, true)!;
      out +=
        `keybind = ${host.host}=text:\\x${keymap.prefixByte(keys.prefix).toString(16).padStart(2, "0")}` +
        (b.key > 32 && b.key < 127 && b.key !== 92
          ? String.fromCodePoint(b.key)
          : "\\x" + b.key.toString(16).padStart(2, "0")) +
        "\n";
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
