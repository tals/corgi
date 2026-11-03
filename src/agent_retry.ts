//! Starts a turn its provider failed on a condition that may pass, such as an
//! overloaded model, again after a while, as long as the conversation a pane
//! shows still stands on that failure. Until then the agent counts as at work.
import { adapter, type Provider } from "./providers";
import type { Snapshot } from "./providers/snapshot";
import type { Agent } from "./agents";
import type { Runtime } from "./runtime";
/** How long it waits before each retry in a row; it gives up after the last. */
export const delays_ms = [15_000, 60_000, 120_000, 300_000, 600_000];
/** How old a failure may be when first seen, as after a reload, and still be retried. */
export const fresh_s = 120;
/** How long a retry waits after input from a viewer focused on its pane. */
export const quiet_ms = 10_000;
/** Snapshots, about 10 s of them, that may still show the failed turn after
 * a retry started it again. */
export const settling = 20;
/** A conversation whose latest turns failed that way. */
export class Retry {
  busy = false;
  /** Whether it started the failed turn again. */
  started = false;
  /** Snapshots since then that still showed the failed turn. */
  stale = 0;
  constructor(
    readonly provider: Provider,
    readonly account: string,
    readonly session: string,
    /** The failed turn it starts again. */
    public turn: string,
    /** Such failures in a row, this one included. */
    public failures: number,
    /** When it starts it again, on the policy clock; Infinity when it won't. */
    public at: number,
  ) {}
}
const due = (retry: Retry) => (Number.isFinite(retry.at) ? retry.at : 0);
/** Notes what `snapshot`, from `account`'s observer, says of its
 * conversation's latest turn, at `now` on the policy clock and `wall_s` in
 * Unix seconds; when it will start that turn again, 0 when it won't. */
export function observe(
  runtime: Runtime,
  provider: Provider,
  account: string,
  snapshot: Snapshot,
  now: number,
  wall_s: number,
) {
  const turn = snapshot.turn.text(),
    i = runtime.retries.findIndex(r => r.provider === provider && r.session === snapshot.session),
    old = i < 0 ? null : runtime.retries[i];
  if (!runtime.auto_retry || !snapshot.lifecycle || !snapshot.request.pane || !turn) return 0;
  if (snapshot.outcome === "failed" && snapshot.transient_failure_at) {
    if (old?.turn === turn) {
      if (old.started && ++old.stale > settling) old.at = Infinity;
      return due(old);
    }
    const failures = (old?.failures ?? 0) + 1,
      at =
        failures > delays_ms.length || wall_s - snapshot.transient_failure_at > fresh_s
          ? Infinity
          : now + delays_ms[failures - 1],
      retry = new Retry(provider, account, snapshot.session, turn, failures, at);
    if (old) runtime.retries[i] = retry;
    else runtime.retries.push(retry);
    return due(retry);
  }
  if (old && snapshot.outcome) runtime.retries.splice(i, 1);
  return 0;
}
/** How long a failed turn's transcript waits on the observer, which knows
 * whether Corgi starts it again, before it ends the turn. */
export const hold_ms = 3000;
/** A failed turn a transcript ended, held for the observer until `until`. */
export type HeldStop = { actor: number; seq: bigint; until: number };
/** Whether the transcript's word that `actor`'s turn failed waits, at `now` in ms. */
export function hold(runtime: Runtime, actor: { id: number; state: Agent }, seq: bigint, now: number) {
  const provider = actor.state.provider;
  if (!provider || !adapter(provider).retry) return false;
  runtime.held_stops.push({ actor: actor.id, seq, until: now + hold_ms });
  return true;
}
/** The held stops whose wait is over at `now`; the turn ends unless the
 * observer took it on. */
export function released(runtime: Runtime, now: number) {
  const due = runtime.held_stops.filter(h => now >= h.until);
  runtime.held_stops = runtime.held_stops.filter(h => now < h.until);
  return due;
}
/** When Corgi starts `agent`'s failed latest turn again, on the policy
 * clock; 0 when it won't. */
export function retryAt(runtime: Runtime, agent: Agent) {
  const retry = runtime.retries.find(r => r.provider === agent.provider && r.session === agent.sessionId());
  return retry && retry.turn === agent.turnId() ? due(retry) : 0;
}
/** Calls off the retry the agent in `pane` waits on. */
export function cancel(runtime: Runtime, pane: number) {
  const agent = runtime.pane(pane)?.agent(),
    retry = agent && runtime.retries.find(r => r.provider === agent.provider && r.session === agent.sessionId());
  if (retry && !retry.busy && !retry.started) retry.at = Infinity;
}
/** Starts the failed turns that are due at `now`, unless someone worked in
 * their pane lately: `input_at` says when a viewer focused on a pane last had
 * input, in ms on the wall clock. */
export function advance(runtime: Runtime, now: number, input_at: (pane: number) => number) {
  for (let i = runtime.retries.length - 1; i >= 0; i--) {
    const retry = runtime.retries[i],
      pane = runtime.panes.find(
        p => !p.terminal.exited && p.agent().provider === retry.provider && p.agent().sessionId() === retry.session,
      );
    if (!pane) {
      runtime.retries.splice(i, 1);
      continue;
    }
    const start = adapter(retry.provider).retry;
    if (!start || retry.busy || retry.started || now < retry.at) continue;
    // Someone at work in its pane may be answering it: wait until they stop.
    const quiet = Date.now() - input_at(pane.id);
    if (quiet < quiet_ms) {
      retry.at = now + quiet_ms - quiet;
      continue;
    }
    retry.busy = true;
    void start(retry.session, retry.turn, retry.account)
      .then(started => {
        retry.started = started;
        if (!started) retry.at = Infinity;
      })
      .catch(error => {
        retry.at = Infinity;
        console.warn("retrying a failed turn:", error);
      })
      .finally(() => (retry.busy = false));
  }
}
