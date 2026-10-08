import { test, expect } from "bun:test";
import { Order } from "./agent_order";
test("agent order mixes pane and native identities and reconciles removal and insertion", () => {
  const a = { pane: 1 },
    b = { pane: 2 },
    c = { native: 1 },
    d = { pane: 3 },
    o = new Order();
  o.move([a, b, c], c, a);
  expect(o.slice()).toEqual([c, a, b]);
  o.move([a, b, c], c, null);
  expect(o.slice()).toEqual([a, b, c]);
  o.move([c, b, d], d, b);
  expect(o.slice()).toEqual([d, b, c]);
  expect(() => o.move([b, c, d], b, a)).toThrow("InvalidDestination");
  expect(() => Order.restore([a, a])).toThrow("InvalidAgentOrder");
});
test("a target moved after another lands right below it", () => {
  const a = { pane: 1 },
    b = { pane: 2 },
    c = { pane: 3 },
    fork = { pane: 4 },
    o = Order.restore([c, a, b]);
  o.moveAfter([a, b, c, fork], fork, c);
  expect(o.slice()).toEqual([c, fork, a, b]);
  o.moveAfter([a, b, c, fork], fork, b);
  expect(o.slice()).toEqual([c, a, b, fork]);
});
