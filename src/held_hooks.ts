//! Hooks about a conversation no pane shows yet. A pane learns its
//! conversation from its title, which can trail the agent's first hooks;
//! they wait here to be caught up instead of being lost.
import type { Presence } from "./agents";
import type { Provider } from "./providers";
import type { Hook } from "./providers/common";

/** How long a hook waits, in µs; a conversation no pane shows by then isn't open in Corgi. */
export const max_age = 60_000_000;
export const per_session = 64;
export const max_sessions = 32;

export type Held = {
  provider: Provider;
  pid: number;
  event: NonNullable<Hook>;
  seq: bigint;
  /** When it came, in µs. */
  at: number;
  presence: Presence;
};

export class HeldHooks {
  private sessions = new Map<string, Held[]>();
  get size() {
    return this.sessions.size;
  }
  /** Keeps a session's newest `per_session` hooks, of the newest `max_sessions` sessions. */
  add(hook: Held) {
    if (!hook.event.session) return;
    this.expire(hook.at);
    const key = `${hook.provider}\0${hook.event.session}`;
    let list = this.sessions.get(key);
    if (!list) {
      if (this.sessions.size >= max_sessions) this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(key, (list = []));
    }
    list.push(hook);
    if (list.length > per_session) list.shift();
  }
  /** Removes `session`'s hooks and returns them in the order they were sent. */
  take(provider: Provider, session: string, now: number) {
    this.expire(now);
    const key = `${provider}\0${session}`,
      list = this.sessions.get(key) ?? [];
    this.sessions.delete(key);
    return list.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  }
  private expire(now: number) {
    for (const [key, list] of this.sessions) {
      while (list.length && now - list[0].at >= max_age) list.shift();
      if (!list.length) this.sessions.delete(key);
    }
  }
}
