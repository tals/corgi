//! What "Jump to attention" goes to: the pane that has waited longest for
//! input, then the one that finished longest ago, then a headless session in
//! that order. A blocked agent waits until answered, even after a visit
//! acknowledged it, matching the sidebar's count. The focused pane yields to
//! any other candidate of the same kind so repeated jumps move on.

import type { Attention } from "./agents";

type Pane = { id: number; agent: { attention: Attention; changed_at: number; state: string } };
type Session = { attention: Attention; state: string };

const waits = (a: { attention: Attention; state: string }) => a.attention === "needs_input" || a.state === "blocked";
const finished = (a: { attention: Attention; state: string }) => !waits(a) && a.attention === "finished";

export function pick<S extends Session>(
  state: { panes: readonly Pane[]; sessions: readonly S[] },
  focused: number | null = null,
): { pane: number } | { session: S } | null {
  // Not focused before focused, then oldest first.
  const before = (p: Pane, best: Pane) =>
    p.id === focused || best.id === focused ? best.id === focused : p.agent.changed_at < best.agent.changed_at;
  for (const matches of [waits, finished]) {
    let best: Pane | null = null;
    for (const p of state.panes) if (matches(p.agent) && (best === null || before(p, best))) best = p;
    if (best) return { pane: best.id };
  }
  for (const matches of [waits, finished])
    for (const session of state.sessions) if (matches(session)) return { session };
  return null;
}
