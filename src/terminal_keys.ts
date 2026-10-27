//! Keys, clicks and wheel notches from a terminal in raw mode with SGR mouse
//! reports, for Corgi's own full-screen frames outside the viewer: the
//! sign-in and voice mode.

export type Key =
  | {
      kind:
        | "up"
        | "down"
        | "left"
        | "right"
        | "tab"
        | "backtab"
        | "enter"
        | "esc"
        | "backspace"
        | "cancel"
        | "pageup"
        | "pagedown";
    }
  | { kind: "text"; text: string }
  /** Ctrl and a letter, as `d` for Ctrl+D. */
  | { kind: "ctrl"; key: string }
  | { kind: "click"; x: number; y: number }
  | { kind: "wheel"; dir: 1 | -1; x: number; y: number };

const named: [string, Key["kind"]][] = [
  ["\x1b[A", "up"],
  ["\x1bOA", "up"],
  ["\x1b[B", "down"],
  ["\x1bOB", "down"],
  ["\x1b[C", "right"],
  ["\x1bOC", "right"],
  ["\x1b[D", "left"],
  ["\x1bOD", "left"],
  ["\x1b[Z", "backtab"],
  ["\x1b[5~", "pageup"],
  ["\x1b[6~", "pagedown"],
];
/** Where `data` ends inside an escape sequence or a paste, or `data.length`:
 * a read can stop between the bytes of one key, and the rest comes next. */
export function incomplete(data: string): number {
  const paste = data.lastIndexOf("\x1b[200~");
  if (paste >= 0 && data.indexOf("\x1b[201~", paste) < 0) return paste;
  const esc = data.lastIndexOf("\x1b");
  return esc >= 0 && /^\x1b(?:\[[0-9;?<]*|O)?$/.test(data.slice(esc)) ? esc : data.length;
}
/** The keys, clicks and wheel notches in `data`. Coordinates are 0-based. */
export function keys(data: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < data.length;) {
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i));
    if (mouse) {
      const button = Number(mouse[1]),
        x = Number(mouse[2]) - 1,
        y = Number(mouse[3]) - 1;
      if (mouse[4] === "M" && button === 0) out.push({ kind: "click", x, y });
      else if (mouse[4] === "M" && (button === 64 || button === 65))
        out.push({ kind: "wheel", dir: button === 64 ? 1 : -1, x, y });
      i += mouse[0].length;
      continue;
    }
    if (data.startsWith("\x1b[200~", i)) {
      const end = data.indexOf("\x1b[201~", i);
      out.push({ kind: "text", text: data.slice(i + 6, end < 0 ? data.length : end) });
      i = end < 0 ? data.length : end + 6;
      continue;
    }
    const seq = named.find(([s]) => data.startsWith(s, i));
    if (seq) {
      out.push({ kind: seq[1] } as Key);
      i += seq[0].length;
      continue;
    }
    const ch = data[i++];
    if (ch === "\x1b") {
      // Another escape sequence: skip it whole.
      const rest = /^(?:\[[0-9;?]*[ -\/]*[@-~]|O.)/.exec(data.slice(i));
      if (rest) i += rest[0].length;
      else out.push({ kind: "esc" });
    } else if (ch === "\r" || ch === "\n") out.push({ kind: "enter" });
    else if (ch === "\t") out.push({ kind: "tab" });
    else if (ch === "\x7f" || ch === "\b") out.push({ kind: "backspace" });
    else if (ch === "\x03" || ch === "\x11") out.push({ kind: "cancel" });
    else if (ch >= " ") out.push({ kind: "text", text: ch });
    else if (ch >= "\x01" && ch <= "\x1a") out.push({ kind: "ctrl", key: String.fromCharCode(ch.charCodeAt(0) + 96) });
  }
  return out;
}
