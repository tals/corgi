//! What "Jump to attention" goes to: the pane that has waited longest for
//! input, then the one that finished longest ago, then a headless session in
//! that order. A blocked agent waits until answered, even after a visit
//! acknowledged it, matching the sidebar's count. Repeated jumps cycle: from a
//! focused candidate, the jump goes to the next older-to-newer candidate of the
//! same kind and wraps around, so every waiting pane is reached.

import type { Attention } from "./agents";

type Pane = { id: number; agent: { attention: Attention; changed_at: number; state: string } };
type Session = { attention: Attention; state: string };

const waits = (a: { attention: Attention; state: string }) => a.attention === "needs_input" || a.state === "blocked";
const finished = (a: { attention: Attention; state: string }) => !waits(a) && a.attention === "finished";

export function pick<S extends Session>(
  state: { panes: readonly Pane[]; sessions: readonly S[] },
  focused: number | null = null,
): { pane: number } | { session: S } | null {
  for (const matches of [waits, finished]) {
    const candidates = state.panes
      .filter(p => matches(p.agent))
      .sort((a, b) => a.agent.changed_at - b.agent.changed_at || a.id - b.id);
    if (candidates.length === 0) continue;
    // The one after the focused pane, oldest first when nothing of this kind is focused.
    const at = candidates.findIndex(p => p.id === focused);
    return { pane: candidates[(at + 1) % candidates.length]!.id };
  }
  for (const matches of [waits, finished])
    for (const session of state.sessions) if (matches(session)) return { session };
  return null;
}
