import type { Terminal } from "./terminal";
/** `path` marks a file path found in plain text (see `file_ref.ts`). */
export type Link = { row: number; start: number; end: number; uri: string; id: bigint; path?: boolean };
// Ghostty owns the render cells and detects links in the same native snapshot.
// JSON gives the viewer independent copies, including during synchronized output.
export class Snapshot {
  links: Link[] = [];
  capture(terminal: Terminal): void {
    this.links = terminal.hyperlinks();
  }
}
