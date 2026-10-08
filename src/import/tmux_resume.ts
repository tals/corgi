import { processArgs, shellEscape } from "../os";
import { basename } from "node:path";
import type { Terminal } from "../pane/terminal";
export function foregroundPid(processes: string, pane_pid: number): number | null {
  for (const line of processes.split("\n")) {
    const fields = line.trim().split(/[ \t]+/);
    if (!/^-?\d+$/.test(fields[0] ?? "") || !/^-?\d+$/.test(fields[1] ?? "")) continue;
    const pid = Number(fields[0]),
      pgid = Number(fields[1]);
    if (pid === pane_pid) return pgid > 0 ? pgid : null;
  }
  return null;
}
export function quote(args: string[]): string {
  if (
    !args.length ||
    !args[0] ||
    args[0][0] === "-" ||
    ["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh"].includes(basename(args[0]))
  )
    return "";
  const line = shellEscape(args);
  return line !== null && Buffer.byteLength(line) <= 2048 ? line : "";
}
export function command(pid: number): string {
  const process = processArgs(pid);
  return process?.complete ? quote(process.argv) : "";
}

export function tail(text: string, limit: number): string {
  const bytes = Buffer.from(text.replace(/[ \r\n]+$/, ""));
  let start = bytes.length,
    used = 0;
  while (start > 0) {
    const ch = bytes[start - 1],
      size = ch < 32 ? 6 : ch === 34 || ch === 92 ? 2 : 1;
    if (used + size > limit) break;
    used += size;
    start--;
  }
  if (start === 0) return bytes.toString();
  const newline = bytes.indexOf(10, start);
  if (newline >= 0) start = newline + 1;
  else while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString();
}
export function feed(terminal: Terminal, text: string): void {
  terminal.feed(text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "").replace(/\n/g, "\r\n"));
  if (text.length) terminal.feed("\r\n");
}
