//! Attaching a terminal to the daemon. Mirrors client.zig.
import { Connection } from "./viewer_connection";
import { run, writeAll, Stdin } from "./viewer";
import { runTest } from "./viewer_test";
import * as terminal_info from "./terminal_info";
import * as keyboard from "./keyboard";
import * as hostBackground from "./host_background";
import * as crash from "./crash";

let keyboard_enabled = false;
let cursor_blink_saved = false;
let restore = false;
export function cleanup(): void {
  if (!restore) return;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {}
  try {
    if (keyboard_enabled) {
      writeAll(keyboard.disable);
      keyboard_enabled = false;
    }
    writeAll(
      hostBackground.release() +
        "\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1004l\x1b[?2031l\x1b[?5522l\x1b[?2004l\x1b[?1049l\x1b]22;default\x1b\\",
    );
    if (cursor_blink_saved) {
      writeAll("\x1b[?12r");
      cursor_blink_saved = false;
    }
  } catch {}
  restore = false;
}
function signalHandler(): void {
  cleanup();
  process.exit(0);
}
/** A crash gives the terminal back before its error prints, which the
 * viewer's own screen would otherwise swallow. Bun prints a thrown error
 * after the monitor but a rejection before any handler, and loses its stack
 * when one is thrown again, so a rejection prints here. */
function rejected(reason: unknown): void {
  cleanup();
  crash.notePanic(reason);
  console.error(reason);
  process.exit(1);
}
/** Opens on the workspace for `folder` when one is given. */
export async function attach(path: string, folder: string | null = null): Promise<void> {
  return attachMode(path, false, folder);
}
export async function onboard(path: string): Promise<void> {
  return attachMode(path, true);
}
async function attachMode(path: string, start_onboarding: boolean, folder: string | null = null): Promise<void> {
  const executable = await attachOnce(path, start_onboarding, folder);
  if (executable) {
    process.execve!(executable, [executable, "attach"], process.env as Record<string, string>);
    throw Error("ExecFailed");
  }
}
async function attachOnce(path: string, start_onboarding: boolean, folder: string | null): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("TerminalRequired");
  const conn = new Connection(path);
  restore = true;
  process.on("SIGTERM", signalHandler);
  process.on("SIGHUP", signalHandler);
  process.on("uncaughtExceptionMonitor", cleanup);
  process.on("unhandledRejection", rejected);
  const stdin = new Stdin();
  try {
    process.stdin.setRawMode(true);
    const input: number[] = [];
    const probe = new terminal_info.Probe();
    // The host's colors, read before the first frame so panes match it.
    writeAll(probe.query());
    await stdin.collect(
      150,
      () => probe.theme.complete(),
      bytes => {
        for (const byte of probe.feed(bytes, Date.now())) input.push(byte);
      },
    );
    // Keep parsing late replies in the normal client loop.
    probe.changed = false;
    // Mode 2031: the terminal says when it switches themes, and the viewer asks for its colors again.
    writeAll("\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?2031h" + keyboard.enable);
    keyboard_enabled = true;
    if (process.env.CORGI_CURSOR_BLINK !== "1") {
      // Save and disable only blinking: retain the host's cursor shape and
      // let each rendered frame continue to control cursor visibility.
      writeAll("\x1b[?12s\x1b[?12l");
      cursor_blink_saved = true;
    }
    return await run(conn, path, probe, input, start_onboarding, stdin, folder);
  } finally {
    stdin.close();
    cleanup();
    process.off("SIGTERM", signalHandler);
    process.off("SIGHUP", signalHandler);
    process.off("uncaughtExceptionMonitor", cleanup);
    process.off("unhandledRejection", rejected);
    conn.close();
  }
}
export async function test(path: string): Promise<void> {
  const conn = new Connection(path);
  try {
    await runTest(conn, process.cwd());
  } finally {
    conn.close();
  }
}
