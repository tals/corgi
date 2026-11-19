import { Terminal } from "../pane/terminal";

/** What a `cols` × `rows` host terminal shows after `bytes`: each row padded to its width, a line apiece. */
export function text(bytes: string, cols: number, rows: number): string {
  const terminal = new Terminal(cols, rows);
  try {
    terminal.feed(bytes);
    return terminal.text();
  } finally {
    terminal.destroy();
  }
}
/** The same screen's rows. */
export function lines(bytes: string, cols: number, rows: number): string[] {
  return text(bytes, cols, rows).split("\n").slice(0, rows);
}
