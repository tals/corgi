//! Notes on lines of a diff, and the text Send pastes into the agent. A note
//! keeps the lines it was written on, so it still reads right after the file
//! moves on. Mirrors herdr-reviewr's comment model and export format.
import type { FileDiff, Row } from "./diff";

export type Side = "new" | "old";
/** Where a note's diff came from: the working tree, or one picked commit. */
export type Rev = { kind: "worktree" } | { kind: "commit"; hash: string };
export interface Note {
  id: number;
  path: string;
  rev: Rev;
  side: Side;
  start: number;
  end: number;
  /** The lines it was written on, each with its `+`, `-` or space. */
  snippet: string;
  text: string;
}
export const sameRev = (a: Rev, b: Rev) =>
  a.kind === "worktree" ? b.kind === "worktree" : b.kind === "commit" && a.hash === b.hash;

/** The line `row` sits at on `side`, or 0 when it has no line there. */
export function lineOn(row: Row, side: Side): number {
  return side === "new" ? (row.kind === "deletion" ? 0 : row.new_no) : row.kind === "deletion" ? row.old_no : 0;
}
/** Where a note on `rows` anchors: the new side's lines when it has any,
 * else the deleted ones. */
export function anchor(diff: FileDiff, rows: Row[]): Pick<Note, "side" | "start" | "end" | "snippet"> | null {
  if (rows.length === 0) return null;
  const fresh = rows.filter(r => r.kind !== "deletion").map(r => r.new_no),
    gone = rows.filter(r => r.kind === "deletion").map(r => r.old_no),
    side: Side = fresh.length ? "new" : "old",
    lines = side === "new" ? fresh : gone;
  const mark = (r: Row) => (r.kind === "insertion" ? "+" : r.kind === "deletion" ? "-" : " ");
  return {
    side,
    start: Math.min(...lines),
    end: Math.max(...lines),
    snippet: rows.map(r => mark(r) + diff.text(r)).join("\n"),
  };
}
export function covers(note: Note, row: Row): boolean {
  const line = lineOn(row, note.side);
  return line !== 0 && line >= note.start && line <= note.end;
}
export function location(note: Note): string {
  const range = note.start === note.end ? `${note.start}` : `${note.start}-${note.end}`;
  const at = note.rev.kind === "commit" ? ` in ${note.rev.hash.slice(0, 7)}` : "";
  return `${note.path}:${range}${note.side === "old" ? " (removed)" : ""}${at}`;
}
/** Every note as one block of location, snippet and text, sorted by file
 * and line, a blank line between blocks. Blank lines inside a note's text
 * are dropped so they can't read as a block break. */
export function format(notes: Note[]): string {
  return notes
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start))
    .map(n => {
      const text = n.text
        .replace(/\r/g, "")
        .split("\n")
        .map(l => l.trimEnd())
        .filter(l => l.trim().length > 0)
        .join("\n");
      return `${location(n)}\n${n.snippet}\n${text}`;
    })
    .join("\n\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "\ufffd");
}
