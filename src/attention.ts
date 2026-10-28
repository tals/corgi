//! What "Jump to attention" goes to: the pane that has waited longest for
//! input, then the one that finished longest ago, then a headless session in
//! that order.

import type { Attention } from "./agents";

type Pane = { id: number; agent: { attention: Attention; changed_at: number } };
type Session = { attention: Attention };

export function pick<S extends Session>(state: {
  panes: readonly Pane[];
  sessions: readonly S[];
}): { pane: number } | { session: S } | null {
  for (const priority of ["needs_input", "finished"]) {
    let best: Pane | null = null;
    for (const p of state.panes)
      if (p.agent.attention === priority && (best === null || p.agent.changed_at < best.agent.changed_at)) best = p;
    if (best) return { pane: best.id };
  }
  for (const priority of ["needs_input", "finished"])
    for (const session of state.sessions) if (session.attention === priority) return { session };
  return null;
}
