import { test, expect } from "bun:test";
import * as attention from "./attention";

type Attention = "none" | "finished" | "needs_input";
const pane = (id: number, state: Attention, changed_at: number) => ({ id, agent: { attention: state, changed_at } });
const session = (id: string, state: Attention) => ({ id, attention: state });

test("the oldest pane waiting for input comes first", () => {
  expect(
    attention.pick({
      panes: [pane(1, "finished", 1), pane(2, "needs_input", 9), pane(3, "needs_input", 5)],
      sessions: [session("s", "needs_input")],
    }),
  ).toEqual({ pane: 3 });
});

test("then the pane that finished longest ago", () => {
  expect(
    attention.pick({
      panes: [pane(1, "finished", 7), pane(2, "none", 1), pane(3, "finished", 4)],
      sessions: [session("s", "needs_input")],
    }),
  ).toEqual({ pane: 3 });
});

test("then a headless session, waiting before finished", () => {
  const waiting = session("b", "needs_input");
  expect(attention.pick({ panes: [pane(1, "none", 1)], sessions: [session("a", "finished"), waiting] })).toEqual({
    session: waiting,
  });
});

test("nothing needs attention", () => {
  expect(attention.pick({ panes: [pane(1, "none", 1)], sessions: [session("a", "none")] })).toBeNull();
  expect(attention.pick({ panes: [], sessions: [] })).toBeNull();
});
