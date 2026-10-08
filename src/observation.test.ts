import { test, expect } from "bun:test";
import { State } from "./observation";
test("late receipts cannot read newer completions; starting work does not read results", () => {
  const state = new State();
  state.finish("completed", "transcript");
  const displayed = state.completed;
  state.finish("completed", "protocol");
  state.acknowledge(displayed);
  expect(state.unread()).toBe(true);
  state.acknowledge(state.completed);
  expect(state.unread()).toBe(false);
});
