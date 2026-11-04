//! Sets the effort a launch left off its agent's command line on each
//! conversation that agent shows, through its provider's own channel.
import { adapter, type Provider } from "./providers";
import * as effort from "./providers/effort";
import type { Pane, Runtime } from "./runtime";
import type { Terminal } from "./pane/terminal";
/** An effort for the agent `terminal` runs in pane `pane`, while it runs. */
export class WantedEffort {
  /** How long a conversation may take to reach the provider's channel. */
  static wait_ms = 20000;
  static retry_ms = 500;
  /** Conversations it was set on or gave up on, as titles and as sessions. */
  done = new Set<string>();
  /** When each conversation it waits on first showed. */
  seen = new Map<string, number>();
  busy = false;
  next_at = 0;
  constructor(
    public pane: number,
    public terminal: Terminal,
    public effort: effort.Effort,
  ) {}
}
/** What a live handoff keeps of the effort `pane` wants: the agent keeps
 * running without it on its command line. */
export function save(runtime: Runtime, pane: Pane) {
  const wanted = runtime.wanted_efforts.find(w => w.pane === pane.id && w.terminal === pane.terminal);
  return wanted ? { value: wanted.effort, done: [...wanted.done] } : null;
}
/** Wants the effort `saved` names again in `pane`, whose agent a live
 * handoff kept running. */
export function restore(runtime: Runtime, pane: Pane, saved: any) {
  const value = effort.parse(saved?.value);
  if (!value) return;
  const wanted = new WantedEffort(pane.id, pane.terminal, value);
  for (const named of Array.isArray(saved.done) ? saved.done : [])
    if (typeof named === "string") wanted.done.add(named);
  runtime.wanted_efforts.push(wanted);
}
/** The conversation the agent in `pane` shows: as its title names it, which
 * a new one does before its first message, or as the agent reported it. */
function shown(pane: Pane, provider: Provider) {
  const title = pane.terminal.titleInfo(),
    named = title.pid > 0 && title.pid === pane.detection.pid ? adapter(provider).titleSession?.(title.text) : null;
  if (named?.len) return named.text();
  const agent = pane.agent();
  return agent.provider === provider && agent.session.len ? agent.sessionId() : "";
}
export function advance(runtime: Runtime, now: number) {
  for (let i = runtime.wanted_efforts.length - 1; i >= 0; i--) {
    const wanted = runtime.wanted_efforts[i],
      pane = runtime.pane(wanted.pane);
    if (!pane || pane.terminal !== wanted.terminal || pane.terminal.exited) {
      runtime.wanted_efforts.splice(i, 1);
      continue;
    }
    const provider = pane.launch?.agent?.provider,
      settle = provider ? adapter(provider).launch.settle : undefined;
    if (!provider || !settle || wanted.busy || now < wanted.next_at) continue;
    const named = shown(pane, provider);
    if (!named || wanted.done.has(named)) continue;
    const seen = wanted.seen.get(named) ?? now;
    wanted.seen.set(named, seen);
    if (now - seen > WantedEffort.wait_ms) {
      wanted.done.add(named);
      console.warn(`setting an agent's effort: ${named} never ran on ${provider}'s shared server`);
      continue;
    }
    wanted.busy = true;
    wanted.next_at = now + WantedEffort.retry_ms;
    void settle(named, pane.account(), wanted.effort)
      .then(session => {
        if (session) wanted.done.add(named).add(session);
      })
      .catch(error => {
        wanted.done.add(named);
        console.warn("setting an agent's effort:", error);
      })
      .finally(() => (wanted.busy = false));
  }
}
