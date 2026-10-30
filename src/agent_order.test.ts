import { test, expect } from "bun:test";
import { Order, Pins, section } from "./agent_order";
test("agent order mixes pane and headless identities and reconciles removal and insertion", () => {
  const a = { pane: 1 },
    b = { pane: 2 },
    c = { headless: 1 },
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
test("pins mix pane and headless identities and drop agents that are gone", () => {
  const a = { pane: 1 },
    b = { pane: 2 },
    c = { headless: 1 },
    d = { pane: 3 },
    p = new Pins();
  p.pin([a, b, c], c, null);
  p.pin([a, b, c], a, c);
  expect(p.slice()).toEqual([a, c]);
  expect(p.has(b)).toBe(false);
  p.pin([a, b, c], a, null);
  expect(p.slice()).toEqual([c, a]);
  p.pin([c, b, d], d, c);
  expect(p.slice()).toEqual([d, c]);
  expect(() => p.pin([b, c, d], b, a)).toThrow("InvalidDestination");
  expect(() => p.pin([b, c], d, null)).toThrow("NoAgent");
  p.unpin([b, c, d], d);
  expect(p.slice()).toEqual([c]);
  expect(() => Pins.restore([a, a])).toThrow("InvalidAgentOrder");
});
test("a fork of a pinned agent is pinned right below it", () => {
  const a = { pane: 1 },
    b = { pane: 2 },
    c = { pane: 3 },
    fork = { pane: 4 },
    p = Pins.restore([c, a]);
  p.pinAfter([a, b, c, fork], fork, c);
  expect(p.slice()).toEqual([c, fork, a]);
  p.pinAfter([a, b, c, fork], fork, a);
  expect(p.slice()).toEqual([c, a, fork]);
  p.pinAfter([a, b, c, fork], fork, b);
  expect(p.slice()).toEqual([c, a, fork]);
});
test("an agent's section follows its state; one waiting on the user is at work", () => {
  expect(section("blocked", "none")).toBe("working");
  expect(section("idle", "needs_input")).toBe("working");
  expect(section("working", "finished")).toBe("working");
  // One just starting waits among the idle.
  expect(section("initializing", "none")).toBe("idle");
  expect(section("idle", "finished")).toBe("ready");
  expect(section("idle", "none")).toBe("idle");
  expect(section("idle", "none", true)).toBe("working");
  expect(section("done", "none", true)).toBe("done");
  expect(section("unknown", "none")).toBe("idle");
  expect(section("done", "needs_input")).toBe("done");
});
test("raising an agent puts it first and keeps the rest in order", () => {
  const a = { pane: 1 },
    b = { pane: 2 },
    c = { headless: 1 },
    o = Order.restore([a, b]);
  o.raise([a, b, c], c);
  expect(o.slice()).toEqual([c, a, b]);
  o.raise([a, b, c], b);
  expect(o.slice()).toEqual([b, c, a]);
  expect(o.has(a)).toBe(true);
  expect(() => o.raise([a], b)).toThrow("NoAgent");
});
