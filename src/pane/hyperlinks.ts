import type { Terminal } from "./terminal";
export type Link = { row: number; start: number; end: number; uri: string; id: number | bigint };
// Ghostty owns the render cells and detects links in the same native snapshot.
// JSON gives the viewer independent copies, including during synchronized output.
export class Snapshot {
  links: Link[] = [];
  capture(terminal: Terminal): void {
    this.links = terminal.native({ op: "links" });
  }
  deinit(): void {
    this.links = [];
  }
}
