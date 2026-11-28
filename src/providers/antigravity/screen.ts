import type { Terminal } from "../../pane/terminal";
import { displayWidth } from "../../text";
import { ScreenWatcher, type Reading } from "../watcher";
import type { PaneView, PaneMemory, Known } from "../adapter";

const separator = /^─{8,}$/;
function reading(_title: string, text: string): Reading | null {
  const rows = text.trimEnd().split("\n").slice(-18),
    tail = rows.join("\n").toLowerCase(),
    composer = rows.findLastIndex(row => /^>(?: |$)/.test(row));
  // Only the live spinner immediately above the composer reports compaction.
  if (
    composer >= 2 &&
    separator.test(rows[composer - 1].trimEnd()) &&
    /^[\u2800-\u28ff]\s+Compacting conversation(?:…|\.\.\.)\s*\([^)]*esc to cancel\)$/.test(
      rows[composer - 2].trim(),
    ) &&
    !rows.slice(composer + 1).some(row => row.includes("? for shortcuts"))
  )
    return "compacting";
  if (
    tail.includes("esc to cancel") &&
    /requesting permission for:|no, (?:cancel|deny)|yes, and always allow/.test(tail)
  )
    return "blocked";
  if (/esc to interrupt|ctrl\+c to interrupt/.test(tail)) return "working";
  return tail.includes("? for shortcuts") ? "idle" : null;
}
export class Watcher extends ScreenWatcher {
  constructor() {
    super(reading);
  }
  route(_hook: Parameters<ScreenWatcher["route"]>[0], from: number | null) {
    return from === null ? null : { pane: from, binds: false };
  }
  read(pane: PaneView, memory: PaneMemory, known: Known | null, now: number) {
    const seen = super.read(pane, memory, known, now);
    if (known?.state === "working" && memory.interrupt_key_at && now - memory.interrupt_key_at <= 5000000) {
      const tail = pane.text().trimEnd().split("\n").slice(-8).join("\n");
      if (tail.includes("Interrupted · What should Antigravity CLI do instead?") && tail.includes("? for shortcuts")) {
        seen.interrupted = true;
        memory.interrupt_key_at = 0;
      }
    }
    return seen;
  }
}
function holds(t: Terminal, text: string) {
  const { cursor, lines } = t.surface(0).surface;
  // Dialogs can leave the previous composer on screen while taking its input.
  if (!cursor || cursor.x !== 2 + displayWidth(text)) return false;
  const row = (y: number) => (lines[y] ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
  return (
    separator.test(row(cursor.y - 1)) && row(cursor.y) === ("> " + text).trimEnd() && separator.test(row(cursor.y + 1))
  );
}
export const rename = {
  command: (name: string) => "/rename " + name,
  empty: (t: Terminal) => holds(t, ""),
  holds,
};
