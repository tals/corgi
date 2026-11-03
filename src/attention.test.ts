import { test, expect } from "bun:test";
import * as attention from "./attention";

type Attention = "none" | "finished" | "needs_input";
type State = "idle" | "working" | "blocked";
const pane = (id: number, state: Attention, changed_at: number, agent_state: State = "idle") => ({
  id,
  agent: { attention: state, changed_at, state: agent_state },
});
const session = (id: string, state: Attention, agent_state: State = "idle") => ({
  id,
  attention: state,
  state: agent_state,
});

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

test("a blocked pane still waits after a visit acknowledged it", () => {
  expect(
    attention.pick({
      panes: [pane(1, "finished", 1), pane(2, "none", 5, "blocked")],
      sessions: [],
    }),
  ).toEqual({ pane: 2 });
});

test("a blocked headless session still waits after a visit acknowledged it", () => {
  const blocked = session("b", "none", "blocked");
  expect(attention.pick({ panes: [], sessions: [session("a", "finished"), blocked] })).toEqual({ session: blocked });
});

test("the focused pane yields to another waiting pane", () => {
  const panes = [pane(1, "none", 1, "blocked"), pane(2, "none", 5, "blocked")];
  expect(attention.pick({ panes, sessions: [] }, 1)).toEqual({ pane: 2 });
  expect(attention.pick({ panes: [panes[0]!], sessions: [] }, 1)).toEqual({ pane: 1 });
});
