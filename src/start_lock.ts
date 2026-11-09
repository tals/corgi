//! `<socket>.start.lock`, held while a daemon is on its way to answering on
//! the socket: `corgi` starting one, or a reload handing over. A client that
//! finds no daemon while it's held waits. The kernel lets go of an `flock`
//! with the last process holding it, so a crash can't leave it held.
import * as fs from "node:fs";
import { flock } from "./native_bridge";

export const path = (socket: string) => `${socket}.start.lock`;
/** How long a client waits for a daemon that's starting or reloading. */
export const wait_ms = 10_000;

/** Whether someone holds it. */
export function held(socket: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(path(socket), "r");
  } catch {
    return false;
  }
  try {
    if (!flock(fd)) return true;
    flock(fd, false);
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
/** Takes it within `limit_ms`: its open descriptor, which holds it until
 * every process it's passed to closes it; null if someone kept it. */
export async function take(socket: string, limit_ms = 2000): Promise<number | null> {
  const fd = fs.openSync(path(socket), "a", 0o600),
    until = Date.now() + limit_ms;
  while (!flock(fd)) {
    if (Date.now() >= until) {
      fs.closeSync(fd);
      return null;
    }
    await Bun.sleep(10);
  }
  return fd;
}
export function release(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {}
}
/** Whether `error` is a failed connect, or a connection dropped unanswered,
 * that a starting daemon explains. */
export function waitable(socket: string, error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") && held(socket);
}
