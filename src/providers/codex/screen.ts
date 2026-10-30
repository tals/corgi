//! What Codex's screen shows, for panes without its hooks, and for what only
//! the screen says: compaction, background terminals, permission prompts.
import { screenTail, sharedPrompt, type Hook } from "../common";
import { ScreenWatcher, type Reading } from "../watcher";
/** The newest status row a turn shows, the one that offers to interrupt it. */
function status(text: string): string | null {
  for (const row of text.trimEnd().split("\n").slice(-8).reverse()) if (row.includes("esc to interrupt")) return row;
  return null;
}
function compacting(row: string) {
  return /^(?:[•◦·] )?Compacting (?:context|conversation) /.test(
    row.slice(0, row.indexOf("esc to interrupt")).trimStart(),
  );
}
function backgroundTerminals(text: string) {
  for (const row of text.trimEnd().split("\n").slice(-8).reverse()) {
    const hint = row.indexOf("esc to interrupt)");
    if (hint < 0) continue;
    if (row.slice(0, hint).includes("Waiting for background terminal")) return true;
    const m = row
      .slice(hint + 17)
      .trim()
      .match(/^· (\d+) (.+)$/);
    if (!m || Number(m[1]) === 0) continue;
    if (
      m[2].startsWith("background terminal") ||
      (m[2].endsWith("…") && m[2].length >= 13 && "background terminals running".startsWith(m[2].slice(0, -1)))
    )
      return true;
  }
  return false;
}
export function screen(title: string, text: string): Reading | null {
  if (title.includes("Action Required")) return "blocked";
  const full = sharedPrompt(text);
  if (full === "blocked" || full === "initializing") return full;
  // The composer and footer can push the live status out of the screen tail.
  const rows = text.trimEnd().split("\n");
  const prompt = rows.findLastIndex(row => row.trimStart().startsWith("›"));
  if (prompt >= 0) text = rows.slice(0, prompt + 1).join("\n");
  const shared = sharedPrompt(text);
  if (shared === "working") {
    const row = status(text);
    return row && compacting(row) ? "compacting" : backgroundTerminals(text) ? "tool" : "working";
  }
  if (shared) return shared;
  return screenTail(text)
    .split("\n")
    .some(r => r.trimStart().startsWith("›"))
    ? "idle"
    : null;
}
/** Codex runs every session of an app server in one process, which sends
 * hooks with the CORGI_PANE of whichever pane started it: the pane showing
 * the session wins, and no hook makes a pane show its session. */
export class Watcher extends ScreenWatcher {
  constructor() {
    super(screen);
  }
  route(hook: NonNullable<Hook>, from: number | null, showing: (session: string) => number | null) {
    const pane = showing(hook.session) ?? from;
    return pane === null ? null : { pane, binds: false };
  }
}
