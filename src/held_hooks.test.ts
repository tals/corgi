import { expect, test } from "bun:test";
import * as codex from "./providers/codex";
import { HeldHooks, max_age, max_sessions, per_session, type Held } from "./held_hooks";

function held(session: string, seq: bigint, at: number): Held {
  const event = codex.adapter.hook({ hook_event_name: "PreToolUse", session_id: session, turn_id: "t" })!;
  return { provider: "codex", pid: 0, event, seq, at, presence: "attaching" };
}

test("a session's hooks come back once, in the order they were sent", () => {
  const hooks = new HeldHooks();
  hooks.add(held("a", 3n, 1));
  hooks.add(held("a", 1n, 2));
  hooks.add(held("b", 2n, 3));
  expect(hooks.take("codex", "a", 4).map(h => h.seq)).toEqual([1n, 3n]);
  expect(hooks.take("codex", "a", 4)).toEqual([]);
  expect(hooks.take("claude", "b", 4)).toEqual([]);
  expect(hooks.take("codex", "b", 4).map(h => h.seq)).toEqual([2n]);
});

test("held hooks expire after a minute", () => {
  const hooks = new HeldHooks();
  hooks.add(held("a", 1n, 0));
  hooks.add(held("a", 2n, max_age / 2));
  expect(hooks.take("codex", "a", max_age).map(h => h.seq)).toEqual([2n]);
  hooks.add(held("b", 1n, 0));
  hooks.add(held("c", 1n, max_age));
  expect(hooks.size).toBe(1);
});

test("the hold keeps a session's newest hooks and the newest sessions", () => {
  const hooks = new HeldHooks();
  for (let i = 0; i < per_session + 2; i++) hooks.add(held("a", BigInt(i), 1));
  const kept = hooks.take("codex", "a", 1);
  expect(kept.length).toBe(per_session);
  expect(kept[0].seq).toBe(2n);
  for (let i = 0; i <= max_sessions; i++) hooks.add(held(`s${i}`, 1n, 1));
  expect(hooks.size).toBe(max_sessions);
  expect(hooks.take("codex", "s0", 1)).toEqual([]);
  expect(hooks.take("codex", `s${max_sessions}`, 1).length).toBe(1);
});
