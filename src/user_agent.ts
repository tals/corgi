//! The User-Agent Corgi's update checks send: its release, and coarse facts
//! about the machine and the terminals viewing it, with no identifier.
import { readFileSync } from "node:fs";
import type { Terminal } from "./bug_report";

/** At most this many terminals, the first by name. */
const max_terminals = 3;
const max_length = 40;

type Read = (path: string) => string;
const read: Read = path => readFileSync(path, "utf8");

/** `value` fit for one field: whatever would end a field or the comment, or
 * isn't printable ASCII, becomes a space. */
export function clean(value: string): string {
  return value
    .replace(/[^\x21-\x7e]|[;,()\\]/g, " ")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, max_length)
    .trimEnd();
}

/** Release, OS, CPU and terminals, for the channel check:
 * `corgi/<release> (macos 15; aarch64; ghostty 1.3.1)`. */
export function full(release: string, platform: string, terminals: readonly string[], system = os()): string {
  const arch = platform.slice(platform.indexOf("-") + 1);
  return `${bare(release)} (${system}; ${arch}; ${terminals.join(",") || "-"})`;
}

/** The release alone, for downloads and any host a check is redirected to. */
export function bare(release: string): string {
  return `corgi/${release}`;
}

/** `macos 15`, `linux/ubuntu 24.04`, `linux/arch` or `linux`; ` wsl` under WSL. */
export function os(system: NodeJS.Platform = process.platform, file: Read = read): string {
  const text = (path: string) => {
    try {
      return file(path);
    } catch {
      return null;
    }
  };
  if (system === "darwin") {
    const plist = text("/System/Library/CoreServices/SystemVersion.plist") ?? "",
      major = /<key>ProductVersion<\/key>\s*<string>(\d+)/.exec(plist)?.[1];
    return major ? `macos ${major}` : "macos";
  }
  if (system !== "linux") return clean(system) || "-";
  const release = text("/etc/os-release") ?? text("/usr/lib/os-release") ?? "",
    field = (key: string) =>
      clean(new RegExp(`^${key}=(["']?)(.*?)\\1\\s*$`, "m").exec(release)?.[2] ?? "").replaceAll(" ", "-"),
    id = field("ID"),
    version = id && field("VERSION_ID"),
    wsl = /microsoft/i.test(text("/proc/sys/kernel/osrelease") ?? "");
  return `linux${id ? `/${id}` : ""}${version ? ` ${version}` : ""}${wsl ? " wsl" : ""}`;
}

/** The terminals viewers reported since the daemon started, the newest of
 * each. Kept whoever is attached, so a check says nothing of whether anyone
 * is now, or which terminal they used last. */
export class Terminals {
  private labels = new Map<string, string>();
  report(t: Pick<Terminal, "name" | "env" | "ssh"> | null): void {
    const seen = terminal(t);
    if (seen) this.labels.set(seen.name, seen.label);
  }
  /** The first few by name, whenever they reported. */
  list(): string[] {
    return [...this.labels.keys()]
      .sort()
      .slice(0, max_terminals)
      .map(name => this.labels.get(name)!);
  }
}

/** A terminal a viewer ran in: `name` tells terminals apart, `label` is what a
 * check sends. */
export interface Seen {
  name: string;
  label: string;
}

/** The terminal a viewer runs in, from its XTVERSION answer, which starts with
 * the program's name (`ghostty 1.3.1`, `kitty(0.36.4)`). Terminal.app doesn't
 * answer, so there `TERM_PROGRAM` names it, but only for a local viewer outside
 * a multiplexer: anywhere else, or for another terminal, the variable may have
 * been inherited from wherever the viewer started. */
export function terminal(t: Pick<Terminal, "name" | "env" | "ssh"> | null): Seen | null {
  if (!t) return null;
  const label = clean(t.name);
  if (label) return { name: (/^[A-Za-z0-9_.-]+/.exec(label)?.[0] ?? label).toLowerCase(), label };
  const { TERM_PROGRAM: program, TERM_PROGRAM_VERSION: version, TMUX, STY, ZELLIJ } = t.env;
  if (program !== "Apple_Terminal" || !version || t.ssh || TMUX || STY || ZELLIJ) return null;
  return { name: "apple_terminal", label: clean(`${program} ${version}`) };
}
