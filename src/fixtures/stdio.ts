import type { Stdio } from "../providers/stdio";

/** A provider's pipes: it reads what a test pushes to `lines`, and what it writes lands in `written`. */
export function stdio(lines: unknown[] = []) {
  const written: unknown[] = [];
  const io = {
    exited: false,
    pid: -1,
    read: () => lines.splice(0),
    write: (value: unknown) => written.push(value),
    reply: (value: unknown) => {
      written.push(value);
      return true;
    },
    wait: async () => {},
    close() {},
    adopt() {},
    save: () => ({ state: {}, handles: [] }),
  } as unknown as Stdio;
  return { io, lines, written };
}
