import { test, expect } from "bun:test";
import { State } from "./limits";
import { Window } from "./account";
test("a new reset starts a new spark while drift within a slot does not", () => {
  const state = new State(),
    week = new Window({ minutes: 10080, used: 30, reset_at: 10080 * 60 });
  state.record([null, week], 60);
  const drift = new Window({
    ...week,
    reset_at: week.reset_at! + 90,
    used: 31,
  });
  const same = state.record([null, drift], 2 * 86400);
  expect(same[1][0]).toBe(30);
  expect(same[1][3]).toBe(31);
  const next = new Window({
    ...week,
    reset_at: week.reset_at! + 10080 * 60,
    used: 2,
  });
  const fresh = state.record([null, next], week.reset_at! + 60);
  expect(fresh[1][0]).toBe(2);
  expect(fresh[1][3]).toBeNull();
});
test("windows follow their length across provider slots and unknown resets have no spark", () => {
  const state = new State(),
    week = new Window({ minutes: 10080, used: 84, reset_at: 10080 * 60 });
  state.record([week, null], 60);
  expect(state.record([null, week], 120)[1][0]).toBe(84);
  expect(
    state.record([new Window({ minutes: 300, used: 5 }), null], 60)[0][0],
  ).toBeNull();
});
