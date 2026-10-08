//! Characterization of the pinned VT formatter, deliberately separate from checkpoints.
import type { Terminal } from "../pane/terminal";
export function format(terminal: Terminal): Buffer {
  return Buffer.from(terminal.native({ op: "probeFormat" }));
}
