import type { Terminal } from "../../pane/terminal";
import { ScreenWatcher, type Reading } from "../watcher";
import type { PaneView, PaneMemory, Known } from "../adapter";

const separator = /^─{8,}$/;
function reading(_title: string, text: string): Reading | null {
  const tail = text.trimEnd().split("\n").slice(-18).join("\n").toLowerCase();
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
function composer(t: Terminal) {
  const surface = t.surface(0).surface;
  const lines = surface.lines.map(s => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd());
  const bottom = lines.findLastIndex(line => separator.test(line));
  if (bottom < 2 || !separator.test(lines[bottom - 2]) || !/^>( |$)/.test(lines[bottom - 1])) return null;
  return lines[bottom - 1].slice(1).trimStart();
}
export const rename = {
  command: (name: string) => "/rename " + name,
  empty: (t: Terminal) => composer(t) === "",
  holds: (t: Terminal, text: string) => composer(t) === text,
};
